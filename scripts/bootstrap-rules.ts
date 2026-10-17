// Optional: seed Actual with payee → category rules learned from a YNAB export.
//
//   CURATOR_TOKEN=… node scripts/bootstrap-rules.ts --export ynab.json [--url http://localhost:5007]
//     [--since YYYY-MM-DD (default 24 months ago)] [--vocab curator.yaml] [--apply]
//
// Without --apply it only prints what it would create. Without CURATOR_TOKEN it prints the proposals
// without checking them against Actual. Rules that already exist (same conditions) are left alone.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { proposeRules, type YnabExport } from '../src/bootstrap/ynab.ts';
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
  minAgreement: Number(args['min-agreement']), genericPayees: vocab.genericPayees });
const covered = proposals.reduce((s, p) => s + p.rows, 0);
console.log(`${proposals.length} rules proposed from rows since ${args.since}, covering ${covered} rows`
  + ` (generic payees skipped: ${vocab.genericPayees.join(', ') || 'none'}).`);

const token = process.env.CURATOR_TOKEN;
if (!token) {
  for (const p of proposals) console.log(`  ${p.importedPayee}  →  ${p.categoryLabel}  (${p.rows} rows, ${Math.round(p.agreement * 100)}%)`);
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
const existing = new Set(rules.filter(r => r.payee && !r.notesContains).map(r => norm(String(r.payee))));

const todo: { payee: string; category: string; p: (typeof proposals)[number] }[] = [];
let skippedExisting = 0;
const missing: string[] = [];
for (const p of proposals) {
  const category = byLabel.get(norm(p.categoryLabel));
  if (!category) { missing.push(`${p.importedPayee} → ${p.categoryLabel}`); continue; }
  if (existing.has(norm(p.importedPayee))) { skippedExisting++; continue; }
  todo.push({ payee: p.importedPayee, category, p });
}
for (const t of todo) console.log(`  ${t.payee}  →  ${t.p.categoryLabel}  (${t.p.rows} rows, ${Math.round(t.p.agreement * 100)}%)`);
console.log(`\nnew: ${todo.length} · already a rule for that payee: ${skippedExisting} · category not in Actual: ${missing.length}`);
for (const m of missing) console.log(`  missing category: ${m}`);

if (!args.apply) {
  console.log('\nDry run. Re-run with --apply to create the new rules.');
  process.exit(0);
}
let created = 0;
for (const t of todo) {
  await api('/rules', { method: 'POST', body: JSON.stringify({ payee: t.payee, category: t.category, origin: 'bootstrap' }) });
  created++;
}
console.log(`Created ${created} rules.`);
