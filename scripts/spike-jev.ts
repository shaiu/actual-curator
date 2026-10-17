// THROWAWAY: rollout gate 1 (spec §3, plan Task 4). Not tested, not shipped.
//
// Asks the classifier the real category question for a stratified sample of
// already-categorized rows from a YNAB export, and reports how often it agrees
// with the human's category, overall and in the >= threshold bucket.
//
//   node --env-file=$HOME/.config/actual-curator/env scripts/spike-jev.ts \
//     --export ~/path/to/ynab-budget.json [--n 300] [--since 2025-10-01] \
//     [--oversample PAYBOX,BIT,הוראת-קבע] [--provider openrouter-jev] [--out result.json]
//   Haiku through OpenRouter with the same key:
//     --provider openai-compatible --base-url https://openrouter.ai/api/v1 --key-env OPENROUTER_API_KEY --model anthropic/claude-haiku-5-5
//
// The export never leaves the machine except as one row's payee/memo per call.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createClassifier, type CategoryOption, type Classifier, ClassifierError, type RowState } from '../src/classifier/index.ts';
import type { ClassifierConfig, ClassifierProvider } from '../src/config.ts';
import { loadVocabulary } from '../src/vocabulary.ts';

const { values: args } = parseArgs({ options: {
  export: { type: 'string' },
  n: { type: 'string', default: '300' },
  since: { type: 'string', default: '2025-10-01' },
  oversample: { type: 'string' },
  'oversample-share': { type: 'string', default: '0.3' },
  provider: { type: 'string', default: 'openrouter-jev' },
  model: { type: 'string' },
  'base-url': { type: 'string' },
  'key-env': { type: 'string' },
  vocab: { type: 'string', default: 'config/curator.example.yaml' },
  threshold: { type: 'string', default: '0.8' },
  concurrency: { type: 'string', default: '4' },
  seed: { type: 'string', default: '1' },
  out: { type: 'string' },
} });
if (!args.export) throw new Error('--export <ynab export json> is required');

// ---------- export ----------
type Y = { id: string; name: string; deleted?: boolean; hidden?: boolean; internal?: boolean };
type YTx = { id: string; date: string; amount: number; memo: string | null; account_id: string; payee_id: string | null;
  category_id: string | null; transfer_account_id: string | null; deleted: boolean };
const budget = JSON.parse(readFileSync(args.export, 'utf8')).data.budget as {
  transactions: YTx[]; payees: Y[]; accounts: (Y & { on_budget: boolean })[];
  categories: (Y & { category_group_id: string })[]; category_groups: Y[]; currency_format?: { iso_code?: string };
};
const currency = budget.currency_format?.iso_code ?? 'ILS';
const vocab = loadVocabulary(args.vocab);
const generic = new Set(args.oversample ? args.oversample.split(',').map(s => s.trim()) : vocab.genericPayees);

const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map(x => [x.id, x]));
const payees = byId(budget.payees), accounts = byId(budget.accounts), groups = byId(budget.category_groups);
const allCats = byId(budget.categories);

// Hints are keyed "Group / Category"; Actual labels may carry emoji the config author left out.
const norm = (s: string) => s.normalize('NFKC').replace(/[^\p{L}\p{N}/ ]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
const hints = new Map(Object.entries(vocab.categoryHints).map(([k, v]) => [norm(k), v]));

const label = (c: Y & { category_group_id: string }) => `${groups.get(c.category_group_id)?.name ?? '?'} / ${c.name.trim()}`;
const INCOME_ID = budget.categories.find(c => c.internal && c.name.startsWith('Inflow'))?.id;
const options: CategoryOption[] = budget.categories
  .filter(c => {
    const g = groups.get(c.category_group_id);
    if (c.deleted || c.hidden || g?.deleted || g?.hidden) return false;
    if (c.id === INCOME_ID) return true;
    return !c.internal && !g?.internal && g?.name !== 'Credit Card Payments';
  })
  .map(c => {
    const o: CategoryOption = c.id === INCOME_ID
      ? { id: c.id, label: 'Income / Ready to Assign', isIncome: true }
      : { id: c.id, label: label(c), isIncome: false };
    const h = hints.get(norm(o.label));
    if (h) o.hint = h;
    return o;
  });
const offered = new Set(options.map(o => o.id));
const labelOf = (id: string) => options.find(o => o.id === id)?.label ?? (allCats.get(id) ? label(allCats.get(id)!) : id);

// ---------- rows ----------
const live = budget.transactions
  .filter(t => !t.deleted && !t.transfer_account_id && t.category_id && accounts.get(t.account_id)?.on_budget)
  .sort((a, b) => a.date.localeCompare(b.date));
const payeeName = (t: YTx) => (t.payee_id && payees.get(t.payee_id)?.name) || '';

// Per payee history, for priorCategories (strictly earlier rows, as the curator would see in Actual).
const history = new Map<string, YTx[]>();
for (const t of live) history.set(payeeName(t), [...(history.get(payeeName(t)) ?? []), t]);

// Payees a bootstrap rule would cover (>=2 rows, >=90% one category, 24 months, not generic):
// those rows never reach the classifier for a category in production.
const cutoff24 = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10);
const ruled = new Set<string>();
for (const [p, rows] of history) {
  if (generic.has(p)) continue;
  const recent = rows.filter(r => r.date >= cutoff24);
  if (recent.length < 2) continue;
  const counts = new Map<string, number>();
  for (const r of recent) counts.set(r.category_id!, (counts.get(r.category_id!) ?? 0) + 1);
  if (Math.max(...counts.values()) / recent.length >= 0.9) ruled.add(p);
}

