import { beforeEach, expect, test } from 'vitest';
import { regularIncome } from '../../src/budget/runway.ts';
import { type MonthSnapshot, type PlanInput, planSchema } from '../../src/budget/types.ts';
import { PLAN_SAVED, cat, makeBudgetApp, plan as helperPlan, row, snapshot } from '../helpers/budget-http.ts';

let ctx: ReturnType<typeof makeBudgetApp>;
/** The shared plan, expecting what these tests pay, so no source reads as off its expected amount. */
const plan: PlanInput = { ...helperPlan, incomeSources: [{ ...helperPlan.incomeSources[0]!, expectedAmount: 4000 }] };
const m = (amount: number) => ({ amount, formatted: (amount / 100).toFixed(2) });
const savePlan = (p: PlanInput = plan) => ctx.files.savePlan(p as never, { by: 't', why: 't' }, PLAN_SAVED);
const salary = (month: string, amount = 400000, over: object = {}) => row({ id: `sal-${month}-${amount}`, date: `${month}-10`, amount, category: 'sal', ...over });
const PAST = ['2026-08', '2026-09', '2026-10'];
/** Income of `amount` in each averaged month. */
const earn = (amount: number) => PAST.map(month => salary(month, amount));
/** Sets this month's totals so that the carry-over out is `out`. */
const carryOut = (out: number) => ctx.store.totals.set('2026-11',
  { carryOverIn: out + 180000, income: 0, lastMonthOverspent: 0, budgeted: 180000, spent: 20000, toBudget: out });
const snap = (edit: (s: MonthSnapshot) => void) => {
  const s = snapshot('2026-11');
  edit(s);
  ctx.store.snaps.set('2026-11', s);
};
const lineOf = (s: MonthSnapshot, id: string) => s.categories.find(c => c.id === id)!;
const get = () => ctx.app.request('/v1/budget/runway', { headers: { authorization: 'Bearer secret' } });
const run = async () => {
  const r = await get();
  expect(r.status).toBe(200);
  return await r.json() as any;
};
const fails = async (status: number, code: string) => {
  const r = await get();
  expect(r.status).toBe(status);
  expect(((await r.json()) as any).error.code).toBe(code);
};
const setaside = (due: string): PlanInput =>
  ({ ...plan, categories: [...plan.categories, { categoryId: 'trip', kind: 'setaside', priority: 4, target: 6000, due }] });

beforeEach(() => {
  ctx = makeBudgetApp({ now: new Date('2026-11-20T09:00:00Z') });
  savePlan();
  carryOut(1000000);
  ctx.store.rows = earn(400000);
});

test('limited: the available carry-over divided by the monthly gap, counting from next month', async () => {
  const b = await run();
  expect(b).toMatchObject({ month: '2026-11', status: 'limited', monthlyPlan: m(460000), averageIncome: m(400000), gap: m(60000),
    available: m(720000), carryOver: { carryOverOut: m(1000000), negativeBalances: m(0), stillNeeded: m(280000) },
    shortfall: null, months: 12, wholeMonths: 12, lastCoveredMonth: '2027-11', oneOffs: [] });
  expect(b.plannedLines).toEqual([
    { categoryId: 'rent', label: 'Needs / Rent', monthly: m(280000) }, { categoryId: 'groc', label: 'Needs / Groceries', monthly: m(100000) },
    { categoryId: 'fun', label: 'Wants / Fun', monthly: m(50000) }, { categoryId: 'prot', label: 'Needs / Insurance', monthly: m(30000) },
  ]);
  expect(b.incomeMonths).toEqual(PAST.map(month => ({ month, regular: [{ source: 'Salary', amount: m(400000) }], regularTotal: m(400000), other: m(0) })));
  expect(ctx.store.syncs).toBeGreaterThan(0);
});

test('the average is rounded to the agora', async () => {
  ctx.store.rows = [salary('2026-08', 100), salary('2026-09', 100), salary('2026-10', 101)];
  expect((await run()).averageIncome).toEqual(m(100));
});

test('money budgeted in later months does not shorten it', async () => {
  const before = (await run()).available;
  const december = snapshot('2026-12');
  december.toBudget = -9000000;
  ctx.store.snaps.set('2026-12', december);
  expect((await run()).available).toEqual(before);
});

test('a negative rollover balance is deducted', async () => {
  snap(s => Object.assign(lineOf(s, 'misc'), { balance: -100000, carryover: true }));
  expect((await run()).available).toEqual(m(620000));
});

test('an overspent line is not subtracted twice', async () => {
  snap(s => Object.assign(lineOf(s, 'groc'), { budgeted: 100000, balance: -20000 }));
  const b = await run();
  expect(b.carryOver).toEqual({ carryOverOut: m(1000000), negativeBalances: m(20000), stillNeeded: m(280000) });
  expect(b.available).toEqual(m(700000));
});

