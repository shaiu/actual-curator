import { expect, test } from 'vitest';
import { categoryHref, createBudgetPage, loadCategoryPage, renderCategory } from '../../src/http/budget-page.ts';
import { PLAN_SAVED, makeBudgetApp, plan, row, snapshot } from '../helpers/budget-http.ts';

const auth = { authorization: 'Bearer secret' };
const setup = () => {
  const h = makeBudgetApp();
  h.files.savePlan(plan as never, { by: 't', why: 't' }, PLAN_SAVED);
  h.store.rows = [
    row({ id: 'pay' }),
    row({ id: 'g1', date: '2026-11-05', category: 'groc', amount: -12000, payee: 'Rami Levy', accountName: 'Max8516' }),
    row({ id: 'g2', date: '2026-11-18', category: 'groc', amount: -35000, payee: 'Shufersal', accountName: 'Cal7299', notes: 'weekly order' }),
    row({ id: 'g0', date: '2026-10-28', category: 'groc', amount: -9900, payee: 'October shop' }),
    row({ id: 'f1', date: '2026-11-07', category: 'fun', amount: -4000, payee: 'Cinema' }),
  ];
  const api = async (path: string) => h.app.request(path, { headers: auth });
  return { ...h, api, now: new Date('2026-11-20T09:00:00Z') };
};
const ok = async (t: string) => (t === 'good' ? 'me@example.com' : null);
const signed = { headers: { 'cf-access-jwt-assertion': 'good' } };
const pageOf = (s: ReturnType<typeof setup>, verify?: typeof ok) => createBudgetPage({ api: s.api, verify, now: () => s.now });
const load = async (s: ReturnType<typeof setup>, id: string, month = '2026-11') => loadCategoryPage(s.api, { now: s.now, month, id });

test("lists the category's rows for the month, newest first, and its status numbers", async () => {
  const s = setup();
  const v = (await load(s, 'groc'))!;
  expect(v.label).toBe('Needs / Groceries');
  expect(v.rows.map(r => r.id)).toEqual(['g2', 'g1']);
  const status = await (await s.api('/v1/budget/status?month=2026-11')).json() as { lines: { categoryId: string; spent: unknown }[] };
  expect(v.line?.spent).toEqual(status.lines.find(l => l.categoryId === 'groc')!.spent);
  const html = renderCategory(v, 'en');
  expect(html.indexOf('Shufersal')).toBeLessThan(html.indexOf('Rami Levy'));
  expect(html).not.toContain('October shop');
  expect(html).not.toContain('Cinema');
  expect(html).toContain('18/11');
  expect(html).toContain('Cal7299');
  expect(html).toContain('weekly order');
});

test('a split child shows with its own amount', async () => {
  const s = setup();
  s.store.rows.push(row({ id: 'child', date: '2026-11-10', category: 'groc', amount: -2500, payee: 'Split shop' }));
  const html = renderCategory((await load(s, 'groc'))!, 'en');
  expect(html).toMatch(/Split shop[\s\S]*₪25</);
});

test('an unknown id is a 404 with no rows', async () => {
  const s = setup();
  expect(await load(s, 'nope')).toBeNull();
  const r = await pageOf(s, ok).request('/budget/category?month=2026-11&id=nope&lang=en', signed);
  expect(r.status).toBe(404);
  const body = await r.text();
  expect(body).toContain('Category not found.');
  expect(body).not.toContain('Shufersal');
});

test('escapes the id in links and the page', async () => {
  const s = setup();
  const r = await pageOf(s, ok).request(`/budget/category?month=2026-11&id=${encodeURIComponent('x"><b>')}`, signed);
  expect(r.status).toBe(404);
  expect(await r.text()).not.toContain('<b>');
  expect(categoryHref('2026-11', 'a&b')).toBe('/budget/category?month=2026-11&id=a%26b');
  expect(categoryHref('2026-11', 'groc', 'en')).toBe('/budget/category?month=2026-11&id=groc&lang=en');
});

test('a refund is green with a plus; a spend has no minus', async () => {
  const s = setup();
  s.store.rows.push(row({ id: 'ref', date: '2026-11-12', category: 'groc', amount: 3000, payee: 'Refund' }));
  const html = renderCategory((await load(s, 'groc'))!, 'en');
  expect(html).toMatch(/class="n good">\+₪30</);
  expect(html).toMatch(/Shufersal[\s\S]*?class="n">₪350</);
  expect(html).not.toContain('-₪350');
});

