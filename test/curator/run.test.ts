import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { CuratorRow, CuratorRule, NewCuratorRule } from '../../src/actual/types.ts';
import { type CategoryOption, type Classification, type Classifier, ClassifierError } from '../../src/classifier/types.ts';
import { type CuratorStore, curate } from '../../src/curator/run.ts';
import { StaleRowError } from '../../src/actual/store.ts';
import { DecisionLog } from '../../src/log.ts';
import { parseVocabulary } from '../../src/vocabulary.ts';

const vocab = parseVocabulary(`
tags:
  - { tag: kids, meaning: for a child }
genericPayees: [PAYBOX]
memoKeyPatterns: ['לטובת:\\s*(.+?)(?:\\.|$)']
`);
const cfg = { thresholds: { category: 0.95, tagDefault: 0.7, exclusive: 0.7 }, promoteAfter: 3, lookbackDays: 60,
  dryRun: false, currency: 'ILS' };
const categories: CategoryOption[] = [{ id: 'coffee', label: 'Needs / Coffee', isIncome: false },
  { id: 'gifts', label: 'Wants / Gifts', isIncome: false }, { id: 'salary', label: 'Income / Salary', isIncome: true }];
const hiddenCat: CategoryOption = { id: 'old', label: 'Needs / Old (hidden)', isIncome: false };
const now = () => new Date('2026-10-16T10:00:00Z');

let n = 0;
const row = (over: Partial<CuratorRow> = {}): CuratorRow => ({ id: `t${++n}`, date: '2026-10-10', account: 'a',
  accountName: 'Bank', amount: -2550, payee: 'ארומה', importedPayee: 'ארומה', notes: 'memo', category: null,
  transferId: null, ...over });

class FakeStore implements CuratorStore {
  events: string[] = [];
  updates: { id: string; fields: { category?: string | null; notes?: string } }[] = [];
  created: (NewCuratorRule & { id: string })[] = [];
  deleted: string[] = [];
  retargeted: { id: string; categoryId: string }[] = [];
  syncFails = false;
  syncs = 0;
  rows: CuratorRow[];
  ruleList: CuratorRule[];
  constructor(rows: CuratorRow[], ruleList: CuratorRule[] = []) { this.rows = rows; this.ruleList = ruleList; }
  async sync() { this.syncs++; this.events.push('sync'); if (this.syncFails) throw new Error('server down'); }
  async candidates() { return this.rows; }
  async categories(o?: { includeHidden?: boolean }) { return o?.includeHidden ? [...categories, hiddenCat] : categories; }
  async rules() { return this.ruleList; }
  async priorCategories() { return ['coffee']; }
  async update(id: string, fields: { category?: string | null; notes?: string },
               _expected?: { category: string | null; notes: string }) {
    this.events.push(`update:${id}`); this.updates.push({ id, fields });
  }
  async createRule(r: NewCuratorRule) {
    const id = `rule${this.created.length + 1}`; this.created.push({ ...r, id }); return id;
  }
  async replaceRule(r: NewCuratorRule) { return this.createRule(r); }
  async deleteRule(id: string) { this.deleted.push(id); return true; }
  async retargetRule(id: string, categoryId: string) { this.retargeted.push({ id, categoryId }); }
}

const offeredIds: string[][] = [];
const classifier = (f: (payee: string, withCategory: boolean) => Classification | Error): Classifier & { calls: { payee: string; withCategory: boolean }[] } => {
  const calls: { payee: string; withCategory: boolean }[] = [];
  return { name: 'fake', calls, async classify(state, opts) {
    calls.push({ payee: state.payee, withCategory: Boolean(opts.categories) });
    if (opts.categories) offeredIds.push(opts.categories.map(c => c.id));
    const r = f(state.payee, Boolean(opts.categories));
    if (r instanceof Error) throw r;
    return r;
  } };
};
const confident = (id = 'coffee', kids = 0): Classification => ({ category: { id, confidence: 0.97, probabilities: { [id]: 0.97 } }, tags: { kids }, raw: null });
const tagsOnly = (kids = 0): Classification => ({ tags: { kids }, raw: null });

const setup = (rows: CuratorRow[], rules: CuratorRule[] = []) => {
  const store = new FakeStore(rows, rules);
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), 'curate-')));
  return { store, log };
};

test('sync failure: nothing written, one error decision', async () => { // Review Focus 4
  const { store, log } = setup([row()]);
  store.syncFails = true;
  const s = await curate({ store, log, vocab, cfg, now, classifier: classifier(() => confident()) });
  expect(s.synced).toBe(false);
  expect(s.ok).toBe(false);
  expect(store.updates).toEqual([]);
  const ds = await log.since('2000');
  expect(ds).toHaveLength(1);
  expect(ds[0]).toMatchObject({ kind: 'error', reason: expect.stringContaining('server down') });
});

