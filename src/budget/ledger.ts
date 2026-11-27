// Read-only facts about a month, in minor units. The rule every figure follows: the plan's lines are shown one by one,
// and everything else is one combined figure with no names, ids or rows.
import type { CuratorRow } from '../actual/types.ts';
import type { JournalEntry } from './plan-store.ts';
import type { MonthSnapshot, MonthTotals, Plan } from './types.ts';

export const OUTSIDE = "outside the plan's lines";

/** The plan's lines: every category whose kind is not excluded. */
export const lineIds = (plan: Plan): Set<string> =>
  new Set(plan.categories.filter(c => c.kind !== 'excluded').map(c => c.categoryId));

/** Actual also makes empty months before the first transaction and after today; those hold no data. */
export const dataMonth = (month: string, first: string | null, current: string): boolean =>
  first !== null && first <= month && month <= current;

/** One line's figures in a snapshot. A line the month does not have, or has hidden, is 0. */
export function lineMonth(snap: MonthSnapshot, id: string): { budgeted: number; spent: number } {
  const c = snap.categories.find(x => x.id === id && !x.hidden && !x.isIncome);
  return { budgeted: c?.budgeted ?? 0, spent: c ? 0 - c.spent : 0 };
}

export function summarize(plan: Plan, snap: MonthSnapshot, totals: MonthTotals) {
  const lines = [...lineIds(plan)].map(id => lineMonth(snap, id));
  /** The totals are Actual's own, so lines plus outside is always the total. */
  const split = (key: 'budgeted' | 'spent') => {
    const own = lines.reduce((s, l) => s + l[key], 0);
    return { lines: own, outside: totals[key] - own, total: totals[key] };
  };
  const carryOverOut = totals.carryOverIn + totals.income + totals.lastMonthOverspent - totals.budgeted;
  return {
    carryOverIn: totals.carryOverIn, income: totals.income, lastMonthOverspent: totals.lastMonthOverspent,
    budgeted: split('budgeted'), spent: split('spent'), toBudget: totals.toBudget,
    // Derived, because the API reports only the manual hold while Actual's formula also uses an automatic one.
    heldForNextMonth: carryOverOut - totals.toBudget, carryOverOut,
  };
}

/** On-budget, non-transfer rows with no category: in none of Actual's totals. Both figures are positive. */
export function uncategorized(rows: CuratorRow[], offbudget: Set<string>): { in: number; out: number } {
  const out = { in: 0, out: 0 };
  for (const r of rows) {
    if (r.category !== null || r.transferId !== null || offbudget.has(r.account)) continue;
    if (r.amount > 0) out.in += r.amount;
    else out.out -= r.amount;
  }
  return out;
}

export type LineChange = {
  at: string; op: JournalEntry['op']; by: string; unconfirmed: boolean;
  lines: { label: string; change: number }[]; counterpart: string | null;
};

/** The curator's own writes for `month`, reduced to the plan's lines. `only` narrows it to one line. */
export function lineChanges(entries: JournalEntry[], lines: Map<string, string>, month: string, only?: string): LineChange[] {
  const out: LineChange[] = [];
  for (const e of entries) {
    if (e.month !== month) continue;
    const sides: [id: string, change: number][] = e.op === 'move'
      ? [[e.from, -e.amount], [e.to, e.amount]]
      : Object.entries(e.added);
    const mine = sides.filter(([id]) => lines.has(id));
    if (!mine.length || (only !== undefined && !mine.some(([id]) => id === only))) continue;
    out.push({
      at: e.at, op: e.op, by: e.approvedBy, unconfirmed: e.outcome === 'unconfirmed',
      lines: mine.filter(([id]) => only === undefined || id === only).map(([id, change]) => ({ label: lines.get(id)!, change })),
      counterpart: mine.length < sides.length ? OUTSIDE : null,
    });
  }
  return out;
}
