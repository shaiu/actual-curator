import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { type Decision, DecisionLog } from '../src/log.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'curator-log-'));
const d = (over: Partial<Decision>): Decision => ({
  at: '2026-10-16T10:00:00.000Z', txId: 't1', importedPayee: 'ארומה', memo: '', amount: -2550, kind: 'classified',
  before: { category: null, notes: '' }, after: { category: 'c1', notes: '#auto' }, categoryConfidence: 0.97,
  dryRun: false, ...over });

test('two coffees on the same day count as two confident hits', async () => { // Review Focus 5
  const log = new DecisionLog(dir());
  await log.append(d({ txId: 't1' }));
  await log.append(d({ txId: 't2' }));
  await log.append(d({ txId: 't2' })); // the same transaction twice is still one hit
  await log.append(d({ txId: 't3', after: { category: 'c2', notes: '#auto' } }));
  await log.append(d({ txId: 't4', kind: 'review', after: { category: null, notes: '#auto #review' } }));
  expect(await log.confidentHits('ארומה', 'c1')).toBe(2);
});

test('dry-run decisions and hits before a UI correction do not count', async () => {
  const log = new DecisionLog(dir());
  await log.append(d({ txId: 't1' }));
  await log.append(d({ txId: 't2', dryRun: true }));
  await log.append(d({ txId: 't9', kind: 'ui-correction', at: '2026-10-16T11:00:00.000Z' }));
  await log.append(d({ txId: 't3', at: '2026-10-16T12:00:00.000Z' }));
  expect(await log.confidentHits('ארומה', 'c1')).toBe(1);
});

test('since crosses a month boundary; one file per month', async () => {
  const p = dir();
  const log = new DecisionLog(p);
  await log.append(d({ txId: 'sep', at: '2026-09-30T23:00:00.000Z' }));
  await log.append(d({ txId: 'oct', at: '2026-10-01T01:00:00.000Z' }));
  expect((await log.since('2026-09-30T00:00:00.000Z')).map(x => x.txId)).toEqual(['sep', 'oct']);
  expect((await log.since('2026-10-01T00:00:00.000Z')).map(x => x.txId)).toEqual(['oct']);
  expect(readdirSync(join(p, 'decisions')).sort()).toEqual(['2026-09.jsonl', '2026-10.jsonl']);
  // a fresh instance reads what the first wrote
  expect((await new DecisionLog(p).since('2026-01-01')).length).toBe(2);
});

test('lastFor returns the newest decision for a transaction', async () => {
  const log = new DecisionLog(dir());
  await log.append(d({ txId: 't1', after: { category: 'c1', notes: '#auto' } }));
  await log.append(d({ txId: 't1', kind: 'ui-correction', after: { category: 'c2', notes: '#auto' } }));
  expect((await log.lastFor('t1'))?.after?.category).toBe('c2');
  expect(await log.lastFor('nope')).toBeUndefined();
});

test('rules index: record, originOf, forget, persisted', async () => {
  const p = dir();
  const log = new DecisionLog(p);
  await log.rules.record('r1', 'promoted', { importedPayee: 'ארומה' });
  expect(await log.rules.originOf('r1')).toBe('promoted');
  expect(await new DecisionLog(p).rules.originOf('r1')).toBe('promoted');
  await log.rules.forget('r1');
  expect(await log.rules.originOf('r1')).toBeUndefined();
  expect(await new DecisionLog(p).rules.originOf('r1')).toBeUndefined();
});
