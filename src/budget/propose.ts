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

export type ProposalLine = {
  categoryId: string; label: string; kind: Kind; priority: number;
  planned: number; budgeted: number; propose: number; unfunded: number; // minor
};
export type Proposal = {
  month: string; proposalId: string; available: number; proposed: number; remaining: number; lines: ProposalLine[];
};

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
  let remaining = available;
  const lines: ProposalLine[] = entries.map(({ c, cat }) => {
    const planned = plannedAmount(c, cat, snap.month);
    const need = Math.max(0, planned - cat.budgeted);
    const give = Math.min(need, Math.max(0, remaining));
    remaining -= give;
    return {
      categoryId: c.categoryId, label: cat.label, kind: c.kind, priority: c.priority,
      planned, budgeted: cat.budgeted, propose: give, unfunded: need - give,
    };
  });
  return {
    month: snap.month, proposalId: proposalId(snap, later), available,
    proposed: lines.reduce((s, l) => s + l.propose, 0), remaining, lines,
  };
}