test('short_now wins over no_gap, and gives the shortfall', async () => {
  carryOut(100000);
  ctx.store.rows = earn(900000);
  expect(await run()).toMatchObject({ status: 'short_now', gap: m(-440000), available: m(-180000), shortfall: m(180000),
    months: 0, wholeMonths: 0, lastCoveredMonth: null });
});

test('short_now with exactly nothing available has no shortfall', async () => {
  carryOut(280000);
  expect(await run()).toMatchObject({ status: 'short_now', available: m(0), shortfall: null, months: 0 });
});

test('no_gap: no month count, a gap of exactly zero included', async () => {
  for (const income of [900000, 460000]) {
    ctx.store.rows = earn(income);
    expect(await run()).toMatchObject({ status: 'no_gap', available: m(720000), shortfall: null,
      months: null, wholeMonths: null, lastCoveredMonth: null });
  }
});

test('under one month', async () => {
  carryOut(304000);
  expect(await run()).toMatchObject({ status: 'limited', available: m(24000), months: 0.4, wholeMonths: 0, lastCoveredMonth: null });
});

test('months are rounded down', async () => {
  carryOut(339999);
  expect(await run()).toMatchObject({ available: m(59999), months: 0.9, wholeMonths: 0 });
});

test('a set-aside due this month is a one-off, taken once from the carry-over', async () => {
  savePlan(setaside('2026-11'));
  snap(s => s.categories.push(cat('trip', 'Wants / Trip', 0, 0)));
  const b = await run();
  expect(b.monthlyPlan).toEqual(m(460000));
  expect(b.plannedLines.some((l: any) => l.categoryId === 'trip')).toBe(false);
  expect(b.oneOffs).toEqual([{ label: 'Wants / Trip', due: '2026-11' }]);
  expect(b.carryOver.stillNeeded).toEqual(m(880000));
});

test('a set-aside due later is a monthly cost at its planned amount', async () => {
  savePlan(setaside('2027-05'));
  snap(s => s.categories.push(cat('trip', 'Wants / Trip', 0, 0)));
  const b = await run();
  // 6000.00 over November to May, seven months, rounded up to the agora.
  expect(b.plannedLines.at(-1)).toEqual({ categoryId: 'trip', label: 'Wants / Trip', monthly: m(85715) });
  expect(b.monthlyPlan).toEqual(m(545715));
  expect(b.oneOffs).toEqual([]);
});

test('regular income: only deposits matching a counted source; other is the uncounted income-category money', () => {
  const p = planSchema.parse({ ...plan, incomeSources: [
    { name: 'Salary', payee: 'Employer', expectedAmount: 1, expectedDay: 1 },
    { name: 'Savings draw', payee: 'Savings', expectedAmount: 1, expectedDay: 1, fixedTransfer: true },
    { name: 'Second', payee: 'Nobody', expectedAmount: 1, expectedDay: 1 },
  ] });
  const named = (id: string, importedPayee: string, amount: number, over: object = {}) =>
    row({ id, importedPayee, payee: importedPayee, amount, category: 'sal', ...over });
  expect(regularIncome(p, [
    named('fixed', 'Savings', 11), named('transfer', 'Employer', 22, { transferId: 'x', category: null }),
    named('off', 'Employer', 33, { account: 'off', category: null }), named('unmatched', 'Gift', 44),
    named('uncat', 'Employer', 55, { category: null }), named('paid', 'Employer', 66, { category: 'groc' }),
  ], new Set(['sal']), new Set(['off']))).toEqual({
    regular: [{ source: 'Salary', amount: 121 }, { source: 'Second', amount: 0 }], regularTotal: 121, other: 55,
  });
});

test('a row takes the first source it matches: a fixed transfer listed first is not counted by a later one', () => {
  const p = planSchema.parse({ ...plan, incomeSources: [
    { name: 'Draw', payee: 'Bank draw', expectedAmount: 1, expectedDay: 1, fixedTransfer: true },
    { name: 'Any', payee: 'Bank', expectedAmount: 1, expectedDay: 1 },
  ] });
  expect(regularIncome(p, [row({ importedPayee: 'Bank draw', amount: 9, category: 'sal' })], new Set(['sal']), new Set()))
    .toEqual({ regular: [{ source: 'Any', amount: 0 }], regularTotal: 0, other: 9 });
});

test('not_enough_history unless all three months come after the first transaction month', async () => {
  ctx.store.firstMonth = '2026-08';
  await fails(409, 'not_enough_history');
  ctx.store.firstMonth = null;
  await fails(409, 'not_enough_history');
  ctx.store.firstMonth = '2026-07';
  expect((await get()).status).toBe(200);
});

