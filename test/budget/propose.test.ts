import { describe, expect, it } from 'vitest';
import { planSchema, type CategoryMonth, type MonthSnapshot, type PlanInput } from '../../src/budget/types.ts';
import { PlanError, checkPlan, plannedAmount, propose, proposalId } from '../../src/budget/propose.ts';

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
    expect(() => checkPlan(p, s)).toThrow(/biz/);
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
