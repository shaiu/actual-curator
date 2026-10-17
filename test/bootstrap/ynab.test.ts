import { expect, test } from 'vitest';
import { bankPayeeFor, proposeRules, type YnabExport } from '../../src/bootstrap/ynab.ts';

let n = 0;
const tx = (payee: string, category: string | null, over: Record<string, unknown> = {}) => ({ id: `x${++n}`,
  date: '2026-05-01', amount: -1000, payee_id: payee, category_id: category, account_id: 'on', transfer_account_id: null,
  deleted: false, ...over });

const exp = (transactions: ReturnType<typeof tx>[]): YnabExport => ({ data: { budget: {
  accounts: [{ id: 'on', name: 'Bank', on_budget: true }, { id: 'off', name: 'Invest', on_budget: false }],
  payees: [{ id: 'aroma', name: 'ארומה' }, { id: 'once', name: 'Once' }, { id: 'pb', name: 'PAYBOX' }, { id: 'shop', name: 'Shop' },
    { id: 'emp', name: 'Employer' }],
  category_groups: [{ id: 'g', name: 'Needs' }, { id: 'h', name: 'Old', hidden: true }, { id: 'i', name: 'Internal Master Category', internal: true }],
  categories: [{ id: 'coffee', name: 'Coffee', category_group_id: 'g' }, { id: 'food', name: 'Food', category_group_id: 'g' },
    { id: 'gone', name: 'Gone', category_group_id: 'h' }, { id: 'rta', name: 'Inflow: Ready to Assign', category_group_id: 'i', internal: true }],
  transactions,
} } });

const opts = { since: '2025-01-01', minRows: 2, minAgreement: 0.9, genericPayees: ['PAYBOX'] };

test('a payee with 10 rows, 9 agreeing, is proposed with agreement 0.9', () => {
  const rows = [...Array.from({ length: 9 }, () => tx('aroma', 'coffee')), tx('aroma', 'food')];
  expect(proposeRules(exp(rows), opts)).toEqual([{ importedPayee: 'ארומה', categoryLabel: 'Needs / Coffee', rows: 10, agreement: 0.9 }]);
});

test('below the agreement bar, a single row, or a generic payee: skipped', () => {
  const rows = [...Array.from({ length: 8 }, () => tx('aroma', 'coffee')), tx('aroma', 'food'), tx('aroma', 'food'),
    tx('once', 'coffee'), tx('pb', 'coffee'), tx('pb', 'coffee'), tx('pb', 'coffee')];
  expect(proposeRules(exp(rows), opts)).toEqual([]);
});

test('deleted, transfer, off-budget, uncategorized and out-of-window rows are ignored', () => {
  const rows = [tx('shop', 'coffee'), tx('shop', 'coffee'),
    tx('shop', 'food', { deleted: true }), tx('shop', 'food', { transfer_account_id: 'x' }), tx('shop', 'food', { account_id: 'off' }),
    tx('shop', null), tx('shop', 'food', { date: '2024-12-31' })];
  expect(proposeRules(exp(rows), opts)).toEqual([{ importedPayee: 'Shop', categoryLabel: 'Needs / Coffee', rows: 2, agreement: 1 }]);
});

test('payees whose category is hidden or internal get no rule', () => {
  const rows = [tx('shop', 'gone'), tx('shop', 'gone'), tx('emp', 'rta', { amount: 100 }), tx('emp', 'rta', { amount: 100 })];
  expect(proposeRules(exp(rows), opts)).toEqual([]);
});

const memoOpts = { ...opts, memoKeyPatterns: ['לטובת:\\s*(.+?)(?:\\.|$)'] };

test('a payee YNAB named after the memo recipient is marked with that memo key', () => {
  const memo = 'לטובת: Shop. עבור: rent 31-022';
  const rows = [tx('shop', 'coffee', { memo }), tx('shop', 'coffee', { memo }), tx('aroma', 'coffee', { memo: 'לטובת: someone else.' }),
    tx('aroma', 'coffee')];
  expect(proposeRules(exp(rows), memoOpts)).toEqual([
    { importedPayee: 'Shop', categoryLabel: 'Needs / Coffee', rows: 2, agreement: 1, memoKey: 'Shop' },
    { importedPayee: 'ארומה', categoryLabel: 'Needs / Coffee', rows: 2, agreement: 1 }]);
});

test('the bank payee for a memo-named rule is the generic payee Actual imported those rows under', () => {
  const generic = ['הוראת-קבע', 'PAYBOX'];
  const row = (importedPayee: string | null, memo: string) => ({ importedPayee, memo });
  expect(bankPayeeFor('אדם וטל', [row('אדם וטל', 'x'), row('הוראת-קבע', 'לטובת: אדם וטל. עבור: rent')], generic)).toBe('הוראת-קבע');
  expect(bankPayeeFor('אדם וטל', [row('Other bank', 'לטובת: אדם וטל.')], generic)).toBeUndefined();
  expect(bankPayeeFor('אדם וטל', [], generic)).toBeUndefined();
});
