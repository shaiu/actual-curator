import { daysInMonth } from './dates.ts';
import type { PaceLine } from './pace.ts';
import type { IncomeSource, Plan } from './types.ts';

export type BudgetEvent =
  | { id: string; kind: 'income'; source: string; amount: number; date: string; transactionId: string }
  | { id: string; kind: 'transfer_missing'; source: string; expectedDay: number }
  | { id: string; kind: 'pace'; categoryId: string; label: string; status: 'watch' | 'off' }
  | { id: string; kind: 'review'; count: number };

/** Amounts in minor units. */
export type IncomeRow = {
  id: string; date: string; amount: number; payee: string | null;
  importedPayee: string | null; transferId: string | null;
};

/** A deposit (not a transfer) whose imported payee, else payee, contains the source's payee text. */
export function matchIncome(source: IncomeSource, row: IncomeRow): boolean {
  if (row.amount <= 0 || row.transferId !== null) return false;
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

export function buildEvents(i: {
  plan: Plan; month: string; today: string; income: IncomeRow[];
  lines: PaceLine[]; reviewCount: number; acked: Record<string, string>;
}): BudgetEvent[] {
  const events: BudgetEvent[] = [];
  const { landed, expected } = incomeStatus(i.plan, i.month, i.income);
  for (const { source, row } of landed) {
    events.push({
      id: `income:${row.id}`, kind: 'income', source: source.name,
      amount: row.amount, date: row.date, transactionId: row.id,
    });
  }

  const todayMonth = i.today.slice(0, 7);
  const todayDay = Number(i.today.slice(8, 10));
  const monthOver = todayMonth > i.month;
  for (const s of expected) {
    if (!s.fixedTransfer) continue;
    const late = monthOver || (todayMonth === i.month && todayDay > Math.min(s.expectedDay + 3, daysInMonth(i.month)));
    if (late) events.push({ id: `transfer:${i.month}`, kind: 'transfer_missing', source: s.name, expectedDay: s.expectedDay });
  }

  for (const l of i.lines) {
    if (l.status === 'ok') continue;
    events.push({
      id: `pace:${i.month}:${l.categoryId}:${l.status}`, kind: 'pace',
      categoryId: l.categoryId, label: l.label, status: l.status,
    });
  }
  if (i.reviewCount > 0) events.push({ id: `review:${i.today}`, kind: 'review', count: i.reviewCount });
  return events.filter((e) => !Object.hasOwn(i.acked, e.id));
}
