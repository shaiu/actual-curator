// Proposes payee → category rules from a YNAB export: payees with enough rows that almost always
// went to one category. Generic payees are skipped; their meaning is in the memo.

type Named = { id: string; name: string; deleted?: boolean; hidden?: boolean; internal?: boolean };

export type YnabExport = { data: { budget: {
  accounts: (Named | { id: string; name: string; on_budget: boolean; deleted?: boolean })[];
  payees: Named[];
  category_groups: Named[];
  categories: (Named & { category_group_id: string })[];
  transactions: { id: string; date: string; payee_id: string | null; category_id: string | null; account_id: string;
    transfer_account_id: string | null; deleted: boolean }[];
} } };

export type ProposedRule = { importedPayee: string; categoryLabel: string; rows: number; agreement: number };

export function proposeRules(exp: YnabExport, opts: { since: string; minRows: number; minAgreement: number;
  genericPayees: string[] }): ProposedRule[] {
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
  for (const t of b.transactions) {
    if (t.deleted || t.transfer_account_id || !t.category_id || !t.payee_id || t.date < opts.since) continue;
    if (!onBudget.has(t.account_id)) continue;
    const payee = payees.get(t.payee_id)?.trim();
    if (!payee || generic.has(payee.toLowerCase())) continue;
    const counts = byPayee.get(payee) ?? new Map<string, number>();
    counts.set(t.category_id, (counts.get(t.category_id) ?? 0) + 1);
    byPayee.set(payee, counts);
  }

  const out: ProposedRule[] = [];
  for (const [importedPayee, counts] of byPayee) {
    const rows = [...counts.values()].reduce((a, b) => a + b, 0);
    const [top, hits] = [...counts].sort((a, b) => b[1] - a[1])[0];
    const agreement = Math.round((hits / rows) * 1000) / 1000;
    const label = usable.get(top);
    if (rows >= opts.minRows && agreement >= opts.minAgreement && label) {
      out.push({ importedPayee, categoryLabel: label, rows, agreement });
    }
  }
  return out.sort((a, b) => b.rows - a.rows || a.importedPayee.localeCompare(b.importedPayee));
}
