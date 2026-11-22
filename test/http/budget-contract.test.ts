// Committed response fixtures for every budget route. The ausie repo copies contract/budget/*.json and tests its MCP tools
// against them, so a change to a route's shape shows up here as a snapshot diff before it can break the other repo.
// Regenerate with `npx vitest run test/http/budget-contract.test.ts -u` and review the diff.
import { beforeEach, expect, test } from 'vitest';
import type { PlanInput } from '../../src/budget/types.ts';
import { PLAN_SAVED, cat, makeBudgetApp, plan, row, snapshot } from '../helpers/budget-http.ts';

// 2026-11-15 09:00 in Jerusalem (+02:00).
const NOW = new Date('2026-11-15T09:00:00+02:00');
// The status fixture runs a week later: a set-aside only reads `watch` from the 20th of its month.
const STATUS_NOW = new Date('2026-11-22T09:00:00+02:00');

let ctx: ReturnType<typeof makeBudgetApp>;
const auth = { authorization: 'Bearer secret' };
const json = (method: string, body: unknown) => ({ method, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string) => ctx.app.request(`/v1/budget${path}`, { headers: auth });
const post = (path: string, body: unknown) => ctx.app.request(`/v1/budget${path}`, json('POST', body));
const savePlan = (p: PlanInput = plan) => ctx.files.savePlan(p as never, { by: 't', why: 't' }, PLAN_SAVED);

async function expectFixture(name: string, route: string, r: Response, status: number) {
  expect(r.status).toBe(status);
  const text = JSON.stringify({ route, status: r.status, body: await r.json() }, null, 2) + '\n';
  await expect(text).toMatchFileSnapshot(`../../contract/budget/${name}.json`);
}

const proposalId = async () => ((await (await get('/propose')).json()) as { proposal: { proposalId: string } }).proposal.proposalId;

beforeEach(() => { ctx = makeBudgetApp({ now: NOW }); });

test('plan-null', async () => {
  await expectFixture('plan-null', 'GET /v1/budget/plan', await get('/plan'), 200);
});

test('propose', async () => {
  savePlan();
  ctx.store.rows = [row({})];
  await expectFixture('propose', 'GET /v1/budget/propose', await get('/propose'), 200);
});

test('apply', async () => {
  savePlan();
  const r = await post('/apply', { month: '2026-11', proposalId: await proposalId(), amounts: { groc: 50, misc: 100.5 }, approvedBy: 'shai' });
  await expectFixture('apply', 'POST /v1/budget/apply', r, 200);
});

test('move', async () => {
  savePlan();
  const r = await post('/move', { month: '2026-11', from: 'fun', to: 'groc', amount: 100, approvedBy: 'shai' });
  await expectFixture('move', 'POST /v1/budget/move', r, 200);
});

test('status: a setaside and a variable on watch, a variable off, a suggested move, one event of each kind', async () => {
  savePlan({
    ...plan,
    // With the default offPct (10) a variable line is `off` before it can be `watch`; a wider off band leaves room for both.
    thresholds: { watchPct: 15, watchMin: 150, offPct: 30, projectFromDay: 7 },
    categories: [
      ...plan.categories,
      { categoryId: 'trip', kind: 'setaside', priority: 4, target: 6000, due: '2027-05' },
      { categoryId: 'dine', kind: 'variable', priority: 3, amount: 1000 },
    ],
    incomeSources: [
      { name: 'Salary', payee: 'Employer', expectedAmount: 15000, expectedDay: 10 },
      { name: 'Alimony', payee: 'Inbal', expectedAmount: 5000, expectedDay: 5, fixedTransfer: true },
    ],
  });
  const s = snapshot('2026-11');
  s.categories.push(cat('trip', 'Wants / Trip', 20000, 0), cat('dine', 'Wants / Dining', 100000, -90000));
  s.categories.find(c => c.id === 'groc')!.spent = -105000; // groceries overspent: off
  s.categories.find(c => c.id === 'groc')!.balance = -5000;
  Object.assign(s.categories.find(c => c.id === 'misc')!, { spent: -3000, balance: -3000 }); // spent outside the plan: unplanned
  Object.assign(s.categories.find(c => c.id === 'biz')!, { spent: -7000, balance: -7000 }); // excluded by decision
  s.toBudget = 0; // no free money: a move is the only way to cover the overspend
  ctx.store.snaps.set('2026-11', s);
  ctx.store.rows = [row({}), row({ id: 'rv', date: '2026-11-15', amount: -500, notes: '#review' })];
  ctx.setNow(STATUS_NOW);
  const r = await get('/status');
  const body = await r.clone().json() as { lines: { categoryId: string; status: string }[]; moves: unknown[]; events: { kind: string }[] };
  expect(body.lines.find(l => l.categoryId === 'trip')!.status).toBe('watch');
  expect(body.lines.find(l => l.categoryId === 'dine')!.status).toBe('watch');
  expect(body.lines.find(l => l.categoryId === 'groc')!.status).toBe('off');
  expect(body.moves.length).toBeGreaterThan(0);
  expect([...new Set(body.events.map(e => e.kind))].sort()).toEqual(['income', 'pace', 'review', 'transfer_missing', 'unplanned']);
  await expectFixture('status', 'GET /v1/budget/status', r, 200);
});

test('ack', async () => {
  savePlan();
  ctx.store.rows = [row({})];
  await expectFixture('ack', 'POST /v1/budget/status/ack', await post('/status/ack', { ids: ['income:t'] }), 200);
});

test('error-no_plan', async () => {
  await expectFixture('error-no_plan', 'GET /v1/budget/propose', await get('/propose'), 409);
});

test('error-stale_proposal', async () => {
  savePlan();
  const id = await proposalId();
  ctx.store.snaps.get('2026-11')!.toBudget += 100; // a deposit landed after propose
  const r = await post('/apply', { month: '2026-11', proposalId: id, amounts: { rent: 100 }, approvedBy: 'shai' });
  await expectFixture('error-stale_proposal', 'POST /v1/budget/apply', r, 409);
});

test('error-protected_source', async () => {
  savePlan();
  const r = await post('/move', { month: '2026-11', from: 'prot', to: 'groc', amount: 1, approvedBy: 'shai' });
  await expectFixture('error-protected_source', 'POST /v1/budget/move', r, 400);
});

test('error-over_available', async () => {
  savePlan();
  const r = await post('/apply', { month: '2026-11', proposalId: await proposalId(), amounts: { rent: 3000, groc: 2001 }, approvedBy: 'shai' });
  await expectFixture('error-over_available', 'POST /v1/budget/apply', r, 400);
});
