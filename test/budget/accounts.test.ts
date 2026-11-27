import { beforeEach, expect, test } from 'vitest';
import { listTransfers } from '../../src/budget/accounts.ts';
import { makeBudgetApp, row } from '../helpers/budget-http.ts';

/** The two rows Actual keeps for one transfer: each names the other account as its payee. */
const pair = (date: string, from: string, to: string, amount: number, key: string) => [
  row({ id: `${key}-out`, transferId: `${key}-in`, date, amount: -amount, account: from, accountName: from, payee: to, importedPayee: null, category: 'biz', notes: 'secret' }),
  row({ id: `${key}-in`, transferId: `${key}-out`, date, amount, account: to, accountName: to, payee: from, importedPayee: null }),
];

let ctx: ReturnType<typeof makeBudgetApp>;
const get = () => ctx.app.request('/v1/accounts', { headers: { authorization: 'Bearer secret' } });
const m = (amount: number) => ({ amount, formatted: (amount / 100).toFixed(2) });
const account = (name: string, balance: number, over: object = {}) => ({ id: name, name, offbudget: false, closed: false, balance, ...over });

beforeEach(() => { ctx = makeBudgetApp({ now: new Date('2026-11-20T09:00:00Z') }); });

test('both sides of a transfer appear once, newest first', () => {
  expect(listTransfers([...pair('2026-11-02', 'Bank', 'Savings', 500, 'a'), ...pair('2026-11-09', 'Savings', 'Bank', 700, 'b')])).toEqual([
    { date: '2026-11-09', from: 'Savings', to: 'Bank', amount: 700 },
    { date: '2026-11-02', from: 'Bank', to: 'Savings', amount: 500 },
  ]);
});

test('one side alone still names both accounts, whichever side it is', () => {
  const [out, into] = pair('2026-11-02', 'Bank', 'Savings', 500, 'a');
  const want = [{ date: '2026-11-02', from: 'Bank', to: 'Savings', amount: 500 }];
  expect(listTransfers([out!])).toEqual(want);
  expect(listTransfers([into!])).toEqual(want);
});

test('ordinary rows are not listed', () => {
  expect(listTransfers([row({ category: 'groc', amount: -10 }), row({ id: 'x' })])).toEqual([]);
});

test('route: transfer entries carry exactly date, from, to and amount, over the last 30 days', async () => {
  ctx.store.rows = [...pair('2026-10-21', 'Bank', 'Savings', 500, 'in'), ...pair('2026-10-20', 'Bank', 'Savings', 900, 'out'),
    row({ id: 'groc', date: '2026-11-01', amount: -10, category: 'groc' })];
  const r = await get();
  expect(r.status).toBe(200);
  const b = await r.json() as any;
  expect(b.transfersSince).toBe('2026-10-21');
  expect(b.transfers).toEqual([{ date: '2026-10-21', from: 'Bank', to: 'Savings', amount: m(500) }]);
  expect(Object.keys(b.transfers[0])).toEqual(['date', 'from', 'to', 'amount']);
  expect(ctx.store.txQueries).toEqual([{ from: '2026-10-21', to: '2026-11-20', limit: 5000 }]);
  expect(JSON.stringify(b)).not.toMatch(/biz|secret|Employer|income|spen[dt]/i);
});

test('route: a closed account with no money is left out, one holding money stays; totals split on and off budget', async () => {
  ctx.store.balances = [account('Bank', 10000), account('Card', -2500), account('Savings', 700000, { offbudget: true }),
    account('Empty', 0, { closed: true }), account('Left', 300, { closed: true, offbudget: true }), account('New', 0)];
  const b = await (await get()).json() as any;
  expect(b.accounts).toEqual([
    { name: 'Bank', onBudget: true, closed: false, balance: m(10000) },
    { name: 'Card', onBudget: true, closed: false, balance: m(-2500) },
    { name: 'Savings', onBudget: false, closed: false, balance: m(700000) },
    { name: 'Left', onBudget: false, closed: true, balance: m(300) },
    { name: 'New', onBudget: true, closed: false, balance: m(0) },
  ]);
  expect(b.totals).toEqual({ onBudget: m(7500), offBudget: m(700300) });
});

test('route: needs no plan, refuses a cut transfer list and a failed sync', async () => {
  expect((await get()).status).toBe(200);
  expect(ctx.store.syncs).toBe(1);
  ctx.store.rows = Array.from({ length: 5000 }, (_, i) => row({ id: `r${i}` }));
  const cut = await get();
  expect(cut.status).toBe(400);
  expect(((await cut.json()) as any).error.code).toBe('too_many_rows');
  ctx.store.failSync = true;
  expect((await get()).status).toBe(503);
});
