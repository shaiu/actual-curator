import { expect, test } from 'vitest';
import { buildQuestions, formatAmount } from '../../src/classifier/questions.ts';

test('questions: one choice keyed by category id, one noul per tag, hints inlined', () => {
  const q = buildQuestions({ categories: [{ id: 'c1', label: 'Needs / Coffee', hint: 'cafés', isIncome: false }],
    tags: [{ tag: 'kids', meaning: 'for a child' }] });
  expect(q.category?.type).toBe('choice');
  expect(q.category?.criteria).toEqual({ c1: 'Needs / Coffee — cafés' });
  expect(q.tag_kids).toMatchObject({ type: 'noul', instructions: expect.stringContaining('for a child') });
  expect(q.tag_kids.criteria).toEqual({ true: expect.stringContaining('for a child'), false: expect.any(String) });
});

test('no category question when categories omitted', () =>
  expect(buildQuestions({ tags: [] })).not.toHaveProperty('category'));

test('no category question when the list is empty', () =>
  expect(buildQuestions({ categories: [], tags: [] })).not.toHaveProperty('category'));

test('income categories are marked in their criteria text', () =>
  expect(buildQuestions({ categories: [{ id: 'i', label: 'Income / Salary', isIncome: true }], tags: [] }).category?.criteria)
    .toEqual({ i: 'Income / Salary (income)' }));

test('amounts are formatted with sign and currency from minor units', () => {
  expect(formatAmount(-2550, 'ILS')).toBe('-25.50 ILS');
  expect(formatAmount(1200000, 'ILS')).toBe('+12000.00 ILS');
});
