// /budget: one phone-sized page for the month's budget, for the two adults, opened from a link the advisor sends.
// It reads the same JSON the advisor reads (GET /v1/budget/status and /v1/budget/propose, through the API app
// in-process), so the page and the WhatsApp messages can never disagree. Read-only: nothing here writes.
// Served only behind Cloudflare Access, like /money.
import { type Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { currentMonth, jerusalemToday } from '../budget/dates.ts';

type Money = { amount: number; formatted: string };
type Kind = 'fixed' | 'variable' | 'setaside' | 'excluded';
export type StatusLine = {
  categoryId: string; label: string; kind: Kind; budgeted: Money; spent: Money; balance: Money;
  expectedByToday: Money; projected: Money; status: 'ok' | 'watch' | 'off';
};
export type StatusJson = {
  month: string; today: string; totals: { budgeted: Money; spent: Money; balance: Money };
  lines: StatusLine[]; moves: { fromLabel: string; toLabel: string; amount: Money }[];
  /** Curator 0.3.3+: categories with activity that the plan does not track, and the plan's excluded ones. */
  unplanned?: OffPlan[]; excluded?: OffPlan[];
};
export type OffPlan = { categoryId: string; label: string; spent: Money; balance: Money };
export type ProposalJson = {
  proposal: {
    proposalId: string; available: Money; proposed: Money; remaining: Money; coversOverspend?: Money;
    lines: { label: string; priority: number; planned: Money; budgeted: Money; propose: Money; unfunded: Money; covers?: Money }[];
  };
  landed: { source: string; amount: Money; date: string }[];
  expected: { source: string; expectedDay: number }[];
};
export type BudgetPageData = { month: string; today: string; status: StatusJson | null; proposal: ProposalJson | null; error: string | null };

/** Calls one API route in-process; the page never reimplements budget math. */
export type ApiCall = (path: string) => Promise<Response>;

const validMonth = (m: string | undefined) => (m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : undefined);
const shift = (month: string, by: number) => {
  const d = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export async function loadBudgetPage(api: ApiCall, o: { now: Date; month?: string }): Promise<BudgetPageData> {
  const today = jerusalemToday(o.now);
  const month = validMonth(o.month) ?? currentMonth(o.now);
  const read = async <T>(path: string): Promise<{ ok: true; body: T } | { ok: false; message: string; code: string }> => {
    const r = await api(path);
    const j = await r.json() as T & { error?: { code: string; message: string } };
    return r.ok ? { ok: true, body: j } : { ok: false, code: j.error?.code ?? String(r.status), message: j.error?.message ?? `HTTP ${r.status}` };
  };
  const s = await read<StatusJson>(`/v1/budget/status?month=${month}`);
  if (!s.ok) return { month, today, status: null, proposal: null, error: s.code === 'no_plan' ? 'no_plan' : s.message };
  // A proposal exists only for this month and later (past months are read-only).
  let proposal: ProposalJson | null = null;
  if (month >= currentMonth(o.now)) {
    const p = await read<ProposalJson>(`/v1/budget/propose?month=${month}`);
    if (p.ok) proposal = p.body;
  }
  return { month, today, status: s.body, proposal, error: null };
}

export type Lang = 'he' | 'en';
const T = {
  he: {
    title: 'התקציב שלנו', other: 'English', dayOf: (d: number, n: number) => `יום ${d} מתוך ${n}`, whole: 'כל החודש',
    leftDaily: 'נשאר להוצאות שוטפות', ofBudget: (b: string) => `מתוך ${b} שהיו בקווים החודש`,
    onPace: 'בקצב', overPace: (a: string) => `${a} מעל הקצב להיום`, underPace: (a: string) => `${a} מתחת לקצב להיום`,
    free: 'כסף שעוד לא קיבל תפקיד', daily: 'הוצאות שוטפות', fixed: 'חשבונות קבועים', setaside: 'חיסכון לדברים גדולים',
    left: (a: string) => `נשאר ${a}`, over: (a: string) => `חריגה ${a}`, paid: 'שולם', due: (a: string) => `ממתין ${a}`,
    spentOf: (s: string, b: string) => `${s} מתוך ${b}`, saved: (a: string) => `נצבר ${a}`,
    proposal: 'הצעת היועץ', available: 'פנוי לחלוקה', proposedLine: (a: string) => `מוצע ${a}`,
    covers: 'מכסה חריגה', unfunded: 'לא מומן', noProposal: 'אין כרגע מה לחלק: כל הקווים מתוקצבים או שאין כסף פנוי.',
    approve: (id: string) => `לאישור, כתבו בקבוצת כספים: "מאשר" על הצעה #${id}`,
    income: 'הכנסות', landed: 'נכנס', expected: (d: number) => `צפוי בערך ב-${d} לחודש`,
    moves: 'היועץ עשוי להציע העברה',
    noPlan: 'עוד אין תוכנית תקציב. היא נבנית בשיחה עם היועץ בקבוצת כספים.', error: 'לא הצלחתי לקרוא את התקציב:',
    legend: 'הקו האנכי: כמה היה צפוי לצאת עד היום. אדום: חריגה מהתקציב. כתום: מוציאים מהר מהחודש או שהתקציב נגמר.',
    unplanned: 'לא בתוכנית', unplannedHint: (m: string) => `שולם ב${m} בלי תקציב. עד שזה מכוסה, הכסף הפנוי של ${m} נראה גדול ממה שהוא. כדי לכסות, בקשו מהיועץ להוסיף את הקטגוריות לתוכנית.`,
    excludedTitle: (n: number) => `מחוץ לתוכנית בהחלטה (${n})`, spentBal: (s: string, b: string) => `הוצא ${s} · יתרה ${b}`,
    freeHint: 'כסף שנכנס ולא שויך לשום קו. הוא עובר לחודש הבא ומשמש כרית.',
    leftHint: 'מה שעוד נשאר בקווי ההוצאות השוטפות, כולל יתרות מחודשים קודמים.',
    notFound: 'הקטגוריה לא נמצאה.', noTx: 'אין תנועות החודש.', back: 'חזרה לחודש',
    drift: (r: string, b: string) => `התנועות כאן מסתכמות ב-${r}; התקציב סופר ${b}.`,
    summary: (n: number, payee: string, amt: string) => `${n} תנועות, הגדולה: ${payee} ${amt}`, spent: (a: string) => `הוצא ${a}`,
  },
  en: {
    title: 'Our budget', other: 'עברית', dayOf: (d: number, n: number) => `Day ${d} of ${n}`, whole: 'Whole month',
    leftDaily: 'Left for day-to-day', ofBudget: (b: string) => `of ${b} the lines held this month`,
    onPace: 'On pace', overPace: (a: string) => `${a} ahead of today's pace`, underPace: (a: string) => `${a} under today's pace`,
    free: 'Money without a job yet', daily: 'Day-to-day', fixed: 'Fixed bills', setaside: 'Saving for big things',
    left: (a: string) => `${a} left`, over: (a: string) => `${a} over`, paid: 'Paid', due: (a: string) => `${a} due`,
    spentOf: (s: string, b: string) => `${s} of ${b}`, saved: (a: string) => `${a} saved`,
    proposal: "The advisor's proposal", available: 'Free to give', proposedLine: (a: string) => `+${a}`,
    covers: 'covers overspending', unfunded: 'not funded', noProposal: 'Nothing to give right now: every line is funded, or no money is free.',
    approve: (id: string) => `To approve, answer "yes" to proposal #${id} in the finance group.`,
    income: 'Income', landed: 'Landed', expected: (d: number) => `expected around the ${d}th`,
    moves: 'The advisor may suggest a move',
    noPlan: 'No budget plan yet. It is built in a conversation with the advisor in the finance group.', error: 'Could not read the budget:',
    legend: 'The vertical line: what was expected to be spent by today. Red: over budget. Amber: spending faster than the month, or used up.',
    unplanned: 'Not in the plan', unplannedHint: (m: string) => `Paid in ${m} without a budget. Until it is covered, ${m}'s free money looks bigger than it is. To cover it, ask the advisor to add these categories to the plan.`,
    excludedTitle: (n: number) => `Left out by decision (${n})`, spentBal: (s: string, b: string) => `spent ${s} · balance ${b}`,
    freeHint: 'Money that came in and is not assigned to any line. It carries into next month as a cushion.',
    leftHint: 'What is still in the day-to-day lines, including balances carried from earlier months.',
    notFound: 'Category not found.', noTx: 'No transactions this month.', back: 'Back to the month',
    drift: (r: string, b: string) => `These rows add up to ${r}; the budget counts ${b}.`,
    summary: (n: number, payee: string, amt: string) => `${n} transactions, largest: ${payee} ${amt}`, spent: (a: string) => `spent ${a}`,
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Whole shekels, minus before the sign: the page is for reading, not reconciling. */
const ils = (minor: number) => `${minor < 0 ? '-' : ''}₪${Math.round(Math.abs(minor) / 100).toLocaleString('en-US')}`;
const name = (label: string) => { const i = label.indexOf(' / '); return i < 0 ? label : label.slice(i + 3); };
/** A category name in its own direction, so an English or emoji name cannot reorder the Hebrew around it. */
const nm = (label: string) => `<bdi>${esc(name(label))}</bdi>`;
/** What the envelope held this month: carried-in balance plus this month's budget, i.e. balance + spent. */
const held = (l: StatusLine) => l.balance.amount + l.spent.amount;
const monthName = (month: string, lang: Lang) => new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB',
  { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-15T00:00:00Z`));
const shortMonth = (month: string, lang: Lang) => new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB',
  { month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-15T00:00:00Z`));
const daysIn = (month: string) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
const pct = (part: number, whole: number) => (whole <= 0 ? (part > 0 ? 100 : 0) : Math.max(0, Math.min(100, (part / whole) * 100)));

const STYLE = `:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1f;--mute:#6e6e73;--line:#e5e4e0;--bar:#3a7bd5;--warn:#b7791f;--off:#c0392b;--good:#1e8449}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--card:#1c1d20;--ink:#f2f2f2;--mute:#9a9aa0;--line:#2c2d31;--bar:#5b9cf0;--warn:#f0b54a;--off:#ff6b5e;--good:#4cd18a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,system-ui,"Segoe UI",Arial,sans-serif}
main{max-width:560px;margin:0 auto;padding:16px 16px 40px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px}header h1{font-size:22px;margin:0}
a{color:var(--bar);text-decoration:none;font-size:15px}.nav{display:flex;justify-content:space-between;margin:0 0 12px}
.when{color:var(--mute);font-size:14px;margin:0 0 10px}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:12px}
h2{font-size:15px;color:var(--mute);font-weight:600;margin:0 0 10px}
.label{color:var(--mute);font-size:14px}.big{font-size:36px;font-weight:700;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.sub{color:var(--mute);font-size:13px;margin:2px 0 0}.pace{margin:10px 0 0;font-weight:600}
.chip{display:inline-block;margin-top:10px;padding:4px 10px;border-radius:999px;background:var(--bg);font-size:14px}
.neg,.off{color:var(--off)}.warn{color:var(--warn)}.good{color:var(--good)}.mute{color:var(--mute)}
ul{list-style:none;margin:0;padding:0}li{padding:8px 0}.row{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.name{font-weight:600}.bar{position:relative;height:8px;background:var(--line);border-radius:4px;margin-top:5px}
.bar i{display:block;height:100%;background:var(--bar);border-radius:4px}.bar em{position:absolute;top:-3px;width:2px;height:14px;background:var(--ink);opacity:.55}
li.watch .bar i{background:var(--warn)}li.off .bar i{background:var(--off)}
.legend{color:var(--mute);font-size:12px;margin:6px 0 0}.hint{color:var(--mute);font-size:12px;margin:6px 0 0}
table{width:100%;border-collapse:collapse}td{padding:7px 0;vertical-align:baseline}td.n{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap;padding-inline-start:10px}
details summary{cursor:pointer;color:var(--bar);padding:8px 0 0}
.proposal .row{margin-bottom:6px}
a.cat{color:inherit;font-size:inherit}.memo{display:block;color:var(--mute);font-size:12px}`;

export function renderBudget(v: BudgetPageData, lang: Lang): string {
  const t = T[lang];
  const current = v.month === v.today.slice(0, 7);
  const D = daysIn(v.month);
  const body: string[] = [];
  /** A line's name, linked to the page listing what went out of it. */
  const ln = (l: { categoryId: string; label: string }) => `<a class="cat" href="${esc(categoryHref(v.month, l.categoryId))}">${nm(l.label)}</a>`;

  if (v.error || !v.status) {
    body.push(`<section><p>${v.error === 'no_plan' ? esc(t.noPlan) : `${esc(t.error)} ${esc(v.error ?? '')}`}</p></section>`);
  } else {
    const lines = v.status.lines;
    // A line with nothing in it and nothing spent says nothing: leave it out.
    const daily = lines.filter(l => l.kind === 'variable' && (held(l) !== 0 || l.spent.amount !== 0));
    const fixed = lines.filter(l => l.kind === 'fixed');
    const saves = lines.filter(l => l.kind === 'setaside');
    const sum = (ls: StatusLine[], f: (l: StatusLine) => number) => ls.reduce((s, l) => s + f(l), 0);

    // Hero: what is left for day-to-day, and pace against today.
    // Left is what Actual shows as the lines' balances (carry-over included), out of what they held this month.
    const dHeld = sum(daily, held), dSpent = sum(daily, l => l.spent.amount);
    const dExpected = sum(daily, l => l.expectedByToday.amount);
    const left = sum(daily, l => l.balance.amount), gap = dSpent - dExpected;
    const paceTxt = !current ? '' : Math.abs(gap) < 10_000 ? t.onPace : gap > 0 ? t.overPace(ils(gap)) : t.underPace(ils(-gap));
    const free = v.proposal?.proposal.available.amount;
    body.push(`<section class="hero"><div class="label">${esc(t.leftDaily)}</div>
<div class="big ${left < 0 ? 'neg' : ''}">${ils(left)}</div><div class="sub">${esc(t.ofBudget(ils(dHeld)))}</div>
<p class="hint">${esc(t.leftHint)}</p>
${paceTxt ? `<p class="pace ${current && gap >= 10_000 ? 'warn' : 'good'}">${esc(paceTxt)}</p>` : ''}
${free !== undefined ? `<div class="chip ${free < 0 ? 'neg' : ''}">${esc(t.free)}: <b>${ils(free)}</b></div><p class="hint">${esc(t.freeHint)}</p>` : ''}</section>`);

    // Day-to-day: a bar per line, spent against budgeted, with today's expected mark (Copilot-style pace).
    if (daily.length) {
      const row = (l: StatusLine) => {
        const b = held(l), s = l.spent.amount, bal = l.balance.amount;
        const scale = Math.max(b, s, 1);
        const tag = bal < 0 ? `<span class="off">${esc(t.over(ils(-bal)))}</span>` : `<span>${esc(t.left(ils(bal)))}</span>`;
        const mark = current && b > 0 ? `<em style="inset-inline-start:${pct(l.expectedByToday.amount, scale).toFixed(1)}%"></em>` : '';
        return `<li class="${l.status}"><div class="row"><span class="name">${ln(l)}</span>${tag}</div>
<div class="bar"><i style="width:${pct(s, scale).toFixed(1)}%"></i>${mark}</div><div class="sub">${esc(t.spentOf(ils(s), ils(b)))}</div></li>`;
      };
      const order = { off: 0, watch: 1, ok: 2 } as const;
      body.push(`<section><h2>${esc(t.daily)}</h2><ul class="lines">${[...daily].sort((a, b) => order[a.status] - order[b.status]).map(row).join('')}</ul>
${current ? `<p class="legend">${esc(t.legend)}</p>` : ''}</section>`);
    }
    if (fixed.length) {
      body.push(`<section><h2>${esc(t.fixed)}</h2><table>${fixed.map(l => {
        const b = l.budgeted.amount, s = l.spent.amount, bal = l.balance.amount;
        const state = bal < 0 ? `<span class="off">${esc(t.over(ils(-bal)))}</span>`
          : s > 0 && s >= b ? `<span class="good">✓ ${esc(t.paid)}</span>` : `<span class="mute">${esc(t.due(ils(Math.max(0, b - s))))}</span>`;
        return `<tr><td>${ln(l)}</td><td class="n">${ils(b)}</td><td class="n">${state}</td></tr>`;
      }).join('')}</table></section>`);
    }
    const offRow = (l: OffPlan) => `<tr><td>${ln(l)}</td><td class="n mute">${esc(t.spentBal(ils(l.spent.amount), ils(l.balance.amount)))}</td></tr>`;
    const unplanned = v.status.unplanned ?? [], excluded = v.status.excluded ?? [];
    if (unplanned.length) {
      body.push(`<section class="unplanned"><h2>${esc(t.unplanned)}</h2><table>${unplanned.map(l =>
        `<tr><td>${ln(l)}</td><td class="n">${ils(l.spent.amount)}</td><td class="n ${l.balance.amount < 0 ? 'off' : 'mute'}">${l.balance.amount < 0
          ? esc(t.over(ils(-l.balance.amount))) : esc(t.left(ils(l.balance.amount)))}</td></tr>`).join('')}</table>
<p class="hint">${esc(t.unplannedHint(shortMonth(v.month, lang)))}</p>
${excluded.length ? `<details><summary>${esc(t.excludedTitle(excluded.length))}</summary><table>${excluded.map(offRow).join('')}</table></details>` : ''}</section>`);
    } else if (excluded.length) {
      body.push(`<section><details><summary>${esc(t.excludedTitle(excluded.length))}</summary><table>${excluded.map(offRow).join('')}</table></details></section>`);
    }
    if (saves.length) {
      body.push(`<section><h2>${esc(t.setaside)}</h2><table>${saves.map(l =>
        `<tr><td>${ln(l)}</td><td class="n">${esc(t.saved(ils(l.balance.amount)))}</td></tr>`).join('')}</table></section>`);
    }

    // The advisor's proposal, as the advisor would send it: what is free, then each line it would fund.
    if (v.proposal) {
      const p = v.proposal.proposal;
      const give = p.lines.filter(l => l.propose.amount > 0);
      const short = p.lines.filter(l => l.unfunded.amount > 0);
      const id = p.proposalId.slice(0, 6);
      body.push(`<section class="proposal"><h2>${esc(t.proposal)} <span class="mute">#${esc(id)}</span></h2>
<div class="row"><span>${esc(t.available)}</span><b>${ils(p.available.amount)}</b></div>
${give.length ? `<table>${give.map(l => `<tr><td>${nm(l.label)}${l.covers && l.covers.amount > 0 ? ` <small class="mute">· ${esc(t.covers)}</small>` : ''}</td>`
        + `<td class="n good">${esc(t.proposedLine(ils(l.propose.amount)))}</td></tr>`).join('')}</table>
<p class="sub">${esc(t.approve(id))}</p>` : `<p class="sub">${esc(t.noProposal)}</p>`}
${short.length ? `<details><summary>${esc(t.unfunded)} (${short.length})</summary><table>${short.map(l =>
        `<tr><td>${nm(l.label)}</td><td class="n off">${ils(l.unfunded.amount)}</td></tr>`).join('')}</table></details>` : ''}
</section>`);
      const inc = v.proposal;
      if (inc.landed.length || inc.expected.length) {
        body.push(`<section><h2>${esc(t.income)}</h2><table>${inc.landed.map(l =>
          `<tr><td>${esc(l.source)}</td><td class="n">${ils(l.amount.amount)}</td><td class="n good">✓ ${esc(l.date.slice(8, 10))}/${esc(l.date.slice(5, 7))}</td></tr>`).join('')}
${inc.expected.map(e => `<tr><td>${esc(e.source)}</td><td></td><td class="n mute">${esc(t.expected(e.expectedDay))}</td></tr>`).join('')}</table></section>`);
      }
    }
    // Moves are the way to cover an overspend when no money is free; while a proposal gives money, it is the answer.
    const proposing = (v.proposal?.proposal.lines ?? []).some(l => l.propose.amount > 0);
    if (v.status.moves.length && !proposing) {
      const arrow = lang === 'he' ? '←' : '→';
      body.push(`<section><h2>${esc(t.moves)}</h2><table>${v.status.moves.map(m =>
        `<tr><td>${nm(m.fromLabel)} ${arrow} ${nm(m.toLabel)}</td><td class="n">${ils(m.amount.amount)}</td></tr>`).join('')}</table></section>`);
    }
  }

  const prev = shift(v.month, -1), next = shift(v.month, 1);
  const showNext = next <= shift(v.today.slice(0, 7), 1);
  const q = (k: string, val: string) => `?${k}=${val}`;
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'he' ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(t.title)} · ${esc(monthName(v.month, lang))}</title>
<style>${STYLE}</style></head>
<body><main>
<header><h1>${esc(monthName(v.month, lang))}</h1><a href="?lang=${lang === 'he' ? 'en' : 'he'}&month=${v.month}">${t.other}</a></header>
<p class="when">${current ? esc(t.dayOf(+v.today.slice(8, 10), D)) : esc(t.whole)}</p>
<nav class="nav"><a href="${q('month', prev)}">${lang === 'he' ? '→' : '←'} ${esc(shortMonth(prev, lang))}</a>${showNext
    ? `<a href="${q('month', next)}">${esc(shortMonth(next, lang))} ${lang === 'he' ? '←' : '→'}</a>` : '<span></span>'}</nav>
${body.join('\n')}
</main></body></html>`;
}


// /budget/category: what went out of one category in one month, so a line on /budget can be traced to its rows.
export type TxRow = { id: string; date: string; payee: string | null; accountName: string; memo: string; amount: number };
export type CategoryPageData = {
  month: string; today: string; id: string; label: string; line: StatusLine | null; off: OffPlan | null; rows: TxRow[];
  /** A read that failed: the page says so instead of showing an empty or partial list. */
  error: string | null;
};

export const categoryHref = (month: string, id: string, lang?: Lang) =>
  `/budget/category?month=${month}&id=${encodeURIComponent(id)}${lang ? `&lang=${lang}` : ''}`;

/** null when the id is no category this page can name: the route answers 404 and shows no rows. */
export async function loadCategoryPage(api: ApiCall, o: { now: Date; month?: string; id: string }): Promise<CategoryPageData | null> {
  const today = jerusalemToday(o.now);
  const month = validMonth(o.month) ?? currentMonth(o.now);
  let error: string | null = null, code: string | null = null;
  const get = async <T>(path: string): Promise<T | null> => {
    const r = await api(path);
    if (r.ok) return await r.json() as T;
    const j = await r.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    code ??= j.error?.code ?? String(r.status);
    error ??= j.error?.message ?? `HTTP ${r.status}`;
    return null;
  };
  const fail = (label = o.id): CategoryPageData => ({ month, today, id: o.id, label, line: null, off: null, rows: [], error });
  const status = await get<StatusJson>(`/v1/budget/status?month=${month}`);
  // no_plan is not a failure: the category can still be listed, it just has no line.
  if (!status && code !== 'no_plan') return fail();
  if (!status) error = code = null;
  const line = status?.lines.find(l => l.categoryId === o.id) ?? null;
  const off = line ? null : [...(status?.unplanned ?? []), ...(status?.excluded ?? [])].find(l => l.categoryId === o.id) ?? null;
  let label = line?.label ?? off?.label;
  if (!label) {
    const cats = await get<{ categories: { id: string; label: string }[] }>('/v1/categories');
    if (!cats) return fail();
    label = cats.categories.find(c => c.id === o.id)?.label;
  }
  if (!label) return null;
  const last = String(daysIn(month)).padStart(2, '0');
  const tx = await get<{ transactions: { id: string; date: string; payee: string | null; accountName: string; memo: string; amount: number }[] }>(
    `/v1/transactions?category=${encodeURIComponent(o.id)}&from=${month}-01&to=${month}-${last}&limit=1000`);
  if (!tx) return fail(label);
  const rows = tx.transactions.map(r => ({ id: r.id, date: r.date, payee: r.payee, accountName: r.accountName, memo: r.memo ?? '', amount: r.amount }));
  return { month, today, id: o.id, label, line, off, rows, error: null };
}

const page = (lang: Lang, title: string, main: string) => `<!doctype html>
<html lang="${lang}" dir="${lang === 'he' ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(title)}</title>
<style>${STYLE}</style></head>
<body><main>
${main}
</main></body></html>`;

export function renderCategoryNotFound(lang: Lang): string {
  const t = T[lang];
  return page(lang, t.title, `<section><p>${esc(t.notFound)}</p><p><a href="/budget">${esc(t.back)}</a></p></section>`);
}

export function renderCategory(v: CategoryPageData, lang: Lang): string {
  const t = T[lang];
  const back = lang === 'he' ? '→' : '←', fwd = lang === 'he' ? '←' : '→';
  const prev = shift(v.month, -1), next = shift(v.month, 1);
  const showNext = next <= shift(v.today.slice(0, 7), 1);
  const nums = v.line
    ? (() => { const bal = v.line.balance.amount; return `<div class="row"><span>${esc(t.spentOf(ils(v.line.spent.amount), ils(held(v.line))))}</span>${bal < 0
      ? `<span class="off">${esc(t.over(ils(-bal)))}</span>` : `<span>${esc(t.left(ils(bal)))}</span>`}</div>`; })()
    : `<div class="row"><span>${esc(t.spent(ils(v.off?.spent.amount ?? -v.rows.reduce((s, r) => s + r.amount, 0))))}</span></div>`;
  // The header counts Actual's budget figure; the list is the ledger. Say so when they disagree, never hide it.
  const net = -v.rows.reduce((s, r) => s + r.amount, 0);
  const counted = v.line?.spent.amount ?? v.off?.spent.amount;
  const drift = counted !== undefined && (net !== counted || v.rows.length >= 1000)
    ? `<p class="hint">${esc(t.drift(ils(net), ils(counted)))}</p>` : '';
  const out = v.rows.filter(r => r.amount < 0);
  const big = out.reduce<TxRow | null>((m, r) => (!m || r.amount < m.amount ? r : m), null);
  const list = v.rows.length
    ? `${big ? `<p class="sub">${esc(t.summary(v.rows.length, big.payee ?? '', ils(-big.amount)))}</p>` : ''}<table>${v.rows.map(r =>
      `<tr><td>${esc(r.date.slice(8, 10))}/${esc(r.date.slice(5, 7))}</td><td><bdi>${esc(r.payee ?? '')}</bdi>${r.memo ? `<span class="memo"><bdi>${esc(r.memo)}</bdi></span>` : ''}</td>`
      + `<td class="mute"><bdi>${esc(r.accountName)}</bdi></td>`
      + (r.amount > 0 ? `<td class="n good">+${ils(r.amount)}</td>` : `<td class="n">${ils(-r.amount)}</td>`) + '</tr>').join('')}</table>`
    : `<p class="sub">${esc(t.noTx)}</p>`;
  return page(lang, `${name(v.label)} · ${monthName(v.month, lang)}`,
    `<header><h1>${nm(v.label)}</h1><a href="${esc(categoryHref(v.month, v.id, lang === 'he' ? 'en' : 'he'))}">${t.other}</a></header>
<p class="when"><a href="${esc(`/budget?month=${v.month}`)}">${back} ${esc(t.back)}</a> · ${esc(monthName(v.month, lang))}</p>
<nav class="nav"><a href="${esc(categoryHref(prev, v.id))}">${back} ${esc(shortMonth(prev, lang))}</a>${showNext
    ? `<a href="${esc(categoryHref(next, v.id))}">${esc(shortMonth(next, lang))} ${fwd}</a>` : '<span></span>'}</nav>
${v.error ? `<section><p>${esc(t.error)} ${esc(v.error)}</p></section>` : `<section>${nums}</section>
<section>${list}${drift}</section>`}`);
}

export function createBudgetPage(deps: { api: ApiCall; verify?: (token: string) => Promise<string | null>; now?: () => Date }): Hono {
  const now = deps.now ?? (() => new Date());
  const app = new Hono();
  /** Access check and language; a Response when the request must stop here. */
  const gate = async (c: Context): Promise<Lang | Response> => {
    if (!deps.verify) return c.text('Not found', 404);
    const token = c.req.header('cf-access-jwt-assertion') ?? getCookie(c, 'CF_Authorization') ?? '';
    if (!token || !(await deps.verify(token))) {
      return c.text('Open this page through its Cloudflare Access address and sign in.', 403);
    }
    const asked = c.req.query('lang');
    let lang: Lang = getCookie(c, 'budget_lang') === 'en' ? 'en' : 'he';
    if (asked === 'he' || asked === 'en') {
      lang = asked;
      setCookie(c, 'budget_lang', asked, { path: '/budget', maxAge: 31_536_000, sameSite: 'Lax', httpOnly: true, secure: true });
    }
    c.header('Cache-Control', 'no-store');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    c.header('Referrer-Policy', 'no-referrer');
    return lang;
  };
  app.get('/budget', async c => {
    const lang = await gate(c);
    if (lang instanceof Response) return lang;
    const v = await loadBudgetPage(deps.api, { now: now(), month: c.req.query('month') });
    return c.html(renderBudget(v, lang));
  });
  app.get('/budget/category', async c => {
    const lang = await gate(c);
    if (lang instanceof Response) return lang;
    const month = c.req.query('month');
    if (month !== undefined && !validMonth(month)) return c.html(renderCategoryNotFound(lang), 404);
    const v = await loadCategoryPage(deps.api, { now: now(), month, id: c.req.query('id') ?? '' });
    if (!v) return c.html(renderCategoryNotFound(lang), 404);
    return c.html(renderCategory(v, lang), v.error ? 502 : 200);
  });
  return app;
}
