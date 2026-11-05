// The budget routes against a real scratch budget: Actual's own budget calls answer success for
// inputs they ignore (measured on 26.10.0), so a fake store here would prove nothing.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { ActualStore, BudgetWriteError } from '../../src/actual/store.ts';
import { createApp } from '../../src/http/app.ts';
import { DecisionLog } from '../../src/log.ts';
import { parseVocabulary } from '../../src/vocabulary.ts';
import { buildBudget, type Fixture } from '../helpers/budget.ts';

let fx: Fixture;
let store: ActualStore;
let app: ReturnType<typeof createApp>;
const auth = { authorization: 'Bearer secret' };
const post = (path: string, body: unknown) =>
  app.request(`/v1${path}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string) => app.request(`/v1${path}`, { headers: auth });

const ym = (offset: number) => {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth() + offset, 1));
  return t.toISOString().slice(0, 7);
};
const THIS = ym(0);
const budgeted = async (month: string, id: string) =>
  (await store.budgetMonth(month)).groups.flatMap(g => g.categories).find(c => c.id === id)!.budgeted;

beforeAll(async () => {
  fx = await buildBudget();
  store = await ActualStore.open({ dataDir: fx.dataDir });
  app = createApp({ store, log: new DecisionLog(mkdtempSync(join(tmpdir(), 'curator-budget-'))),
    vocab: parseVocabulary('tags:\n  - { tag: kids, meaning: for a child }\n'), cfg: { token: 'secret', currency: 'ILS' }, classifierName: 'fake',
    runNow: async () => { throw new Error('unused'); }, status: () => ({}),
    versions: { curator: 'test', actualApi: 'test', server: 'test' } });
}, 60_000);
afterAll(async () => { await store?.close(); });

test('GET /budget/:month: visible groups only, income flagged, totals as money, budgeted total positive', async () => {
  await store.setBudgets(THIS, [{ category: fx.ids.coffee, amount: 5000 }], [{ category: fx.ids.coffee, amount: 0 }]);
  const res = await get(`/budget/${THIS}`);
  expect(res.status).toBe(200);
  const b = await res.json();
  expect(b.month).toBe(THIS);
  expect(b.totalBudgeted).toEqual({ amount: 5000, formatted: '50.00' });
  expect(Object.keys(b.toBudget)).toEqual(['amount', 'formatted']);
  const cats = b.groups.flatMap((g: { categories: unknown[] }) => g.categories);
  const labels = cats.map((c: { label: string }) => c.label);
  expect(labels).toContain('Needs / Coffee');
  expect(labels).not.toContain('Needs / Old stuff');
  expect(cats.find((c: { label: string }) => c.label === 'Needs / Coffee')).toMatchObject({
    id: fx.ids.coffee, isIncome: false, budgeted: { amount: 5000, formatted: '50.00' }, carryover: false });
  expect(cats.find((c: { label: string }) => c.label === 'Income / Salary').isIncome).toBe(true);
});

test('GET /budget/:month: a month Actual holds no budget for is a 400, never an empty month', async () => {
  expect((await get('/budget/2099-01')).status).toBe(400);
  expect((await get('/budget/2026-13')).status).toBe(400);
});

test('POST /budget/:month: writes, then answers what was read back', async () => {
  const res = await post(`/budget/${THIS}`, { items: [
    { category: fx.ids.coffee, expectLabel: 'Needs / Coffee', amount: 150000 },
    { category: fx.ids.groceries, expectLabel: 'needs / groceries', amount: 0 },
  ] });
  expect(res.status).toBe(200);
  const b = await res.json();
  expect(b.items[0]).toMatchObject({ category: fx.ids.coffee, label: 'Needs / Coffee',
    before: { amount: 5000, formatted: '50.00' }, after: { amount: 150000, formatted: '1500.00' } });
  expect(b.items[1].after.formatted).toBe('0.00');
  const month = await store.budgetMonth(THIS);
  expect(b.toBudget.amount).toBe(month.toBudget);
  expect(await budgeted(THIS, fx.ids.coffee)).toBe(150000);
});

test('POST /budget/:month: an expectLabel mismatch writes nothing', async () => {
  const was = await budgeted(THIS, fx.ids.coffee);
  const res = await post(`/budget/${THIS}`, { items: [{ category: fx.ids.coffee, expectLabel: 'Needs / Groceries', amount: 1 }] });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/is "Needs \/ Coffee", not "Needs \/ Groceries"/);
  expect(await budgeted(THIS, fx.ids.coffee)).toBe(was);
});

test('POST /budget/:month: one bad item refuses the whole batch, naming it', async () => {
  const was = await budgeted(THIS, fx.ids.coffee);
  for (const [bad, why] of [
    [{ category: fx.ids.salary, expectLabel: 'Income / Salary', amount: 100 }, /income category/],
    [{ category: fx.ids.old, expectLabel: 'Needs / Old stuff', amount: 100 }, /hidden/],
    [{ category: 'no-such-category', expectLabel: 'Needs / Coffee', amount: 100 }, /not a category/],
    [{ category: fx.ids.coffee, expectLabel: 'Needs / Coffee', amount: 100 }, /more than once/],
  ] as const) {
    const res = await post(`/budget/${THIS}`, { items: [{ category: fx.ids.coffee, expectLabel: 'Needs / Coffee', amount: 777 }, bad] });
    expect(res.status, String(why)).toBe(400);
    const msg = (await res.json()).error.message;
    expect(msg).toMatch(/^Nothing was written\. items\.1: /);
    expect(msg).toMatch(why);
    expect(await budgeted(THIS, fx.ids.coffee)).toBe(was);
  }
});

test('POST /budget/:month: amounts are non-negative integers, at most 50 items', async () => {
  for (const amount of [-1, 1.5, '100']) {
    expect((await post(`/budget/${THIS}`, { items: [{ category: fx.ids.coffee, expectLabel: 'Needs / Coffee', amount }] })).status).toBe(400);
  }
  const items = Array.from({ length: 51 }, () => ({ category: fx.ids.coffee, expectLabel: 'Needs / Coffee', amount: 1 }));
  expect((await post(`/budget/${THIS}`, { items })).status).toBe(400);
});

test('POST /budget/:month: more than 12 months ahead is refused before anything is read', async () => {
  const res = await post(`/budget/${ym(13)}`, { items: [{ category: fx.ids.coffee, expectLabel: 'Needs / Coffee', amount: 1 }] });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/13 months ahead/);
});

test('setBudgets: a write Actual silently ignores is caught by the read-back and the batch is put back', async () => {
  const was = await budgeted(THIS, fx.ids.coffee);
  // setBudgetAmount answers success for an unknown category; only the read-back can see it.
  await expect(store.setBudgets(THIS, [{ category: fx.ids.coffee, amount: 4242 }, { category: 'no-such-category', amount: 1 }],
    [{ category: fx.ids.coffee, amount: was }])).rejects.toThrow(BudgetWriteError);
  await expect(store.setBudgets(THIS, [{ category: 'no-such-category', amount: 1 }], [{ category: fx.ids.coffee, amount: was }]))
    .rejects.toThrow(/restored the previous amounts/);
  expect(await budgeted(THIS, fx.ids.coffee)).toBe(was);
});

test('POST /budget/:month/carryover: sets the flag and answers it read back', async () => {
  const res = await post(`/budget/${THIS}/carryover`, { category: fx.ids.groceries, expectLabel: 'Needs / Groceries', carryover: true });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ label: 'Needs / Groceries', before: false, after: true });
  expect((await post(`/budget/${THIS}/carryover`, { category: fx.ids.salary, expectLabel: 'Income / Salary', carryover: true })).status).toBe(400);
});

test('POST /budget/:month/hold: holds, replaces, releases, and refuses more than can be held', async () => {
  const month = await store.budgetMonth(THIS);
  const res = await post(`/budget/${THIS}/hold`, { amount: 10000 });
  expect(res.status).toBe(200);
  const b = await res.json();
  expect(b.after).toEqual({ amount: 10000, formatted: '100.00' });
  expect(b.toBudget.amount).toBe(month.toBudget + month.forNextMonth - 10000);
  // Actual answers true for a hold far above to-budget; the route refuses it instead.
  const tooMuch = await post(`/budget/${THIS}/hold`, { amount: month.toBudget + month.forNextMonth + 1 });
  expect(tooMuch.status).toBe(400);
  expect((await store.budgetMonth(THIS)).forNextMonth).toBe(10000);
  const release = await (await post(`/budget/${THIS}/hold`, { amount: 0 })).json();
  expect(release).toMatchObject({ before: { amount: 10000 }, after: { amount: 0 } });
});
