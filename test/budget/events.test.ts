import { describe, expect, it } from 'vitest';
import { planSchema } from '../../src/budget/types.ts';
import { buildEvents, incomeStatus, matchIncome, type IncomeRow } from '../../src/budget/events.ts';
import { offPlan, type OffPlanLine, type PaceLine } from '../../src/budget/pace.ts';

const plan = planSchema.parse({
  version: 1, categories: [],
  incomeSources: [
    { name: 'Salary', payee: 'ACME', expectedAmount: 20000, expectedDay: 10 },
    { name: 'Transfer', payee: 'Inbal', expectedAmount: 5000, expectedDay: 5, fixedTransfer: true },
  ],
});
const row = (id: string, o: Partial<IncomeRow> = {}): IncomeRow => ({
  id, date: '2026-11-10', amount: 2000000, payee: 'ACME LTD', importedPayee: null, transferId: null, account: 'hap', ...o,
});
const base = { plan, month: '2026-11', today: '2026-11-12', income: [] as IncomeRow[], lines: [] as PaceLine[], reviewIds: [] as string[], unplanned: [] as OffPlanLine[], acked: {} };
const line = (status: 'ok' | 'watch' | 'off'): PaceLine => ({
  categoryId: 'dining', label: 'Dining', kind: 'variable', budgeted: 1, spent: 1, balance: 0, expectedByToday: 1, projected: 1, status,
});

describe('matchIncome', () => {
  it('needs positive amount, no transferId, payee substring (importedPayee first)', () => {
    const s = plan.incomeSources[0]!;
    expect(matchIncome(s, row('1'))).toBe(true);
    expect(matchIncome(s, row('2', { amount: -5 }))).toBe(false);
    expect(matchIncome(s, row('3', { transferId: 't' }))).toBe(false);
    expect(matchIncome(s, row('4', { payee: 'Other', importedPayee: 'ACME 123' }))).toBe(true);
    expect(matchIncome(s, row('5', { payee: 'ACME', importedPayee: 'Other' }))).toBe(false);
    expect(matchIncome(s, row('6', { payee: null, importedPayee: null }))).toBe(false);
  });
});

describe('incomeStatus', () => {
  it('lists landed and still-expected sources', () => {
    const r = incomeStatus(plan, '2026-11', [row('1'), row('x', { date: '2026-10-10' })]);
    expect(r.landed.map((l) => [l.source.name, l.row.id])).toEqual([['Salary', '1']]);
    expect(r.expected.map((s) => s.name)).toEqual(['Transfer']);
  });
});