test('an empty month says so', async () => {
  const s = setup();
  const html = renderCategory((await load(s, 'fun', '2026-10'))!, 'en');
  expect(html).toContain('No transactions this month.');
  expect(html).not.toContain('<table');
});

test('an unplanned category shows only spent', async () => {
  const s = setup();
  const snap = snapshot('2026-11');
  snap.categories.find(c => c.id === 'misc')!.spent = -7000;
  snap.categories.find(c => c.id === 'misc')!.balance = -7000;
  s.store.snaps.set('2026-11', snap);
  s.store.rows.push(row({ id: 'm1', date: '2026-11-09', category: 'misc', amount: -7000, payee: 'Garage' }));
  const v = (await load(s, 'misc'))!;
  expect(v.line).toBeNull();
  expect(v.off?.spent.amount).toBe(7000);
  const html = renderCategory(v, 'en');
  expect(html).toContain('spent ₪70');
  expect(html).not.toMatch(/₪70 of ₪/);
});

test('a real category outside the plan with no activity is still found through /categories', async () => {
  const s = setup();
  s.store.cats = [{ id: 'misc', label: 'Wants / Misc', isIncome: false }];
  const v = await load(s, 'misc');
  expect(v?.label).toBe('Wants / Misc');
  expect(v?.rows).toEqual([]);
});

test('needs Access like /budget', async () => {
  const s = setup();
  expect((await pageOf(s).request('/budget/category?month=2026-11&id=groc', signed)).status).toBe(404);
  expect((await pageOf(s, ok).request('/budget/category?month=2026-11&id=groc')).status).toBe(403);
  const r = await pageOf(s, ok).request('/budget/category?month=2026-11&id=groc', signed);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(await r.text()).toContain('dir="rtl"');
  expect(s.store.writes).toEqual([]);
});

test('summary names the count and the largest outflow', async () => {
  const s = setup();
  expect(renderCategory((await load(s, 'groc'))!, 'en')).toContain('2 transactions, largest: Shufersal ₪350');
});

test('month arrows keep the category, and there is a way back to the month', async () => {
  const s = setup();
  const html = renderCategory((await load(s, 'groc'))!, 'en');
  expect(html).toContain('href="/budget/category?month=2026-10&amp;id=groc"');
  expect(html).toContain('href="/budget/category?month=2026-12&amp;id=groc"');
  expect(html).toContain('href="/budget?month=2026-11"');
  const dec = renderCategory((await load(s, 'groc', '2026-12'))!, 'en');
  expect(dec).not.toContain('month=2027-01');
});

test('a failed read is an error page, never "no transactions" or "not found" (review I1)', async () => {
  const s = setup();
  const failing = (bad: string) => async (path: string) =>
    path.startsWith(bad) ? new Response(JSON.stringify({ error: { code: 'sync', message: 'server unreachable' } }), { status: 500 }) : s.api(path);
  for (const bad of ['/v1/transactions', '/v1/budget/status']) {
    const r = await createBudgetPage({ api: failing(bad), verify: ok, now: () => s.now }).request('/budget/category?month=2026-11&id=groc&lang=en', signed);
    expect(r.status).toBe(502);
    const body = await r.text();
    expect(body).toContain('Could not read the budget:');
    expect(body).not.toContain('No transactions this month.');
    expect(body).not.toContain('Category not found.');
  }
});

test('rows that do not add up to the budget figure say so (review I2)', async () => {
  const s = setup();
  const v = (await load(s, 'groc'))!;
  // The fixture's status says groceries spent ₪200; the rows add up to ₪470.
  expect(renderCategory(v, 'en')).toContain('These rows add up to ₪470; the budget counts ₪200.');
  v.rows = v.rows.filter(r => r.id === 'g2').map(r => ({ ...r, amount: -20000 }));
  expect(renderCategory(v, 'en')).not.toContain('add up to');
});

test('a malformed month is a 404, not the current month (review I3)', async () => {
  const s = setup();
  expect((await pageOf(s, ok).request('/budget/category?month=2026-13&id=groc', signed)).status).toBe(404);
});
