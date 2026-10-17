// Optional: seed Actual with payee → category rules learned from a YNAB export.
//
//   CURATOR_TOKEN=… node scripts/bootstrap-rules.ts --export ynab.json [--url http://localhost:5007]
//     [--since YYYY-MM-DD (default 24 months ago)] [--vocab curator.yaml] [--apply]
//
// Without --apply it only prints what it would create. Without CURATOR_TOKEN it prints the proposals
// without checking them against Actual. Rules that already exist (same conditions) are left alone.
// A YNAB payee named after the memo (a standing order shown as its recipient) becomes a rule on the
// generic payee Actual imported it under plus the name in the memo; it is skipped until Actual has
// such a row, because a rule on the recipient's name would never match.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { bankPayeeFor, proposeRules, type YnabExport } from '../src/bootstrap/ynab.ts';
import { loadVocabulary } from '../src/vocabulary.ts';

const { values: args } = parseArgs({ options: {
  export: { type: 'string' },
  url: { type: 'string', default: 'http://localhost:5007' },
  since: { type: 'string', default: new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10) },
  vocab: { type: 'string', default: process.env.VOCAB_PATH ?? 'config/curator.example.yaml' },
  'min-rows': { type: 'string', default: '2' },
  'min-agreement': { type: 'string', default: '0.9' },
  apply: { type: 'boolean', default: false },
} });
if (!args.export) throw new Error('--export <ynab export json> is required');

const vocab = loadVocabulary(args.vocab);
const exp = JSON.parse(readFileSync(args.export, 'utf8')) as YnabExport;
const proposals = proposeRules(exp, { since: args.since, minRows: Number(args['min-rows']),
  minAgreement: Number(args['min-agreement']), genericPayees: vocab.genericPayees, memoKeyPatterns: vocab.memoKeyPatterns });
const covered = proposals.reduce((s, p) => s + p.rows, 0);
console.log(`${proposals.length} rules proposed from rows since ${args.since}, covering ${covered} rows`
  + ` (generic payees skipped: ${vocab.genericPayees.join(', ') || 'none'}).`);

const token = process.env.CURATOR_TOKEN;
if (!token) {
  for (const p of proposals) console.log(`  ${p.importedPayee}  →  ${p.categoryLabel}  (${p.rows} rows, ${Math.round(p.agreement * 100)}%)`
    + (p.memoKey ? '  [named from the memo; needs Actual to find the bank payee]' : ''));
  console.log('\nCURATOR_TOKEN not set: proposals not checked against Actual, nothing applied.');
  process.exit(0);
}

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${args.url.replace(/\/+$/, '')}/v1${path}`, { ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } });
  const body = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
};

const norm = (s: string) => s.trim().toLowerCase();
const categories = (await api('/categories')).categories as { id: string; label: string }[];
const byLabel = new Map(categories.map(c => [norm(c.label), c.id]));
const rules = (await api('/rules')).rules as { payee?: string; notesContains?: string }[];
const ruleKey = (payee: string, notesContains?: string) => `${norm(payee)}\u0000${norm(notesContains ?? '')}`;
const existing = new Set(rules.filter(r => r.payee).map(r => ruleKey(String(r.payee), r.notesContains)));

const todo: { payee: string; notesContains?: string; category: string; p: (typeof proposals)[number] }[] = [];
let skippedExisting = 0;
const missing: string[] = [];
const unresolved: string[] = [];
for (const p of proposals) {
  const category = byLabel.get(norm(p.categoryLabel));
  if (!category) { missing.push(`${p.importedPayee} → ${p.categoryLabel}`); continue; }
  let payee = p.importedPayee;
  let notesContains: string | undefined;
  if (p.memoKey) {
    const q = new URLSearchParams({ q: p.memoKey, from: args.since, limit: '1000' });
    const rows = (await api(`/transactions?${q}`)).transactions as { importedPayee: string | null; memo: string }[];
    const bank = bankPayeeFor(p.memoKey, rows, vocab.genericPayees);
    if (!bank) { unresolved.push(`${p.importedPayee} → ${p.categoryLabel}`); continue; }
    payee = bank;
    notesContains = p.memoKey;
  }
  if (existing.has(ruleKey(payee, notesContains))) { skippedExisting++; continue; }
  todo.push({ payee, ...(notesContains ? { notesContains } : {}), category, p });
}
for (const t of todo) console.log(`  ${t.payee}${t.notesContains ? ` + memo "${t.notesContains}"` : ''}  →  ${t.p.categoryLabel}`
  + `  (${t.p.rows} rows, ${Math.round(t.p.agreement * 100)}%)`);
console.log(`\nnew: ${todo.length} · already a rule: ${skippedExisting} · category not in Actual: ${missing.length}`
  + ` · named from the memo, no matching row in Actual yet: ${unresolved.length}`);
for (const m of missing) console.log(`  missing category: ${m}`);
for (const u of unresolved) console.log(`  not created yet (re-run after the first such row is imported): ${u}`);

if (!args.apply) {
  console.log('\nDry run. Re-run with --apply to create the new rules.');
  process.exit(0);
}
let created = 0;
for (const t of todo) {
  await api('/rules', { method: 'POST', body: JSON.stringify({ payee: t.payee, notesContains: t.notesContains,
    category: t.category, origin: 'bootstrap' }) });
  created++;
}
console.log(`Created ${created} rules.`);
