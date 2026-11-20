import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import type { CuratorRow } from '../../src/actual/types.ts';
import type { CategoryOption } from '../../src/classifier/types.ts';
import { BudgetFiles } from '../../src/budget/plan-store.ts';
import type { MonthSnapshot, PlanInput } from '../../src/budget/types.ts';
import { type ApiStore, createApp } from '../../src/http/app.ts';
import { DecisionLog } from '../../src/log.ts';
import { parseVocabulary } from '../../src/vocabulary.ts';

const vocab = parseVocabulary(`
tags:
  - { tag: kids, meaning: for a child }
genericPayees: [PAYBOX]
memoKeyPatterns: []
`);

const cat = (id: string, label: string, budgeted: number, spent: number, extra: object = {}) =>
  ({ id, label, hidden: false, isIncome: false, budgeted, spent, balance: budgeted + spent, ...extra });
const snapshot = (month: string): MonthSnapshot => ({
  month, toBudget: 500000,
  categories: [
    cat('rent', 'Needs / Rent', 0, 0),
    cat('groc', 'Needs / Groceries', 100000, -20000),
    cat('fun', 'Wants / Fun', 50000, 0),
    cat('prot', 'Needs / Insurance', 30000, 0),
    cat('biz', 'Biz / Inbal', 0, month === '2026-10' ? -50000 : 0),
    cat('old', 'Old', 0, 0, { hidden: true }),
    cat('sal', 'Income / Salary', 0, 0, { isIncome: true }),
    cat('misc', 'Wants / Misc', 0, 0),
  ],
});
const plan: PlanInput = {
  version: 1,
  categories: [
    { categoryId: 'rent', kind: 'fixed', priority: 1, amount: 2800 },
    { categoryId: 'groc', kind: 'variable', priority: 2, amount: 1000 },
    { categoryId: 'fun', kind: 'variable', priority: 3, amount: 500 },
    { categoryId: 'prot', kind: 'variable', priority: 2, amount: 300, protected: true },
    { categoryId: 'biz', kind: 'excluded', priority: 9 },
  ],
  incomeSources: [{ name: 'Salary', payee: 'Employer', expectedAmount: 15000, expectedDay: 10 }],
};
const row = (over: Partial<CuratorRow>): CuratorRow => ({ id: 't', date: '2026-11-10', account: 'a', accountName: 'Bank',
  amount: 1500000, payee: 'Employer', importedPayee: 'Employer', notes: '', category: null, transferId: null, ...over });

class FakeStore implements ApiStore {
  snaps = new Map<string, MonthSnapshot>();
  rows: CuratorRow[] = [];
  writes: { month: string; amounts: Record<string, number> }[] = [];
  txQueries: { from: string; to: string; tag?: string; limit: number }[] = [];
  async sync() {}
  async categories() { return [] as CategoryOption[]; }
  async transactions(q: { from: string; to: string; tag?: string; limit: number }) {
    this.txQueries.push(q);
    return this.rows.filter(r => r.date >= q.from && r.date <= q.to && (!q.tag || (r.notes ?? '').includes(`#${q.tag}`)));
  }
  async transaction() { return undefined; }
  async update() {}
  async rules() { return []; }
  async replaceRule() { return 'r'; }
  async deleteRule() { return false; }
  async spend() { return []; }
  async income() { return []; }
  async budgetMonth(month: string) {
    if (this.failPrev && month === '2026-10') throw new Error('No budget exists for month: 2026-10');
    if (!this.snaps.has(month)) this.snaps.set(month, snapshot(month));
    return structuredClone(this.snaps.get(month)!);
  }
  failWrite = false;
  failPrev = false;
  async setBudgeted(month: string, amounts: Record<string, number>) {
    await Promise.resolve();
    if (this.failWrite) throw new Error('boom');
    const s = await this.budgetMonth(month);
    const unknown = Object.keys(amounts).filter(id => !s.categories.some(c => c.id === id));
    if (unknown.length) throw new Error(`unknown category id(s): ${unknown.join(', ')}`);
    this.writes.push({ month, amounts });
    for (const [id, a] of Object.entries(amounts)) {
      const c = s.categories.find(x => x.id === id)!;
      s.toBudget -= a - c.budgeted;
      c.balance += a - c.budgeted;
      c.budgeted = a;
    }
    this.snaps.set(month, s);
  }
}

