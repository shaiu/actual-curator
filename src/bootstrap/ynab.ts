// Proposes payee → category rules from a YNAB export: payees with enough rows that almost always
// went to one category. Generic payees are skipped; their meaning is in the memo.
//
// Some YNAB payees are not what the bank sends: a standing order arrives as a generic payee
// ("הוראת-קבע") with the recipient in the memo, and YNAB was set to show the recipient. A rule on
// that name would never match in Actual, so such proposals carry `memoKey`, and the caller looks up
// the generic payee Actual imported them under (bankPayeeFor) to build a payee + memo rule instead.

import { memoKeyPhrase } from '../curator/rules.ts';

type Named = { id: string; name: string; deleted?: boolean; hidden?: boolean; internal?: boolean };

export type YnabExport = { data: { budget: {
  accounts: (Named | { id: string; name: string; on_budget: boolean; deleted?: boolean })[];
  payees: Named[];
  category_groups: Named[];
  categories: (Named & { category_group_id: string })[];
  transactions: { id: string; date: string; payee_id: string | null; category_id: string | null; account_id: string;
    transfer_account_id: string | null; deleted: boolean; memo?: string | null }[];
} } };

export type ProposedRule = { importedPayee: string; categoryLabel: string; rows: number; agreement: number;
  /** Set when YNAB named the payee after the memo's key phrase; the bank's payee is a generic one. */
  memoKey?: string };

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export function proposeRules(exp: YnabExport, opts: { since: string; minRows: number; minAgreement: number;
  genericPayees: string[]; memoKeyPatterns?: string[] }): ProposedRule[] {
  const b = exp.data.budget;
  const onBudget = new Set(b.accounts.filter(a => 'on_budget' in a && a.on_budget && !a.deleted).map(a => a.id));
  const payees = new Map(b.payees.map(p => [p.id, p.name]));
  const groups = new Map(b.category_groups.map(g => [g.id, g]));
  const generic = new Set(opts.genericPayees.map(g => g.trim().toLowerCase()));
  const usable = new Map(b.categories
    .filter(c => {
      const g = groups.get(c.category_group_id);
      return !c.deleted && !c.hidden && !c.internal && g && !g.deleted && !g.hidden && !g.internal;
    })
    .map(c => [c.id, `${groups.get(c.category_group_id)!.name} / ${c.name}`]));

  const byPayee = new Map<string, Map<string, number>>();
  const namedFromMemo = new Map<string, number>();
  for (const t of b.transactions) {
    if (t.deleted || t.transfer_account_id || !t.category_id || !t.payee_id || t.date < opts.since) continue;
    if (!onBudget.has(t.account_id)) continue;
    const payee = payees.get(t.payee_id)?.trim();
    if (!payee || generic.has(payee.toLowerCase())) continue;
    const counts = byPayee.get(payee) ?? new Map<string, number>();
    counts.set(t.category_id, (counts.get(t.category_id) ?? 0) + 1);
    byPayee.set(payee, counts);
    const key = t.memo ? memoKeyPhrase(t.memo, opts.memoKeyPatterns ?? []) : undefined;
    if (key && norm(key) === norm(payee)) namedFromMemo.set(payee, (namedFromMemo.get(payee) ?? 0) + 1);
  }

  const out: ProposedRule[] = [];
  for (const [importedPayee, counts] of byPayee) {
    const rows = [...counts.values()].reduce((a, b) => a + b, 0);
    const [top, hits] = [...counts].sort((a, b) => b[1] - a[1])[0];
    const agreement = Math.round((hits / rows) * 1000) / 1000;
    const label = usable.get(top);
    if (rows >= opts.minRows && agreement >= opts.minAgreement && label) {
      const fromMemo = (namedFromMemo.get(importedPayee) ?? 0) * 2 > rows;
      out.push({ importedPayee, categoryLabel: label, rows, agreement, ...(fromMemo ? { memoKey: importedPayee } : {}) });
    }
  }
  return out.sort((a, b) => b.rows - a.rows || a.importedPayee.localeCompare(b.importedPayee));
}

/**
 * The generic payee Actual imported a memo-named payee's rows under: the most common generic
 * imported payee among rows whose memo contains the name. Undefined when Actual has no such row yet.
 */
export function bankPayeeFor(memoKey: string, rows: { importedPayee: string | null; memo: string }[],
  genericPayees: string[]): string | undefined {
  const generic = new Set(genericPayees.map(norm));
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.importedPayee || !generic.has(norm(r.importedPayee)) || !norm(r.memo).includes(norm(memoKey))) continue;
    counts.set(r.importedPayee, (counts.get(r.importedPayee) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}
