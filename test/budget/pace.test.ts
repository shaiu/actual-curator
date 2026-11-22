import { describe, expect, it } from 'vitest';
import { planSchema, type CategoryMonth, type MonthSnapshot, type PlanInput } from '../../src/budget/types.ts';
import { PlanError } from '../../src/budget/propose.ts';
import { offPlan, pace, suggestMoves, type PaceLine } from '../../src/budget/pace.ts';

const cat = (id: string, o: Partial<CategoryMonth> = {}): CategoryMonth => ({
  id, label: id, hidden: false, isIncome: false, budgeted: 0, spent: 0, balance: 0, ...o,
});
const snap = (categories: CategoryMonth[], month = '2026-11'): MonthSnapshot => ({ month, toBudget: 0, categories });
const plan = (categories: PlanInput['categories']) => planSchema.parse({ version: 1, categories, incomeSources: [] });
const NIS = (n: number) => n * 100;
/** A category with budget b, spent s (shekels, positive). */
const c = (id: string, b: number, s: number, o: Partial<CategoryMonth> = {}) =>
  cat(id, { budgeted: NIS(b), spent: -NIS(s), balance: NIS(b - s), ...o });
const vplan = plan([{ categoryId: 'dining', kind: 'variable', priority: 1, amount: 2800 }]);
const status = (b: number, s: number, today: string) =>
  pace(vplan, snap([c('dining', b, s)]), today)[0]!;