test('no_income_sources when every source is a fixed transfer, or there is none', async () => {
  savePlan({ ...plan, incomeSources: [{ name: 'Draw', payee: 'x', expectedAmount: 1, expectedDay: 1, fixedTransfer: true }] });
  await fails(409, 'no_income_sources');
  savePlan({ ...plan, incomeSources: [] });
  await fails(409, 'no_income_sources');
});

test('too_many_rows, no_plan, stale_plan and a failed sync are errors', async () => {
  ctx.store.rows = Array.from({ length: 5000 }, (_, i) => row({ id: `r${i}`, date: '2026-09-02', amount: -1 }));
  await fails(400, 'too_many_rows');
  snap(s => { s.categories = s.categories.filter(c => c.id !== 'groc'); });
  await fails(409, 'stale_plan');
  ctx.store.failSync = true;
  await fails(503, 'sync_failed');
  ctx = makeBudgetApp();
  await fails(409, 'no_plan');
});

const ALWAYS_LESS = { effect: 'less', text: "Spending outside the plan's lines is not in the monthly gap." };
const ALWAYS = { effect: 'always', text: 'The plan and its income sources are used as saved: a line or source that has ended or not started counts as written. Savings outside Actual are not counted.' };

test('notes: with nothing uncategorized, all income landed and no balances, only the two standing ones', async () => {
  snap(s => { for (const c of s.categories) c.balance = 0; });
  ctx.store.rows.push(salary('2026-11'));
  expect((await run()).notes).toEqual([ALWAYS_LESS, ALWAYS]);
});

test('notes: uncategorized outflows of this and the three averaged months, income not landed, money in balances', async () => {
  const out = (id: string, date: string, amount: number) => row({ id, date, amount, importedPayee: 'Shop', payee: 'Shop' });
  ctx.store.rows.push(out('u1', '2026-08-02', -100), out('u2', '2026-11-02', -250), out('old', '2026-07-31', -9999),
    salary('2026-11', 400000, { id: 'off-pay', account: 'off' }));
  savePlan({ ...plan, incomeSources: [...plan.incomeSources,
    { name: 'Draw', payee: 'Draw', expectedAmount: 1, expectedDay: 1, fixedTransfer: true }] });
  expect((await run()).notes).toEqual([
    ALWAYS_LESS,
    { effect: 'less', text: 'Uncategorized spending is not deducted.', amount: m(350) },
    { effect: 'longer', text: 'Expected income "Salary" has not landed this month and is not counted.' },
    { effect: 'longer', text: 'Money already in category balances is not counted.' },
    ALWAYS,
  ]);
});

test('no excluded or unplanned name or id appears', async () => {
  snap(s => {
    Object.assign(lineOf(s, 'biz'), { budgeted: 999900, spent: -7000, balance: -7000 });
    Object.assign(lineOf(s, 'misc'), { budgeted: 1234, spent: -3000, balance: 500 });
  });
  ctx.store.rows.push(row({ id: 'b', date: '2026-10-02', amount: -50, category: 'biz' }));
  const text = JSON.stringify(await run());
  for (const s of ['biz', 'Biz / Inbal', 'misc', 'Wants / Misc']) expect(text).not.toContain(s);
});

test('a stale excluded category is counted in the error, never named; a stale line is still named', async () => {
  const hidden = (...ids: string[]) => snap(s => { for (const id of ids) lineOf(s, id).hidden = true; });
  const message = async (path: string) => {
    const r = await ctx.app.request(`/v1/budget${path}`, { headers: { authorization: 'Bearer secret' } });
    expect(r.status).toBe(409);
    return ((await r.json()) as any).error.message as string;
  };
  hidden('biz');
  for (const path of ['/runway', '/summary?month=2026-11', '/history?month=2026-11', '/status']) {
    expect(await message(path)).toBe('plan categories missing or hidden in Actual: 1 excluded (not named)');
  }
  hidden('biz', 'groc');
  expect(await message('/runway')).toBe('plan categories missing or hidden in Actual: groc, 1 excluded (not named)');
});

const averageNote = (effect: string, average: string, deposits: number, expected = '4000.00', name = 'Salary') => ({ effect,
  text: `Income "${name}": the three averaged months give ${average} a month (${deposits} deposit(s)); the plan expects ${expected}. `
    + `At the plan's amount the money would last ${effect === 'less' ? 'less' : 'longer'}.` });
const incomeNotes = async () => (await run()).notes.filter((x: any) => x.text.startsWith('Income "'));

