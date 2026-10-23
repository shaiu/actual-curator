import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import type { CuratorRow, CuratorRule, NewCuratorRule, ReportRow } from '../../src/actual/types.ts';
import type { CategoryOption } from '../../src/classifier/types.ts';
import type { RunSummary } from '../../src/curator/run.ts';
import { type ApiStore, createApp } from '../../src/http/app.ts';
import { DecisionLog } from '../../src/log.ts';
import { parseVocabulary } from '../../src/vocabulary.ts';

const vocab = parseVocabulary(`
tags:
  - { tag: kids, meaning: for a child }
genericPayees: [PAYBOX]
memoKeyPatterns: ['לטובת:\\s*(.+?)(?:\\.|$)']
`);
const categories: CategoryOption[] = [{ id: 'coffee', label: 'Needs / Coffee', isIncome: false },
  { id: 'gifts', label: 'Wants / Gifts', isIncome: false }, { id: 'dining', label: 'Wants / Dining', isIncome: false },
  { id: 'groc', label: 'Needs / Groceries', isIncome: false }];
const row = (over: Partial<CuratorRow>): CuratorRow => ({ id: 't', date: '2026-10-10', account: 'a', accountName: 'Bank',
  amount: -2550, payee: 'ארומה', importedPayee: 'ארומה', notes: '', category: null, transferId: null, ...over });

class FakeStore implements ApiStore {
  rows: CuratorRow[] = [];
  ruleList: CuratorRule[] = [];
  spendRows: ReportRow[] = [];
  updates: { id: string; fields: object }[] = [];
  syncs = 0;
  async sync() { this.syncs++; }
  async categories(o?: { includeHidden?: boolean }) {
    return o?.includeHidden ? [...categories, { id: 'old', label: 'Needs / Old (hidden)', isIncome: false }] : categories;
  }
  async transactions(q: { tag?: string; limit: number }) {
    return this.rows.filter(r => !q.tag || (r.notes ?? '').includes(`#${q.tag}`)).slice(0, q.limit);
  }
  async transaction(id: string) { return this.rows.find(r => r.id === id); }
  async update(id: string, fields: { category?: string | null; notes?: string }) {
    this.updates.push({ id, fields });
    const r = this.rows.find(x => x.id === id)!;
    Object.assign(r, fields);
  }
  async rules() { return this.ruleList; }
  async replaceRule(r: NewCuratorRule) {
    const conds = [{ field: 'imported_payee', op: 'is', value: r.importedPayee },
      ...(r.notesContains ? [{ field: 'notes', op: 'contains', value: r.notesContains }] : [])];
    const existing = this.ruleList.find(x => JSON.stringify(x.conditions) === JSON.stringify(conds));
    const actions = [{ field: 'category', op: 'set', value: r.categoryId }];
    if (existing) { existing.actions = actions; return existing.id; }
    const id = `rule${this.ruleList.length + 1}`;
    this.ruleList.push({ id, stage: null, conditionsOp: 'and', conditions: conds, actions });
    return id;
  }
  async deleteRule(id: string) {
    const before = this.ruleList.length;
    this.ruleList = this.ruleList.filter(r => r.id !== id);
    return this.ruleList.length < before;
  }
  excludes: (readonly string[] | undefined)[] = [];
  async spend(q: { exclude?: readonly string[] }) { this.excludes.push(q.exclude); return this.spendRows; }
  async income(q: { exclude?: readonly string[] }) { this.excludes.push(q.exclude); return [{ key: 'sal', label: 'Income / Salary', amount: 1500000 }]; }
}

const summary: RunSummary = { synced: true, ok: true, seen: 2, ruleHits: 1, classified: 1, review: 0, settled: 0,
  corrections: 0, promoted: 0, errors: 0 };
