import type { CuratorRow } from '../actual/types.ts';

export type Transfer = { date: string; from: string; to: string; amount: number /* minor, positive */ };

/**
 * One entry per transfer, newest first. A transfer is two rows that point at each other, and each row's payee is the
 * other account, so one side is enough. Nothing else of the row (payee text, notes, category) is carried over.
 */
export function listTransfers(rows: CuratorRow[]): Transfer[] {
  const byPair = new Map<string, Transfer>();
  for (const r of rows) {
    if (r.transferId === null) continue;
    const other = r.payee ?? '';
    const [from, to] = r.amount < 0 ? [r.accountName, other] : [other, r.accountName];
    byPair.set([r.id, r.transferId].sort().join('|'), { date: r.date, from, to, amount: Math.abs(r.amount) });
  }
  return [...byPair.values()].sort((a, b) => b.date.localeCompare(a.date));
}