test('notes: an irregular source averaging above the plan means the money may last less, whatever the deposit count', async () => {
  savePlan({ ...plan, incomeSources: [...plan.incomeSources, { name: 'Draw', payee: 'Draw', expectedAmount: 5000, expectedDay: 19 }] });
  const draw = (month: string, amount: number) =>
    row({ id: `draw-${month}`, date: `${month}-19`, amount, category: 'sal', payee: 'Draw', importedPayee: 'Draw' });
  ctx.store.rows.push(draw('2026-08', 2000000), draw('2026-10', 1000000));
  expect(await incomeNotes()).toEqual([averageNote('less', '10000.00', 2, '5000.00', 'Draw')]);
});

test('notes: a source averaging below the plan means the money may last longer', async () => {
  ctx.store.rows = earn(400000).slice(1);
  expect(await incomeNotes()).toEqual([averageNote('longer', '2666.67', 2)]);
});

test('notes: an extra deposit that raises the average is reported by its effect on the money', async () => {
  ctx.store.rows = [...earn(400000), salary('2026-10', 400001, { date: '2026-10-30' })];
  expect(await incomeNotes()).toEqual([averageNote('less', '5333.34', 4)]);
});

test('notes: an average within 10% of the plan, either way, is not flagged; just past it is', async () => {
  for (const amount of [440000, 360000]) {
    ctx.store.rows = earn(amount);
    expect(await incomeNotes()).toEqual([]);
  }
  ctx.store.rows = earn(440100);
  expect(await incomeNotes()).toEqual([averageNote('less', '4401.00', 3)]);
  ctx.store.rows = earn(359900);
  expect(await incomeNotes()).toEqual([averageNote('longer', '3599.00', 3)]);
});

test('notes: three deposits spread unevenly give the same average, so no note', async () => {
  ctx.store.rows = [salary('2026-08'), salary('2026-10', 400000, { date: '2026-10-01', id: 'a' }), salary('2026-10', 400000, { date: '2026-10-31', id: 'b' })];
  expect(await incomeNotes()).toEqual([]);
});

test('notes: money received this month with no category is not available, and the answer says so', async () => {
  // It matches the salary source, so no "has not landed" note covers it.
  ctx.store.rows.push(salary('2026-11', 400000, { category: null }),
    salary('2026-10', 777, { category: null, id: 'old-in', payee: 'Gift', importedPayee: 'Gift' }));
  const notes = (await run()).notes;
  expect(notes).toContainEqual({ effect: 'longer', text: 'Uncategorized money received this month is not counted until it has a category.', amount: m(400000) });
  expect(notes.some((x: any) => x.text.includes('has not landed'))).toBe(false);
});

const expecting = (amount: number) => savePlan({ ...plan, incomeSources: [{ ...plan.incomeSources[0]!, expectedAmount: amount }] });

test('atPlan: the same money and plan, with income at the expected amounts; the recent figure is unchanged', async () => {
  expecting(3500);
  const b = await run();
  expect(b).toMatchObject({ status: 'limited', averageIncome: m(400000), gap: m(60000), months: 12 });
  expect(b.atPlan).toEqual({ income: m(350000), sources: [{ source: 'Salary', amount: m(350000) }], gap: m(110000),
    status: 'limited', months: 6.5, wholeMonths: 6, lastCoveredMonth: '2027-05' });
});

test('atPlan: adds every counted source, to the agora, and leaves out a fixed transfer', async () => {
  savePlan({ ...plan, incomeSources: [
    { ...plan.incomeSources[0]!, expectedAmount: 3000.5 },
    { name: 'Side', payee: 'Side', expectedAmount: 499.5, expectedDay: 19 },
    { name: 'Savings', payee: 'Savings', expectedAmount: 9000, expectedDay: 1, fixedTransfer: true },
  ] });
  expect((await run()).atPlan).toMatchObject({ income: m(350000), gap: m(110000),
    sources: [{ source: 'Salary', amount: m(300050) }, { source: 'Side', amount: m(49950) }] });
});

test('atPlan: its own status, either way round', async () => {
  expecting(4600);
  let b = await run();
  expect(b.status).toBe('limited');
  expect(b.atPlan).toMatchObject({ status: 'no_gap', gap: m(0), months: null, wholeMonths: null, lastCoveredMonth: null });
  expecting(4000);
  ctx.store.rows = earn(500000);
  b = await run();
  expect(b.status).toBe('no_gap');
  expect(b.atPlan).toMatchObject({ status: 'limited', gap: m(60000), months: 12, wholeMonths: 12 });
});

test('atPlan: nothing available is short_now in both, with no months', async () => {
  carryOut(100000);
  const b = await run();
  expect(b.status).toBe('short_now');
  expect(b.atPlan).toMatchObject({ status: 'short_now', months: 0, wholeMonths: 0, lastCoveredMonth: null });
});
