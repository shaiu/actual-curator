import { expect, test } from 'vitest';
import { dataMonth, lineChanges, lineIds, summarize, uncategorized } from '../../src/budget/ledger.ts';
import type { JournalEntry } from '../../src/budget/plan-store.ts';
import { planSchema } from '../../src/budget/types.ts';
import { cat, plan, row, snapshot } from '../helpers/budget-http.ts';

const parsed = planSchema.parse(plan);
const lines = new Map([['groc', 'Needs / Groceries'], ['fun', 'Wants / Fun']]);

test('lineIds: every plan category that is not excluded', () => {
  expect([...lineIds(parsed)].sort()).toEqual(['fun', 'groc', 'prot', 'rent']);
});

test('dataMonth: from the first transaction month to the current month, both included', () => {
  const at = (m: string) => dataMonth(m, '2026-09', '2026-11');
  expect(['2026-08', '2026-09', '2026-11', '2026-12'].map(at)).toEqual([false, true, true, false]);
  expect(dataMonth('2026-11', null, '2026-11')).toBe(false);
});

test('summarize: a hidden line counts outside the lines, and lines plus outside stays the total', () => {
  const snap = snapshot('2026-11');
  snap.categories = [cat('groc', 'G', 100000, -20000), cat('fun', 'F', 50000, -100, { hidden: true })];
  const s = summarize(parsed, snap, { carryOverIn: 0, income: 0, lastMonthOverspent: 0, budgeted: 150000, spent: 20100, toBudget: -150000 });
  expect(s.budgeted).toEqual({ lines: 100000, outside: 50000, total: 150000 });
  expect(s.spent).toEqual({ lines: 20000, outside: 100, total: 20100 });
});

test('uncategorized: positive both ways; transfers, off-budget and categorized rows are left out', () => {
  expect(uncategorized([
    row({ id: '1', amount: -700 }), row({ id: '2', amount: 300 }), row({ id: '3', amount: -9, transferId: 'x' }),
    row({ id: '4', amount: -9, account: 'off' }), row({ id: '5', amount: -9, category: 'groc' }),
  ], new Set(['off']))).toEqual({ in: 300, out: 700 });
});

test('lineChanges: a move between lines, one leaving the lines, one with no line side, and `only`', () => {
  const base = { at: '2026-11-02T00:00:00Z', month: '2026-11', approvedBy: 'shai' };
  const entries: JournalEntry[] = [
    { ...base, op: 'move', from: 'groc', to: 'fun', amount: 100 },
    { ...base, op: 'move', from: 'misc', to: 'fun', amount: 200, outcome: 'unconfirmed' },
    { ...base, op: 'move', from: 'misc', to: 'biz', amount: 300 },
    { ...base, op: 'apply', added: { biz: 400, groc: 500 } },
    { ...base, op: 'apply', month: '2026-10', added: { groc: 1 } },
  ];
  const head = { at: base.at, by: 'shai', unconfirmed: false };
  expect(lineChanges(entries, lines, '2026-11')).toEqual([
    { ...head, op: 'move', lines: [{ label: 'Needs / Groceries', change: -100 }, { label: 'Wants / Fun', change: 100 }], counterpart: null },
    { ...head, op: 'move', unconfirmed: true, lines: [{ label: 'Wants / Fun', change: 200 }], counterpart: "outside the plan's lines" },
    { ...head, op: 'apply', lines: [{ label: 'Needs / Groceries', change: 500 }], counterpart: "outside the plan's lines" },
  ]);
  expect(lineChanges(entries, lines, '2026-11', 'groc').map(e => e.lines))
    .toEqual([[{ label: 'Needs / Groceries', change: -100 }], [{ label: 'Needs / Groceries', change: 500 }]]);
});
