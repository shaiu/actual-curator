import { expect, test } from 'vitest';
import type { ReportRow } from '../../src/actual/types.ts';
import { createMoneyPage, type MoneyDeps, moneyView, renderMoney } from '../../src/http/money.ts';

const cats = [
  { id: 'rent', label: 'Bills / Rent', isIncome: false }, { id: 'groc', label: 'Needs / 🛒 Groceries', isIncome: false },
  { id: 'fuel', label: 'Needs / Fuel', isIncome: false }, { id: 'house', label: 'Wants / New house', isIncome: false },
];
// Spend rows per `${from}..${to}`; income is a flat 30,000.00.
const SPEND: Record<string, ReportRow[]> = {
  '2026-10-01..2026-10-23': [{ key: 'rent', label: 'Bills / Rent', amount: -850000 },
    { key: 'groc', label: 'Needs / 🛒 Groceries', amount: -438800 }, { key: 'fuel', label: 'Needs / Fuel', amount: 5000 }],
  '2026-09-01..2026-09-23': [{ key: 'rent', label: 'Bills / Rent', amount: -1000000 }],
  '2026-09-01..2026-09-30': [{ key: 'rent', label: 'Bills / Rent', amount: -1100000 },
    { key: 'groc', label: 'Needs / 🛒 Groceries', amount: -521000 }],
  '2026-08-01..2026-08-31': [{ key: 'rent', label: 'Bills / Rent', amount: -900000 }],
};
function deps(over: Partial<MoneyDeps> = {}) {
  const calls: { from: string; to: string; exclude?: readonly string[] }[] = [];
  const d: MoneyDeps = {
    store: {
      categories: async () => cats,
      spend: async (q: { from: string; to: string; exclude?: readonly string[] }) => { calls.push(q); return SPEND[`${q.from}..${q.to}`] ?? []; },
      income: async () => [{ key: 'sal', label: 'Income / Income', amount: 3000000 }],
    },
    exclusions: async () => ({ ids: ['house'], labels: ['Wants / New house'] }),
    pending: async () => 3,
    watch: ['Needs / 🛒 Groceries', 'fuel', 'Nope'],
    ...over,
  };
  return { d, calls };
}

test('this month so far: spend, income, the change against last month at the same day, categories biggest first', async () => {
  const { d, calls } = deps();
  const v = await moneyView(d, { today: '2026-10-23' });
  expect(v).toMatchObject({ month: '2026-10', current: true, from: '2026-10-01', to: '2026-10-23', day: 23, daysInMonth: 31,
    spent: 1288800 - 5000, income: 3000000, prevMonth: '2026-09', nextMonth: null, pending: 3, excluded: ['Wants / New house'] });
  expect(v.prev).toEqual({ month: '2026-09', from: '2026-09-01', to: '2026-09-23', spent: 1000000 });
  expect(v.change).toBeCloseTo((1283800 - 1000000) / 1000000);
  // spend shown as positive; a category that nets to a refund is left out of the list
  expect(v.categories).toEqual([{ name: 'Rent', group: 'Bills', amount: 850000 }, { name: '🛒 Groceries', group: 'Needs', amount: 438800 }]);
  expect(calls.every(c => c.exclude?.includes('house'))).toBe(true);
});

test('watched categories: this month against the whole of last month; unknown names are skipped', async () => {
  const v = await moneyView(deps().d, { today: '2026-10-23' });
  expect(v.watch).toEqual([{ name: '🛒 Groceries', now: 438800, last: 521000 }, { name: 'Fuel', now: -5000, last: 0 }]);
});

test('a past month is shown whole and compared with the whole month before it', async () => {
  const v = await moneyView(deps().d, { today: '2026-10-23', month: '2026-09' });
  expect(v).toMatchObject({ month: '2026-09', current: false, from: '2026-09-01', to: '2026-09-30', day: null,
    prevMonth: '2026-08', nextMonth: '2026-10' });
  expect(v.prev).toEqual({ month: '2026-08', from: '2026-08-01', to: '2026-08-31', spent: 900000 });
});

test('a future or malformed month falls back to this month; day 31 compares with the 30th of a short month', async () => {
  expect((await moneyView(deps().d, { today: '2026-10-23', month: '2027-01' })).month).toBe('2026-10');
  expect((await moneyView(deps().d, { today: '2026-10-23', month: 'x' })).month).toBe('2026-10');
  expect((await moneyView(deps().d, { today: '2026-10-31' })).prev.to).toBe('2026-09-30');
});

test('no spending last month at this point: no percentage', async () => {
  const v = await moneyView(deps().d, { today: '2026-11-05' });
  expect(v.change).toBeNull();
});

test('Hebrew is right-to-left; English left-to-right; labels are escaped; shekels without agorot', async () => {
  const v = await moneyView(deps({ store: { ...deps().d.store, categories: async () => cats,
    spend: async () => [{ key: 'x', label: 'Needs / <b>x</b>', amount: -123456 }] } }).d, { today: '2026-10-23' });
  const he = renderMoney(v, 'he');
  expect(he).toContain('<html lang="he" dir="rtl">');
  expect(he).toContain('הוצאנו');
  expect(he).toContain('₪1,235');
  expect(he).toContain('&lt;b&gt;x&lt;/b&gt;');
  expect(he).not.toContain('<b>x</b>');
  const en = renderMoney(v, 'en');
  expect(en).toContain('<html lang="en" dir="ltr">');
  expect(en).toContain('Spent');
  expect(en).toContain('3 transactions');
});

const page = (verify?: (t: string) => Promise<string | null>) =>
  createMoneyPage({ ...deps().d, verify, now: () => new Date('2026-10-23T09:00:00Z') });
const ok = async (t: string) => (t === 'good' ? 'me@example.com' : null);

test('GET /money needs a Cloudflare Access sign-in: none or a bad one is 403', async () => {
  const app = page(ok);
  expect((await app.request('/money')).status).toBe(403);
  expect((await app.request('/money', { headers: { 'cf-access-jwt-assertion': 'bad' } })).status).toBe(403);
  const r = await app.request('/money', { headers: { 'cf-access-jwt-assertion': 'good' } });
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(await r.text()).toContain('dir="rtl"');
  expect((await app.request('/money', { headers: { cookie: 'CF_Authorization=good' } })).status).toBe(200);
});

test('?lang=en switches the page and remembers it in a cookie', async () => {
  const app = page(ok);
  const r = await app.request('/money?lang=en', { headers: { 'cf-access-jwt-assertion': 'good' } });
  expect(await r.text()).toContain('dir="ltr"');
  expect(r.headers.get('set-cookie')).toMatch(/money_lang=en/);
  const again = await app.request('/money', { headers: { 'cf-access-jwt-assertion': 'good', cookie: 'money_lang=en' } });
  expect(await again.text()).toContain('dir="ltr"');
});

test('without Access configured the page does not exist', async () => {
  expect((await page(undefined).request('/money', { headers: { 'cf-access-jwt-assertion': 'good' } })).status).toBe(404);
});