const pool = live.filter(t => t.date >= args.since! && offered.has(t.category_id!) && (payeeName(t) || t.memo));
const excludedHidden = live.filter(t => t.date >= args.since! && !offered.has(t.category_id!)).length;

let seed = Number(args.seed);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const shuffle = <T>(xs: T[]) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const n = Number(args.n);
const gen = shuffle(pool.filter(t => generic.has(payeeName(t))));
const rest = shuffle(pool.filter(t => !generic.has(payeeName(t))));
const nGen = Math.min(gen.length, Math.round(n * Number(args['oversample-share'])));
const sample = [...gen.slice(0, nGen), ...rest.slice(0, n - nGen)];

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function toState(t: YTx): RowState {
  const d = new Date(`${t.date}T12:00:00Z`);
  const prior = (history.get(payeeName(t)) ?? []).filter(r => r.date < t.date || (r.date === t.date && r.id < t.id));
  return {
    payee: payeeName(t), memo: t.memo ?? '', amount: Math.round(t.amount / 10), // YNAB milliunits -> minor units
    currency, account: accounts.get(t.account_id)?.name ?? '', weekday: DAYS[d.getUTCDay()], month: MONTHS[d.getUTCMonth()],
    priorCategories: prior.slice(-3).reverse().map(r => labelOf(r.category_id!)),
  };
}

// ---------- classifier ----------
const provider = args.provider as ClassifierProvider;
const keyVar = args['key-env'] ?? { 'openrouter-jev': 'OPENROUTER_API_KEY', anthropic: 'ANTHROPIC_API_KEY', 'openai-compatible': 'OPENAI_API_KEY' }[provider];
const defaultModel = { 'openrouter-jev': 'typesafe/jev-1.14', anthropic: 'claude-haiku-5-5', 'openai-compatible': '' }[provider];
if (!keyVar) throw new Error(`unknown --provider ${provider}`);
const cfg: ClassifierConfig = { provider, apiKey: process.env[keyVar] ?? '', model: args.model ?? defaultModel };
const baseUrl = args['base-url'] ?? (provider === 'openai-compatible' ? process.env.OPENAI_BASE_URL : undefined);
if (baseUrl) cfg.baseUrl = baseUrl;
if (!cfg.apiKey && provider !== 'openai-compatible') throw new Error(`${keyVar} is not set (use --env-file)`);
const classifier: Classifier = createClassifier(cfg);

type Result = { id: string; date: string; payee: string; memo: string; generic: boolean; ruled: boolean;
  truth: string; guess?: string; confidence?: number; ok?: boolean; error?: string; ms?: number; cost?: number };

async function one(t: YTx): Promise<Result> {
  const base = { id: t.id, date: t.date, payee: payeeName(t), memo: t.memo ?? '', generic: generic.has(payeeName(t)),
    ruled: ruled.has(payeeName(t)), truth: labelOf(t.category_id!) };
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    try {
      const r = await classifier.classify(toState(t), { categories: options, tags: [] });
      return { ...base, guess: labelOf(r.category!.id), confidence: r.category!.confidence,
        ok: r.category!.id === t.category_id || labelOf(r.category!.id) === base.truth,
        ms: Math.round(performance.now() - started), ...(r.cost !== undefined ? { cost: r.cost } : {}) };
    } catch (e) {
      if (e instanceof ClassifierError && e.retryable && attempt < 3) { await new Promise(r => setTimeout(r, 2000 * 2 ** attempt)); continue; }
      return { ...base, error: (e as Error).message.slice(0, 200) };
    }
  }
}

