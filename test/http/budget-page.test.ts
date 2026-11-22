import { expect, test } from 'vitest';
import { createBudgetPage, loadBudgetPage, renderBudget } from '../../src/http/budget-page.ts';
import { PLAN_SAVED, makeBudgetApp, plan, row } from '../helpers/budget-http.ts';

const auth = { authorization: 'Bearer secret' };
const setup = (withPlan = true) => {
  const h = makeBudgetApp();
  if (withPlan) h.files.savePlan(plan as never, { by: 't', why: 't' }, PLAN_SAVED);
  h.store.rows = [row({ id: 'pay' })];
  const api = async (path: string) => h.app.request(path, { headers: auth });
  return { ...h, api, now: new Date('2026-11-20T09:00:00Z') };
};
const ok = async (t: string) => (t === 'good' ? 'me@example.com' : null);
const pageOf = (s: ReturnType<typeof setup>, verify?: typeof ok) => createBudgetPage({ api: s.api, verify, now: () => s.now });
const signed = { headers: { 'cf-access-jwt-assertion': 'good' } };

test('loads the same status and proposal the advisor reads', async () => {
  const s = setup();
  const v = await loadBudgetPage(s.api, { now: s.now });
  expect(v.error).toBeNull();
  expect(v.month).toBe('2026-11');
  const status = await (await s.api('/v1/budget/status?month=2026-11')).json();
  expect(v.status).toEqual(status);
  expect(v.proposal?.proposal.available).toEqual({ amount: 500000, formatted: '5000.00' });
  expect(v.proposal?.landed.map(l => l.source)).toEqual(['Salary']);
});