let store: FakeStore;
let log: DecisionLog;
let app: ReturnType<typeof createApp>;
const auth = { authorization: 'Bearer secret' };
const json = (body: unknown) => ({ method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  store = new FakeStore();
  log = new DecisionLog(mkdtempSync(join(tmpdir(), 'curator-http-')));
  app = createApp({ store, log, vocab, cfg: { token: 'secret', currency: 'ILS' }, classifierName: 'fake',
    runNow: async () => summary, versions: { curator: '0.1.0', actualApi: '26.10.0', server: '26.10.0' },
    status: () => ({ lastSyncAt: '2026-10-16T10:00:00Z', lastRunAt: '2026-10-16T10:00:00Z', lastRunOk: true }),
    now: () => new Date('2026-10-16T12:00:00Z') });
});

test('health answers without a bearer; everything else needs the right one', async () => {
  const h = await app.request('/v1/health');
  expect(h.status).toBe(200);
  expect(await h.json()).toMatchObject({ ok: true, pendingReview: 0, classifier: { name: 'fake', reachable: true },
    versions: { curator: '0.1.0', actualApi: '26.10.0', server: '26.10.0' } });
  expect((await app.request('/v1/categories')).status).toBe(401);
  expect((await app.request('/v1/categories', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  const r = await app.request('/v1/categories', { headers: auth });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ categories });
  expect(await (await app.request('/v1/x', { headers: auth })).json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
});

test('POST /transactions/:id with a category strips #review, writes, logs and makes a human rule on the memo phrase', async () => {
  store.rows.push(row({ id: 'p1', payee: 'PAYBOX', importedPayee: 'PAYBOX', notes: 'לטובת: דנה. #auto #review' }));
  const r = await app.request('/v1/transactions/p1', json({ category: 'gifts' }));
  expect(r.status).toBe(200);
  expect(store.updates).toEqual([{ id: 'p1', fields: { category: 'gifts', notes: 'לטובת: דנה. #auto' } }]);
  expect(store.syncs).toBe(1);
  expect(store.ruleList).toHaveLength(1);
  expect(store.ruleList[0].conditions).toContainEqual({ field: 'notes', op: 'contains', value: 'דנה' });
  expect(await log.rules.originOf('rule1')).toBe('human');
  expect(await log.lastFor('p1')).toMatchObject({ kind: 'settled-review', before: { notes: 'לטובת: דנה. #auto #review' } });
  const body = await r.json();
  expect(body).toMatchObject({ transaction: { id: 'p1', category: 'gifts', tags: ['auto'], memo: 'לטובת: דנה.' }, ruleId: 'rule1' });
});

test('POST /transactions/:id: rule:false makes no rule; tags add/remove; unknown tag and unknown id are rejected', async () => {
  store.rows.push(row({ id: 't1', notes: 'm #auto' }));
  await app.request('/v1/transactions/t1', json({ category: 'coffee', rule: false, tags: { add: ['kids'] } }));
  expect(store.ruleList).toEqual([]);
  expect(store.rows[0].notes).toBe('m #kids #auto');
  expect((await app.request('/v1/transactions/t1', json({ tags: { add: ['nope'] } }))).status).toBe(400);
  expect((await app.request('/v1/transactions/t1', json({ category: 'missing' }))).status).toBe(400);
  expect((await app.request('/v1/transactions/zzz', json({ category: 'coffee' }))).status).toBe(404);
  expect((await app.request('/v1/transactions/t1', json({ category: 5 }))).status).toBe(400);
});

test('report/spend?by=tag returns the #kids row with amount and formatted', async () => {
  store.spendRows = [{ key: 'kids', label: '#kids', amount: -70050 }];
  const r = await app.request('/v1/report/spend?from=2026-10-01&to=2026-10-31&by=tag', { headers: auth });
  expect(await r.json()).toEqual({ from: '2026-10-01', to: '2026-10-31', by: 'tag',
    rows: [{ key: 'kids', label: '#kids', amount: -70050, formatted: '-700.50' }], total: { amount: -70050, formatted: '-700.50' } });
  expect((await app.request('/v1/report/spend?from=bad&to=2026-10-31&by=tag', { headers: auth })).status).toBe(400);
});

test('POST /rules twice with the same conditions yields one rule; DELETE removes it, then 404', async () => {
  const a = await (await app.request('/v1/rules', json({ payee: 'ארומה', category: 'coffee' }))).json();
  const b = await (await app.request('/v1/rules', json({ payee: 'ארומה', category: 'dining', origin: 'bootstrap' }))).json();
  expect(b.id).toBe(a.id);
  const list = await (await app.request('/v1/rules', { headers: auth })).json();
  expect(list.rules).toEqual([{ id: a.id, payee: 'ארומה', category: 'dining', categoryLabel: 'Wants / Dining', categoryHidden: false, origin: 'bootstrap', supported: true,
    conditions: expect.any(Array), actions: expect.any(Array) }]);
  expect((await app.request(`/v1/rules/${a.id}`, { method: 'DELETE', headers: auth })).status).toBe(200);
  expect((await app.request(`/v1/rules/${a.id}`, { method: 'DELETE', headers: auth })).status).toBe(404);
});

test('GET /review: oldest first, with the top-3 candidates from the decision log', async () => {
  store.rows.push(row({ id: 'new', date: '2026-10-12', notes: 'b #auto #review' }), row({ id: 'old', date: '2026-10-01', notes: 'a #auto #review' }));
  await log.append({ at: '2026-10-02T00:00:00Z', txId: 'old', importedPayee: 'ארומה', memo: 'a', amount: -2550, kind: 'review',
    before: { category: null, notes: 'a' }, after: { category: null, notes: 'a #auto #review' }, dryRun: false,
    classification: { category: { id: 'coffee', confidence: 0.5, probabilities: { coffee: 0.5, dining: 0.3, groc: 0.15, gifts: 0.05 } }, tags: {} } as never });
  const body = await (await app.request('/v1/review', { headers: auth })).json();
  expect(body.rows.map((r: { id: string }) => r.id)).toEqual(['old', 'new']);
  expect(body.rows[0].candidates).toEqual([{ id: 'coffee', label: 'Needs / Coffee', p: 0.5 },
    { id: 'dining', label: 'Wants / Dining', p: 0.3 }, { id: 'groc', label: 'Needs / Groceries', p: 0.15 }]);
  expect(body.rows[0].rule).toEqual({ payee: 'ארומה' });
  expect(body.rows[1].candidates).toEqual([]);
});

test('GET /review: reviewSince is the latest review decision time, null without one', async () => {
  store.rows.push(row({ id: 'logged', notes: 'a #auto #review' }), row({ id: 'orphan', notes: 'b #auto #review' }));
  await log.append({ at: '2026-10-02T00:00:00Z', txId: 'logged', importedPayee: 'X', memo: 'a', amount: -100, kind: 'review',
    before: { category: null, notes: 'a' }, after: { category: null, notes: 'a #auto #review' }, dryRun: false });
  const body = await (await app.request('/v1/review', { headers: auth })).json();
  expect(body.rows.find((r: { id: string }) => r.id === 'logged').reviewSince).toBe('2026-10-02T00:00:00Z');
  expect(body.rows.find((r: { id: string }) => r.id === 'orphan').reviewSince).toBeNull();
});

test('POST /curate/run returns the run summary; GET /decisions?since filters', async () => {
  expect(await (await app.request('/v1/curate/run', { method: 'POST', headers: auth })).json()).toEqual(summary);
  await log.append({ at: '2026-10-16T09:00:00Z', txId: 'x', importedPayee: '', memo: '', amount: 0, kind: 'skipped',
    before: { category: null, notes: '' }, dryRun: false });
  expect((await (await app.request('/v1/decisions?since=2026-10-16T08:00:00Z', { headers: auth })).json()).decisions).toHaveLength(1);
  expect((await (await app.request('/v1/decisions?since=2026-10-16T10:00:00Z', { headers: auth })).json()).decisions).toHaveLength(0);
});

test('openapi.yaml documents every route the app registers', () => {
  const spec = parse(readFileSync('openapi.yaml', 'utf8')) as { paths: Record<string, Record<string, unknown>> };
  const documented = new Set(Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map(m => `${m.toUpperCase()} ${p}`)));
  const registered = app.routes.filter(r => r.method !== 'ALL')
    .map(r => `${r.method} ${r.path.replace(/:(\w+)/g, '{$1}')}`);
  expect(registered.length).toBeGreaterThan(10);
  for (const r of registered) expect(documented, r).toContain(r);
});

test('a failed transaction write gets an error line after the settled-review claim', async () => { // review #3/#11
  store.rows.push(row({ id: 'f1', notes: 'm #auto #review' }));
  store.update = async () => { throw new Error('batch already started'); };
  const err = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation(() => {});
  const r = await app.request('/v1/transactions/f1', json({ category: 'coffee', rule: false }));
  err.mockRestore();
  expect(r.status).toBe(500);
  expect(await log.lastFor('f1')).toMatchObject({ kind: 'error', reason: expect.stringContaining('write failed') });
});

test('reports pass the configured exclusions to the store as ids and name them in the reply', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const ex = createApp({ store, log, vocab, cfg: { token: 'secret', currency: 'ILS', reportExclude: ['Wants / Gifts', 'dining', 'Nope / Typo'] },
    classifierName: 'fake', runNow: async () => summary, versions: { curator: '0', actualApi: '0', server: '0' },
    status: () => ({}), now: () => new Date('2026-10-16T12:00:00Z') });
  const spend = await (await ex.request('/v1/report/spend?from=2026-10-01&to=2026-10-31', { headers: auth })).json();
  expect(spend.excluded).toEqual(['Wants / Gifts', 'Wants / Dining']);
  const income = await (await ex.request('/v1/report/income?from=2026-10-01&to=2026-10-31', { headers: auth })).json();
  expect(income.excluded).toEqual(['Wants / Gifts', 'Wants / Dining']);
  const cmp = await (await ex.request('/v1/report/compare', { headers: auth })).json();
  expect(cmp.excluded).toEqual(['Wants / Gifts', 'Wants / Dining']);
  expect(store.excludes).toEqual(Array(4).fill(['gifts', 'dining']));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Nope / Typo'));
  warn.mockRestore();
});

