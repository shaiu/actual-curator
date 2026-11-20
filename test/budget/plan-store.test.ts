import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { BudgetFiles } from '../../src/budget/plan-store.ts';
import { planSchema } from '../../src/budget/types.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'budget-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const plan = planSchema.parse({
  version: 1,
  categories: [{ categoryId: 'rent', kind: 'fixed', priority: 1, amount: 4000 }],
  incomeSources: [{ name: 'Salary', payee: 'Acme', expectedAmount: 20000, expectedDay: 10 }],
});

test('plan() on an empty dir is null', () => expect(new BudgetFiles(dir).plan()).toBeNull());

test('savePlan then plan() round-trips', () => {
  const f = new BudgetFiles(dir);
  f.savePlan(plan, { by: 'test', why: 'init' }, new Date('2026-11-20T10:00:00Z'));
  expect(f.plan()).toEqual(plan);
});

test('plan-history.jsonl has one {at,by,why,plan} line per save', () => {
  const f = new BudgetFiles(dir);
  f.savePlan(plan, { by: 'a', why: 'one' }, new Date('2026-11-20T10:00:00Z'));
  f.savePlan(plan, { by: 'b', why: 'two' }, new Date('2026-11-21T10:00:00Z'));
  const lines = readFileSync(join(dir, 'budget', 'plan-history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines).toEqual([
    { at: '2026-11-20T10:00:00.000Z', by: 'a', why: 'one', plan },
    { at: '2026-11-21T10:00:00.000Z', by: 'b', why: 'two', plan },
  ]);
});

test('journal appends to writes.jsonl', () => {
  const f = new BudgetFiles(dir);
  f.journal({ kind: 'apply', n: 1 }, new Date('2026-11-20T10:00:00Z'));
  f.journal({ kind: 'move', n: 2 }, new Date('2026-11-20T11:00:00Z'));
  const lines = readFileSync(join(dir, 'budget', 'writes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines).toEqual([
    { at: '2026-11-20T10:00:00.000Z', kind: 'apply', n: 1 },
    { at: '2026-11-20T11:00:00.000Z', kind: 'move', n: 2 },
  ]);
});

test('state() defaults empty; ack records the iso time and keeps earlier acks', () => {
  const f = new BudgetFiles(dir);
  expect(f.state()).toEqual({ acked: {} });
  f.ack(['a'], new Date('2026-11-20T10:00:00Z'));
  f.ack(['b'], new Date('2026-11-21T10:00:00Z'));
  expect(f.state().acked).toEqual({ a: '2026-11-20T10:00:00.000Z', b: '2026-11-21T10:00:00.000Z' });
});

test('no *.tmp file is left behind', () => {
  const f = new BudgetFiles(dir);
  f.savePlan(plan, { by: 'a', why: 'x' }, new Date());
  f.ack(['a'], new Date());
  expect(readdirSync(join(dir, 'budget')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
});

test('firstSavedAt: null before any save, then the first history line', () => {
  const f = new BudgetFiles(dir);
  expect(f.firstSavedAt()).toBeNull();
  f.savePlan(plan, { by: 'a', why: 'one' }, new Date('2026-11-20T10:00:00Z'));
  f.savePlan(plan, { by: 'a', why: 'two' }, new Date('2026-11-25T10:00:00Z'));
  expect(f.firstSavedAt()?.toISOString()).toBe('2026-11-20T10:00:00.000Z');
});

test('firstSavedAt skips a corrupt first line', () => {
  const f = new BudgetFiles(dir);
  f.savePlan(plan, { by: 'a', why: 'one' }, new Date('2026-11-20T10:00:00Z'));
  const file = join(dir, 'budget', 'plan-history.jsonl');
  writeFileSync(file, `{not json\n{"at":"nope"}\n${readFileSync(file, 'utf8')}`);
  expect(f.firstSavedAt()?.toISOString()).toBe('2026-11-20T10:00:00.000Z');
  writeFileSync(file, 'garbage\n');
  expect(f.firstSavedAt()).toBeNull();
});