test('renders the hero, the lines with a pace mark, fixed bills, the proposal and income, in Hebrew by default', async () => {
  const s = setup();
  const html = renderBudget(await loadBudgetPage(s.api, { now: s.now }), 'he');
  expect(html).toContain('dir="rtl"');
  expect(html).toContain('נשאר להוצאות שוטפות');
  // groceries 1,000 + fun 500 + insurance 300 budgeted, 200 spent: 1,600 left.
  expect(html).toContain('₪1,600');
  expect(html).toContain('Groceries');
  expect(html).toMatch(/<em style="inset-inline-start:/);
  expect(html).toContain('חשבונות קבועים');
  expect(html).toContain('הצעת היועץ');
  expect(html).toContain('מוצע ₪2,800'); // rent's proposed amount
  expect(html).toContain('Salary');
});

test('a month before any plan says so instead of failing', async () => {
  const s = setup(false);
  const v = await loadBudgetPage(s.api, { now: s.now });
  expect(v.error).toBe('no_plan');
  expect(renderBudget(v, 'en')).toContain('No budget plan yet');
});

test('a past month shows status and no proposal', async () => {
  const s = setup();
  const v = await loadBudgetPage(s.api, { now: s.now, month: '2026-10' });
  expect(v.status?.month).toBe('2026-10');
  expect(v.proposal).toBeNull();
});

test('the page writes nothing', async () => {
  const s = setup();
  await pageOf(s, ok).request('/budget', signed);
  expect(s.store.writes ?? []).toEqual([]);
});

test('GET /budget needs a Cloudflare Access sign-in, and does not exist without Access', async () => {
  const s = setup();
  expect((await pageOf(s, ok).request('/budget')).status).toBe(403);
  const r = await pageOf(s, ok).request('/budget?lang=en', signed);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(r.headers.get('set-cookie')).toMatch(/budget_lang=en/);
  expect(await r.text()).toContain('dir="ltr"');
  expect((await pageOf(s).request('/budget', signed)).status).toBe(404);
});

const mny = (n: number) => ({ amount: n * 100, formatted: n.toFixed(2) });
const line = (label: string, budgeted: number, spent: number, balance: number) => ({ categoryId: label, label, kind: 'variable' as const,
  budgeted: mny(budgeted), spent: mny(spent), balance: mny(balance), expectedByToday: mny(0), projected: mny(spent), status: 'ok' as const });
const view = (lines: ReturnType<typeof line>[], proposing: boolean) => ({ month: '2026-11', today: '2026-11-21', error: null,
  status: { month: '2026-11', today: '2026-11-21', totals: { budgeted: mny(0), spent: mny(0), balance: mny(0) }, lines,
    moves: [{ fromLabel: 'Needs / Gas ⛽', toLabel: 'Bills / Phone', amount: mny(80) }] },
  proposal: { proposal: { proposalId: 'abcdef123456', available: mny(100), proposed: mny(proposing ? 50 : 0), remaining: mny(50),
    lines: [{ label: 'Wants / Fun', priority: 3, planned: mny(50), budgeted: mny(0), propose: mny(proposing ? 50 : 0), unfunded: mny(0) }] },
    landed: [], expected: [] } });

test('a line is measured against what it held this month, carry-over included (Entertainment, 2026-11-21)', () => {
  const html = renderBudget(view([line('Wants / Entertainment', 0, 941, 133)], false), 'en');
  expect(html).toContain('₪941 of ₪1,074');
  expect(html).toContain('₪133 left');
  expect(html).toContain('of ₪1,074 the lines held this month');
});

test('an empty line is left out, and names are direction-isolated', () => {
  const html = renderBudget(view([line('Needs / Beauty care', 0, 0, 0), line('Needs / Gas ⛽', 1855, 384, 1471)], false), 'he');
  expect(html).not.toContain('Beauty care');
  expect(html).toContain('<bdi>Gas ⛽</bdi>');
});

test('suggested moves show only while no proposal gives money', () => {
  const lines = [line('Needs / Gas ⛽', 1855, 384, 1471)];
  expect(renderBudget(view(lines, false), 'he')).toContain('<bdi>Gas ⛽</bdi> ← <bdi>Phone</bdi>');
  expect(renderBudget(view(lines, true), 'he')).not.toContain('היועץ עשוי להציע העברה');
});

test('categories outside the plan get their own section; excluded ones are collapsed apart', () => {
  const v = view([line('Needs / Gas ⛽', 1855, 384, 1471)], false) as any;
  v.status.unplanned = [{ categoryId: 'auto', label: 'Needs / 🚗 Auto maintenance', spent: mny(2922), balance: mny(-2922) }];
  v.status.excluded = [{ categoryId: 'biz', label: "Needs / Inbal's Business Stuff", spent: mny(15766), balance: mny(-15766) }];
  const html = renderBudget(v, 'en');
  expect(html).toContain('Not in the plan');
  expect(html).toContain("Paid in November without a budget. Until it is covered, November&#39;s free money looks bigger");
  expect(html).toContain('<bdi>🚗 Auto maintenance</bdi>');
  expect(html).toContain('₪2,922 over');
  expect(html).toMatch(/<details><summary>Left out by decision \(1\)<\/summary>/);
  delete v.status.unplanned; delete v.status.excluded;
  expect(renderBudget(v, 'en')).not.toContain('Not in the plan');
});

test('every planned, unplanned and excluded line links to its category page', async () => {
  const s = setup();
  const html = renderBudget(await loadBudgetPage(s.api, { now: s.now }), 'en');
  expect(html).toContain('href="/budget/category?month=2026-11&amp;id=groc"');
  expect(html).toContain('href="/budget/category?month=2026-11&amp;id=rent"');
  const v = view([line('Needs / Gas ⛽', 1855, 384, 1471)], true) as any;
  v.status.unplanned = [{ categoryId: 'auto', label: 'Needs / Auto', spent: mny(2922), balance: mny(-2922) }];
  v.status.excluded = [{ categoryId: 'biz', label: 'Needs / Biz', spent: mny(100), balance: mny(-100) }];
  const h = renderBudget(v, 'en');
  for (const id of ['Needs%20%2F%20Gas%20%E2%9B%BD', 'auto', 'biz']) expect(h).toContain(`href="/budget/category?month=2026-11&amp;id=${id}"`);
  // Proposal lines and moves carry labels only: no link.
  expect(h).not.toMatch(/<a class="cat"[^>]*>(<bdi>)?Fun/);
});
