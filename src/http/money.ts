// /money: one phone-sized page that answers "where did the money go this month" in plain words, Hebrew or
// English. Same numbers as /v1/report (report exclusions applied, refunds netted). Served only behind
// Cloudflare Access: the person's Access token is verified here, so the LAN port does not open it.
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { ActualStore } from '../actual/store.ts';
import type { Exclusions } from './exclusions.ts';

export type MoneyDeps = {
  store: Pick<ActualStore, 'categories' | 'spend' | 'income'>;
  exclusions: () => Promise<Exclusions>;
  pending: () => Promise<number>;
  /** Category labels or ids to show this month against last month. */
  watch: string[];
};

type Cat = { name: string; group: string; amount: number };
export type MoneyView = {
  month: string; current: boolean; from: string; to: string; day: number | null; daysInMonth: number;
  /** Positive minor units: net spend (refunds reduce it). */
  spent: number; income: number;
  prev: { month: string; from: string; to: string; spent: number };
  /** (spent - prev.spent) / prev.spent; null when the previous period had no spending. */
  change: number | null;
  categories: Cat[];
  watch: { name: string; now: number; last: number }[];
  pending: number; excluded: string[];
  prevMonth: string; nextMonth: string | null;
};

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (month: string) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
const shift = (month: string, by: number) => {
  const d = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + by, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};
/** Spend is stored negative; the page shows it positive. `|| 0` turns the -0 of an empty category into 0. */
const flip = (n: number) => -n || 0;
const split = (label: string) => {
  const i = label.indexOf(' / ');
  return i < 0 ? { group: '', name: label } : { group: label.slice(0, i), name: label.slice(i + 3) };
};

export async function moneyView(d: MoneyDeps, o: { today: string; month?: string }): Promise<MoneyView> {
  const thisMonth = o.today.slice(0, 7);
  const month = o.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(o.month) && o.month <= thisMonth ? o.month : thisMonth;
  const current = month === thisMonth;
  const daysInMonth = lastDay(month);
  const day = current ? +o.today.slice(8, 10) : null;
  const from = `${month}-01`;
  const to = current ? o.today : `${month}-${pad(daysInMonth)}`;
  const prevMonth = shift(month, -1);
  const prevTo = `${prevMonth}-${pad(Math.min(day ?? 31, lastDay(prevMonth)))}`;
  const prevWhole = `${prevMonth}-${pad(lastDay(prevMonth))}`;

  const ex = await d.exclusions();
  const exclude = ex.ids;
  const [rows, prevRows, wholePrevRows, income] = await Promise.all([
    d.store.spend({ from, to, by: 'category', exclude }),
    d.store.spend({ from: `${prevMonth}-01`, to: prevTo, by: 'category', exclude }),
    prevTo === prevWhole ? null : d.store.spend({ from: `${prevMonth}-01`, to: prevWhole, by: 'category', exclude }),
    d.store.income({ from, to, exclude }),
  ]);
  const total = (r: { amount: number }[]) => flip(r.reduce((s, x) => s + x.amount, 0));
  const spent = total(rows);
  const prevSpent = total(prevRows);
  const lastRows = wholePrevRows ?? prevRows;

  const cats = await d.store.categories({ includeHidden: true });
  const watch = [];
  for (const w of d.watch) {
    const c = cats.find(x => x.id === w || x.label === w);
    if (!c) continue;
    watch.push({ name: split(c.label).name, now: flip(rows.find(r => r.key === c.id)?.amount ?? 0),
      last: flip(lastRows.find(r => r.key === c.id)?.amount ?? 0) });
  }
  return {
    month, current, from, to, day, daysInMonth, spent, income: income.reduce((s, x) => s + x.amount, 0),
    prev: { month: prevMonth, from: `${prevMonth}-01`, to: prevTo, spent: prevSpent },
    change: prevSpent > 0 ? (spent - prevSpent) / prevSpent : null,
    categories: rows.filter(r => r.amount < 0).map(r => ({ ...split(r.label), amount: -r.amount }))
      .sort((a, b) => b.amount - a.amount),
    watch, pending: await d.pending(), excluded: ex.labels,
    prevMonth, nextMonth: current ? null : shift(month, 1),
  };
}