test('confident row: log line first, then the write with category, tags and #auto', async () => {
  const r = row({ notes: 'cappuccino' });
  const { store, log } = setup([r]);
  const origAppend = log.append.bind(log);
  log.append = async d => { store.events.push(`log:${d.txId}:${d.kind}`); return origAppend(d); };
  const s = await curate({ store, log, vocab, cfg, now, classifier: classifier(() => confident('coffee', 0.9)) });
  expect(store.events).toEqual(['sync', `log:${r.id}:classified`, `update:${r.id}`, 'sync']);
  expect(store.updates[0].fields).toEqual({ category: 'coffee', notes: 'cappuccino #kids #auto' });
  expect(s).toMatchObject({ synced: true, ok: true, seen: 1, classified: 1, review: 0, errors: 0 });
  const [d] = await log.since('2000');
  expect(d).toMatchObject({ before: { category: null, notes: 'cappuccino' }, after: { category: 'coffee', notes: 'cappuccino #kids #auto' },
    categoryConfidence: 0.97, dryRun: false, importedPayee: 'ארומה', memo: 'cappuccino' });
  expect(d.classification).not.toHaveProperty('raw');
});

test('classifier fails on one row: that row is skipped (no #auto), the next is processed', async () => { // Review Focus 3
  const bad = row({ payee: 'BAD', importedPayee: 'BAD' });
  const good = row();
  const { store, log } = setup([bad, good]);
  const s = await curate({ store, log, vocab, cfg, now,
    classifier: classifier(p => p === 'BAD' ? new ClassifierError('HTTP 429', true) : confident()) });
  expect(store.updates.map(u => u.id)).toEqual([good.id]);
  expect((await log.lastFor(bad.id))).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('429') });
  expect(s).toMatchObject({ errors: 1, classified: 1, ok: true });
});

test('every classification failing makes the run not ok', async () => {
  const { store, log } = setup([row(), row()]);
  const s = await curate({ store, log, vocab, cfg, now, classifier: classifier(() => new ClassifierError('down', true)) });
  expect(s).toMatchObject({ synced: true, ok: false, errors: 2 });
});

test('dry run: decisions logged with dryRun, nothing written, nothing promoted', async () => {
  const { store, log } = setup([row(), row(), row()]);
  const s = await curate({ store, log, vocab, cfg: { ...cfg, dryRun: true }, now, classifier: classifier(() => confident()) });
  expect(store.updates).toEqual([]);
  expect(store.created).toEqual([]);
  expect((await log.since('2000')).every(d => d.dryRun)).toBe(true);
  expect(s.classified).toBe(3);
});

test('rows already carrying #auto are not classified again', async () => {
  const { store, log } = setup([row({ notes: 'x #auto', category: 'coffee' })]);
  const c = classifier(() => confident());
  const s = await curate({ store, log, vocab, cfg, now, classifier: c });
  expect(c.calls).toEqual([]);
  expect(s.seen).toBe(0);
});

test('unsure row goes to review with #auto #review and no category', async () => {
  const { store, log } = setup([row({ notes: '' })]);
  const s = await curate({ store, log, vocab, cfg, now,
    classifier: classifier(() => ({ category: { id: 'coffee', confidence: 0.6, probabilities: { coffee: 0.6 } }, tags: { kids: 0 }, raw: null })) });
  expect(store.updates[0].fields).toEqual({ notes: '#auto #review' });
  expect(s.review).toBe(1);
});

test('settle: an answered #review row on a generic payee strips #review and makes a human rule on the memo phrase', async () => {
  const r = row({ payee: 'PAYBOX', importedPayee: 'PAYBOX', notes: 'לטובת: דנה. #auto #review', category: 'gifts' });
  const { store, log } = setup([r]);
  const s = await curate({ store, log, vocab, cfg, now, classifier: classifier(() => confident()) });
  expect(store.created).toEqual([{ id: 'rule1', importedPayee: 'PAYBOX', notesContains: 'דנה', categoryId: 'gifts' }]);
  expect(await log.rules.originOf('rule1')).toBe('human');
  expect(store.updates).toEqual([{ id: r.id, fields: { notes: 'לטובת: דנה. #auto' } }]);
  expect(await log.lastFor(r.id)).toMatchObject({ kind: 'settled-review' });
  expect(s.settled).toBe(1);
});

test('settle: a generic payee with an empty memo gets no rule', async () => {
  const { store, log } = setup([row({ payee: 'PAYBOX', importedPayee: 'PAYBOX', notes: '#auto #review', category: 'gifts' })]);
  await curate({ store, log, vocab, cfg, now, classifier: classifier(() => confident()) });
  expect(store.created).toEqual([]);
});

