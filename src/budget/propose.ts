import { createHash } from 'node:crypto';
import { monthsBetween } from './dates.ts';
import type { CategoryMonth, Kind, MonthSnapshot, Plan, PlanCategory } from './types.ts';

export class PlanError extends Error {
  readonly code: 'no_plan' | 'stale_plan';
  constructor(code: 'no_plan' | 'stale_plan', message: string) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

/** Throws PlanError('stale_plan') naming every plan categoryId missing from the snapshot or hidden. */
export function checkPlan(plan: Plan, snap: MonthSnapshot): void {
  const live = new Map(snap.categories.map((c) => [c.id, c]));
  const stale = plan.categories.filter((c) => {
    const s = live.get(c.categoryId);
    return !s || s.hidden;
  }).map((c) => c.categoryId);
  if (stale.length > 0) {
    throw new PlanError('stale_plan', `plan categories missing or hidden in Actual: ${stale.join(', ')}`);
  }
}

/** Throws PlanError('stale_plan') naming every income source whose `account` is not an open on-budget account id. */
export function checkAccounts(plan: Plan, accounts: { id: string; name: string; offbudget: boolean; closed?: boolean }[]): void {
  const ok = new Set(accounts.filter((a) => !a.offbudget && !a.closed).map((a) => a.id));
  const bad = plan.incomeSources.filter((s) => s.account !== undefined && !ok.has(s.account));
  if (bad.length > 0) {
    const ids = accounts.filter((a) => ok.has(a.id)).map((a) => `${a.name}=${a.id}`).join(', ');
    throw new PlanError('stale_plan',
      `income source account must be an on-budget account id, got ${bad.map((s) => `${s.name}: ${s.account}`).join('; ')}. Ids: ${ids}`);
  }
}

export type ProposalLine = {
  categoryId: string; label: string; kind: Kind; priority: number;
  /** `covers`: the part of `propose` that funds this month's overspending, which later months already lost. */
  planned: number; budgeted: number; propose: number; unfunded: number; covers: number; // minor
};
export type Proposal = {
  month: string; proposalId: string; available: number; proposed: number; remaining: number;
  /** The part of `proposed` that covers overspending; it is not taken from `available`. */
  coversOverspend: number; lines: ProposalLine[];
};

/** This month's overspending in a category that next month's To budget already lost (none with carryover). */
export const overspendOf = (cat: CategoryMonth): number => (cat.balance < 0 && !cat.carryover ? -cat.balance : 0);

/**
 * Whether adding `adds` to `snap.month` double-spends. Every shekel comes out of this month's To budget. A later
 * month already lost this month's uncovered overspending, so covering it costs that month nothing; only the rest
 * comes out of `min(later)`. Returns the shortfall of each budget (0 when it fits).
 */
export function fundingShortfall(snap: MonthSnapshot, later: number[], adds: { cat: CategoryMonth; added: number }[]):
  { now: number; later: number } {
  const total = adds.reduce((s, a) => s + a.added, 0);
  const fresh = adds.reduce((s, a) => s + Math.max(0, a.added - Math.min(Math.max(0, a.added), overspendOf(a.cat))), 0);
  const freeLater = later.length ? Math.min(...later) : Infinity;
  return { now: Math.max(0, total - snap.toBudget), later: Math.max(0, fresh - Math.max(0, freeLater)) };
}

/** The month's planned amount for one plan category (minor units); used by propose and by pace. */
export function plannedAmount(c: PlanCategory, cat: CategoryMonth, month: string): number {
  switch (c.kind) {
    case 'fixed':
    case 'variable':
      return Math.round((c.amount ?? 0) * 100);
    case 'setaside': {
      const months = Math.max(1, monthsBetween(month, c.due ?? month));
      const carryIn = cat.balance - cat.budgeted - cat.spent;
      return Math.max(0, Math.ceil((Math.round((c.target ?? 0) * 100) - carryIn) / months));
    }
    case 'excluded':
      return 0;
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What can still be given to `snap.month` without double-spending. In Actual's envelope model a later month's
 * To budget includes this month's leftover, so money already given to a later month is no longer free here.
 * `later` holds the toBudget of every later month with budget data, in month order.
 */
export const availableFor = (snap: MonthSnapshot, later: number[] = []): number => Math.min(snap.toBudget, ...later);

/** sha256 of month + toBudget + every later month's toBudget + every category's budgeted, sorted by id; first 12 hex chars. */
export function proposalId(snap: MonthSnapshot, later: number[] = []): string {
  const cats = [...snap.categories].sort((a, b) => cmp(a.id, b.id))
    .map((c) => `${c.id}:${c.budgeted}`);
  return createHash('sha256').update([snap.month, snap.toBudget, `later:${later.join(',')}`, ...cats].join('|'))
    .digest('hex').slice(0, 12);
}

export function propose(plan: Plan, snap: MonthSnapshot, later: number[] = []): Proposal {
  checkPlan(plan, snap);
  const byId = new Map(snap.categories.map((c) => [c.id, c]));
  const entries = plan.categories
    .filter((c) => c.kind !== 'excluded')
    .map((c) => ({ c, cat: byId.get(c.categoryId)! }))
    .sort((x, y) => x.c.priority - y.c.priority || cmp(x.cat.label, y.cat.label));

  const available = availableFor(snap, later);
  // Two budgets: this month's To budget pays for everything; later months pay only for what does not cover overspending.
  let now = snap.toBudget;
  let free = later.length ? Math.min(...later) : Infinity;
  const lines: ProposalLine[] = entries.map(({ c, cat }) => {
    const planned = plannedAmount(c, cat, snap.month);
    // Up to the plan, and never less than what brings an overspent line back to zero: the overspend is
    // money already gone, and leaving it uncovered only moves it into next month's To budget.
    const need = Math.max(0, planned - cat.budgeted, -cat.balance);
    const cover = overspendOf(cat);
    const give = Math.max(0, Math.min(need, now, cover + Math.max(0, free)));
    const covers = Math.min(give, cover);
    now -= give;
    free -= give - covers;
    return {
      categoryId: c.categoryId, label: cat.label, kind: c.kind, priority: c.priority,
      planned, budgeted: cat.budgeted, propose: give, unfunded: need - give, covers,
    };
  });
  return {
    month: snap.month, proposalId: proposalId(snap, later), available,
    proposed: lines.reduce((s, l) => s + l.propose, 0), remaining: Math.min(now, free),
    coversOverspend: lines.reduce((s, l) => s + l.covers, 0), lines,
  };
}
