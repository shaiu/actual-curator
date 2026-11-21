import { daysInMonth } from './dates.ts';
import { checkPlan, plannedAmount } from './propose.ts';
import type { Kind, MonthSnapshot, Plan } from './types.ts';

export type PaceStatus = 'ok' | 'watch' | 'off';
/** Amounts in minor units; `spent` is positive. `projected` is only a projection for variable kinds; for fixed and setaside it is just `spent`. */
export type PaceLine = {
  categoryId: string; label: string; kind: Kind; budgeted: number; spent: number;
  balance: number; expectedByToday: number; projected: number; status: PaceStatus;
};
export type Move = { from: string; fromLabel: string; to: string; toLabel: string; amount: number };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Day of the snapshot month that `today` stands at: 0 for a future month, D for a past one. */
function dayIn(month: string, today: string): number {
  const m = today.slice(0, 7);
  if (m < month) return 0;
  if (m > month) return daysInMonth(month);
  return Number(today.slice(8, 10));
}

export function pace(plan: Plan, snap: MonthSnapshot, today: string): PaceLine[] {
  checkPlan(plan, snap);
  const byId = new Map(snap.categories.map((c) => [c.id, c]));
  const D = daysInMonth(snap.month);
  const d = dayIn(snap.month, today);
  const t = plan.thresholds;
  return plan.categories
    .filter((c) => c.kind !== 'excluded')
    .map((c) => ({ c, cat: byId.get(c.categoryId)! }))
    .sort((x, y) => x.c.priority - y.c.priority || cmp(x.cat.label, y.cat.label))
    .map(({ c, cat }): PaceLine => {
      const spent = -cat.spent;
      const expected = Math.round((cat.budgeted * d) / D);
      // Month-end figure if the rest of the month runs at plan. (spent*D/d would make projected/budgeted equal spent/expected, so `off` would always pre-empt `watch`.)
      // Spending that the carried-over balance already covers is not overspend, so it is netted out of the excess (ruling R7).
      const carryIn = cat.balance - cat.budgeted - cat.spent;
      const effExcess = spent - expected - Math.max(0, carryIn);
      const projected = c.kind === 'variable' ? spent + Math.round((cat.budgeted * (D - d)) / D) : spent;
      let status: PaceStatus = 'ok';
      if (cat.budgeted === 0 && spent === 0) {
        status = 'ok';
      } else if (cat.balance < 0) {
        status = 'off';
      } else if (c.kind === 'variable') {
        if (d >= t.projectFromDay && effExcess >= (t.offPct / 100) * cat.budgeted) status = 'off';
        else if (effExcess > (expected * t.watchPct) / 100 && effExcess >= t.watchMin * 100) status = 'watch';
      } else if (c.kind === 'setaside') {
        if (d >= 20 && cat.budgeted < plannedAmount(c, cat, snap.month)) status = 'watch';
      }
      return {
        categoryId: c.categoryId, label: cat.label, kind: c.kind, budgeted: cat.budgeted, spent,
        balance: cat.balance, expectedByToday: expected, projected, status,
      };
    });
}

const TEN_SHEKEL = 1000;

/**
 * `today` is unused: slack comes from each line's expectedByToday, which pace() computed for the snapshot's own month.
 * `free` is money with no job yet (the proposal's `available`): it covers shortfalls first, and a move is suggested only
 * for what it cannot cover. Taking from another line while money sits unassigned was the 2026-11-21 confusion.
 */
export function suggestMoves(plan: Plan, lines: PaceLine[], _today: string, free = 0): Move[] {
  let unassigned = Math.max(0, free);
  const protectedIds = new Set(plan.categories.filter((c) => c.protected).map((c) => c.categoryId));
  const slack = new Map<string, number>();
  for (const l of lines) {
    if (l.kind !== 'variable' || l.status !== 'ok' || protectedIds.has(l.categoryId)) continue;
    const s = l.balance - (l.budgeted - l.expectedByToday);
    if (s > 0) slack.set(l.categoryId, s);
  }
  const label = new Map(lines.map((l) => [l.categoryId, l.label]));
  const moves: Move[] = [];
  for (const off of lines.filter((l) => l.status === 'off')) {
    const carryIn = off.balance - off.budgeted + off.spent;
    let rest = Math.max(-off.balance, off.projected - off.budgeted - Math.max(0, carryIn));
    const fromFree = Math.min(unassigned, Math.max(0, rest));
    unassigned -= fromFree;
    rest -= fromFree;
    const sources = [...slack].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
    for (const [id, s] of sources) {
      if (rest <= 0) break;
      const take = Math.min(s, Math.ceil(Math.min(s, rest) / TEN_SHEKEL) * TEN_SHEKEL);
      moves.push({ from: id, fromLabel: label.get(id)!, to: off.categoryId, toLabel: off.label, amount: take });
      slack.set(id, s - take);
      rest -= take;
    }
  }
  return moves;
}

/** A category with activity this month that the plan does not track. Amounts in minor units; `spent` is positive. */
export type OffPlanLine = { categoryId: string; label: string; spent: number; balance: number };

/**
 * Visible expense categories with spending or a negative balance this month that the plan does not track
 * (`unplanned`), and the plan's `excluded` ones with activity. Their overspending still leaves next month's
 * To budget, so a page or a message that shows only plan lines hides real money (2026-11-21: seven such
 * categories held -22,960.83 with no line anywhere). Largest spend first.
 */
export function offPlan(plan: Plan, snap: MonthSnapshot): { unplanned: OffPlanLine[]; excluded: OffPlanLine[] } {
  const kind = new Map(plan.categories.map((c) => [c.categoryId, c.kind]));
  const unplanned: OffPlanLine[] = [];
  const excluded: OffPlanLine[] = [];
  for (const c of snap.categories) {
    if (c.hidden || c.isIncome || (c.spent === 0 && c.balance >= 0)) continue;
    const k = kind.get(c.id);
    if (k !== undefined && k !== 'excluded') continue;
    (k === 'excluded' ? excluded : unplanned).push({ categoryId: c.id, label: c.label, spent: -c.spent, balance: c.balance });
  }
  const order = (a: OffPlanLine, b: OffPlanLine) => b.spent - a.spent || cmp(a.label, b.label);
  return { unplanned: unplanned.sort(order), excluded: excluded.sort(order) };
}
