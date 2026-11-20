import { createHash } from 'node:crypto';
import { addMonths, daysInMonth, previousMonth } from './dates.ts';
import type { PaceLine } from './pace.ts';
import type { IncomeSource, Plan } from './types.ts';

export type BudgetEvent =
  | { id: string; kind: 'income'; source: string; amount: number; date: string; transactionId: string }
  | { id: string; kind: 'transfer_missing'; source: string; expectedDay: number }
  | { id: string; kind: 'pace'; categoryId: string; label: string; status: 'watch' | 'off' }
  | { id: string; kind: 'review'; count: number };

/** Amounts in minor units. */
export type IncomeRow = {
  id: string; date: string; amount: number; account: string; payee: string | null;
  importedPayee: string | null; transferId: string | null;
};

/** A deposit (not a transfer) whose imported payee, else payee, contains the source's payee text, in the source's account when it names one. */
export function matchIncome(source: IncomeSource, row: IncomeRow): boolean {
  if (row.amount <= 0 || row.transferId !== null) return false;
  if (source.account !== undefined && row.account !== source.account) return false;
  return (row.importedPayee ?? row.payee ?? '').includes(source.payee);
}

/** For one month: the rows that landed (with the source they matched), and the sources with no row yet. */
export function incomeStatus(plan: Plan, month: string, rows: IncomeRow[]):
  { landed: { source: IncomeSource; row: IncomeRow }[]; expected: IncomeSource[] } {
  const inMonth = rows.filter((r) => r.date.startsWith(month));
  const landed: { source: IncomeSource; row: IncomeRow }[] = [];
  for (const row of inMonth) {
    const source = plan.incomeSources.find((s) => matchIncome(s, row));
    if (source) landed.push({ source, row });
  }
  const got = new Set(landed.map((l) => l.source.name));
  return { landed, expected: plan.incomeSources.filter((s) => !got.has(s.name)) };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Date by which a fixed transfer must have landed: expectedDay + 3, counted across the month boundary. */
function transferDue(month: string, expectedDay: number): string {
  const D = daysInMonth(month);
  const day = expectedDay + 3;
  if (day <= D) return `${month}-${pad(day)}`;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  return `${next}-${pad(day - D)}`;
}

/** Last day a late row can still settle `month`'s transfer: its due date, but at least the 3rd of the next month. */
function graceEnd(month: string, expectedDay: number): string {
  const next = addMonths(month, 1);
  const due = transferDue(month, expectedDay);
  return due > `${next}-03` ? due : `${next}-03`;
}

/**
 * Whether source `s`'s transfer for `month` has landed. One row settles one month: a row in the first days of the next
 * month settles this month only if this month has no row of its own, and then it does not also settle the next month.
 */
function transferLanded(s: IncomeSource, month: string, rows: IncomeRow[]): boolean {
  const mine = rows.filter((r) => matchIncome(s, r));
  const dated = (m: string) => mine.filter((r) => r.date.startsWith(m));
  const prev = previousMonth(month);
  const claimedByPrev = (r: IncomeRow) => dated(prev).length === 0 && r.date <= graceEnd(prev, s.expectedDay);
  const own = dated(month).filter((r) => !claimedByPrev(r));
  if (own.length > 0) return true;
  const end = graceEnd(month, s.expectedDay);
  return mine.some((r) => r.date.startsWith(addMonths(month, 1)) && r.date <= end);
}

/** `income` is every candidate row (any dates): income events come from all of it, so a deposit near a month boundary is never lost. */
export function buildEvents(i: {
  plan: Plan; month: string; today: string; income: IncomeRow[];
  lines: PaceLine[]; reviewIds: string[]; acked: Record<string, string>;
  /** Jerusalem YYYY-MM-DD the plan was first saved: no transfer due before it is reported missing. */
  planSince?: string;
}): BudgetEvent[] {
  const events: BudgetEvent[] = [];
  for (const row of i.income) {
    const source = i.plan.incomeSources.find((s) => matchIncome(s, row));
    if (!source) continue;
    events.push({
      id: `income:${row.id}`, kind: 'income', source: source.name,
      amount: row.amount, date: row.date, transactionId: row.id,
    });
  }

  // One verdict per (source, month): due date passed, not before the plan existed, and nothing landed by then.
  const missing = (s: IncomeSource, month: string): boolean => {
    const due = transferDue(month, s.expectedDay);
    if (i.today <= due || (i.planSince !== undefined && due < i.planSince)) return false;
    return !transferLanded(s, month, i.income);
  };
  const todayMonth = i.today.slice(0, 7);
  for (const s of i.plan.incomeSources) {
    if (s.fixedTransfer && missing(s, i.month)) {
      events.push({ id: `transfer:${i.month}`, kind: 'transfer_missing', source: s.name, expectedDay: s.expectedDay });
    }
  }
  // Only a due date that spills past month end is invisible to the month's own check; the next month looks back.
  if (todayMonth === i.month) {
    const prev = previousMonth(i.month);
    for (const s of i.plan.incomeSources) {
      if (!s.fixedTransfer || s.expectedDay + 3 <= daysInMonth(prev)) continue;
      if (missing(s, prev)) events.push({ id: `transfer:${prev}`, kind: 'transfer_missing', source: s.name, expectedDay: s.expectedDay });
    }
  }

  for (const l of i.lines) {
    if (l.status === 'ok') continue;
    events.push({
      id: `pace:${i.month}:${l.categoryId}:${l.status}`, kind: 'pace',
      categoryId: l.categoryId, label: l.label, status: l.status,
    });
  }
  if (i.reviewIds.length > 0) {
    const hash = createHash('sha256').update([...i.reviewIds].sort().join(',')).digest('hex').slice(0, 12);
    events.push({ id: `review:${hash}`, kind: 'review', count: i.reviewIds.length });
  }
  return events.filter((e) => !Object.hasOwn(i.acked, e.id));
}