const results: Result[] = [];
let next = 0;
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (next < sample.length) {
    const t = sample[next++];
    results.push(await one(t));
    if (results.length % 25 === 0) process.stderr.write(`${results.length}/${sample.length}\n`);
  }
}));

// ---------- report ----------
const thr = Number(args.threshold);
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
function stats(rs: Result[]) {
  const done = rs.filter(r => !r.error);
  const bucket = done.filter(r => (r.confidence ?? 0) >= thr);
  return { rows: rs.length, errors: rs.length - done.length,
    agree: pct(done.filter(r => r.ok).length, done.length),
    inBucket: pct(bucket.length, done.length),
    bucketAgree: pct(bucket.filter(r => r.ok).length, bucket.length),
    bucketN: bucket.length };
}
const slices: [string, Result[]][] = [
  ['all sampled', results],
  ['generic payees', results.filter(r => r.generic)],
  ['non-generic', results.filter(r => !r.generic)],
  ['would reach classifier (no bootstrap rule)', results.filter(r => !r.ruled)],
];
const lines: string[] = [];
lines.push(`Classifier: ${classifier.name} · threshold ${thr} · ${options.length} categories offered · since ${args.since}`);
lines.push(`Pool ${pool.length} rows (${excludedHidden} more excluded: hidden/credit-card/internal category); sample ${sample.length} (${nGen} generic).`, '');
lines.push('| Slice | Rows | Errors | Agreement | In ≥thr bucket | Agreement in bucket |', '|---|---|---|---|---|---|');
for (const [name, rs] of slices) {
  const s = stats(rs);
  lines.push(`| ${name} | ${s.rows} | ${s.errors} | ${s.agree} | ${s.inBucket} (${s.bucketN}) | ${s.bucketAgree} |`);
}
const calib = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map((lo, i, a) => {
  const hi = a[i + 1] ?? 1.01;
  const rs = results.filter(r => !r.error && r.confidence! >= lo && r.confidence! < hi);
  return `| ${lo.toFixed(2)}–${hi > 1 ? '1.00' : hi.toFixed(2)} | ${rs.length} | ${pct(rs.filter(r => r.ok).length, rs.length)} |`;
});
lines.push('', '| Confidence band | Rows | Agreement |', '|---|---|---|', ...calib);
lines.push(`| below 0.50 | ${results.filter(r => !r.error && r.confidence! < 0.5).length} | ${pct(results.filter(r => !r.error && r.confidence! < 0.5 && r.ok).length, results.filter(r => !r.error && r.confidence! < 0.5).length)} |`);

const confusion = new Map<string, number>();
for (const r of results) if (!r.error && !r.ok) confusion.set(`${r.truth} → ${r.guess}`, (confusion.get(`${r.truth} → ${r.guess}`) ?? 0) + 1);
lines.push('', '| Top confusions (truth → guess) | Rows |', '|---|---|',
  ...[...confusion].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `| ${k} | ${v} |`));

const confidentWrong = results.filter(r => !r.error && !r.ok && r.confidence! >= thr).sort((a, b) => b.confidence! - a.confidence!);
lines.push('', `Confident and wrong (≥${thr}): ${confidentWrong.length}`, '', '| Payee | Memo | Truth | Guess | Conf |', '|---|---|---|---|---|',
  ...confidentWrong.slice(0, 15).map(r => `| ${r.payee} | ${r.memo.slice(0, 40)} | ${r.truth} | ${r.guess} | ${r.confidence!.toFixed(2)} |`));

const costs = results.filter(r => r.cost !== undefined).map(r => r.cost!);
const ms = results.filter(r => r.ms !== undefined).map(r => r.ms!).sort((a, b) => a - b);
lines.push('', `Cost: ${costs.length ? `$${costs.reduce((a, b) => a + b, 0).toFixed(5)} for ${costs.length} calls` : 'not reported'}`
  + ` · latency p50 ${ms[Math.floor(ms.length / 2)] ?? '—'} ms, p95 ${ms[Math.floor(ms.length * 0.95)] ?? '—'} ms`);
const errs = results.filter(r => r.error);
if (errs.length) lines.push('', 'Errors:', ...[...new Set(errs.map(e => e.error))].slice(0, 5).map(e => `- ${e}`));

console.log(lines.join('\n'));
if (args.out) writeFileSync(args.out, JSON.stringify({ options: options.length, results }, null, 2));