test('promotion after the third confident hit creates one promoted rule', async () => {
  const { store, log } = setup([row(), row(), row(), row()]);
  const c = classifier((_p, withCategory) => withCategory ? confident() : tagsOnly());
  const s = await curate({ store, log, vocab, cfg, now, classifier: c });
  expect(store.created).toEqual([{ id: 'rule1', importedPayee: 'ארומה', categoryId: 'coffee' }]);
  expect(await log.rules.originOf('rule1')).toBe('promoted');
  expect(s.promoted).toBe(1);
  // the fourth row is filed by the new rule: tags only
  expect(c.calls.map(x => x.withCategory)).toEqual([true, true, true, false]);
  expect(s).toMatchObject({ classified: 3, ruleHits: 1 });
});

test('generic payees are never promoted', async () => {
  const p = { payee: 'PAYBOX', importedPayee: 'PAYBOX', notes: 'לטובת: דנה.' };
  const { store, log } = setup([row(p), row(p), row(p)]);
  await curate({ store, log, vocab, cfg, now, classifier: classifier(() => confident('gifts')) });
  expect(store.created).toEqual([]);
});

test('backlog: an uncategorized row matching a rule gets its category; classifier asked tags only', async () => {
  const rule: CuratorRule = { id: 'r1', stage: null, conditionsOp: 'and',
    conditions: [{ field: 'imported_payee', op: 'is', value: 'ארומה' }], actions: [{ field: 'category', op: 'set', value: 'coffee' }] };
  const r = row({ notes: 'm' });
  const { store, log } = setup([r], [rule]);
  const c = classifier(() => tagsOnly(0.9));
  const s = await curate({ store, log, vocab, cfg, now, classifier: c });
  expect(c.calls).toEqual([{ payee: 'ארומה', withCategory: false }]);
  expect(store.updates[0].fields).toEqual({ category: 'coffee', notes: 'm #kids #auto' });
  expect(s.ruleHits).toBe(1);
});

test('UI correction deletes a promoted rule for that payee but not a human one', async () => {
  const promoted: CuratorRule = { id: 'p1', stage: null, conditionsOp: 'and',
    conditions: [{ field: 'imported_payee', op: 'is', value: 'ארומה' }], actions: [{ field: 'category', op: 'set', value: 'coffee' }] };
  const human: CuratorRule = { ...promoted, id: 'h1',
    conditions: [...promoted.conditions, { field: 'notes', op: 'contains', value: 'x' }] };
  const r = row({ notes: 'm #auto', category: 'gifts' });
  const { store, log } = setup([r], [promoted, human]);
  await log.rules.record('p1', 'promoted', { importedPayee: 'ארומה' });
  await log.rules.record('h1', 'human', { importedPayee: 'ארומה', notesContains: 'x' });
  await log.append({ at: '2026-10-15T00:00:00Z', txId: r.id, importedPayee: 'ארומה', memo: 'm', amount: -2550,
    kind: 'classified', before: { category: null, notes: 'm' }, after: { category: 'coffee', notes: 'm #auto' }, dryRun: false });
  const s = await curate({ store, log, vocab, cfg, now, classifier: classifier(() => confident()) });
  expect(store.deleted).toEqual(['p1']);
  expect(await log.rules.originOf('p1')).toBeUndefined();
  expect(await log.lastFor(r.id)).toMatchObject({ kind: 'ui-correction', after: { category: 'gifts' } });
  expect(s.corrections).toBe(1);
  // a second run does not flag it again
  const s2 = await curate({ store, log, vocab, cfg, now, classifier: classifier(() => confident()) });
  expect(s2.corrections).toBe(0);
});

test('no writes, no second sync', async () => {
  const { store, log } = setup([row({ notes: 'x #auto', category: 'coffee' })]);
  await curate({ store, log, vocab, cfg, now, classifier: classifier(() => confident()) });
  expect(store.syncs).toBe(1);
});

test('outflows are offered expense categories only; inflows get everything', async () => { // Review Focus 2
  offeredIds.length = 0;
  const { store, log } = setup([row({ amount: -100 }), row({ amount: 100 })]);
  await curate({ store, log, vocab, cfg, now, classifier: classifier(() => confident()) });
  expect(offeredIds).toEqual([['coffee', 'gifts'], ['coffee', 'gifts', 'salary']]);
});