export type Lang = 'he' | 'en';
const T = {
  he: {
    title: 'הכסף שלנו', spent: 'הוצאנו', income: 'נכנס', where: 'לאן הלך הכסף', watching: 'במעקב',
    thisMonth: 'החודש', lastMonth: 'חודש שעבר', other: 'English', none: 'אין הוצאות בתקופה הזו.',
    soFar: (d: number, n: number) => `עד היום · יום ${d} מתוך ${n}`, whole: 'כל החודש',
    more: (p: number, m: string, same: boolean) => `${p}% יותר מ${m}${same ? ' באותה נקודה' : ''}`,
    less: (p: number, m: string, same: boolean) => `${p}% פחות מ${m}${same ? ' באותה נקודה' : ''}`,
    showAll: (n: number) => `עוד ${n} קטגוריות`,
    pending: (n: number) => (n === 1 ? 'עסקה אחת מחכה לסיווג' : `${n} עסקאות מחכות לסיווג`),
    excluded: (l: string) => `לא כולל: ${l}`, prev: 'הקודם', next: 'הבא',
  },
  en: {
    title: 'Our money', spent: 'Spent', income: 'Came in', where: 'Where it went', watching: 'Watching',
    thisMonth: 'This month', lastMonth: 'Last month', other: 'עברית', none: 'No spending in this period.',
    soFar: (d: number, n: number) => `So far · day ${d} of ${n}`, whole: 'Whole month',
    more: (p: number, m: string, same: boolean) => `${p}% more than ${m}${same ? ' at this point' : ''}`,
    less: (p: number, m: string, same: boolean) => `${p}% less than ${m}${same ? ' at this point' : ''}`,
    showAll: (n: number) => `${n} more categories`,
    pending: (n: number) => (n === 1 ? '1 transaction waiting for a category' : `${n} transactions waiting for a category`),
    excluded: (l: string) => `Not counting: ${l}`, prev: 'Previous', next: 'Next',
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Whole shekels: the page is for reading, not reconciling. */
const ils = (minor: number) => `${minor < 0 ? '-' : ''}₪${Math.round(Math.abs(minor) / 100).toLocaleString('en-US')}`;
const monthName = (month: string, lang: Lang) => new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB',
  { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-15T00:00:00Z`));
const shortMonth = (month: string, lang: Lang) => new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB',
  { month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-15T00:00:00Z`));

export function renderMoney(v: MoneyView, lang: Lang): string {
  const t = T[lang];
  const max = Math.max(1, ...v.categories.map(c => c.amount));
  const bar = (c: Cat) => `<li><div class="row"><span class="name">${esc(c.name)}<small>${esc(c.group)}</small></span>`
    + `<span class="amt">${ils(c.amount)}</span></div><div class="bar"><i style="width:${(c.amount / max * 100).toFixed(1)}%"></i></div></li>`;
  const top = v.categories.slice(0, 6), rest = v.categories.slice(6);
  const change = v.change === null ? '' : (() => {
    const p = Math.round(Math.abs(v.change) * 100);
    const s = v.change >= 0 ? t.more(p, shortMonth(v.prev.month, lang), v.current) : t.less(p, shortMonth(v.prev.month, lang), v.current);
    return `<p class="change ${v.change >= 0 ? 'up' : 'down'}">${v.change >= 0 ? '▲' : '▼'} ${esc(s)}</p>`;
  })();
  const q = (month: string) => (month === v.month ? '' : `month=${month}`);
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'he' ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(t.title)} · ${esc(monthName(v.month, lang))}</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1f;--mute:#6e6e73;--line:#e5e4e0;--bar:#3a7bd5;--up:#c0392b;--down:#1e8449}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--card:#1c1d20;--ink:#f2f2f2;--mute:#9a9aa0;--line:#2c2d31;--bar:#5b9cf0;--up:#ff6b5e;--down:#4cd18a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,system-ui,"Segoe UI",Arial,sans-serif}
main{max-width:560px;margin:0 auto;padding:16px 16px 40px}
header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
header h1{font-size:22px;margin:0}nav a,header a{color:var(--bar);text-decoration:none;font-size:15px}
.nav{display:flex;justify-content:space-between;margin:0 0 12px}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:12px}
h2{font-size:15px;color:var(--mute);font-weight:600;margin:0 0 10px}
.totals{display:grid;grid-template-columns:1fr 1fr;gap:12px}.big{font-size:30px;font-weight:700;letter-spacing:-.5px}
.label{color:var(--mute);font-size:14px}.change{margin:10px 0 0;font-weight:600}.up{color:var(--up)}.down{color:var(--down)}
.sub{color:var(--mute);font-size:13px;margin:6px 0 0}
ul{list-style:none;margin:0;padding:0}li{padding:7px 0}.row{display:flex;justify-content:space-between;gap:8px}
.name small{display:block;color:var(--mute);font-size:12px}.amt{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
.bar{height:6px;background:var(--line);border-radius:3px;margin-top:4px;overflow:hidden}.bar i{display:block;height:100%;background:var(--bar);border-radius:3px}
details summary{cursor:pointer;color:var(--bar);padding:8px 0 0;list-style:none}
table{width:100%;border-collapse:collapse}td,th{padding:7px 0;text-align:start}th{color:var(--mute);font-size:13px;font-weight:600}
td.n,th.n{text-align:end;font-variant-numeric:tabular-nums}.pending{display:block;font-weight:600}
</style></head>
<body><main>
<header><h1>${esc(monthName(v.month, lang))}</h1><a href="?lang=${lang === 'he' ? 'en' : 'he'}${q(v.month) ? `&${q(v.month)}` : ''}">${t.other}</a></header>
<nav class="nav"><a href="?month=${v.prevMonth}">${lang === 'he' ? '→' : '←'} ${esc(shortMonth(v.prevMonth, lang))}</a>${v.nextMonth
    ? `<a href="?month=${v.nextMonth}">${esc(shortMonth(v.nextMonth, lang))} ${lang === 'he' ? '←' : '→'}</a>` : '<span></span>'}</nav>
<section>
<h2>${v.current ? esc(t.soFar(v.day!, v.daysInMonth)) : esc(t.whole)}</h2>
<div class="totals"><div><div class="label">${t.spent}</div><div class="big">${ils(v.spent)}</div></div>
<div><div class="label">${t.income}</div><div class="big">${ils(v.income)}</div></div></div>
${change}
${v.excluded.length ? `<p class="sub">${esc(t.excluded(v.excluded.map(l => split(l).name).join(', ')))}</p>` : ''}
</section>
<section><h2>${t.where}</h2>
${v.categories.length ? `<ul>${top.map(bar).join('')}</ul>${rest.length
    ? `<details><summary>${esc(t.showAll(rest.length))}</summary><ul>${rest.map(bar).join('')}</ul></details>` : ''}` : `<p class="sub">${t.none}</p>`}
</section>
${v.watch.length ? `<section><h2>${t.watching}</h2><table><tr><th></th><th class="n">${v.current ? t.thisMonth : esc(shortMonth(v.month, lang))}</th>`
    + `<th class="n">${v.current ? t.lastMonth : esc(shortMonth(v.prev.month, lang))}</th></tr>${v.watch.map(w =>
    `<tr><td>${esc(w.name)}</td><td class="n">${ils(w.now)}</td><td class="n">${ils(w.last)}</td></tr>`).join('')}</table></section>` : ''}
${v.pending ? `<section><span class="pending">${esc(t.pending(v.pending))}</span></section>` : ''}
</main></body></html>`;
}

/** Local calendar day of the server (Home Assistant passes its time zone to the app as TZ). */
const localDay = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

export function createMoneyPage(deps: MoneyDeps & { verify?: (token: string) => Promise<string | null>; now?: () => Date }): Hono {
  const now = deps.now ?? (() => new Date());
  const app = new Hono();
  app.get('/money', async c => {
    if (!deps.verify) return c.text('Not found', 404);
    const token = c.req.header('cf-access-jwt-assertion') ?? getCookie(c, 'CF_Authorization') ?? '';
    if (!token || !(await deps.verify(token))) {
      return c.text('Open this page through its Cloudflare Access address and sign in.', 403);
    }
    const asked = c.req.query('lang');
    let lang: Lang = getCookie(c, 'money_lang') === 'en' ? 'en' : 'he';
    if (asked === 'he' || asked === 'en') {
      lang = asked;
      setCookie(c, 'money_lang', asked, { path: '/money', maxAge: 31_536_000, sameSite: 'Lax', httpOnly: true, secure: true });
    }
    const v = await moneyView(deps, { today: localDay(now()), month: c.req.query('month') });
    c.header('Cache-Control', 'no-store');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(renderMoney(v, lang));
  });
  return app;
}
