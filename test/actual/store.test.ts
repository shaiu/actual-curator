import { afterAll, beforeAll, expect, test } from 'vitest';
import { ActualStore } from '../../src/actual/store.ts';
import { buildBudget, daysAgo, type Fixture } from '../helpers/budget.ts';

let fx: Fixture;
let store: ActualStore;

beforeAll(async () => {
  fx = await buildBudget();
  store = await ActualStore.open({ dataDir: fx.dataDir });
}, 60_000);
afterAll(async () => { await store?.close(); });

test('categories: hidden excluded, labels and income flag', async () => {
  const cats = await store.categories();
  const labels = cats.map(c => c.label);
  expect(labels).toContain('Needs / Coffee');
  expect(labels).not.toContain('Needs / Old stuff');
  expect(cats.find(c => c.label === 'Income / Salary')?.isIncome).toBe(true);
  expect(cats.find(c => c.label === 'Needs / Coffee')?.isIncome).toBe(false);
  expect((await store.categories({ includeHidden: true })).map(c => c.label)).toContain('Needs / Old stuff');
});

test('candidates exclude transfers, off-budget, splits and rows older than lookback', async () => {
  const rows = await store.candidates({ lookbackDays: 60 });
  const notes = rows.map(r => r.notes);
  expect(notes).toEqual(expect.arrayContaining(['cappuccino', 'latte #kids', 'salary']));
  expect(notes).not.toContain('card payment');
  expect(rows.some(r => r.importedPayee === 'Broker')).toBe(false);
  expect(rows.some(r => r.importedPayee === 'ישן')).toBe(false);
  expect(rows.some(r => r.importedPayee === 'Split shop')).toBe(false);
  const row = rows.find(r => r.notes === 'cappuccino')!;
  expect(row).toMatchObject({ amount: -2550, payee: 'ארומה', importedPayee: 'ארומה', accountName: 'Bank',
    category: null, transferId: null, date: daysAgo(5), account: fx.ids.bank });
});

test('priorCategories: most recent distinct categories first', async () => {
  expect(await store.priorCategories('ארומה', 3)).toEqual([fx.ids.coffee, fx.ids.groceries]);
});

test('transactions: tag filter is an exact trailing-token match', async () => {
  const rows = await store.transactions({ from: daysAgo(30), to: daysAgo(0), tag: 'kids', limit: 50 });
  expect(rows.map(r => r.notes).sort()).toEqual(['latte #kids', 'refund #kids']);
});

test('transactions: text search across payee and notes, newest first', async () => {
  const rows = await store.transactions({ from: daysAgo(30), to: daysAgo(0), text: 'ארומ', limit: 2 });
  expect(rows).toHaveLength(2);
  expect(rows[0].date >= rows[1].date).toBe(true);
});

test('createRule round-trips imported_payee is + notes contains', async () => {
  const id = await store.createRule({ importedPayee: 'PAYBOX', notesContains: 'שכירות', categoryId: fx.ids.groceries });
  const r = (await store.rules()).find(x => x.id === id)!;
  expect(r.conditionsOp).toBe('and');
  expect(r.conditions).toEqual([
    { field: 'imported_payee', op: 'is', value: 'PAYBOX' },
    { field: 'notes', op: 'contains', value: 'שכירות' },
  ]);
  expect(r.actions).toEqual([{ field: 'category', op: 'set', value: fx.ids.groceries }]);
});

test('replaceRule updates the rule with identical conditions instead of adding one', async () => {
  const id1 = await store.replaceRule({ importedPayee: 'BIT', categoryId: fx.ids.coffee });
  const id2 = await store.replaceRule({ importedPayee: 'BIT', categoryId: fx.ids.groceries });
  expect(id2).toBe(id1);
  const bits = (await store.rules()).filter(r => r.conditions.some(c => c.value === 'BIT'));
  expect(bits).toHaveLength(1);
  expect(bits[0].actions[0].value).toBe(fx.ids.groceries);
  expect(await store.deleteRule(id1)).toBe(true);
  expect((await store.rules()).some(r => r.id === id1)).toBe(false);
});

test('update writes category and notes', async () => {
  const row = (await store.candidates({ lookbackDays: 60 })).find(r => r.notes === 'cappuccino')!;
  await store.update(row.id, { category: fx.ids.coffee, notes: 'cappuccino #auto' });
  const after = (await store.candidates({ lookbackDays: 60 })).find(r => r.id === row.id)!;
  expect(after).toMatchObject({ category: fx.ids.coffee, notes: 'cappuccino #auto' });
});

