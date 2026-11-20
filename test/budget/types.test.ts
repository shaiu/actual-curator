import { expect, test } from 'vitest';
import { planSchema } from '../../src/budget/types.ts';

const base = { version: 1, incomeSources: [] };
const cat = (c: object) => ({ ...base, categories: [{ categoryId: 'x', priority: 1, ...c }] });

test('plan — fills default thresholds', () => {
  const p = planSchema.parse({ version: 1, categories: [], incomeSources: [] });
  expect(p.thresholds).toEqual({ watchPct: 15, watchMin: 150, offPct: 10, projectFromDay: 7 });
});

test('plan — setaside needs target and due', () => {
  expect(() => planSchema.parse(cat({ kind: 'setaside' }))).toThrow();
  expect(() => planSchema.parse(cat({ kind: 'setaside', target: 1000, due: '2027-03' }))).not.toThrow();
});

test('plan — fixed/variable need amount', () => {
  expect(() => planSchema.parse(cat({ kind: 'fixed' }))).toThrow();
  expect(() => planSchema.parse(cat({ kind: 'variable' }))).toThrow();
  expect(() => planSchema.parse(cat({ kind: 'variable', amount: 500 }))).not.toThrow();
});

test('plan — excluded rejects amount', () => {
  expect(() => planSchema.parse(cat({ kind: 'excluded', amount: 5 }))).toThrow();
  expect(() => planSchema.parse(cat({ kind: 'excluded' }))).not.toThrow();
});

test('plan — due must be YYYY-MM', () => {
  expect(() => planSchema.parse(cat({ kind: 'setaside', target: 1, due: '2027-3' }))).toThrow();
  expect(() => planSchema.parse(cat({ kind: 'setaside', target: 1, due: '2027-13' }))).toThrow();
});

test('plan — duplicate categoryId rejected', () => {
  const dup = { ...base, categories: [
    { categoryId: 'x', priority: 1, kind: 'fixed', amount: 1 },
    { categoryId: 'x', priority: 2, kind: 'fixed', amount: 2 },
  ] };
  expect(() => planSchema.parse(dup)).toThrow();
});
