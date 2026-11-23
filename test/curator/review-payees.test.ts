import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { CuratorRow } from '../../src/actual/types.ts';
import { ReviewPayees } from '../../src/curator/review-payees.ts';
import { ruleForRow } from '../../src/curator/rules.ts';
import { parseVocabulary } from '../../src/vocabulary.ts';

const mk = () => parseVocabulary(`
tags:
  - { tag: kids, meaning: for a child }
genericPayees: [BIT]
reviewPayees: ['היי ביז בע"מ']
memoKeyPatterns: ['לטובת:\\s*(.+?)(?:\\.|$)']
`);
const row = (over: Partial<CuratorRow> = {}): CuratorRow => ({ id: 't', date: '2026-10-10', account: 'a', accountName: 'Bank',
  amount: -100, payee: 'x', importedPayee: 'x', notes: '', category: null, transferId: null, ...over });
const at = new Date('2026-11-23T10:00:00Z');

test('construction: vocab.reviewPayees stays the config list; list marks it source config', () => {
  const vocab = mk();
  const rp = new ReviewPayees(mkdtempSync(join(tmpdir(), 'rp-')), vocab);
  expect(vocab.reviewPayees).toEqual(['היי ביז בע"מ']);
  expect(rp.list()).toEqual([{ payee: 'היי ביז בע"מ', source: 'config' }]);
});

test('add: extends vocab.reviewPayees in place, trims, dedupes case-insensitively against config and api', () => {
  const vocab = mk();
  const same = vocab;
  const rp = new ReviewPayees(mkdtempSync(join(tmpdir(), 'rp-')), vocab);
  expect(rp.add('  Amazon ', 'shai', at)).toBe(true);
  expect(same.reviewPayees).toEqual(['היי ביז בע"מ', 'Amazon']);
  expect(rp.add('amazon', 'inbal', at)).toBe(false);
  expect(rp.add('היי ביז בע"מ ', 'shai', at)).toBe(false);
  expect(vocab.reviewPayees).toHaveLength(2);
  expect(rp.list()).toEqual([{ payee: 'היי ביז בע"מ', source: 'config' },
    { payee: 'Amazon', source: 'api', by: 'shai', at: at.toISOString() }]);
});

test('persists across instances, atomically (no tmp file left)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-'));
  new ReviewPayees(dir, mk()).add('Amazon', 'shai', at);
  const vocab = mk();
  const again = new ReviewPayees(dir, vocab);
  expect(vocab.reviewPayees).toEqual(['היי ביז בע"מ', 'Amazon']);
  expect(again.list().at(-1)).toEqual({ payee: 'Amazon', source: 'api', by: 'shai', at: at.toISOString() });
  expect(readdirSync(dir)).toEqual(['review-payees.json']);
  expect(JSON.parse(readFileSync(join(dir, 'review-payees.json'), 'utf8'))).toBeTruthy();
});

test('remove: removed / absent / config, and vocab follows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-'));
  const vocab = mk();
  const rp = new ReviewPayees(dir, vocab);
  rp.add('Amazon', 'shai', at);
  expect(rp.remove(' AMAZON ')).toBe('removed');
  expect(vocab.reviewPayees).toEqual(['היי ביז בע"מ']);
  expect(rp.remove('amazon')).toBe('absent');
  expect(rp.remove('היי ביז בע"מ')).toBe('config');
  expect(vocab.reviewPayees).toEqual(['היי ביז בע"מ']);
  expect(new ReviewPayees(dir, mk()).list()).toHaveLength(1);
});

test('a corrupt or missing file is an empty api list, not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-'));
  expect(existsSync(join(dir, 'review-payees.json'))).toBe(false);
  expect(new ReviewPayees(dir, mk()).list()).toHaveLength(1);
});

test('ruleForRow: no rule for an always-review non-generic payee (case/space-insensitive); generic BIT still gets a memo rule', () => {
  const vocab = mk();
  new ReviewPayees(mkdtempSync(join(tmpdir(), 'rp-')), vocab).add('Amazon', 'shai', at);
  expect(ruleForRow(row({ importedPayee: 'היי ביז בע"מ ' }), 'c', vocab)).toBeUndefined();
  expect(ruleForRow(row({ importedPayee: ' amazon' }), 'c', vocab)).toBeUndefined();
  expect(ruleForRow(row({ importedPayee: 'ארומה' }), 'c', vocab)).toEqual({ importedPayee: 'ארומה', categoryId: 'c' });
  vocab.reviewPayees.push('BIT');
  expect(ruleForRow(row({ importedPayee: 'BIT', notes: 'לטובת: דנה.' }), 'c', vocab))
    .toEqual({ importedPayee: 'BIT', notesContains: 'דנה', categoryId: 'c' });
});

test('a failed save leaves memory, vocab and the file unchanged (add and remove)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-'));
  const vocab = mk();
  const rp = new ReviewPayees(dir, vocab);
  rp.add('Amazon', 'shai', at);
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'x');
  const broken = new ReviewPayees(join(blocker, 'sub'), mk()); // mkdir under a file fails
  expect(() => broken.add('Ebay', 'shai', at)).toThrow();
  expect(broken.list().map(p => p.payee)).toEqual(['היי ביז בע"מ']);
  const v2 = mk();
  const rp2 = new ReviewPayees(dir, v2);
  rmSync(join(dir, 'review-payees.json'));
  mkdirSync(join(dir, 'review-payees.json')); // rename onto a directory fails
  expect(() => rp2.remove('Amazon')).toThrow();
  expect(v2.reviewPayees).toEqual(['היי ביז בע"מ', 'Amazon']);
  expect(rp2.list().map(p => p.payee)).toContain('Amazon');
});
