import { expect, test } from 'vitest';
import type { CuratorRow } from '../../src/actual/types.ts';
import type { CategoryOption, Classification } from '../../src/classifier/types.ts';
import { decide } from '../../src/curator/decide.ts';
import { parseVocabulary } from '../../src/vocabulary.ts';

const vocab = parseVocabulary(`
tags:
  - { tag: kids, meaning: for a child }
  - { tag: recurring, meaning: repeats, threshold: 0.9 }
  - { tag: essential, meaning: needed }
  - { tag: discretionary, meaning: optional }
exclusive: [[essential, discretionary]]
reviewPayees: [PAYBOX]
`);
const thresholds = { category: 0.95, tagDefault: 0.7, exclusive: 0.7 };
const categories: CategoryOption[] = [
  { id: 'coffee', label: 'Needs / Coffee', isIncome: false },
  { id: 'salary', label: 'Income / Salary', isIncome: true },
];
const row = (over: Partial<CuratorRow> = {}): CuratorRow => ({ id: 't', date: '2026-10-10', account: 'a', accountName: 'Bank',
  amount: -2550, payee: 'ארומה', importedPayee: 'ארומה', notes: 'memo', category: null, transferId: null, ...over });
const cls = (category: Classification['category'], tags: Record<string, number> = {}): Classification =>
  ({ category, tags: { kids: 0, recurring: 0, essential: 0, discretionary: 0, ...tags }, raw: null });
const run = (r: CuratorRow, c: Classification | undefined) => decide({ row: r, classification: c, vocab, thresholds, categories });

test('rule-hit row: tags only, keeps its category', () => {
  expect(run(row({ category: 'coffee' }), cls(undefined, { kids: 0.8 })))
    .toEqual({ category: 'coffee', addTags: ['kids', 'auto'], review: false, kind: 'rule-hit' });
});

test('confident category + tags at or above their thresholds, adds #auto', () => {
  expect(run(row(), cls({ id: 'coffee', confidence: 0.97, probabilities: { coffee: 0.97 } }, { kids: 0.7, recurring: 0.85 })))
    .toEqual({ category: 'coffee', addTags: ['kids', 'auto'], review: false, kind: 'classified' });
});

test('unsure: no category, #auto #review, tags that pass', () => {
  expect(run(row(), cls({ id: 'coffee', confidence: 0.9, probabilities: { coffee: 0.9 } }, { recurring: 0.95 })))
    .toMatchObject({ category: null, addTags: ['recurring', 'auto', 'review'], review: true, kind: 'review' });
});

test('exclusive pair: only the higher one, and only if ≥ 0.70', () => {
  const c = (e: number, d: number) => run(row({ category: 'coffee' }), cls(undefined, { essential: e, discretionary: d })).addTags;
  expect(c(0.8, 0.75)).toEqual(['essential', 'auto']);
  expect(c(0.6, 0.65)).toEqual(['auto']);
  expect(c(0.72, 0.9)).toEqual(['discretionary', 'auto']);
});

test('refuses income category on outflow → review', () => { // Review Focus 2
  expect(run(row({ amount: -100 }), cls({ id: 'salary', confidence: 0.99, probabilities: { salary: 0.99 } })))
    .toMatchObject({ category: null, review: true, kind: 'review', reason: expect.stringMatching(/income/) });
  expect(run(row({ amount: 100 }), cls({ id: 'salary', confidence: 0.99, probabilities: { salary: 0.99 } })))
    .toMatchObject({ category: 'salary', kind: 'classified' });
});

test('hidden categories are not offered: a choice outside the offered list goes to review', () => { // Review Focus 2
  expect(run(row(), cls({ id: 'hidden-old', confidence: 0.99, probabilities: { 'hidden-old': 0.99 } })))
    .toMatchObject({ category: null, review: true, kind: 'review', reason: expect.stringMatching(/not offered/) });
});

test('no classification: skipped, nothing written', () => {
  expect(run(row(), undefined)).toMatchObject({ category: null, addTags: [], review: false, kind: 'skipped' });
});

test('a review payee always goes to review, even with a confident answer; a rule hit still applies', () => {
  const p = { payee: 'Paybox', importedPayee: ' paybox ' };
  expect(run(row(p), cls({ id: 'coffee', confidence: 0.99, probabilities: { coffee: 0.99 } }, { kids: 0.8 })))
    .toEqual({ category: null, addTags: ['kids', 'auto', 'review'], review: true, kind: 'review', reason: 'payee paybox is always reviewed' });
  expect(run(row({ ...p, category: 'coffee' }), cls(undefined)).kind).toBe('rule-hit');
});
