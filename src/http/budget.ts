import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { BudgetWriteUnconfirmedError } from '../actual/store.ts';
import type { CuratorRow } from '../actual/types.ts';
import { addMonths, currentMonth, daysInMonth, jerusalemToday, previousMonth } from '../budget/dates.ts';
import { buildEvents, type BudgetEvent, type IncomeRow, incomeStatus } from '../budget/events.ts';
import { dataMonth, lineChanges, lineIds, lineMonth, summarize, uncategorized } from '../budget/ledger.ts';
import { type Move, offPlan, type OffPlanLine, pace, type PaceLine, suggestMoves } from '../budget/pace.ts';
import { availableFor, checkAccounts, checkPlan, fundingShortfall, PlanError, propose, proposalId } from '../budget/propose.ts';
import { countedSources, runway } from '../budget/runway.ts';
import { type MonthSnapshot, type Plan, planSchema } from '../budget/types.ts';
import { ApiError } from './errors.ts';
import { money } from './format.ts';
import type { ApiDeps } from './app.ts';

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');
/** Shekels with at most 2 decimals. `multipleOf(0.01)` is float-fragile, so compare in agorot. */
const hasAgorotPrecision = (x: number) => Math.abs(Math.round(x * 100) - x * 100) < 1e-6;
const shekels = z.number().refine(hasAgorotPrecision, 'at most 2 decimals');
const toMinor = (shekel: number) => Math.round(shekel * 100);
const who = z.string().trim().min(1);

const putPlanBody = z.object({ plan: planSchema, by: who, why: who });
const applyBody = z.object({
  month: monthSchema, proposalId: z.string().min(1),
  amounts: z.record(z.string().min(1), shekels.refine(x => x >= 0, 'must be >= 0'))
    .refine(a => Object.keys(a).length > 0, 'needs at least one category'), approvedBy: who,
});
const moveBody = z.object({
  month: monthSchema, from: z.string().min(1), to: z.string().min(1),
  amount: shekels.refine(x => x > 0, 'must be > 0'), approvedBy: who,
});
const ackBody = z.object({ ids: z.array(z.string().min(1)) });

const HISTORY_MONTHS = 6;
const HISTORY_NOTE = "Only applies and moves made through the curator have a change record; edits made in Actual's own screen do not.";

const planAmounts = (plan: Plan): number[] => [
  ...plan.categories.flatMap(c => [c.amount, c.target]),
  ...plan.incomeSources.map(s => s.expectedAmount),
].filter((x): x is number => x !== undefined);

const moneyPace = (l: PaceLine) => ({ ...l, budgeted: money(l.budgeted), spent: money(l.spent), balance: money(l.balance),
  expectedByToday: money(l.expectedByToday), projected: money(l.projected) });
const moneyMove = (m: Move) => ({ ...m, amount: money(m.amount) });
const moneyOff = (l: OffPlanLine) => ({ ...l, spent: money(l.spent), balance: money(l.balance) });
const moneyEvent = (e: BudgetEvent) =>
  e.kind === 'income' ? { ...e, amount: money(e.amount) } : e.kind === 'unplanned' ? { ...e, balance: money(e.balance) } : e;

export const day30Before = (today: string): string => dayBefore(today, 30);
const addDay = (date: string): string => dayBefore(date, -1);
const dayBefore = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) - days * 864e5).toISOString().slice(0, 10);
/** Read the latest from the Actual server before reading local state; never decide on stale data. */
export const freshSync = async (store: ApiDeps['store']): Promise<void> => {
  try { await store.sync(); } catch (e) {
    throw new ApiError(503, 'sync_failed', `could not sync with the Actual server: ${(e as Error).message}`);
  }
};
/** A list that is summed or shown whole must not be a full page: it may be cut short. */
export const ROW_LIMIT = 5000;
export const wholeList = <T>(rows: T[], what: string): T[] => {
  if (rows.length >= ROW_LIMIT) {
    throw new ApiError(400, 'too_many_rows', `${what} has ${ROW_LIMIT} or more transactions; the list would be cut short`);
  }
  return rows;
};
/** How far ahead of a month its later months are scanned for carried-over To budget. */
const LOOKAHEAD_MONTHS = 12;
/** Income events look back this many days from today, so a deposit near a month boundary is not lost. */
const INCOME_WINDOW_DAYS = 35;
/** Days into the next month a past month's rows are read (covers a due date spilling over a 28-day February). */
const GRACE_DAYS = 6;

