import { expect, test } from 'vitest';
import { currentMonth, daysInMonth, jerusalemToday, monthsBetween } from '../../src/budget/dates.ts';

test('currentMonth rolls over at midnight Jerusalem while UTC is still November', () => // Review Focus 2
  expect(currentMonth(new Date('2026-11-30T22:30:00Z'))).toBe('2026-12'));

test('jerusalemToday just before local midnight', () =>
  expect(jerusalemToday(new Date('2026-11-20T21:59:00Z'))).toBe('2026-11-20'));

test('jerusalemToday just after local midnight', () =>
  expect(jerusalemToday(new Date('2026-11-20T22:00:00Z'))).toBe('2026-11-21'));

test('daysInMonth', () => {
  expect(daysInMonth('2027-02')).toBe(28);
  expect(daysInMonth('2028-02')).toBe(29);
  expect(daysInMonth('2026-12')).toBe(31);
});

test('monthsBetween is inclusive', () => {
  expect(monthsBetween('2026-12', '2027-03')).toBe(4);
  expect(monthsBetween('2026-12', '2026-12')).toBe(1);
});
