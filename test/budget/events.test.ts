import { describe, expect, it } from 'vitest';
import { planSchema } from '../../src/budget/types.ts';
import { buildEvents, incomeStatus, matchIncome, type IncomeRow } from '../../src/budget/events.ts';
import type { PaceLine } from '../../src/budget/pace.ts';

const plan = planSchema.parse({
  version: 1, categories: [],
  incomeSources: [
    { name: 'Salary', payee: 'ACME', expectedAmount: 20000, expectedDay: 10 },
    { name: 'Transfer', payee: 'Inbal', expectedAmount: 5000, expectedDay: 5, fixedTransfer: true },
  ],
});
const row = (id: string, o: Partial<IncomeRow> = {}): IncomeRow => ({
  id, date: '2026-11-10', amount: 2000000, payee: 'ACME LTD', importedPayee: null, transferId: null, ...o,
});
const base = { plan, month: '2026-11', today: '2026-11-12', income: [] as IncomeRow[], lines: [] as PaceLine[], reviewCount: 0, acked: {} };
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

  it('review event once per day when count > 0', () => {
    expect(buildEvents({ ...base, reviewCount: 3 }).filter((e) => e.kind === 'review'))
      .toEqual([{ id: 'review:2026-11-12', kind: 'review', count: 3 }]);
    expect(buildEvents({ ...base, reviewCount: 0 }).filter((e) => e.kind === 'review')).toEqual([]);
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