test('spend by tag nets a refund; excludes transfers, off-budget and income', async () => {
  const byTag = await store.spend({ from: daysAgo(30), to: daysAgo(0), by: 'tag' });
  expect(byTag).toEqual([{ key: 'kids', label: '#kids', amount: -700 }]);
  const byCat = await store.spend({ from: daysAgo(30), to: daysAgo(0), by: 'category' });
  const coffee = byCat.find(r => r.key === fx.ids.coffee)!;
  expect(coffee.amount).toBe(-2550 - 1200 + 500 - 1000); // incl. the split child and the row set in the update test
  expect(byCat.some(r => r.label.includes('Salary'))).toBe(false);
  expect(byCat.reduce((s, r) => s + r.amount, 0)).toBe(-2550 - 1200 - 1800 + 500 - 3000);
  const byGroup = await store.spend({ from: daysAgo(30), to: daysAgo(0), by: 'group' });
  expect(byGroup).toEqual([{ key: fx.ids.needs, label: 'Needs', amount: -2550 - 1200 - 1800 + 500 - 3000 }]);
});

test('income returns only income categories', async () => {
  expect(await store.income({ from: daysAgo(30), to: daysAgo(0) }))
    .toEqual([{ key: fx.ids.salary, label: 'Income / Salary', amount: 1500000 }]);
});

test('transaction(id) returns one row, or undefined', async () => {
  const any = (await store.candidates({ lookbackDays: 60 }))[0];
  expect(await store.transaction(any.id)).toEqual(any);
  expect(await store.transaction('nope')).toBeUndefined();
});

test('concurrent updates from two callers both land (writes are serialized)', async () => { // review #3
  const [a, b] = (await store.candidates({ lookbackDays: 60 })).filter(r => r.notes === 'salary' || r.notes === 'latte #kids');
  await Promise.all([store.update(a.id, { notes: `${a.notes} x` }), store.update(b.id, { notes: `${b.notes} y` })]);
  expect((await store.transaction(a.id))?.notes).toBe(`${a.notes} x`);
  expect((await store.transaction(b.id))?.notes).toBe(`${b.notes} y`);
});

test('update with an expected state that no longer holds throws StaleRowError and writes nothing', async () => { // review #2
  const { StaleRowError } = await import('../../src/actual/store.ts');
  const r = (await store.candidates({ lookbackDays: 60 })).find(x => x.notes === 'salary x')!;
  await expect(store.update(r.id, { notes: 'machine' }, { category: r.category, notes: 'what the curator saw' }))
    .rejects.toBeInstanceOf(StaleRowError);
  expect((await store.transaction(r.id))?.notes).toBe('salary x');
  await store.update(r.id, { notes: 'salary' }, { category: r.category, notes: 'salary x' });
  expect((await store.transaction(r.id))?.notes).toBe('salary');
});

test('date ranges honour `to`: rows after it are excluded from transactions and reports', async () => {
  const dates = (await store.transactions({ from: daysAgo(30), to: daysAgo(5), limit: 50 })).map(r => r.date);
  expect(dates.length).toBeGreaterThan(0);
  expect(dates.filter(d => d < daysAgo(30) || d > daysAgo(5))).toEqual([]);
  expect(await store.income({ from: daysAgo(30), to: daysAgo(8) })).toEqual([]);
  const spend = await store.spend({ from: daysAgo(30), to: daysAgo(4), by: 'category' });
  expect(spend.find(r => r.key === fx.ids.coffee)?.amount).toBe(-2550 - 1200 - 1000); // the +500 refund (day 2) is out
});

test('reports leave out excluded categories in every cut; the rows stay searchable', async () => {
  const exclude = [fx.ids.coffee];
  const byCat = await store.spend({ from: daysAgo(30), to: daysAgo(0), by: 'category', exclude });
  expect(byCat.some(r => r.key === fx.ids.coffee)).toBe(false);
  expect(byCat.find(r => r.key === fx.ids.groceries)?.amount).toBe(-1800 - 2000);
  expect(await store.spend({ from: daysAgo(30), to: daysAgo(0), by: 'tag', exclude })).toEqual([]); // both #kids rows are coffee
  expect(await store.spend({ from: daysAgo(30), to: daysAgo(0), by: 'group', exclude }))
    .toEqual([{ key: fx.ids.needs, label: 'Needs', amount: -1800 - 2000 }]);
  expect(await store.income({ from: daysAgo(30), to: daysAgo(0), exclude: [fx.ids.salary] })).toEqual([]);
  expect((await store.transactions({ from: daysAgo(30), to: daysAgo(0), category: fx.ids.coffee, limit: 50 })).length).toBeGreaterThan(0);
});
