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
      const projected = c.kind === 'variable' ? spent + Math.round((cat.budgeted * (D - d)) / D) : spent;
      let status: PaceStatus = 'ok';
      if (cat.budgeted === 0 && spent === 0) {
        status = 'ok';
      } else if (cat.balance < 0) {
        status = 'off';
      } else if (c.kind === 'variable') {
        if (d >= t.projectFromDay && projected - cat.budgeted >= (t.offPct / 100) * cat.budgeted) status = 'off';
        else if (spent > expected * (1 + t.watchPct / 100) && spent - expected >= t.watchMin * 100) status = 'watch';
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

/** `today` is unused: slack comes from each line's expectedByToday, which pace() computed for the snapshot's own month. Kept for the declared interface. */
export function suggestMoves(plan: Plan, lines: PaceLine[], _today: string): Move[] {
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
    let rest = Math.max(-off.balance, off.projected - off.budgeted);
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
