// How long the money already in the budget covers the gap between the plan and regular income. An estimate, in minor
// units, and it says what it leaves out. Spec: ausie docs/superpowers/specs/2026-11-27-finance-income-gap-tools-design.md §4.
import type { CuratorRow } from '../actual/types.ts';
import { addMonths } from './dates.ts';
import { incomeStatus, matchIncome } from './events.ts';
import { lineIds, summarize, uncategorized } from './ledger.ts';
import { plannedAmount } from './propose.ts';
import type { IncomeSource, MonthSnapshot, MonthTotals, Plan } from './types.ts';

/** The sources the runway counts: a fixed transfer is the household's own savings, not income. */
export const countedSources = (plan: Plan): IncomeSource[] => plan.incomeSources.filter(s => !s.fixedTransfer);

export type RegularIncome = {
  regular: { source: string; amount: number }[]; regularTotal: number;
  /** Income-category money that is not counted. Never averaged. */
  other: number;
};

export function regularIncome(plan: Plan, rows: CuratorRow[], incomeCategoryIds: Set<string>, offbudget: Set<string>): RegularIncome {
  const bySource = new Map(countedSources(plan).map(s => [s, 0]));
  let other = 0;
  for (const r of rows) {
    if (offbudget.has(r.account)) continue;
    // A row takes the first source it matches, as incomeStatus does.
    const source = plan.incomeSources.find(s => matchIncome(s, r));
    if (source && bySource.has(source)) bySource.set(source, bySource.get(source)! + r.amount);
    else if (r.category !== null && incomeCategoryIds.has(r.category)) other += r.amount;
  }
  const regular = [...bySource].map(([s, amount]) => ({ source: s.name, amount }));
  return { regular, regularTotal: regular.reduce((s, x) => s + x.amount, 0), other };
}

export type RunwayNote = { effect: 'less' | 'longer' | 'always'; text: string; amount?: number };

export type RunwayInput = {
  plan: Plan; snap: MonthSnapshot; totals: MonthTotals;
  /** The three complete months before `snap.month`, oldest first. */
  past: { month: string; rows: CuratorRow[] }[];
  currentRows: CuratorRow[]; offbudget: Set<string>;
};

export function runway({ plan, snap, totals, past, currentRows, offbudget }: RunwayInput) {
  const month = snap.month;
  const ids = lineIds(plan);
  const byId = new Map(snap.categories.map(c => [c.id, c]));
  const lines = plan.categories.filter(c => ids.has(c.categoryId)).map(c => ({ c, cat: byId.get(c.categoryId)! }));

  const plannedLines: { categoryId: string; label: string; monthly: number }[] = [];
  const oneOffs: { label: string; due: string }[] = [];
  let stillNeeded = 0;
  for (const { c, cat } of lines) {
    const planned = plannedAmount(c, cat, month);
    // What the line still needs this month. An overspend is left out: negativeBalances already takes it.
    const overspent = Math.max(0, -cat.balance);
    stillNeeded += Math.max(0, planned - cat.budgeted, overspent) - overspent;
    // A set-aside due this month or earlier is a one-off, taken once through stillNeeded.
    if (c.kind === 'setaside' && c.due! <= month) oneOffs.push({ label: cat.label, due: c.due! });
    else plannedLines.push({ categoryId: c.categoryId, label: cat.label, monthly: planned });
  }
  const monthlyPlan = plannedLines.reduce((s, l) => s + l.monthly, 0);

  const incomeIds = new Set(snap.categories.filter(c => c.isIncome).map(c => c.id));
  const incomeMonths = past.map(p => ({ month: p.month, ...regularIncome(plan, p.rows, incomeIds, offbudget) }));
  const averageIncome = Math.round(incomeMonths.reduce((s, x) => s + x.regularTotal, 0) / incomeMonths.length);
  const gap = monthlyPlan - averageIncome;

  const { carryOverOut } = summarize(plan, snap, totals);
  // Cash already spent, rollover or not.
  const negativeBalances = snap.categories.filter(c => !c.isIncome).reduce((s, c) => s + Math.max(0, -c.balance), 0);
  const available = carryOverOut - negativeBalances - stillNeeded;

  const status = available <= 0 ? 'short_now' as const : gap <= 0 ? 'no_gap' as const : 'limited' as const;
  const count = status === 'short_now' ? { months: 0, wholeMonths: 0 }
    : status === 'no_gap' ? { months: null, wholeMonths: null }
    // Rounded down: never promise a month the money does not cover.
    : { months: Math.floor(available * 10 / gap) / 10, wholeMonths: Math.floor(available / gap) };
  const lastCoveredMonth = count.wholeMonths ? addMonths(month, count.wholeMonths) : null;

  const notes: RunwayNote[] = [{ effect: 'less', text: "Spending outside the plan's lines is not in the monthly gap." }];
  const loose = [...past.map(p => p.rows), currentRows].reduce((s, rows) => s + uncategorized(rows, offbudget).out, 0);
  if (loose > 0) notes.push({ effect: 'less', text: 'Uncategorized spending is not deducted.', amount: loose });
  for (const s of incomeStatus(plan, month, currentRows.filter(r => !offbudget.has(r.account))).expected) {
    if (!s.fixedTransfer) notes.push({ effect: 'longer', text: `Expected income "${s.name}" has not landed this month and is not counted.` });
  }
  if (lines.some(l => l.cat.balance > 0)) notes.push({ effect: 'longer', text: 'Money already in category balances is not counted.' });
  notes.push({ effect: 'always', text: 'The plan and its income sources are used as saved: a line or source that has ended or not started counts as written. Savings outside Actual are not counted.' });

  return {
    month, status, monthlyPlan, plannedLines, oneOffs, averageIncome, incomeMonths, gap, available,
    carryOver: { carryOverOut, negativeBalances, stillNeeded },
    shortfall: available < 0 ? -available : null, ...count, lastCoveredMonth, notes,
  };
}
