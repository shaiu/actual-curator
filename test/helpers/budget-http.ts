import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetWriteUnconfirmedError } from '../../src/actual/store.ts';
import type { CuratorRow } from '../../src/actual/types.ts';
import type { CategoryOption } from '../../src/classifier/types.ts';
import { BudgetFiles } from '../../src/budget/plan-store.ts';
import type { MonthSnapshot, MonthTotals, PlanInput } from '../../src/budget/types.ts';
import { type ApiStore, createApp } from '../../src/http/app.ts';
import { ReviewPayees } from '../../src/curator/review-payees.ts';
import { DecisionLog } from '../../src/log.ts';
import { parseVocabulary } from '../../src/vocabulary.ts';

export const vocab = parseVocabulary(`
tags:
  - { tag: kids, meaning: for a child }
genericPayees: [PAYBOX]
memoKeyPatterns: []
`);

export const cat = (id: string, label: string, budgeted: number, spent: number, extra: object = {}) =>
  ({ id, label, hidden: false, isIncome: false, budgeted, spent, balance: budgeted + spent, ...extra });
export const snapshot = (month: string): MonthSnapshot => ({
  month, toBudget: 500000,
  categories: [
    cat('rent', 'Needs / Rent', 0, 0),
    cat('groc', 'Needs / Groceries', 100000, -20000),
    cat('fun', 'Wants / Fun', 50000, 0),
    cat('prot', 'Needs / Insurance', 30000, 0),
    cat('biz', 'Biz / Inbal', 0, month === '2026-10' ? -50000 : 0),
    cat('old', 'Old', 0, 0, { hidden: true }),
    cat('sal', 'Income / Salary', 0, 0, { isIncome: true }),
    cat('misc', 'Wants / Misc', 0, 0),
  ],
});
export const plan: PlanInput = {
  version: 1,
  categories: [
    { categoryId: 'rent', kind: 'fixed', priority: 1, amount: 2800 },
    { categoryId: 'groc', kind: 'variable', priority: 2, amount: 1000 },
    { categoryId: 'fun', kind: 'variable', priority: 3, amount: 500 },
    { categoryId: 'prot', kind: 'variable', priority: 2, amount: 300, protected: true },
    { categoryId: 'biz', kind: 'excluded', priority: 9 },
  ],
  incomeSources: [{ name: 'Salary', payee: 'Employer', expectedAmount: 15000, expectedDay: 10 }],
};
export const row = (over: Partial<CuratorRow>): CuratorRow => ({ id: 't', date: '2026-11-10', account: 'a', accountName: 'Bank',
  amount: 1500000, payee: 'Employer', importedPayee: 'Employer', notes: '', category: null, transferId: null, ...over });

export class FakeStore implements ApiStore {
  snaps = new Map<string, MonthSnapshot>();
  rows: CuratorRow[] = [];
  writes: { month: string; amounts: Record<string, number> }[] = [];
  txQueries: { from: string; to: string; tag?: string; limit: number }[] = [];
  failSync = false;
  syncs = 0;
  onSync: (() => void) | undefined;
  months = ['2026-10', '2026-11', '2026-12'];
  totals = new Map<string, MonthTotals>();
  balances: Awaited<ReturnType<ApiStore['accountBalances']>> = [];
  firstMonth: string | null = '2026-01';
  async monthTotals(month: string): Promise<MonthTotals> {
    return structuredClone(this.totals.get(month) ?? { carryOverIn: 0, income: 0, lastMonthOverspent: 0, budgeted: 0,
      spent: 0, toBudget: (await this.budgetMonth(month)).toBudget });
  }
  async accountBalances() { return structuredClone(this.balances); }
  async firstTransactionMonth() { return this.firstMonth; }
  async sync() {
    this.syncs++;
    if (this.failSync) throw new Error('server unreachable');
    this.onSync?.();
  }
  async budgetMonths() { return [...this.months]; }
  accountCalls = 0;
  async accounts() { this.accountCalls++; return [{ id: 'a', name: 'Bank', offbudget: false }, { id: 'off', name: 'Savings', offbudget: true }, { id: 'hap', name: 'Hapoalim', offbudget: false }]; }
  cats: CategoryOption[] = [];
  async categories() { return [...this.cats]; }
  async transactions(q: { from: string; to: string; category?: string; tag?: string; limit: number }) {
    this.txQueries.push(q);
    return this.rows.filter(r => r.date >= q.from && r.date <= q.to && (!q.category || r.category === q.category)
      && (!q.tag || (r.notes ?? '').includes(`#${q.tag}`))).sort((a, b) => b.date.localeCompare(a.date)).slice(0, q.limit);
  }
  async transaction() { return undefined; }
  async update() {}
  async rules() { return []; }
  async payees() { return [] as { id: string; name: string }[]; }
  async replaceRule() { return 'r'; }
  async deleteRule() { return false; }
  async spend() { return []; }
  async income() { return []; }
  async budgetMonth(month: string) {
    if (this.failPrev && month === '2026-10') throw new Error(this.failPrev);
    if (!this.snaps.has(month)) this.snaps.set(month, snapshot(month));
    return structuredClone(this.snaps.get(month)!);
  }
  failWrite: boolean | 'unconfirmed' = false;
  failPrev: string | false = false;
  async setBudgeted(month: string, amounts: Record<string, number>) {
    await Promise.resolve();
    if (this.failWrite === 'unconfirmed') throw new BudgetWriteUnconfirmedError(month);
    if (this.failWrite) throw new Error('boom');
    const s = await this.budgetMonth(month);
    const unknown = Object.keys(amounts).filter(id => !s.categories.some(c => c.id === id));
    if (unknown.length) throw new Error(`unknown category id(s): ${unknown.join(', ')}`);
    this.writes.push({ month, amounts });
    let delta = 0;
    for (const [id, a] of Object.entries(amounts)) {
      const c = s.categories.find(x => x.id === id)!;
      delta += a - c.budgeted;
      c.balance += a - c.budgeted;
      c.budgeted = a;
    }
    s.toBudget -= delta;
    this.snaps.set(month, s);
    // Envelope carry-over: what a month gives away is also missing from every later month's To budget.
    for (const m of this.months.filter(x => x > month)) {
      const later = await this.budgetMonth(m);
      later.toBudget -= delta;
      this.snaps.set(m, later);
    }
  }
}


export const PLAN_SAVED = new Date('2026-11-01T00:00:00Z');

/** An app over a FakeStore and a scratch BudgetFiles dir. `setNow` moves the clock the app reads. */
export function makeBudgetApp(opts: { now?: Date } = {}) {
  let clock = opts.now ?? new Date('2026-11-20T09:00:00Z');
  const store = new FakeStore();
  const dir = mkdtempSync(join(tmpdir(), 'curator-budget-'));
  const files = new BudgetFiles(dir);
  const app = createApp({ store, log: new DecisionLog(dir), vocab, reviewPayees: new ReviewPayees(dir, vocab), cfg: { token: 'secret', currency: 'ILS' }, classifierName: 'fake',
    runNow: async () => { throw new Error('unused'); }, versions: { curator: '0.2.0', actualApi: '1', server: '1' },
    status: () => ({}), budget: files, now: () => clock });
  return { app, store, files, dir, setNow: (d: Date) => { clock = d; } };
}