test('dry run: a second run over unchanged rows asks the classifier nothing', async () => { // review #1
  const answered = row({ payee: 'PAYBOX', importedPayee: 'PAYBOX', notes: 'לטובת: דנה. #auto #review', category: 'gifts' });
  const { store, log } = setup([row(), row(), answered]);
  const c = classifier(() => confident());
  const dry = { ...cfg, dryRun: true };
  await curate({ store, log, vocab, cfg: dry, now, classifier: c });
  expect(c.calls).toHaveLength(2);
  const s2 = await curate({ store, log, vocab, cfg: dry, now, classifier: c });
  expect(c.calls).toHaveLength(2);
  expect(s2).toMatchObject({ seen: 0, settled: 0 });
  // a row that changed since its dry-run decision is decided again
  store.rows[0] = { ...store.rows[0], notes: 'edited' };
  await curate({ store, log, vocab, cfg: dry, now, classifier: c });
  expect(c.calls).toHaveLength(3);
  // and turning dry run off classifies for real
  await curate({ store, log, vocab, cfg, now, classifier: c });
  expect(c.calls).toHaveLength(5);
});

test('a row changed in Actual since the snapshot is skipped, not overwritten', async () => { // review #2
  const r = row();
  const { store, log } = setup([r]);
  store.update = async () => { throw new StaleRowError(r.id); };
  const s = await curate({ store, log, vocab, cfg, now, classifier: classifier(() => confident()) });
  expect(await log.lastFor(r.id)).toMatchObject({ kind: 'skipped', reason: expect.stringMatching(/changed/) });
  expect(s.errors).toBe(0);
});

test('the snapshot values are passed to update as the expected state', async () => { // review #2
  const r = row({ notes: 'm' });
  const { store, log } = setup([r]);
  const seen: unknown[] = [];
  store.update = async (_id, _f, expected) => { seen.push(expected); };
  await curate({ store, log, vocab, cfg, now, classifier: classifier(() => confident()) });
  expect(seen).toEqual([{ category: null, notes: 'm' }]);
});

test('a rule created while settling is used for the same payee in the same run', async () => { // review #4
  const answered = row({ payee: 'X', importedPayee: 'X', notes: '#auto #review', category: 'gifts' });
  const later = row({ payee: 'X', importedPayee: 'X', notes: 'second' });
  const { store, log } = setup([answered, later]);
  const c = classifier((_p, withCategory) => withCategory ? confident('coffee') : tagsOnly());
  await curate({ store, log, vocab, cfg, now, classifier: c });
  expect(c.calls).toEqual([{ payee: 'X', withCategory: false }]);
  expect(store.updates.find(u => u.id === later.id)?.fields).toMatchObject({ category: 'gifts' });
});

// 2026-10-23: Actual's own payee rules, carried over from YNAB, filed new rows into categories
// hidden since. Nobody saw the spending, and Actuali's overspent badge skips hidden categories.
test('a row Actual filed into a hidden category goes to review, uncategorized, with candidates', async () => {
  const { store, log } = setup([row({ id: 'h1', category: 'old', notes: 'm' })]);
  const c = classifier(() => ({ category: { id: 'coffee', confidence: 0.99, probabilities: { coffee: 0.99 } }, tags: { kids: 0 }, raw: null }));
  const s = await curate({ store, log, vocab, cfg, now, classifier: c });
  expect(c.calls).toEqual([{ payee: 'ארומה', withCategory: true }]);
  expect(store.updates[0].fields).toEqual({ category: null, notes: 'm #auto #review' });
  expect(s.review).toBe(1); expect(s.ruleHits).toBe(0);
  expect(await log.lastFor('h1')).toMatchObject({ kind: 'review', reason: 'category Needs / Old (hidden) is hidden' });
});

test('a curator rule pointing at a hidden category does not file the row there', async () => {
  const rule: CuratorRule = { id: 'r1', stage: null, conditionsOp: 'and',
    conditions: [{ field: 'imported_payee', op: 'is', value: 'ארומה' }], actions: [{ field: 'category', op: 'set', value: 'old' }] };
  const { store, log } = setup([row({ notes: 'm' })], [rule]);
  await curate({ store, log, vocab, cfg, now, classifier: classifier(() => tagsOnly()) });
  expect(store.updates[0].fields).toEqual({ notes: 'm #auto #review' }); // the row was uncategorized; it stays so
});

test('answering a row a stale rule sent to review points that rule at the answer', async () => {
  const stale: CuratorRule = { id: 's1', stage: null, conditionsOp: 'and', conditions: [{ field: 'payee', op: 'is', value: 'p-aroma' }],
    actions: [{ field: 'category', op: 'set', value: 'old' }] };
  const other: CuratorRule = { ...stale, id: 's2', conditions: [{ field: 'payee', op: 'is', value: 'p-else' }] };
  const { store, log } = setup([row({ id: 'a1', payeeId: 'p-aroma', category: 'coffee', notes: 'm #auto #review' })], [stale, other]);
  await curate({ store, log, vocab, cfg, now, classifier: classifier(() => tagsOnly()) });
  expect(store.retargeted).toEqual([{ id: 's1', categoryId: 'coffee' }]);
  expect((await log.lastFor('a1'))?.reason).toContain('rule s1 moved from hidden Needs / Old (hidden)');
});
