import { expect, test } from 'vitest';
import { pageFor } from '../../src/http/route.ts';

test('/budget and everything under it go to the budget page app; /money to its own; the rest to the API', () => {
  expect(pageFor('/budget')).toBe('budget');
  expect(pageFor('/budget/category')).toBe('budget');
  expect(pageFor('/money')).toBe('money');
  expect(pageFor('/budgetx')).toBe('api');
  expect(pageFor('/v1/budget/status')).toBe('api');
});