describe('pace', () => {
  it('variable on track is ok', () => {
    expect(status(2800, 1400, '2026-11-15').status).toBe('ok');
  });

  it('variable ahead is watch', () => {
    const l = status(2800, 1200, '2026-11-10');
    expect(l.expectedByToday).toBe(93333);
    expect(l.projected).toBe(120000 + 186667);
    expect(l.spent).toBe(120000);
    expect(l.status).toBe('watch');
  });

  it('projected overspend is off', () => {
    const l = status(2800, 1700, '2026-11-15');
    expect(l.projected).toBe(310000);
    expect(l.status).toBe('off');
  });

  it('day 2 large spend is watch at most', () => {
    expect(status(2800, 600, '2026-11-02').status).toBe('watch');
  });

  it('carried-over balance is not overspend: 3000 carry-in, 2800 budget, 3500 spent by day 20 is not off', () => {
    const carried = pace(vplan, snap([c('dining', 2800, 3500, { balance: NIS(2300) })]), '2026-11-20')[0]!;
    expect(carried.status).toBe('ok');
    // spending beyond carry-in plus the pace line still counts: effExcess = 5600 - 1866.67 - 3000 = 733.33
    const over = pace(vplan, snap([c('dining', 2800, 5600, { balance: NIS(200) })]), '2026-11-20')[0]!;
    expect(over.status).toBe('off');
    // day 10, spent 1200, expected 933.33: carry-in 100 leaves 166.67 (watch), carry-in 200 leaves 66.67 (ok)
    expect(pace(vplan, snap([c('dining', 2800, 1200, { balance: NIS(1700) })]), '2026-11-10')[0]!.status).toBe('watch');
    expect(pace(vplan, snap([c('dining', 2800, 1200, { balance: NIS(1800) })]), '2026-11-10')[0]!.status).toBe('ok');
  });

  it('projection starts at day 7: d=6 is watch at most, d=7 is off', () => {
    expect(status(2800, 1000, '2026-11-06').status).toBe('watch');
    expect(status(2800, 1000, '2026-11-07').status).toBe('off');
  });

  it('negative balance is off for every kind', () => {
    const p = plan([
      { categoryId: 'v', kind: 'variable', priority: 1, amount: 100 },
      { categoryId: 'f', kind: 'fixed', priority: 2, amount: 100 },
      { categoryId: 's', kind: 'setaside', priority: 3, target: 100, due: '2026-11' },
    ]);
    const lines = pace(p, snap([c('v', 100, 150), c('f', 100, 150), c('s', 100, 150)]), '2026-11-02');
    expect(lines.map((l) => l.status)).toEqual(['off', 'off', 'off']);
  });

  it('fixed bill fully spent early is ok', () => {
    const p = plan([{ categoryId: 'rent', kind: 'fixed', priority: 1, amount: 4000 }]);
    expect(pace(p, snap([c('rent', 4000, 4000)]), '2026-11-03')[0]!.status).toBe('ok');
  });

  it('budgeted 0 and spent 0 is ok for every kind', () => {
    const p = plan([
      { categoryId: 'v', kind: 'variable', priority: 1, amount: 0 },
      { categoryId: 'f', kind: 'fixed', priority: 2, amount: 0 },
      { categoryId: 's', kind: 'setaside', priority: 3, target: 500, due: '2027-06' },
    ]);
    expect(pace(p, snap([cat('v'), cat('f'), cat('s')]), '2026-11-25').map((l) => l.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('setaside is watch from day 20 when under-funded, ok when funded', () => {
    const p = plan([{ categoryId: 's', kind: 'setaside', priority: 1, target: 600, due: '2026-12' }]);
    expect(pace(p, snap([c('s', 100, 0)]), '2026-11-19')[0]!.status).toBe('ok');
    expect(pace(p, snap([c('s', 100, 0)]), '2026-11-20')[0]!.status).toBe('watch');
    expect(pace(p, snap([c('s', 300, 0)]), '2026-11-25')[0]!.status).toBe('ok');
  });

  it('future month uses d=0, past month d=D', () => {
    const fut = status(2800, 0, '2026-10-20');
    expect(fut.expectedByToday).toBe(0);
    expect(fut.projected).toBe(NIS(2800));
    expect(fut.status).toBe('ok');
    const past = pace(vplan, snap([c('dining', 2800, 3000)], '2026-10'), '2026-11-05')[0]!;
    expect(past.expectedByToday).toBe(NIS(2800));
    expect(past.projected).toBe(NIS(3000));
    expect(past.status).toBe('off');
  });

  it('skips excluded, orders by priority then label, throws stale_plan', () => {
    const p = plan([
      { categoryId: 'b', kind: 'variable', priority: 2, amount: 10 },
      { categoryId: 'a', kind: 'variable', priority: 2, amount: 10 },
      { categoryId: 'x', kind: 'excluded', priority: 1 },
      { categoryId: 'z', kind: 'fixed', priority: 1, amount: 10 },
    ]);
    const s = snap([cat('a'), cat('b'), cat('x'), cat('z')]);
    expect(pace(p, s, '2026-11-05').map((l) => l.categoryId)).toEqual(['z', 'a', 'b']);
    expect(() => pace(p, snap([cat('a')]), '2026-11-05')).toThrow(PlanError);
  });
});

describe('suggestMoves', () => {
  const p = plan([
    { categoryId: 'dining', kind: 'variable', priority: 1, amount: 2800 },
    { categoryId: 'fun', kind: 'variable', priority: 2, amount: 1000 },
    { categoryId: 'clothes', kind: 'variable', priority: 3, amount: 1000 },
    { categoryId: 'savings', kind: 'variable', priority: 4, amount: 1000, protected: true },
    { categoryId: 'biz', kind: 'excluded', priority: 5 },
  ]);
  const today = '2026-11-15';

  it('picks the largest-slack ok variable source, rounds up to 10, skips protected and excluded', () => {
    // dining overspent: spent 1700 of 2800 at day 15 -> shortfall 1700-1400 = 300
    const s = snap([
      c('dining', 2800, 1700), c('fun', 1000, 0), c('clothes', 1000, 300),
      c('savings', 1000, 0), cat('biz', { budgeted: NIS(500), balance: NIS(500) }),
    ]);
    const lines = pace(p, s, today);
    const moves = suggestMoves(p, lines, today);
    expect(moves).toEqual([
      { from: 'fun', fromLabel: 'fun', to: 'dining', toLabel: 'dining', amount: NIS(300) },
    ]);
  });

  it('rounds up to whole 10 shekels but never above the slack', () => {
    const s = snap([c('dining', 2800, 1707), c('fun', 1000, 0), c('clothes', 1000, 0), cat('savings'), cat('biz')]);
    const moves = suggestMoves(p, pace(p, s, today), today);
    expect(moves[0]!.amount).toBe(NIS(310)); // shortfall 307 -> 310
    const tight = snap([c('dining', 2800, 1707), c('fun', 1000, 0, { balance: 50050 }), cat('clothes'), cat('savings'), cat('biz')]);
    // fun slack = 50050 - 50000 = 50 -> 50 agorot cap, takes min(slack, rest) rounded up but capped at slack
    const m2 = suggestMoves(p, pace(p, tight, today), today);
    expect(m2[0]!.amount).toBe(50);
  });

  it('empty when no source has slack', () => {
    const s = snap([c('dining', 2800, 1700), c('fun', 1000, 500), c('clothes', 1000, 500), cat('savings'), cat('biz')]);
    expect(suggestMoves(p, pace(p, s, today), today)).toEqual([]);
  });

  it('shared sources: earlier moves reduce slack for later off lines', () => {
    const p2 = plan([
      { categoryId: 'a', kind: 'variable', priority: 1, amount: 1000 },
      { categoryId: 'b', kind: 'variable', priority: 2, amount: 1000 },
      { categoryId: 'src', kind: 'variable', priority: 3, amount: 1000 },
    ]);
    // a and b each spent 700 at day 15 -> shortfall 200 each; src slack 500 - 0 = 500
    const s = snap([c('a', 1000, 700), c('b', 1000, 700), c('src', 1000, 0)]);
    const moves = suggestMoves(p2, pace(p2, s, today), today);
    const total = moves.filter((m) => m.from === 'src').reduce((t, m) => t + m.amount, 0);
    expect(total).toBeLessThanOrEqual(NIS(500));
    expect(moves.map((m) => [m.to, m.amount])).toEqual([['a', NIS(200)], ['b', NIS(200)]]);
    // now only 300 of slack: second gets what is left
    const s2 = snap([c('a', 1000, 700), c('b', 1000, 700), c('src', 1000, 200)]);
    const m2 = suggestMoves(p2, pace(p2, s2, today), today);
    expect(m2.map((m) => [m.to, m.amount])).toEqual([['a', NIS(200)], ['b', NIS(100)]]);
  });

  it('slack is computed for the snapshot month, not today\'s month', () => {
    const p3 = plan([
      { categoryId: 'a', kind: 'variable', priority: 1, amount: 1000 },
      { categoryId: 'src', kind: 'variable', priority: 2, amount: 1000 },
    ]);
    // future month: nothing spent, balance == budgeted -> slack 0
    const flat = snap([c('a', 1000, 1200), c('src', 1000, 0)], '2026-12');
    expect(suggestMoves(p3, pace(p3, flat, '2026-11-15'), '2026-11-15')).toEqual([
    ]);
    // carry-in: balance 1400 vs budgeted 1000 -> slack 400
    const carry = snap([c('a', 1000, 1200), cat('src', { budgeted: NIS(1000), balance: NIS(1400) })], '2026-12');
    const m = suggestMoves(p3, pace(p3, carry, '2026-11-15'), '2026-11-15');
    expect(m).toEqual([{ from: 'src', fromLabel: 'src', to: 'a', toLabel: 'a', amount: NIS(400) }]);
  });

  it('shortfall nets out the carry-in: max(-balance, effExcess)', () => {
    const p4 = plan([
      { categoryId: 'a', kind: 'variable', priority: 1, amount: 1000 },
      { categoryId: 'src', kind: 'variable', priority: 2, amount: 1000 },
    ]);
    // a: budget 1000, carry-in 500, spent 1600 at day 15 -> balance -100, expected 500, effExcess 1600-500-500 = 600
    const s = snap([c('a', 1000, 1600, { balance: NIS(-100) }), cat('src', { budgeted: NIS(1000), balance: NIS(2100) })]);
    const m = suggestMoves(p4, pace(p4, s, today), today);
    expect(m).toEqual([{ from: 'src', fromLabel: 'src', to: 'a', toLabel: 'a', amount: NIS(600) }]);
  });

  it('a watch source is never a move source', () => {
    const lines = [
      { categoryId: 'a', label: 'a', kind: 'variable', budgeted: 100000, spent: 150000, balance: -50000, expectedByToday: 50000, projected: 200000, status: 'off' },
      { categoryId: 'w', label: 'w', kind: 'variable', budgeted: 100000, spent: 0, balance: 100000, expectedByToday: 50000, projected: 50000, status: 'watch' },
    ] as const;
    expect(suggestMoves(p, [...lines], today)).toEqual([]);
  });
});

describe('suggestMoves with free money (2026-11-21: moves were offered beside ₪16,864 unassigned)', () => {
  const p = planSchema.parse({ version: 1, incomeSources: [], categories: [
    { categoryId: 'gas', kind: 'variable', priority: 2, amount: 1000 },
    { categoryId: 'kv', kind: 'variable', priority: 2, amount: 55 },
  ] });
  const lines: PaceLine[] = [
    { categoryId: 'gas', label: 'Gas', kind: 'variable', budgeted: 100000, spent: 10000, balance: 90000, expectedByToday: 70000, projected: 40000, status: 'ok' },
    { categoryId: 'kv', label: 'Kvish6', kind: 'variable', budgeted: 5500, spent: 12700, balance: -7200, expectedByToday: 3850, projected: 12700, status: 'off' },
  ];
  it('free money covers the shortfall: no move', () => {
    expect(suggestMoves(p, lines, '2026-11-21', 1686400)).toEqual([]);
  });
  it('only what free money cannot cover becomes a move', () => {
    expect(suggestMoves(p, lines, '2026-11-21', 5000).map((m) => m.amount)).toEqual([3000]);
  });
  it('no free money behaves as before', () => {
    expect(suggestMoves(p, lines, '2026-11-21').map((m) => m.amount)).toEqual([7200 + 800]);
  });
});

describe('offPlan', () => {
  const p = planSchema.parse({ version: 1, incomeSources: [], categories: [
    { categoryId: 'groc', kind: 'variable', priority: 2, amount: 1000 },
    { categoryId: 'biz', kind: 'excluded', priority: 9 },
  ] });
  const c = (id: string, o: Partial<CategoryMonth> = {}): CategoryMonth =>
    ({ id, label: `G / ${id}`, hidden: false, isIncome: false, budgeted: 0, spent: 0, balance: 0, ...o });
  const s: MonthSnapshot = { month: '2026-11', toBudget: 0, categories: [
    c('groc', { spent: -50000, balance: -10000 }),
    c('auto', { spent: -292183, balance: -292183 }),
    c('usa', { spent: -337400, balance: -337400 }),
    c('quiet', { budgeted: 10000, balance: 10000 }),
    c('refund', { spent: 5000, balance: 5000 }),
    c('old', { spent: -100, balance: -100, hidden: true }),
    c('sal', { spent: 0, balance: -1, isIncome: true }),
    c('biz', { spent: -1576600, balance: -1576600 }),
  ] };
  it('lists categories with activity the plan does not track, largest spend first, and the excluded ones apart', () => {
    const r = offPlan(p, s);
    expect(r.unplanned.map((l) => l.categoryId)).toEqual(['usa', 'auto', 'refund']);
    expect(r.unplanned[0]).toMatchObject({ spent: 337400, balance: -337400 });
    expect(r.excluded.map((l) => l.categoryId)).toEqual(['biz']);
  });
});

describe('pace: used-up lines', () => {
  it('spent exactly to the budget (balance 0) is watch, not off', () => {
    expect(status(500, 500, '2026-11-22').status).toBe('watch');
  });
  it('a negative balance is still off', () => {
    expect(status(500, 600, '2026-11-22').status).toBe('off');
  });
  it('ahead of pace with a positive balance is still off', () => {
    expect(status(1000, 900, '2026-11-10').status).toBe('off');
  });
  it('budgeted 0 and spent 0 is ok', () => {
    expect(status(0, 0, '2026-11-22').status).toBe('ok');
  });
  it('a fixed line paid in full stays ok', () => {
    const p = plan([{ categoryId: 'f', kind: 'fixed', priority: 1, amount: 100 }]);
    expect(pace(p, snap([c('f', 100, 100)]), '2026-11-22')[0]!.status).toBe('ok');
  });
});
