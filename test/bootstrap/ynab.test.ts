import { expect, test } from 'vitest';
import { proposeRules, type YnabExport } from '../../src/bootstrap/ynab.ts';

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
