import { describe, expect, it } from 'vitest';
import { planSchema, type CategoryMonth, type MonthSnapshot, type PlanInput } from '../../src/budget/types.ts';
import { PlanError, checkPlan, fundingShortfall, plannedAmount, propose, proposalId } from '../../src/budget/propose.ts';

const cat = (id: string, o: Partial<CategoryMonth> = {}): CategoryMonth => ({
  id, label: id, hidden: false, isIncome: false, budgeted: 0, spent: 0, balance: 0, ...o,
});
const snap = (toBudget: number, categories: CategoryMonth[], month = '2026-12'): MonthSnapshot => ({ month, toBudget, categories });
const plan = (categories: PlanInput['categories']) => planSchema.parse({ version: 1, categories, incomeSources: [] });

describe('propose', () => {
  it('fills by priority up to available', () => {
    const p = plan([
      { categoryId: 'dining', kind: 'variable', priority: 2, amount: 2800 },
      { categoryId: 'rent', kind: 'fixed', priority: 1, amount: 4000 },
    ]);
    const r = propose(p, snap(500000, [cat('rent'), cat('dining')]));
    expect(r.lines.map((l) => l.categoryId)).toEqual(['rent', 'dining']);
    expect(r.lines[0]).toMatchObject({ propose: 400000, unfunded: 0, planned: 400000 });
    expect(r.lines[1]).toMatchObject({ propose: 100000, unfunded: 180000 });
    expect(r.available).toBe(500000);
    expect(r.proposed).toBe(500000);
    expect(r.remaining).toBe(0);
  });

  it('subtracts what is already budgeted', () => {
    const p = plan([{ categoryId: 'dining', kind: 'variable', priority: 1, amount: 2800 }]);
    const r = propose(p, snap(1000000, [cat('dining', { budgeted: 200000 })]));
    expect(r.lines[0]!.propose).toBe(80000);
    expect(r.lines[0]!.budgeted).toBe(200000);
    expect(r.remaining).toBe(920000);
  });

  it('setaside spreads target over months to due', () => {
    const p = plan([{ categoryId: 'car', kind: 'setaside', priority: 1, target: 6000, due: '2027-02' }]);
    const s = snap(1000000, [cat('car', { balance: 150000 })]);
    expect(plannedAmount(p.categories[0]!, s.categories[0]!, '2026-12')).toBe(150000);
    expect(propose(p, s).lines[0]!.planned).toBe(150000);
  });

  it('setaside carryIn excludes this month budgeted and spent; overdue counts 1 month; never negative', () => {
    const c = plan([{ categoryId: 'car', kind: 'setaside', priority: 1, target: 6000, due: '2026-01' }]).categories[0]!;
    // balance 200000 = carryIn 150000 + budgeted 100000 + spent -50000
    expect(plannedAmount(c, cat('car', { balance: 200000, budgeted: 100000, spent: -50000 }), '2026-12')).toBe(450000);
    expect(plannedAmount(c, cat('car', { balance: 900000 }), '2026-12')).toBe(0);
  });

  it('setaside fractional-shekel target has no float noise', () => {
    const c = plan([{ categoryId: 'x', kind: 'setaside', priority: 1, target: 1.1, due: '2026-12' }]).categories[0]!;
    expect(plannedAmount(c, cat('x'), '2026-12')).toBe(110);
  });

  it('excluded category has no line', () => {
    const p = plan([
      { categoryId: 'biz', kind: 'excluded', priority: 1 },
      { categoryId: 'rent', kind: 'fixed', priority: 2, amount: 100 },
    ]);
    const r = propose(p, snap(100000, [cat('biz'), cat('rent')]));
    expect(r.lines.map((l) => l.categoryId)).toEqual(['rent']);
    expect(plannedAmount(p.categories[0]!, cat('biz'), '2026-12')).toBe(0);
  });

  it('sorts by priority then label, using the snapshot label', () => {
    const p = plan([
      { categoryId: 'a', kind: 'fixed', priority: 1, amount: 1 },
      { categoryId: 'b', kind: 'fixed', priority: 1, amount: 1 },
      { categoryId: 'c', kind: 'fixed', priority: 0, amount: 1 },
    ]);
    const r = propose(p, snap(10000, [cat('a', { label: 'Zed' }), cat('b', { label: 'Alpha' }), cat('c', { label: 'Mid' })]));
    expect(r.lines.map((l) => l.label)).toEqual(['Mid', 'Alpha', 'Zed']);
  });

  it('never exceeds toBudget', () => {
    const p = plan([
      { categoryId: 'a', kind: 'fixed', priority: 1, amount: 300 },
      { categoryId: 'b', kind: 'fixed', priority: 2, amount: 300 },
    ]);
    const r = propose(p, snap(45000, [cat('a'), cat('b')]));
    expect(r.proposed).toBe(45000);
    expect(r.proposed).toBeLessThanOrEqual(r.available);
    expect(r.remaining).toBe(0);
  });

  it('negative toBudget proposes 0 everywhere and reports remaining unclamped', () => {
    const p = plan([{ categoryId: 'a', kind: 'fixed', priority: 1, amount: 300 }]);
    const r = propose(p, snap(-5000, [cat('a')]));
    expect(r.lines[0]).toMatchObject({ propose: 0, unfunded: 30000 });
    expect(r.proposed).toBe(0);
    expect(r.remaining).toBe(-5000);
  });
});

