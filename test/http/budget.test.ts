import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import type { BudgetFiles } from '../../src/budget/plan-store.ts';
import type { PlanInput } from '../../src/budget/types.ts';
import type { createApp } from '../../src/http/app.ts';
import { formatAmount } from '../../src/http/format.ts';
import { type FakeStore, PLAN_SAVED, makeBudgetApp, plan, row, snapshot } from '../helpers/budget-http.ts';

let store: FakeStore;
let files: BudgetFiles;
let dir: string;
let setNow: (d: Date) => void;
let app: ReturnType<typeof createApp>;
const auth = { authorization: 'Bearer secret' };
const send = (method: string, body?: unknown) => ({ method, headers: { ...auth, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (path: string) => app.request(`/v1/budget${path}`, { headers: auth });
const post = (path: string, body: unknown) => app.request(`/v1/budget${path}`, send('POST', body));
const put = (path: string, body: unknown) => app.request(`/v1/budget${path}`, send('PUT', body));
const errCode = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const savePlan = () => files.savePlan(plan as never, { by: 't', why: 't' }, PLAN_SAVED);

beforeEach(() => {
  const made = makeBudgetApp({ now: new Date('2026-11-20T09:00:00Z') });
  ({ store, files, dir, app } = made);
  setNow = made.setNow;
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
  const rid = `review:${createHash('sha256').update('rv').digest('hex').slice(0, 12)}`;
  expect(b.events).toContainEqual({ id: rid, kind: 'review', count: 1 });
  setNow(new Date('2026-11-21T09:00:00Z')); // same unreviewed rows the next day: same id, no new alert
  const again = await (await get('/status')).json() as any;
  expect(again.events).toContainEqual({ id: rid, kind: 'review', count: 1 });
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
  store.failPrev = 'No budget exists for month: 2026-10';
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

test('propose: a real failure reading the previous month is not hidden as zero', async () => {
  savePlan();
  store.failPrev = 'connection lost';
  expect((await get('/propose?month=2026-11')).status).toBe(500);
});

const savePlanOf = (p: PlanInput) => files.savePlan(p as never, { by: 't', why: 't' }, PLAN_SAVED);
const statusOf = async (path = '/status') => (await (await get(path)).json()) as any;

test('C1: apply December, then November is limited to what December left', async () => {
  savePlan();
  const dec = await (await get('/propose?month=2026-12')).json() as any;
  expect((await post('/apply', { month: '2026-12', proposalId: dec.proposal.proposalId,
    amounts: { rent: 2800, groc: 1000 }, approvedBy: 's' })).status).toBe(200);
  expect(store.snaps.get('2026-12')!.toBudget).toBe(120000);

  const nov = await (await get('/propose?month=2026-11')).json() as any;
  expect(nov.proposal.available).toEqual({ amount: 120000, formatted: '1200.00' });
  expect(nov.proposal.lines.find((l: any) => l.categoryId === 'rent').propose.amount).toBe(120000);
  const over = await post('/apply', { month: '2026-11', proposalId: nov.proposal.proposalId, amounts: { rent: 1200.01 }, approvedBy: 's' });
  expect(over.status).toBe(400);
  expect(await errCode(over)).toBe('over_available');
  expect((await post('/apply', { month: '2026-11', proposalId: nov.proposal.proposalId, amounts: { rent: 1200 }, approvedBy: 's' })).status).toBe(200);
  expect(store.snaps.get('2026-12')!.toBudget).toBe(0); // November's gift came out of December's carry-over
  expect(((await (await get('/propose?month=2026-11')).json()) as any).proposal.available.amount).toBe(0);
});

test('C1: funding a later month after propose makes the proposal stale', async () => {
  savePlan();
  const id = await proposalId();
  store.snaps.set('2026-12', { ...snapshot('2026-12'), toBudget: 400000 }); // December changed since propose
  const r = await post('/apply', { month: '2026-11', proposalId: id, amounts: { rent: 10 }, approvedBy: 's' });
  expect(r.status).toBe(409);
  expect(await errCode(r)).toBe('stale_proposal');
  expect(store.writes).toEqual([]);
});

test('C1: later months are scanned only up to 12 months ahead', async () => {
  savePlan();
  store.months = ['2026-11', '2027-11', '2027-12'];
  store.snaps.set('2027-12', { ...snapshot('2027-12'), toBudget: 5 });
  expect(((await (await get('/propose?month=2026-11')).json()) as any).proposal.available.amount).toBe(500000);
  store.snaps.set('2027-11', { ...snapshot('2027-11'), toBudget: 7 });
  expect(((await (await get('/propose?month=2026-11')).json()) as any).proposal.available.amount).toBe(7);
});

test('I1: a manual edit visible only after sync makes apply return stale_proposal', async () => {
  savePlan();
  const id = await proposalId();
  store.onSync = () => { store.snaps.get('2026-11')!.toBudget += 100; };
  const r = await post('/apply', { month: '2026-11', proposalId: id, amounts: { rent: 10 }, approvedBy: 's' });
  expect(r.status).toBe(409);
  expect(await errCode(r)).toBe('stale_proposal');
  expect(store.writes).toEqual([]);
});

test('I1: propose, apply and move sync first; a sync failure is 503 sync_failed and writes nothing', async () => {
  savePlan();
  const id = await proposalId();
  const before = store.syncs;
  await get('/propose');
  expect(store.syncs).toBe(before + 1);
  store.failSync = true;
  const p = await get('/propose');
  expect(p.status).toBe(503);
  expect(await errCode(p)).toBe('sync_failed');
  const a = await post('/apply', { month: '2026-11', proposalId: id, amounts: { rent: 10 }, approvedBy: 's' });
  expect(a.status).toBe(503);
  expect(await errCode(a)).toBe('sync_failed');
  const m = await post('/move', { month: '2026-11', from: 'fun', to: 'groc', amount: 1, approvedBy: 's' });
  expect(m.status).toBe(503);
  expect(await errCode(m)).toBe('sync_failed');
  expect(store.writes).toEqual([]);
  expect(existsSync(join(dir, 'budget', 'writes.jsonl'))).toBe(false);
  store.failSync = false;
  expect((await post('/move', { month: '2026-11', from: 'fun', to: 'groc', amount: 1, approvedBy: 's' })).status).toBe(200);
});

test('I2: a salary row from the last day of the previous month still alerts after the month rolls over', async () => {
  savePlan();
  setNow(new Date('2026-12-02T09:00:00Z'));
  store.rows = [row({ id: 'nov30', date: '2026-11-30' })];
  const b = await statusOf();
  expect(b.month).toBe('2026-12');
  expect(b.events.map((e: any) => e.id)).toContain('income:nov30');
  // and when a past month is asked for, today's window rows are still reported
  expect((await statusOf('/status?month=2026-11')).events.map((e: any) => e.id)).toContain('income:nov30');
});

test('I2: a transfer due across the month boundary is reported missing from the next month', async () => {
  savePlanOf({ ...plan, incomeSources: [{ name: 'Alimony', payee: 'Inbal', expectedAmount: 5000, expectedDay: 29, fixedTransfer: true }] });
  setNow(new Date('2026-12-05T09:00:00Z'));
  const ids = async () => (await statusOf()).events.map((e: any) => e.id) as string[];
  expect(await ids()).toContain('transfer:2026-11');
  store.rows = [row({ id: 'alim', date: '2026-11-29', payee: 'Inbal', importedPayee: 'Inbal' })];
  expect(await ids()).not.toContain('transfer:2026-11');
});

test('I3: deposits into off-budget accounts do not count as income landed', async () => {
  savePlan();
  store.rows = [row({ id: 'sav', account: 'off' })];
  const b = await (await get('/propose')).json() as any;
  expect(b.landed).toEqual([]);
  expect((await statusOf()).events.map((e: any) => e.id)).not.toContain('income:sav');
});

test('I3: an income source with an account only matches rows in that account', async () => {
  savePlanOf({ ...plan, incomeSources: [{ name: 'Salary', payee: 'Employer', expectedAmount: 15000, expectedDay: 10, account: 'hap' }] });
  store.rows = [row({ id: 'elsewhere', account: 'a' })];
  expect(((await (await get('/propose')).json()) as any).landed).toEqual([]);
  store.rows = [row({ id: 'there', account: 'hap' })];
  const b = await (await get('/propose')).json() as any;
  expect(b.landed.map((l: any) => l.source)).toEqual(['Salary']);
});

test('M2: an unconfirmed write is journaled as unconfirmed, then the error surfaces; other failures stay unjournaled', async () => {
  savePlan();
  store.failWrite = 'unconfirmed';
  const a = await post('/apply', { month: '2026-11', proposalId: await proposalId(), amounts: { groc: 10 }, approvedBy: 'shai' });
  expect(a.status).toBe(500);
  const m = await post('/move', { month: '2026-11', from: 'fun', to: 'groc', amount: 1, approvedBy: 'shai' });
  expect(m.status).toBe(500);
  const lines = readFileSync(join(dir, 'budget', 'writes.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ op: 'apply', month: '2026-11', approvedBy: 'shai', outcome: 'unconfirmed', amounts: { groc: 101000 } });
  expect(lines[1]).toMatchObject({ op: 'move', month: '2026-11', from: 'fun', to: 'groc', amount: 100, outcome: 'unconfirmed' });
});

test('M3: a visible category that is not in the plan cannot be a move source', async () => {
  savePlan();
  const r = await post('/move', { month: '2026-11', from: 'misc', to: 'groc', amount: 1, approvedBy: 's' });
  expect(r.status).toBe(400);
  const err = ((await r.json()) as { error: { code: string; message: string } }).error;
  expect(err.code).toBe('protected_source');
  expect(err.message).toContain('not in the plan');
  // any visible expense category is still a valid destination
  expect((await post('/move', { month: '2026-11', from: 'fun', to: 'misc', amount: 1, approvedBy: 's' })).status).toBe(200);
});

test('status: a transfer due before the plan was first saved is never reported missing', async () => {
  files.savePlan({ ...plan, incomeSources: [{ name: 'Alimony', payee: 'Inbal', expectedAmount: 5000, expectedDay: 29, fixedTransfer: true }] } as never,
    { by: 't', why: 't' }, new Date('2026-12-04T08:00:00Z'));
  setNow(new Date('2026-12-05T09:00:00Z'));
  expect((await statusOf()).events.map((e: any) => e.id)).not.toContain('transfer:2026-11');
});

test('status: reads transactions and accounts once each for income', async () => {
  savePlan();
  await get('/status');
  expect(store.txQueries.filter(q => q.tag === undefined)).toHaveLength(1);
  expect(store.accountCalls).toBe(1);
});

test('status: planSince is the Jerusalem date of the first save (22:30Z is already the next day)', async () => {
  // Saved Dec 4 22:30Z = Dec 5 00:30 in Jerusalem. A November transfer (expectedDay 31) was due Dec 4: before the plan.
  files.savePlan({ ...plan, incomeSources: [{ name: 'Alimony', payee: 'Inbal', expectedAmount: 5000, expectedDay: 31, fixedTransfer: true }] } as never,
    { by: 't', why: 't' }, new Date('2026-12-04T22:30:00Z'));
  setNow(new Date('2026-12-06T09:00:00Z'));
  expect((await statusOf()).events.map((e: any) => e.id)).not.toContain('transfer:2026-11');
});

test('status: a far-past month is read with separate queries per range, not one huge span', async () => {
  savePlan();
  await get('/status?month=2026-01');
  const q = store.txQueries.filter(x => x.tag === undefined);
  expect(q.map(x => [x.from, x.to])).toEqual([['2025-12-01', '2026-02-06'], ['2026-10-16', '2026-11-20']]);
});

test('status: a past month reads 3+ days into the next month, so a transfer landing Nov 1 settles October', async () => {
  savePlanOf({ ...plan, incomeSources: [{ name: 'Alimony', payee: 'Inbal', expectedAmount: 5000, expectedDay: 29, fixedTransfer: true }] });
  setNow(new Date('2026-12-10T09:00:00Z'));
  store.rows = [row({ id: 'nov1', date: '2026-11-01', payee: 'Inbal', importedPayee: 'Inbal' })];
  expect((await statusOf('/status?month=2026-10')).events.map((e: any) => e.id)).not.toContain('transfer:2026-10');
});

test('status: a past month also reads the month before it, so a claimed grace row does not fake a missing transfer', async () => {
  // expectedDay 5. October has its own row (Oct 5), so the Nov 2 row is November's; without the October rows it looked like a late October one.
  savePlanOf({ ...plan, incomeSources: [{ name: 'Alimony', payee: 'Inbal', expectedAmount: 5000, expectedDay: 5, fixedTransfer: true }] });
  setNow(new Date('2026-12-09T09:00:00Z'));
  store.rows = [
    row({ id: 'oct5', date: '2026-10-05', payee: 'Inbal', importedPayee: 'Inbal' }),
    row({ id: 'nov2', date: '2026-11-02', payee: 'Inbal', importedPayee: 'Inbal' }),
  ];
  expect((await statusOf('/status?month=2026-11')).events.map((e: any) => e.id)).not.toContain('transfer:2026-11');
});

test('plan: an income source account that is a name, not an on-budget id, is refused on save and on load', async () => {
  const bad = { ...plan, incomeSources: [{ name: 'Salary', payee: 'Employer', expectedAmount: 15000, expectedDay: 1, account: 'Hapoalim' }] };
  const r = await put('/plan', { plan: bad, by: 't', why: 't' });
  expect(r.status).toBe(409);
  const msg = ((await r.json()) as any).error.message as string;
  expect(msg).toContain('Salary: Hapoalim');
  expect(msg).toContain('Hapoalim=hap');
  expect((await put('/plan', { plan: { ...bad, incomeSources: [{ ...bad.incomeSources[0], account: 'off' }] }, by: 't', why: 't' })).status).toBe(409);
  savePlanOf(bad);
  expect(await errCode(await get('/propose'))).toBe('stale_plan');
});

const m = (amount: number) => ({ amount, formatted: formatAmount(amount) });
const SECRETS = ['biz', 'Biz / Inbal', 'misc', 'Wants / Misc'];
const bodyOf = async (path: string, status = 200) => {
  const r = await get(path);
  expect(r.status).toBe(status);
  return await r.json() as any;
};
/** Gives the excluded and the unplanned category real figures in a month. */
const outsideSpend = (month: string, bizBudgeted: number) => {
  const s = snapshot(month);
  Object.assign(s.categories.find(c => c.id === 'biz')!, { budgeted: bizBudgeted, spent: -7000 });
  Object.assign(s.categories.find(c => c.id === 'misc')!, { budgeted: 1234, spent: -3000 });
  store.snaps.set(month, s);
};

test('summary identity: held and carry-over out are derived from Actual\'s totals', async () => {
  savePlan();
  store.totals.set('2026-11', { carryOverIn: 100000, income: 400000, lastMonthOverspent: -5000, budgeted: 180000, spent: 20000, toBudget: 305000 });
  const b = await bodyOf('/summary?month=2026-11');
  expect(b).toMatchObject({ month: '2026-11', partial: true, carryOverIn: m(100000), income: m(400000), lastMonthOverspent: m(-5000),
    toBudget: m(305000), carryOverOut: m(315000), heldForNextMonth: m(10000), uncategorized: { in: m(0), out: m(0) } });
  expect(b.budgeted).toEqual({ lines: m(180000), outside: m(0), total: m(180000) });
  expect(b.spent).toEqual({ lines: m(20000), outside: m(0), total: m(20000) });
  expect(store.syncs).toBeGreaterThan(0);
});

test('summary: lines plus outside equals the total, a negative outside figure included', async () => {
  savePlan();
  outsideSpend('2026-10', -4482635 - 0);
  store.snaps.get('2026-10')!.categories.find(c => c.id === 'misc')!.budgeted = 0;
  store.totals.set('2026-10', { carryOverIn: 0, income: 0, lastMonthOverspent: 0, budgeted: -4302635, spent: 20000, toBudget: 4302635 });
  const b = await bodyOf('/summary?month=2026-10');
  expect(b.partial).toBe(false);
  expect(b.budgeted).toEqual({ lines: m(180000), outside: m(-4482635), total: m(-4302635) });
});

test('no excluded leak: summary, history and one line\'s history name nothing outside the lines', async () => {
  savePlan();
  for (const month of ['2026-10', '2026-11']) outsideSpend(month, 999900);
  const entry = { month: '2026-11', approvedBy: 'shai' };
  files.journal({ ...entry, op: 'move', from: 'groc', to: 'misc', amount: 100 }, new Date('2026-11-03T00:00:00Z'));
  files.journal({ ...entry, op: 'apply', added: { biz: 5000, groc: 700 } }, new Date('2026-11-04T00:00:00Z'));
  for (const path of ['/summary?month=2026-11', '/history?month=2026-11', '/history?month=2026-11&categoryId=groc']) {
    const b = await bodyOf(path);
    for (const s of SECRETS) expect(JSON.stringify(b)).not.toContain(s);
    if (b.months) {
      const changes = b.months.find((x: any) => x.month === '2026-11').changes;
      expect(changes.map((e: any) => e.counterpart)).toEqual(["outside the plan's lines", "outside the plan's lines"]);
      expect(changes.map((e: any) => e.lines)).toEqual([[{ label: 'Needs / Groceries', change: m(-100) }], [{ label: 'Needs / Groceries', change: m(700) }]]);
    }
  }
});

test('history: six months ending at the asked one, negative amounts, change and missingMonths', async () => {
  savePlan();
  store.firstMonth = '2026-09';
  const sep = snapshot('2026-09');
  sep.categories.find(c => c.id === 'groc')!.budgeted = -5000;
  store.snaps.set('2026-09', sep);
  store.totals.set('2026-09', { carryOverIn: 0, income: 0, lastMonthOverspent: 0, budgeted: 75000, spent: 0, toBudget: 0 });
  const b = await bodyOf('/history?month=2026-11');
  expect(b.months.map((x: any) => x.month)).toEqual(['2026-09', '2026-10', '2026-11']);
  expect(b.missingMonths).toEqual(['2026-06', '2026-07', '2026-08']);
  expect(b.months.map((x: any) => [x.partial, x.firstMonth])).toEqual([[false, true], [false, false], [true, false]]);
  const groc = (i: number) => b.months[i].lines.find((l: any) => l.categoryId === 'groc');
  expect(groc(0)).toEqual({ categoryId: 'groc', label: 'Needs / Groceries', budgeted: m(-5000), change: null });
  expect(groc(1)).toEqual({ categoryId: 'groc', label: 'Needs / Groceries', budgeted: m(100000), change: m(105000) });
  expect(b.months[0].total).toEqual(m(75000));
  expect(b.months[0].outside).toEqual(m(0));
  expect(b.months[0].uncategorized).toEqual({ in: m(0), out: m(0) });
  expect(b.note).toBe('Only applies and moves made through the curator have a change record; edits made in Actual\'s own screen do not.');
});

test('history: the window\'s first month is compared with the month before the window', async () => {
  savePlan();
  const may = snapshot('2026-05');
  may.categories.find(c => c.id === 'groc')!.budgeted = 90000;
  store.snaps.set('2026-05', may);
  const b = await bodyOf('/history?month=2026-11');
  expect(b.months[0].month).toBe('2026-06');
  expect(b.months[0].lines.find((l: any) => l.categoryId === 'groc').change).toEqual(m(10000));
});

test('history with categoryId has that line only, with no outside, total or uncategorized', async () => {
  savePlan();
  const b = await bodyOf('/history?month=2026-11&categoryId=groc');
  for (const month of b.months) {
    expect(month.lines.map((l: any) => l.categoryId)).toEqual(['groc']);
    expect(Object.keys(month)).toEqual(['month', 'partial', 'firstMonth', 'lines', 'changes']);
  }
});

test('history: excluded, unplanned and unknown ids get one identical refusal', async () => {
  savePlan();
  const bodies = [];
  for (const id of ['biz', 'misc', 'nope', '']) bodies.push(await bodyOf(`/history?month=2026-11&categoryId=${id}`, 400));
  expect(bodies[0]).toEqual({ error: { code: 'bad_category', message: 'not a line of this budget' } });
  for (const b of bodies) expect(b).toEqual(bodies[0]);
});

test('history and summary: a line absent from a past snapshot is 0, not stale_plan', async () => {
  savePlan();
  const oct = snapshot('2026-10');
  oct.categories = oct.categories.filter(c => c.id !== 'groc');
  oct.categories.find(c => c.id === 'fun')!.hidden = true;
  store.snaps.set('2026-10', oct);
  const b = await bodyOf('/history?month=2026-11');
  const october = b.months.find((x: any) => x.month === '2026-10');
  for (const [id, label] of [['groc', 'Needs / Groceries'], ['fun', 'Wants / Fun']]) {
    expect(october.lines.find((l: any) => l.categoryId === id)).toMatchObject({ label, budgeted: m(0) });
  }
  expect((await bodyOf('/summary?month=2026-10')).budgeted.lines).toEqual(m(30000));
});

test('history: a corrupt or foreign journal line is skipped', async () => {
  savePlan();
  files.journal({ op: 'apply', month: '2026-11', approvedBy: 'shai', added: { groc: 100 } }, new Date('2026-11-03T00:00:00Z'));
  appendFileSync(join(dir, 'budget', 'writes.jsonl'), '{"at":"2026-11-04T00:00:00Z","op":"app\nnull\n{"op":"apply","month":"2026-11"}\n');
  const b = await bodyOf('/history?month=2026-11');
  expect(b.months.at(-1).changes).toHaveLength(1);
});

test('summary and history: 5000 rows in a month refuse instead of summing a truncated list', async () => {
  savePlan();
  store.rows = Array.from({ length: 5000 }, (_, i) => row({ id: `r${i}`, amount: -1 }));
  for (const path of ['/summary?month=2026-11', '/history?month=2026-11']) {
    expect((await bodyOf(path, 400)).error.code).toBe('too_many_rows');
  }
});

test('summary and history report the month\'s uncategorized money beside the totals', async () => {
  savePlan();
  store.rows = [row({ id: 'out', amount: -700 }), row({ id: 'in', amount: 300 }),
    row({ id: 'tr', amount: -9, transferId: 'x' }), row({ id: 'off', amount: -9, account: 'off' })];
  const want = { in: m(300), out: m(700) };
  expect((await bodyOf('/summary?month=2026-11')).uncategorized).toEqual(want);
  expect((await bodyOf('/history?month=2026-11')).months.at(-1).uncategorized).toEqual(want);
});

test('summary: no_data after the current month and before the first transaction month', async () => {
  savePlan();
  store.firstMonth = '2026-09';
  for (const month of ['2026-12', '2026-08']) {
    expect((await bodyOf(`/summary?month=${month}`, 404)).error.code).toBe('no_data');
  }
});

test('summary and history: no plan, no month and a failed sync are errors', async () => {
  for (const path of ['/summary?month=2026-11', '/history?month=2026-11']) {
    expect((await bodyOf(path, 409)).error.code).toBe('no_plan');
  }
  savePlan();
  for (const path of ['/summary', '/history']) expect((await get(path)).status).toBe(400);
  store.failSync = true;
  expect((await bodyOf('/history?month=2026-11', 503)).error.code).toBe('sync_failed');
});