let store: FakeStore;
let files: BudgetFiles;
let dir: string;
let app: ReturnType<typeof createApp>;
const auth = { authorization: 'Bearer secret' };
const send = (method: string, body?: unknown) => ({ method, headers: { ...auth, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (path: string) => app.request(`/v1/budget${path}`, { headers: auth });
const post = (path: string, body: unknown) => app.request(`/v1/budget${path}`, send('POST', body));
const put = (path: string, body: unknown) => app.request(`/v1/budget${path}`, send('PUT', body));
const errCode = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const savePlan = () => files.savePlan(plan as never, { by: 't', why: 't' }, new Date());

beforeEach(() => {
  store = new FakeStore();
  dir = mkdtempSync(join(tmpdir(), 'curator-budget-'));
  files = new BudgetFiles(dir);
  app = createApp({ store, log: new DecisionLog(dir), vocab, cfg: { token: 'secret', currency: 'ILS' }, classifierName: 'fake',
    runNow: async () => { throw new Error('unused'); }, versions: { curator: '0.2.0', actualApi: '1', server: '1' },
    status: () => ({}), budget: files, now: () => new Date('2026-11-20T09:00:00Z') });
});

test('GET plan: null before any save', async () => {
  const r = await get('/plan');
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ plan: null });
});

test('PUT plan: saves and records by/why', async () => {
  const r = await put('/plan', { plan, by: 'shai', why: 'initial' });
  expect(r.status).toBe(200);
  expect(files.plan()?.categories).toHaveLength(5);
  const hist = readFileSync(join(dir, 'budget', 'plan-history.jsonl'), 'utf8');
  expect(hist).toContain('"by":"shai"');
  expect(hist).toContain('"why":"initial"');
  expect(((await (await get('/plan')).json()) as { plan: { version: number } }).plan.version).toBe(1);
});

test('PUT plan: unknown category -> 409 stale_plan and nothing saved', async () => {
  const bad = { ...plan, categories: [...plan.categories, { categoryId: 'ghost', kind: 'variable', priority: 5, amount: 10 }] };
  const r = await put('/plan', { plan: bad, by: 'a', why: 'b' });
  expect(r.status).toBe(409);
  expect(await errCode(r)).toBe('stale_plan');
  expect(existsSync(join(dir, 'budget', 'plan.json'))).toBe(false);
});

test('PUT plan: malformed body -> 400 bad_request; more than 2 decimals rejected', async () => {
  const r = await put('/plan', { by: 'a' });
  expect(r.status).toBe(400);
  expect(await errCode(r)).toBe('bad_request');
  const dec = { ...plan, categories: [{ categoryId: 'rent', kind: 'fixed', priority: 1, amount: 10.123 }] };
  expect((await put('/plan', { plan: dec, by: 'a', why: 'b' })).status).toBe(400);
});

test('propose: no plan -> 409 no_plan', async () => {
  const r = await get('/propose?month=2026-11');
  expect(r.status).toBe(409);
  expect(await errCode(r)).toBe('no_plan');
});

test('propose: past month -> 400 past_month; bad month format -> 400', async () => {
  savePlan();
  const r = await get('/propose?month=2026-10');
  expect(r.status).toBe(400);
  expect(await errCode(r)).toBe('past_month');
  expect((await get('/propose?month=nope')).status).toBe(400);
});

test('propose: returns lines with money(), the landed salary and excluded spend of last month', async () => {
  savePlan();
  store.rows = [row({})];
  const r = await get('/propose');
  expect(r.status).toBe(200);
  const b = await r.json() as any;
  expect(b.proposal.month).toBe('2026-11');
  expect(b.proposal.available).toEqual({ amount: 500000, formatted: '5000.00' });
  const rent = b.proposal.lines.find((l: any) => l.categoryId === 'rent');
  expect(rent.planned).toEqual({ amount: 280000, formatted: '2800.00' });
  expect(rent.propose).toEqual({ amount: 280000, formatted: '2800.00' });
  expect(b.proposal.lines.some((l: any) => l.categoryId === 'biz')).toBe(false);
  expect(b.landed).toEqual([{ source: 'Salary', amount: { amount: 1500000, formatted: '15000.00' }, date: '2026-11-10' }]);
  expect(b.expected).toEqual([]);
  expect(b.excludedSpentLastMonth).toEqual({ amount: 50000, formatted: '500.00' });
});

test('propose: expected lists a source with no deposit yet', async () => {
  savePlan();
  const b = await (await get('/propose?month=2026-11')).json() as any;
  expect(b.landed).toEqual([]);
  expect(b.expected).toEqual([{ source: 'Salary', expectedDay: 10 }]);
});

const proposalId = async () => ((await (await get('/propose')).json()) as any).proposal.proposalId as string;

test('apply: writes added amounts on top of budgeted and journals', async () => {
  savePlan();
  const id = await proposalId();
  const r = await post('/apply', { month: '2026-11', proposalId: id, amounts: { groc: 50, misc: 100.5 }, approvedBy: 'shai' });
  expect(r.status).toBe(200);
  expect(store.writes).toEqual([{ month: '2026-11', amounts: { groc: 105000, misc: 10050 } }]);
  const b = await r.json() as any;
  expect(b.month).toBe('2026-11');
  expect(b.applied).toEqual([
    { categoryId: 'groc', label: 'Needs / Groceries', added: { amount: 5000, formatted: '50.00' }, budgeted: { amount: 105000, formatted: '1050.00' } },
    { categoryId: 'misc', label: 'Wants / Misc', added: { amount: 10050, formatted: '100.50' }, budgeted: { amount: 10050, formatted: '100.50' } },
  ]);
  expect(b.toBudget).toEqual({ amount: 500000 - 15050, formatted: '4849.50' });
  const j = readFileSync(join(dir, 'budget', 'writes.jsonl'), 'utf8');
  expect(j).toContain('"op":"apply"');
  expect(j).toContain('"approvedBy":"shai"');
});

test('apply: shekel 2800 becomes 280000 minor', async () => {
  savePlan();
  await post('/apply', { month: '2026-11', proposalId: await proposalId(), amounts: { rent: 2800 }, approvedBy: 'shai' });
  expect(store.writes[0]!.amounts.rent).toBe(280000);
});

test('apply: stale proposalId -> 409 stale_proposal and no write', async () => {
  savePlan();
  const id = await proposalId();
  store.snaps.get('2026-11')!.toBudget += 100; // a deposit landed after propose
  const r = await post('/apply', { month: '2026-11', proposalId: id, amounts: { rent: 100 }, approvedBy: 'shai' });
  expect(r.status).toBe(409);
  expect(await errCode(r)).toBe('stale_proposal');
  expect(store.writes).toEqual([]);
});

test('apply: sum over toBudget -> 400 over_available', async () => {
  savePlan();
  const r = await post('/apply', { month: '2026-11', proposalId: await proposalId(), amounts: { rent: 3000, groc: 2001 }, approvedBy: 's' });
  expect(r.status).toBe(400);
  expect(await errCode(r)).toBe('over_available');
  expect(store.writes).toEqual([]);
});

test.each([['biz'], ['sal'], ['old'], ['ghost']])('apply: %s -> 400 bad_category', async id => {
  savePlan();
  const r = await post('/apply', { month: '2026-11', proposalId: await proposalId(), amounts: { [id]: 10 }, approvedBy: 's' });
  expect(r.status).toBe(400);
  expect(await errCode(r)).toBe('bad_category');
});

test('apply: no plan -> 409 no_plan; past month -> 400; bad body -> 400; 3 decimals -> 400', async () => {
  const body = { month: '2026-11', proposalId: 'x', amounts: { rent: 1 }, approvedBy: 's' };
  expect(await errCode(await post('/apply', body))).toBe('no_plan');
  savePlan();
  expect(await errCode(await post('/apply', { ...body, month: '2026-10' }))).toBe('past_month');
  expect((await post('/apply', { month: '2026-11' })).status).toBe(400);
  expect((await post('/apply', { ...body, amounts: { rent: 1.005 } })).status).toBe(400);
  expect((await post('/apply', { ...body, amounts: { rent: -1 } })).status).toBe(400);
});

test('apply: stale plan (category hidden in Actual) -> 409 stale_plan', async () => {
  savePlan();
  const s = snapshot('2026-11');
  s.categories.find(c => c.id === 'fun')!.hidden = true;
  store.snaps.set('2026-11', s);
  expect(await errCode(await post('/apply', { month: '2026-11', proposalId: 'x', amounts: { rent: 1 }, approvedBy: 's' }))).toBe('stale_plan');
});

test('move: moves between categories, writes both absolute values and journals', async () => {
  savePlan();
  const r = await post('/move', { month: '2026-11', from: 'fun', to: 'groc', amount: 100, approvedBy: 'shai' });
  expect(r.status).toBe(200);
  expect(store.writes).toEqual([{ month: '2026-11', amounts: { fun: 40000, groc: 110000 } }]);
  const b = await r.json() as any;
  expect(b.from).toEqual({ id: 'fun', label: 'Wants / Fun', budgeted: { amount: 40000, formatted: '400.00' }, balance: { amount: 40000, formatted: '400.00' } });
  expect(b.to.balance).toEqual({ amount: 90000, formatted: '900.00' });
  expect(readFileSync(join(dir, 'budget', 'writes.jsonl'), 'utf8')).toContain('"op":"move"');
});

test('move: more than balance -> 400 insufficient_balance', async () => {
  savePlan();
  const r = await post('/move', { month: '2026-11', from: 'fun', to: 'groc', amount: 500.01, approvedBy: 's' });
  expect(r.status).toBe(400);
  expect(await errCode(r)).toBe('insufficient_balance');
  expect(store.writes).toEqual([]);
});

test.each([['prot'], ['biz']])('move: source %s -> 400 protected_source', async from => {
  savePlan();
  const r = await post('/move', { month: '2026-11', from, to: 'groc', amount: 1, approvedBy: 's' });
  expect(r.status).toBe(400);
  expect(await errCode(r)).toBe('protected_source');
});

test.each([['biz'], ['sal'], ['old'], ['ghost']])('move: destination %s -> 400 bad_category', async to => {
  savePlan();
  const r = await post('/move', { month: '2026-11', from: 'fun', to, amount: 1, approvedBy: 's' });
  expect(await errCode(r)).toBe('bad_category');
});

test('move: unknown source -> bad_category; past month -> past_month; no plan -> no_plan', async () => {
  const body = { month: '2026-11', from: 'fun', to: 'groc', amount: 1, approvedBy: 's' };
  expect(await errCode(await post('/move', body))).toBe('no_plan');
  savePlan();
  expect(await errCode(await post('/move', { ...body, from: 'ghost' }))).toBe('bad_category');
  expect(await errCode(await post('/move', { ...body, month: '2026-10' }))).toBe('past_month');
  expect((await post('/move', { ...body, amount: 0 })).status).toBe(400);
});

test('status: shape, money() everywhere, and review count over the last 30 days', async () => {
  savePlan();
  store.rows = [row({ id: 'rv', date: '2026-11-15', amount: -500, notes: '#review' })];
  const r = await get('/status');
  expect(r.status).toBe(200);
  const b = await r.json() as any;
  expect(b.month).toBe('2026-11');
  expect(b.today).toBe('2026-11-20');
  expect(b.totals.budgeted.formatted).toBe('1800.00');
  expect(b.lines.find((l: any) => l.categoryId === 'groc').spent).toEqual({ amount: 20000, formatted: '200.00' });
  expect(b.lines.some((l: any) => l.categoryId === 'biz')).toBe(false);
  expect(b.events).toContainEqual({ id: 'review:2026-11-20', kind: 'review', count: 1 });
  const q = store.txQueries.find(x => x.tag === 'review')!;
  expect(q).toMatchObject({ from: '2026-10-21', to: '2026-11-20' });
});

test('status: events repeat until acked, then not', async () => {
  savePlan();
  store.rows = [row({})];
  const ids = async () => ((await (await get('/status')).json()) as any).events.map((e: any) => e.id) as string[];
  expect(await ids()).toContain('income:t');
  expect(await ids()).toContain('income:t');
  const ev = ((await (await get('/status')).json()) as any).events.find((e: any) => e.id === 'income:t');
  expect(ev.amount).toEqual({ amount: 1500000, formatted: '15000.00' });
  expect(ev.source).toBe('Salary');
  const ack = await post('/status/ack', { ids: ['income:t'] });
  expect(await ack.json()).toEqual({ acked: 1 });
  expect(await ids()).not.toContain('income:t');
  expect((await post('/status/ack', { ids: 'x' })).status).toBe(400);
});

test('status: past month allowed with no suggested moves; no plan -> 409', async () => {
  expect(await errCode(await get('/status'))).toBe('no_plan');
  savePlan();
  const r = await get('/status?month=2026-10');
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).moves).toEqual([]);
});