describe('checkPlan', () => {
  const p = plan([
    { categoryId: 'gone', kind: 'fixed', priority: 1, amount: 1 },
    { categoryId: 'hid', kind: 'fixed', priority: 2, amount: 1 },
    { categoryId: 'ok', kind: 'fixed', priority: 3, amount: 1 },
    { categoryId: 'biz', kind: 'excluded', priority: 4 },
  ]);
  it('hidden or missing plan category throws stale_plan naming both ids', () => {
    const s = snap(0, [cat('hid', { hidden: true }), cat('ok'), cat('biz')]);
    try { checkPlan(p, s); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(PlanError);
      expect((e as PlanError).code).toBe('stale_plan');
      expect((e as PlanError).message).toContain('gone');
      expect((e as PlanError).message).toContain('hid');
      expect((e as PlanError).message).not.toContain('ok');
    }
  });
  it('covers excluded categories too, and propose checks first', () => {
    const s = snap(0, [cat('gone'), cat('hid'), cat('ok')]);
    expect(() => checkPlan(p, s)).toThrow(/1 excluded \(not named\)/);
    expect(() => checkPlan(p, s)).not.toThrow(/biz/);
    expect(() => propose(p, s)).toThrow(PlanError);
  });
  it('passes when all present', () => {
    expect(() => checkPlan(p, snap(0, [cat('gone'), cat('hid'), cat('ok'), cat('biz')]))).not.toThrow();
  });
});

describe('proposalId', () => {
  const base = snap(1000, [cat('b', { budgeted: 5 }), cat('a', { budgeted: 7 })]);
  it('is stable, 12 hex, order-independent', () => {
    const id = proposalId(base);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(proposalId(snap(1000, [...base.categories].reverse()))).toBe(id);
    expect(proposalId({ ...base, categories: base.categories.map((c) => ({ ...c, spent: -9, label: 'x' })) })).toBe(id);
  });
  it('changes when toBudget, a budgeted amount, or month changes', () => {
    const id = proposalId(base);
    expect(proposalId({ ...base, toBudget: 1001 })).not.toBe(id);
    expect(proposalId(snap(1000, [cat('b', { budgeted: 5 }), cat('a', { budgeted: 8 })]))).not.toBe(id);
    expect(proposalId({ ...base, month: '2027-01' })).not.toBe(id);
  });
  it('propose returns the snapshot-derived id', () => {
    const p = plan([{ categoryId: 'a', kind: 'fixed', priority: 1, amount: 1 }]);
    expect(propose(p, base).proposalId).toBe(proposalId(base));
  });
});