describe('events', () => {
  it('income matched by payee substring, transfers ignored', () => {
    const ev = buildEvents({ ...base, income: [row('1'), row('2', { transferId: 't' }), row('3', { payee: 'Shop' })] });
    expect(ev.filter((e) => e.kind === 'income')).toEqual([
      { id: 'income:1', kind: 'income', source: 'Salary', amount: 2000000, date: '2026-11-10', transactionId: '1' },
    ]);
  });

  it('transfer_missing only after expectedDay+3', () => {
    const at = (today: string, month = '2026-11') => buildEvents({ ...base, month, today })
      .filter((e) => e.kind === 'transfer_missing');
    expect(at('2026-11-08')).toEqual([]);
    expect(at('2026-11-09')).toEqual([{ id: 'transfer:2026-11', kind: 'transfer_missing', source: 'Transfer', expectedDay: 5 }]);
    expect(at('2026-11-01', '2026-12')).toEqual([]);
    expect(at('2026-12-01')).toHaveLength(1);
    const landed = buildEvents({ ...base, today: '2026-11-20', income: [row('9', { payee: 'Inbal' })] });
    expect(landed.filter((e) => e.kind === 'transfer_missing')).toEqual([]);
  });

  it('watch to off emits a new pace event', () => {
    const paceOnly = (e: ReturnType<typeof buildEvents>) => e.filter((x) => x.kind === 'pace');
    const w = paceOnly(buildEvents({ ...base, lines: [line('watch')] }));
    const o = paceOnly(buildEvents({ ...base, lines: [line('off')], acked: { [w[0]!.id]: 'x' } }));
    expect(w[0]).toMatchObject({ id: 'pace:2026-11:dining:watch', kind: 'pace', status: 'watch' });
    expect(o[0]).toMatchObject({ id: 'pace:2026-11:dining:off', status: 'off' });
    expect(paceOnly(buildEvents({ ...base, lines: [line('ok')] }))).toEqual([]);
  });

  it('an unplanned category over budget produces one unplanned event; balance >= 0 produces none', () => {
    const u = (balance: number): OffPlanLine => ({ categoryId: 'yuval', label: 'Yuval', spent: 80000, balance });
    const only = (o: object) => buildEvents({ ...base, ...o }).filter((e) => e.kind === 'unplanned');
    expect(only({ unplanned: [u(-80000)] })).toEqual([
      { id: 'unplanned:2026-11:yuval', kind: 'unplanned', categoryId: 'yuval', label: 'Yuval', balance: -80000 },
    ]);
    expect(only({ unplanned: [u(0)] })).toEqual([]);
    expect(only({ unplanned: [u(500)] })).toEqual([]);
    expect(only({ unplanned: [u(-80000)], acked: { 'unplanned:2026-11:yuval': 'x' } })).toEqual([]);
  });

  it('an excluded category over budget produces no unplanned event', () => {
    const p = planSchema.parse({ version: 1, categories: [{ categoryId: 'biz', kind: 'excluded', priority: 1 }], incomeSources: [] });
    const snap = { month: '2026-11', toBudget: 0, categories: [
      { id: 'biz', label: 'Biz', hidden: false, isIncome: false, budgeted: 0, spent: -7000, balance: -7000 }] };
    const off = offPlan(p, snap);
    expect(off.excluded).toHaveLength(1);
    expect(buildEvents({ ...base, plan: p, unplanned: off.unplanned }).filter((e) => e.kind === 'unplanned')).toEqual([]);
  });

  it('review event id hashes the sorted row ids: same rows keep the id on another day, new rows change it', () => {
    const rev = (o: object) => buildEvents({ ...base, ...o }).filter((e) => e.kind === 'review');
    const a = rev({ reviewIds: ['r3', 'r1', 'r2'] });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'review', count: 3 });
    expect(a[0]!.id).toMatch(/^review:[0-9a-f]{12}$/);
    expect(rev({ reviewIds: ['r1', 'r2', 'r3'], today: '2026-11-13' })[0]!.id).toBe(a[0]!.id);
    expect(rev({ reviewIds: ['r1', 'r2', 'r3', 'r4'] })[0]!.id).not.toBe(a[0]!.id);
    expect(rev({ reviewIds: [] })).toEqual([]);
  });

  it('income: a row from the previous month still yields an event (month boundary)', () => {
    const ev = buildEvents({ ...base, month: '2026-12', today: '2026-12-02', income: [row('b', { date: '2026-11-30' })] });
    expect(ev.filter((e) => e.kind === 'income').map((e) => e.id)).toEqual(['income:b']);
  });

  it('transfer_missing for the previous month when expectedDay+3 spills past month end', () => {
    // Transfer expectedDay 5 -> use a source expected on day 29: Nov has 30 days, due = Dec 2
    const p = planSchema.parse({ version: 1, categories: [],
      incomeSources: [{ name: 'Late', payee: 'Inbal', expectedAmount: 1, expectedDay: 29, fixedTransfer: true }] });
    const at = (today: string, income: IncomeRow[] = []) => buildEvents({ ...base, plan: p, month: today.slice(0, 7), today, income })
      .filter((e) => e.id === 'transfer:2026-11');
    expect(at('2026-11-30')).toEqual([]);
    expect(at('2026-12-02')).toEqual([]);
    expect(at('2026-12-03')).toEqual([{ id: 'transfer:2026-11', kind: 'transfer_missing', source: 'Late', expectedDay: 29 }]);
    expect(at('2026-12-03', [row('l', { date: '2026-11-29', payee: 'Inbal' })])).toEqual([]);
    expect(at('2026-12-03', [row('l', { date: '2026-12-01', payee: 'Inbal' })])).toEqual([]); // landed inside the grace window
  });

  it('look-back only for transfers whose due date spills into the new month, never before the plan existed', () => {
    const p = planSchema.parse({ version: 1, categories: [], incomeSources: [
      { name: 'Late', payee: 'Inbal', expectedAmount: 1, expectedDay: 29, fixedTransfer: true }] });
    const at = (today: string, planSince?: string, income: IncomeRow[] = []) =>
      buildEvents({ ...base, plan: p, month: today.slice(0, 7), today, income, ...(planSince ? { planSince } : {}) })
        .filter((e) => e.kind === 'transfer_missing').map((e) => e.id);
    expect(at('2026-12-03', '2026-11-01')).toEqual(['transfer:2026-11']);
    expect(at('2026-12-03', '2026-12-03')).toEqual([]); // plan saved after the November due date (Dec 2)
    expect(at('2026-12-03', '2026-12-02')).toEqual(['transfer:2026-11']);
    // a day-5 transfer does not spill: day 1 of the next month raises nothing for the month before
    const early = planSchema.parse({ version: 1, categories: [], incomeSources: [
      { name: 'Early', payee: 'Inbal', expectedAmount: 1, expectedDay: 5, fixedTransfer: true }] });
    expect(buildEvents({ ...base, plan: early, month: '2026-12', today: '2026-12-01' })
      .filter((e) => e.kind === 'transfer_missing')).toEqual([]);
    // in-month rule also respects planSince
    expect(buildEvents({ ...base, today: '2026-11-20', planSince: '2026-11-10' }).filter((e) => e.kind === 'transfer_missing')).toEqual([]);
  });

  it('transfer:<month> gets the same verdict from the month itself and from a later view (grace window)', () => {
    const p = planSchema.parse({ version: 1, categories: [], incomeSources: [
      { name: 'Late', payee: 'Inbal', expectedAmount: 1, expectedDay: 29, fixedTransfer: true }] });
    const landedInGrace = [row('g', { date: '2026-12-01', payee: 'Inbal' })];
    const view = (month: string, today: string, income: IncomeRow[]) =>
      buildEvents({ ...base, plan: p, month, today, income }).filter((e) => e.id === 'transfer:2026-11').length;
    expect(view('2026-12', '2026-12-10', landedInGrace)).toBe(0);
    expect(view('2026-11', '2026-12-10', landedInGrace)).toBe(0); // monthOver used to say missing
    expect(view('2026-12', '2026-12-10', [])).toBe(1);
    expect(view('2026-11', '2026-12-10', [])).toBe(1);
  });

  it('one row, one month: a Dec 1 row that settles a late November transfer does not also settle December', () => {
    const p = planSchema.parse({ version: 1, categories: [], incomeSources: [
      { name: 'Alimony', payee: 'Inbal', expectedAmount: 1, expectedDay: 5, fixedTransfer: true }] });
    const dec1 = row('d1', { date: '2026-12-01', payee: 'Inbal' });
    const ids = (month: string, income: IncomeRow[]) => buildEvents({ ...base, plan: p, month, today: '2026-12-09', income })
      .filter((e) => e.kind === 'transfer_missing').map((e) => e.id);
    expect(ids('2026-12', [dec1])).toEqual(['transfer:2026-12']);
    expect(ids('2026-11', [dec1])).toEqual([]);
    // with its own November row, the Dec 1 row belongs to December
    const nov = row('n5', { date: '2026-11-05', payee: 'Inbal' });
    expect(ids('2026-12', [nov, dec1])).toEqual([]);
    expect(ids('2026-11', [nov, dec1])).toEqual([]);
  });

  it('income matching honours the source account', () => {
    const p = planSchema.parse({ version: 1, categories: [],
      incomeSources: [{ name: 'Salary', payee: 'ACME', expectedAmount: 1, expectedDay: 10, account: 'hap' }] });
    const ev = buildEvents({ ...base, plan: p, income: [row('1', { account: 'hap' }), row('2', { account: 'other' })] });
    expect(ev.filter((e) => e.kind === 'income').map((e) => e.id)).toEqual(['income:1']);
    expect(incomeStatus(p, '2026-11', [row('2', { account: 'other' })]).expected.map((s) => s.name)).toEqual(['Salary']);
    expect(matchIncome(p.incomeSources[0]!, row('3', { account: 'other' }))).toBe(false);
    expect(matchIncome(plan.incomeSources[0]!, row('4', { account: 'other' }))).toBe(true);
  });

  it('status — acked income event not re-emitted, unacked one repeats', () => {
    const input = { ...base, income: [row('1')] };
    const first = buildEvents(input).filter((e) => e.kind === 'income');
    const again = buildEvents(input).filter((e) => e.kind === 'income');
    expect(again).toEqual(first);
    const acked = { 'income:1': '2026-11-12T10:00:00Z' };
    expect(buildEvents({ ...input, acked }).filter((e) => e.kind === 'income')).toEqual([]);
  });
});