export function registerBudgetRoutes(app: Hono, deps: ApiDeps, now: () => Date): void {
  const { store, budget } = deps;
  const g = '/budget';

  // Serializes read -> validate -> write -> journal for apply and move. Not the store's lock: setBudgeted takes that one.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };

  const body = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> =>
    schema.parse(await c.req.json().catch(() => ({})));
  const monthParam = (c: Context): string => monthSchema.parse(c.req.query('month') ?? currentMonth(now()));
  const writable = (month: string): void => {
    if (month < currentMonth(now())) throw new ApiError(400, 'past_month', `${month} is in the past and read-only`);
  };
  const needPlan = (): Plan => {
    const plan = budget.plan();
    if (!plan) throw new PlanError('no_plan', 'No budget plan saved yet; PUT /v1/budget/plan first');
    return plan;
  };
  /** A fresh snapshot checked against the saved plan: the starting point of every month-bound route. */
  const load = async (month: string): Promise<{ plan: Plan; snap: MonthSnapshot }> => {
    const plan = needPlan();
    const snap = await store.budgetMonth(month);
    checkPlan(plan, snap);
    if (plan.incomeSources.some(s => s.account !== undefined)) checkAccounts(plan, await store.accounts());
    return { plan, snap };
  };
  /** Deposit candidates from on-budget accounts only: income "landed" means money in the budget. */
  const incomeRows = async (ranges: [from: string, to: string][]): Promise<IncomeRow[]> => {
    const off = new Set((await store.accounts()).filter(a => a.offbudget).map(a => a.id));
    // Merge ranges that overlap or touch; one query per merged range, so a far-past month never drags a huge span through the row limit.
    const merged: [string, string][] = [];
    for (const [f, t] of [...ranges].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
      const last = merged.at(-1);
      if (last && f <= addDay(last[1])) last[1] = t > last[1] ? t : last[1];
      else merged.push([f, t]);
    }
    const out = new Map<string, IncomeRow>();
    for (const [from, to] of merged) {
      for (const r of await store.transactions({ from, to, limit: 5000 })) {
        if (off.has(r.account)) continue;
        out.set(r.id, { id: r.id, date: r.date, amount: r.amount, account: r.account, payee: r.payee,
          importedPayee: r.importedPayee, transferId: r.transferId });
      }
    }
    return [...out.values()];
  };
  const monthRange = (month: string): [string, string] => [`${month}-01`, `${month}-${daysInMonth(month)}`];
  const monthRows = (month: string) => incomeRows([monthRange(month)]);
  /** Every row of a month, or a refusal when the list would be cut short. */
  const monthRowsAll = async (month: string): Promise<CuratorRow[]> => {
    const [from, to] = monthRange(month);
    return wholeList(await store.transactions({ from, to, limit: ROW_LIMIT }), month);
  };
  const offBudgetIds = async () => new Set((await store.accounts()).filter(a => a.offbudget).map(a => a.id));
  const uncategorizedOf = async (month: string, off: Set<string>) => {
    const u = uncategorized(await monthRowsAll(month), off);
    return { in: money(u.in), out: money(u.out) };
  };
  /**
   * toBudget of every later month Actual has data for (up to a year ahead), in month order. A later month's To budget
   * includes this month's leftover, so what is free to give this month is the minimum across all of them.
   */
  const laterToBudgets = async (month: string): Promise<number[]> => {
    const last = addMonths(month, LOOKAHEAD_MONTHS);
    const months = (await store.budgetMonths()).filter(m => m > month && m <= last).sort();
    const out: number[] = [];
    for (const m of months) out.push((await store.budgetMonth(m)).toBudget);
    return out;
  };
  /** The write may have landed even though Actual did not confirm it: leave a trace, then surface the error. */
  const guardedWrite = async (month: string, amounts: Record<string, number>, entry: object): Promise<void> => {
    try { await store.setBudgeted(month, amounts); } catch (e) {
      if (e instanceof BudgetWriteUnconfirmedError) budget.journal({ ...entry, outcome: 'unconfirmed' }, now());
      throw e;
    }
  };
  /** Push to the Actual server now; a failure only delays it to the next run's sync. */
  const push = () => store.sync().catch(e => console.error(`sync after budget write failed: ${(e as Error).message}`));

  app.get(`${g}/plan`, c => c.json({ plan: budget.plan() }));

  app.put(`${g}/plan`, async c => {
    const b = await body(c, putPlanBody);
    const bad = planAmounts(b.plan).filter(x => !hasAgorotPrecision(x));
    if (bad.length) throw new ApiError(400, 'bad_request', `plan amounts need at most 2 decimals: ${bad.join(', ')}`);
    checkPlan(b.plan, await store.budgetMonth(currentMonth(now())));
    if (b.plan.incomeSources.some(s => s.account !== undefined)) checkAccounts(b.plan, await store.accounts());
    budget.savePlan(b.plan, { by: b.by, why: b.why }, now());
    return c.json({ plan: b.plan });
  });

  app.get(`${g}/propose`, async c => {
    const month = monthParam(c);
    writable(month);
    await freshSync(store);
    const { plan, snap } = await load(month);
    const p = propose(plan, snap, await laterToBudgets(month));
    const { landed, expected } = incomeStatus(plan, month, await monthRows(month));
    // Actual throws "No budget exists for month" before its earliest month; that just means nothing was spent.
    const prev = await store.budgetMonth(previousMonth(month)).catch((e: unknown) => {
      if (e instanceof Error && e.message.includes('No budget exists for month')) return null;
      throw e;
    });
    const excluded = new Set(plan.categories.filter(x => x.kind === 'excluded').map(x => x.categoryId));
    const excludedSpent = (prev?.categories ?? []).filter(x => excluded.has(x.id)).reduce((s, x) => s - x.spent, 0);
    return c.json({
      proposal: { ...p, available: money(p.available), proposed: money(p.proposed), remaining: money(p.remaining),
        coversOverspend: money(p.coversOverspend),
        lines: p.lines.map(l => ({ ...l, planned: money(l.planned), budgeted: money(l.budgeted),
          propose: money(l.propose), unfunded: money(l.unfunded), covers: money(l.covers) })) },
      landed: landed.map(l => ({ source: l.source.name, amount: money(l.row.amount), date: l.row.date })),
      expected: expected.map(s => ({ source: s.name, expectedDay: s.expectedDay })),
      excludedSpentLastMonth: money(excludedSpent),
    });
  });

  app.post(`${g}/apply`, c => exclusive(async () => {
    const b = await body(c, applyBody);
    writable(b.month);
    await freshSync(store);
    const { plan, snap } = await load(b.month);
    const later = await laterToBudgets(b.month);
    const byId = new Map(snap.categories.map(x => [x.id, x]));
    const excluded = new Set(plan.categories.filter(x => x.kind === 'excluded').map(x => x.categoryId));
    const bad = Object.keys(b.amounts).filter(id => {
      const cat = byId.get(id);
      return !cat || cat.hidden || cat.isIncome || excluded.has(id);
    });
    if (bad.length) {
      throw new ApiError(400, 'bad_category', `not fundable (unknown, excluded, income or hidden): ${bad.join(', ')}`);
    }
    if (b.proposalId !== proposalId(snap, later)) {
      throw new ApiError(409, 'stale_proposal', 'To budget or a budgeted amount changed since the proposal; propose again');
    }
    const added = Object.entries(b.amounts).map(([id, shekel]) => ({ cat: byId.get(id)!, added: toMinor(shekel) }));
    const total = added.reduce((s, a) => s + a.added, 0);
    const short = fundingShortfall(snap, later, added);
    if (short.now > 0 || short.later > 0) {
      throw new ApiError(400, 'over_available', `adds ${money(total).formatted} but only ${money(availableFor(snap, later)).formatted} is available`
        + ` beyond covering this month's overspending (short ${money(Math.max(short.now, short.later)).formatted})`);
    }
    const absolute = Object.fromEntries(added.map(a => [a.cat.id, a.cat.budgeted + a.added]));
    const entry = { op: 'apply', month: b.month, approvedBy: b.approvedBy, amounts: absolute, added: Object.fromEntries(added.map(a => [a.cat.id, a.added])) };
    await guardedWrite(b.month, absolute, entry);
    budget.journal(entry, now());
    await push();
    return c.json({ month: b.month,
      applied: added.map(a => ({ categoryId: a.cat.id, label: a.cat.label, added: money(a.added), budgeted: money(a.cat.budgeted + a.added) })),
      toBudget: money(snap.toBudget - total) });
  }));

  app.post(`${g}/move`, c => exclusive(async () => {
    const b = await body(c, moveBody);
    writable(b.month);
    await freshSync(store);
    const { plan, snap } = await load(b.month);
    const byId = new Map(snap.categories.map(x => [x.id, x]));
    const planOf = new Map(plan.categories.map(x => [x.categoryId, x]));
    const usable = (id: string) => {
      const cat = byId.get(id);
      return cat && !cat.hidden && !cat.isIncome && planOf.get(id)?.kind !== 'excluded' ? cat : undefined;
    };
    const from = byId.get(b.from);
    if (!from || from.hidden || from.isIncome) throw new ApiError(400, 'bad_category', `unknown source category ${b.from}`);
    const fromPlan = planOf.get(b.from);
    if (!fromPlan) {
      throw new ApiError(400, 'protected_source', `${from.label} is not in the plan and cannot fund moves; add it to the plan first`);
    }
    if (fromPlan.protected || fromPlan.kind === 'excluded') {
      throw new ApiError(400, 'protected_source', `${from.label} is ${fromPlan.kind === 'excluded' ? 'excluded' : 'protected'} and cannot fund moves`);
    }
    const to = usable(b.to);
    if (!to) throw new ApiError(400, 'bad_category', `destination ${b.to} is unknown, excluded, income or hidden`);
    if (from.id === to.id) throw new ApiError(400, 'bad_request', 'from and to are the same category');
    const amount = toMinor(b.amount);
    if (amount > from.balance) {
      throw new ApiError(400, 'insufficient_balance', `${from.label} holds ${money(from.balance).formatted}, cannot move ${money(amount).formatted}`);
    }
    const amounts = { [from.id]: from.budgeted - amount, [to.id]: to.budgeted + amount };
    const entry = { op: 'move', month: b.month, approvedBy: b.approvedBy, from: from.id, to: to.id, amount, amounts };
    await guardedWrite(b.month, amounts, entry);
    budget.journal(entry, now());
    await push();
    const out = (cat: typeof from, delta: number) => ({ id: cat.id, label: cat.label,
      budgeted: money(cat.budgeted + delta), balance: money(cat.balance + delta) });
    return c.json({ month: b.month, from: out(from, -amount), to: out(to, amount) });
  }));

  app.get(`${g}/summary`, async c => {
    const month = monthSchema.parse(c.req.query('month'));
    await freshSync(store);
    const current = currentMonth(now());
    const { plan } = await load(current);
    if (!dataMonth(month, await store.firstTransactionMonth(), current)) {
      throw new ApiError(404, 'no_data', `no budget data for ${month}`);
    }
    const s = summarize(plan, await store.budgetMonth(month), await store.monthTotals(month));
    const split = (x: typeof s.budgeted) => ({ lines: money(x.lines), outside: money(x.outside), total: money(x.total) });
    return c.json({ month, partial: month === current, carryOverIn: money(s.carryOverIn), income: money(s.income),
      lastMonthOverspent: money(s.lastMonthOverspent), budgeted: split(s.budgeted), spent: split(s.spent),
      toBudget: money(s.toBudget), heldForNextMonth: money(s.heldForNextMonth), carryOverOut: money(s.carryOverOut),
      uncategorized: await uncategorizedOf(month, await offBudgetIds()) });
  });

  app.get(`${g}/history`, async c => {
    const month = monthSchema.parse(c.req.query('month'));
    const only = c.req.query('categoryId');
    await freshSync(store);
    const current = currentMonth(now());
    const { plan, snap: live } = await load(current);
    const ids = lineIds(plan);
    // One refusal for excluded, unplanned and unknown ids, so the answer never says which an id is.
    if (only !== undefined && !ids.has(only)) throw new ApiError(400, 'bad_category', 'not a line of this budget');
    const labels = new Map(live.categories.filter(x => ids.has(x.id)).map(x => [x.id, x.label]));
    const shown = only === undefined ? [...ids] : [only];
    const first = await store.firstTransactionMonth();
    const off = await offBudgetIds();
    const journal = budget.writes();
    const months = [];
    const missingMonths: string[] = [];
    for (const m of Array.from({ length: HISTORY_MONTHS }, (_, i) => addMonths(month, i + 1 - HISTORY_MONTHS))) {
      if (!dataMonth(m, first, current)) {
        missingMonths.push(m);
        continue;
      }
      const snap = await store.budgetMonth(m);
      const before = previousMonth(m);
      const prev = dataMonth(before, first, current) ? await store.budgetMonth(before) : null;
      const lines = shown.map(id => {
        const budgeted = lineMonth(snap, id).budgeted;
        return { categoryId: id, label: labels.get(id)!, budgeted: money(budgeted),
          change: prev ? money(budgeted - lineMonth(prev, id).budgeted) : null };
      });
      const changes = lineChanges(journal, labels, m, only)
        .map(e => ({ ...e, lines: e.lines.map(l => ({ label: l.label, change: money(l.change) })) }));
      const head = { month: m, partial: m === current, firstMonth: m === first, lines };
      if (only !== undefined) {
        months.push({ ...head, changes });
        continue;
      }
      const { budgeted } = summarize(plan, snap, await store.monthTotals(m));
      months.push({ ...head, outside: money(budgeted.outside), total: money(budgeted.total),
        uncategorized: await uncategorizedOf(m, off), changes });
    }
    return c.json({ months, missingMonths, note: HISTORY_NOTE });
  });

  app.get(`${g}/runway`, async c => {
    await freshSync(store);
    const month = currentMonth(now());
    const { plan, snap } = await load(month);
    if (!countedSources(plan).length) {
      throw new ApiError(409, 'no_income_sources', 'the plan has no income source that is not a fixed transfer');
    }
    const averaged = [-3, -2, -1].map(n => addMonths(month, n));
    // The month of the first transaction may be partial, so it is never averaged.
    const first = await store.firstTransactionMonth();
    if (first === null || first >= averaged[0]!) {
      throw new ApiError(409, 'not_enough_history', `needs three complete months of data before ${month}`);
    }
    const past = [];
    for (const m of averaged) past.push({ month: m, rows: await monthRowsAll(m) });
    const r = runway({ plan, snap, totals: await store.monthTotals(month), past, currentRows: await monthRowsAll(month),
      offbudget: await offBudgetIds() });
    return c.json({ ...r, monthlyPlan: money(r.monthlyPlan),
      plannedLines: r.plannedLines.map(l => ({ ...l, monthly: money(l.monthly) })), averageIncome: money(r.averageIncome),
      incomeMonths: r.incomeMonths.map(x => ({ month: x.month, regular: x.regular.map(s => ({ ...s, amount: money(s.amount) })),
        regularTotal: money(x.regularTotal), other: money(x.other) })),
      gap: money(r.gap), available: money(r.available),
      carryOver: { carryOverOut: money(r.carryOver.carryOverOut), negativeBalances: money(r.carryOver.negativeBalances),
        stillNeeded: money(r.carryOver.stillNeeded) },
      shortfall: r.shortfall === null ? null : money(r.shortfall),
      notes: r.notes.map(({ amount, ...n }) => ({ ...n, ...(amount === undefined ? {} : { amount: money(amount) }) })) });
  });

  app.get(`${g}/status`, async c => {
    const month = monthParam(c);
    await store.sync();
    const { plan, snap } = await load(month);
    const today = jerusalemToday(now());
    const lines = pace(plan, snap, today);
    const moves = month < currentMonth(now()) ? [] : suggestMoves(plan, lines, today, availableFor(snap, await laterToBudgets(month)));
    // Income events look 35 days back from today, plus the queried month, plus always the previous
    // month (for the transfer check). Row ids are the event ids, so overlapping windows never duplicate an event.
    // A past month also reads the first days of the next one: a late transfer landing there still settles it.
    const viewed: [string, string] = month < currentMonth(now()) ? [`${month}-01`, dayBefore(`${month}-${daysInMonth(month)}`, -GRACE_DAYS)] : monthRange(month);
    const ranges: [string, string][] = [[dayBefore(today, INCOME_WINDOW_DAYS), today], viewed];
    ranges.push(monthRange(previousMonth(month))); // a row in the first days of this month may settle the previous month's transfer instead
    const income = await incomeRows(ranges);
    const reviewIds = (await store.transactions({ from: day30Before(today), to: today, tag: 'review', limit: 10_000 })).map(r => r.id);
    const firstSaved = budget.firstSavedAt();
    const planSince = firstSaved ? jerusalemToday(firstSaved) : undefined;
    const off = offPlan(plan, snap);
    const events = buildEvents({ plan, month, today, income, lines, reviewIds, unplanned: off.unplanned, acked: budget.state().acked,
      ...(planSince ? { planSince } : {}) });
    const sum = (f: (l: PaceLine) => number) => lines.reduce((s, l) => s + f(l), 0);
    return c.json({ month, today,
      totals: { budgeted: money(sum(l => l.budgeted)), spent: money(sum(l => l.spent)), balance: money(sum(l => l.balance)) },
      lines: lines.map(moneyPace), moves: moves.map(moneyMove), events: events.map(moneyEvent),
      unplanned: off.unplanned.map(moneyOff), excluded: off.excluded.map(moneyOff) });
  });

  app.post(`${g}/status/ack`, async c => {
    const { ids } = await body(c, ackBody);
    budget.ack(ids, now());
    return c.json({ acked: ids.length });
  });
}