describe('available across later months (Actual carry-over)', () => {
  const p = plan([{ categoryId: 'rent', kind: 'fixed', priority: 1, amount: 4000 }]);
  const s = snap(3700000, [cat('rent')], '2026-11');
  it('available is the minimum toBudget from this month through the later ones', () => {
    const r = propose(p, s, [100000, 2500000]);
    expect(r.available).toBe(100000);
    expect(r.lines[0]).toMatchObject({ propose: 100000, unfunded: 300000 });
    expect(r.remaining).toBe(0);
  });
  it('a larger later month does not raise it; no later months leaves it alone', () => {
    expect(propose(p, snap(100000, [cat('rent')]), [9000000]).available).toBe(100000);
    expect(propose(p, s).available).toBe(3700000);
  });
  it('proposalId folds in every later toBudget, in order', () => {
    const id = proposalId(s, [100, 200]);
    expect(proposalId(s, [100, 201])).not.toBe(id);
    expect(proposalId(s, [101, 200])).not.toBe(id);
    expect(proposalId(s, [100, 200, 300])).not.toBe(id);
    expect(proposalId(s, [100, 200])).toBe(id);
    expect(propose(p, s, [100, 200]).proposalId).toBe(id);
  });
});

describe('propose: overspending already lost by later months', () => {
  const p = plan([
    { categoryId: 'rent', kind: 'fixed', priority: 1, amount: 8500 },
    { categoryId: 'food', kind: 'variable', priority: 2, amount: 5000 },
  ]);
  it('covering an overspend costs later months nothing (the 2026-11 case)', () => {
    // rent spent 8,500 with nothing budgeted: next month already lost it, so later = 1,000 net.
    const s = snap(1000000, [cat('rent', { spent: -850000, balance: -850000 }), cat('food')], '2026-11');
    const r = propose(p, s, [100000]);
    expect(r.available).toBe(100000);
    expect(r.lines[0]).toMatchObject({ propose: 850000, covers: 850000 });
    expect(r.lines[1]).toMatchObject({ propose: 100000, covers: 0, unfunded: 400000 });
    expect(r.coversOverspend).toBe(850000);
    expect(r.proposed - r.coversOverspend).toBe(r.available);
    expect(r.remaining).toBe(0);
  });
  it('a carryover category keeps its overspend, so covering it is ordinary spending', () => {
    const s = snap(1000000, [cat('rent', { balance: -850000, carryover: true }), cat('food')], '2026-11');
    const r = propose(p, s, [100000]);
    expect(r.lines[0]).toMatchObject({ propose: 100000, covers: 0 });
    expect(r.coversOverspend).toBe(0);
  });
  it('this month\'s To budget still caps everything', () => {
    const s = snap(300000, [cat('rent', { balance: -850000 }), cat('food')], '2026-11');
    expect(propose(p, s, [500000]).lines.map((l) => l.propose)).toEqual([300000, 0]);
  });
  it('covers an overspend even when later months are negative', () => {
    const s = snap(1000000, [cat('rent', { balance: -850000 }), cat('food')], '2026-11');
    const r = propose(p, s, [-1500000]);
    expect(r.lines.map((l) => l.propose)).toEqual([850000, 0]);
  });
});

describe('fundingShortfall (the apply check)', () => {
  const rent = cat('rent', { balance: -850000 }), food = cat('food');
  const s = snap(1000000, [rent, food], '2026-11');
  it('allows covering an overspend beyond min(later)', () => {
    expect(fundingShortfall(s, [100000], [{ cat: rent, added: 850000 }, { cat: food, added: 100000 }])).toEqual({ now: 0, later: 0 });
  });
  it('reports what new money exceeds', () => {
    expect(fundingShortfall(s, [100000], [{ cat: rent, added: 850000 }, { cat: food, added: 100001 }])).toEqual({ now: 0, later: 1 });
    expect(fundingShortfall(s, [5000000], [{ cat: food, added: 1000001 }])).toEqual({ now: 1, later: 0 });
  });
});

describe('propose covers an overspend beyond the plan (Kvish6 planned 55, spent 127)', () => {
  it('needs what brings the line back to zero', () => {
    const p = plan([{ categoryId: 'kv', kind: 'variable', priority: 1, amount: 55 }]);
    const r = propose(p, snap(1000000, [cat('kv', { budgeted: 5500, spent: -12700, balance: -7200 })], '2026-11'), [1000000]);
    expect(r.lines[0]).toMatchObject({ propose: 7200, covers: 7200, unfunded: 0 });
  });
});