test('with no exclusions configured, reports carry no excluded field', async () => {
  const spend = await (await app.request('/v1/report/spend?from=2026-10-01&to=2026-10-31', { headers: auth })).json();
  expect(spend).not.toHaveProperty('excluded');
  expect(store.excludes).toEqual([[]]);
});

test('GET /rules marks a rule whose category is hidden', async () => {
  store.ruleList.push({ id: 'h', stage: null, conditionsOp: 'and', conditions: [{ field: 'imported_payee', op: 'is', value: 'X' }],
    actions: [{ field: 'category', op: 'set', value: 'old' }] });
  await app.request('/v1/rules', json({ payee: 'ארומה', category: 'coffee' }));
  const { rules } = await (await app.request('/v1/rules', { headers: auth })).json();
  expect(rules.find((r: { id: string }) => r.id === 'h')).toMatchObject({ categoryLabel: 'Needs / Old (hidden)', categoryHidden: true });
  expect(rules.find((r: { id: string }) => r.id !== 'h')).toMatchObject({ categoryHidden: false });
});

test('GET /review carries why the row is in review', async () => {
  store.rows.push(row({ id: 'h', notes: 'x #auto #review' }));
  await log.append({ at: '2026-10-02T00:00:00Z', txId: 'h', importedPayee: 'ארומה', memo: 'x', amount: -2550, kind: 'review',
    before: { category: 'old', notes: 'x' }, after: { category: null, notes: 'x #auto #review' }, dryRun: false,
    reason: 'category Needs / Old (hidden) is hidden' });
  const { rows } = await (await app.request('/v1/review', { headers: auth })).json();
  expect(rows[0]).toMatchObject({ id: 'h', reviewReason: 'category Needs / Old (hidden) is hidden' });
});