test('budget routes need the bearer', async () => {
  expect((await app.request('/v1/budget/plan')).status).toBe(401);
});

test('apply: two concurrent applies with the same proposalId write once; the other is 409 stale_proposal', async () => {
  savePlan();
  const id = await proposalId();
  const go = () => post('/apply', { month: '2026-11', proposalId: id, amounts: { groc: 10 }, approvedBy: 's' });
  const rs = await Promise.all([go(), go()]);
  expect(rs.map(r => r.status).sort()).toEqual([200, 409]);
  expect(await errCode(rs.find(r => r.status === 409)!)).toBe('stale_proposal');
  expect(store.writes).toHaveLength(1);
  expect(store.snaps.get('2026-11')!.categories.find(c => c.id === 'groc')!.budgeted).toBe(101000);
});

test('apply and move: when setBudgeted throws nothing is journaled', async () => {
  savePlan();
  store.failWrite = true;
  const a = await post('/apply', { month: '2026-11', proposalId: await proposalId(), amounts: { groc: 10 }, approvedBy: 's' });
  expect(a.status).toBe(500);
  const m = await post('/move', { month: '2026-11', from: 'fun', to: 'groc', amount: 1, approvedBy: 's' });
  expect(m.status).toBe(500);
  expect(existsSync(join(dir, 'budget', 'writes.jsonl'))).toBe(false);
  store.failWrite = false;
  expect((await post('/move', { month: '2026-11', from: 'fun', to: 'groc', amount: 1, approvedBy: 's' })).status).toBe(200);
});

test('propose: excludedSpentLastMonth is 0 when Actual has no budget for the previous month', async () => {
  savePlan();
  store.failPrev = true;
  const r = await get('/propose?month=2026-11');
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).excludedSpentLastMonth).toEqual({ amount: 0, formatted: '0.00' });
});

test('apply: empty amounts -> 400 bad_request', async () => {
  savePlan();
  const r = await post('/apply', { month: '2026-11', proposalId: await proposalId(), amounts: {}, approvedBy: 's' });
  expect(r.status).toBe(400);
  expect(await errCode(r)).toBe('bad_request');
});

test('apply: a protected category can be funded', async () => {
  savePlan();
  expect((await post('/apply', { month: '2026-11', proposalId: await proposalId(), amounts: { prot: 5 }, approvedBy: 's' })).status).toBe(200);
});
