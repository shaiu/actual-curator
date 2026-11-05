import * as api from '@actual-app/api';
import type { CategoryOption } from '../classifier/types.ts';
import { parseTags } from '../notes.ts';
import type { BudgetMonth, CuratorRow, CuratorRule, NewCuratorRule, ReportRow, RuleAction, RuleCondition } from './types.ts';

type Raw = Record<string, unknown>;

const ROW_FIELDS = ['id', 'date', 'account', 'account.name', 'amount', 'payee', 'payee.name', 'imported_payee', 'notes',
  'category', 'transfer_id'];

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function toRow(r: Raw): CuratorRow {
  return {
    id: r.id as string,
    date: r.date as string,
    account: r.account as string,
    accountName: (r['account.name'] as string) ?? '',
    amount: r.amount as number,
    payee: (r['payee.name'] as string | null) ?? null,
    payeeId: (r.payee as string | null) ?? null,
    importedPayee: (r.imported_payee as string | null) ?? null,
    notes: (r.notes as string | null) ?? undefined,
    category: (r.category as string | null) ?? null,
    transferId: (r.transfer_id as string | null) ?? null,
  };
}

const ruleKey = (conds: RuleCondition[]) =>
  JSON.stringify([...conds].map(c => [c.field, c.op, c.value]).sort());

function conditionsFor(r: NewCuratorRule): RuleCondition[] {
  const c: RuleCondition[] = [{ field: 'imported_payee', op: 'is', value: r.importedPayee }];
  if (r.notesContains) c.push({ field: 'notes', op: 'contains', value: r.notesContains });
  return c;
}

/** The row no longer matches what the caller read: a human (or another writer) changed it. */
export class StaleRowError extends Error {
  constructor(id: string) {
    super(`transaction ${id} changed since it was read`);
    this.name = 'StaleRowError';
  }
}

/** A budget write failed; the message says whether the previous amounts were put back. */
export class BudgetWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetWriteError';
  }
}

/**
 * The only module that talks to `@actual-app/api`. The API is a process-wide
 * singleton holding one open budget, so there is one store per process.
 */
export class ActualStore {
  private readonly remote: boolean;
  /** Mutations run one at a time: the api is one process-wide budget and rejects overlapping batches. */
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(remote: boolean) { this.remote = remote; }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  static async open(cfg: { serverUrl?: string; password?: string; syncId?: string; dataDir: string }): Promise<ActualStore> {
    await api.init(cfg.serverUrl
      ? { dataDir: cfg.dataDir, serverURL: cfg.serverUrl, password: cfg.password ?? '' }
      : { dataDir: cfg.dataDir });
    if (cfg.syncId) {
      await api.downloadBudget(cfg.syncId);
    } else {
      // Local budget only (tests, offline runs): open the single budget in dataDir.
      const local = (await api.getBudgets()).find(b => (b as Raw).id);
      if (!local) throw new Error(`No budget found in ${cfg.dataDir}`);
      await api.loadBudget((local as Raw).id as string);
    }
    return new ActualStore(Boolean(cfg.serverUrl && cfg.syncId));
  }

  async sync(): Promise<void> { if (this.remote) await this.locked(() => api.sync()); }

  async close(): Promise<void> { await api.shutdown(); }

  async serverVersion(): Promise<string> {
    const v = await api.getServerVersion().catch(() => undefined) as Raw | undefined;
    return typeof v?.version === 'string' ? v.version : 'unknown';
  }

  private async query(query: ReturnType<typeof api.q>): Promise<Raw[]> {
    return ((await api.runQuery(query)) as { data: Raw[] }).data;
  }

  async categories(opts: { includeHidden?: boolean } = {}): Promise<CategoryOption[]> {
    const groups = await api.getCategoryGroups();
    const out: CategoryOption[] = [];
    for (const g of groups as (Raw & { categories?: Raw[] })[]) {
      if (g.hidden && !opts.includeHidden) continue;
      for (const c of g.categories ?? []) {
        if (c.hidden && !opts.includeHidden) continue;
        out.push({ id: c.id as string, label: `${g.name} / ${c.name}`, isIncome: Boolean(g.is_income) });
      }
    }
    return out;
  }

  async accounts(): Promise<{ id: string; name: string; offbudget: boolean }[]> {
    return (await api.getAccounts()).map(a => ({ id: a.id, name: a.name, offbudget: Boolean(a.offbudget) }));
  }

  /** Rows the curator may touch, minus the `#auto` check (the caller does that). */
  async candidates(opts: { lookbackDays: number; today?: Date }): Promise<CuratorRow[]> {
    const from = isoDay(new Date((opts.today ?? new Date()).getTime() - opts.lookbackDays * 864e5));
    const rows = await this.query(api.q('transactions')
      .filter({ date: { $gte: from }, 'account.offbudget': false, transfer_id: null, is_parent: false, is_child: false })
      .options({ splits: 'all' })
      .select(ROW_FIELDS)
      .orderBy({ date: 'asc' }));
    return rows.map(toRow);
  }

  async transactions(q: { from: string; to: string; category?: string; tag?: string; account?: string;
    text?: string; limit: number }): Promise<CuratorRow[]> {
    const filter: Raw = { ...dateRange(q.from, q.to), is_parent: false };
    if (q.category) filter.category = q.category;
    if (q.account) filter.account = q.account;
    if (q.tag) filter.notes = { $like: `%#${q.tag}%` };
    if (q.text) {
      const like = { $like: `%${q.text}%` };
      filter.$or = [{ notes: like }, { imported_payee: like }, { 'payee.name': like }];
    }
    let rows = (await this.query(api.q('transactions').filter(filter).options({ splits: 'all' })
      .select(ROW_FIELDS).orderBy({ date: 'desc' }))).map(toRow);
    if (q.tag) rows = rows.filter(r => parseTags(r.notes, new Set([q.tag!])).tags.includes(q.tag!));
    return rows.slice(0, q.limit);
  }

  async transaction(id: string): Promise<CuratorRow | undefined> {
    const [r] = await this.query(api.q('transactions').filter({ id }).options({ splits: 'all' }).select(ROW_FIELDS));
    return r ? toRow(r) : undefined;
  }

  async priorCategories(importedPayee: string, limit: number): Promise<string[]> {
    const rows = await this.query(api.q('transactions')
      .filter({ imported_payee: importedPayee, category: { $ne: null }, is_parent: false })
      .options({ splits: 'all' }).select(['category', 'date']).orderBy({ date: 'desc' }));
    return [...new Set(rows.map(r => r.category as string))].slice(0, limit);
  }

  /**
   * Writes the fields only if the row still matches `expected` (what the caller decided from), so a
   * human edit made after the read is never overwritten; throws StaleRowError otherwise.
   * `api.updateTransaction` resolves before its write is applied (26.10.0's handler does not await
   * `transactions-batch-update`), so the write runs inside a batch and is read back until it shows.
   */
  async update(id: string, fields: { category?: string | null; notes?: string },
               expected?: { category: string | null; notes: string }): Promise<void> {
    await this.locked(async () => {
      const read = async () => (await this.query(api.q('transactions').filter({ id }).options({ splits: 'all' })
        .select(['category', 'notes'])))[0];
      if (expected) {
        const now = await read();
        if (!now || (now.category ?? null) !== expected.category || ((now.notes as string | null) ?? '') !== expected.notes) {
          throw new StaleRowError(id);
        }
      }
      await api.batchBudgetUpdates(async () => { await api.updateTransaction(id, fields as never); });
      const applied = async () => {
        const r = await read();
        return Boolean(r) && (fields.category === undefined || (r.category ?? null) === fields.category)
          && (fields.notes === undefined || (r.notes ?? '') === fields.notes);
      };
      for (let waited = 0; !(await applied()); waited += 25) {
        if (waited >= 2000) throw new Error(`Actual did not apply the update to transaction ${id}`);
        await new Promise(r => setTimeout(r, 25));
      }
    });
  }

  async rules(): Promise<CuratorRule[]> {
    return (await api.getRules()).map(r => {
      const raw = r as unknown as Raw;
      return {
        id: raw.id as string,
        stage: (raw.stage as string | null) ?? null,
        conditionsOp: raw.conditionsOp as 'and' | 'or',
        conditions: (raw.conditions as Raw[]).map(c => ({ field: c.field as string, op: c.op as string, value: c.value })),
        actions: (raw.actions as Raw[]).map(a => ({ ...(a.field ? { field: a.field as string } : {}), op: a.op as string,
          value: a.value }) as RuleAction),
      };
    });
  }

  async createRule(r: NewCuratorRule): Promise<string> {
    return this.locked(() => this.insertRule(r));
  }

  private async insertRule(r: NewCuratorRule): Promise<string> {
    const created = await api.createRule({ stage: null, conditionsOp: 'and', conditions: conditionsFor(r),
      actions: [{ op: 'set', field: 'category', value: r.categoryId }] } as never);
    return (created as unknown as Raw).id as string;
  }

  /** Finds the rule with exactly these conditions; updates its category, or creates it. */
  async replaceRule(r: NewCuratorRule): Promise<string> {
    return this.locked(() => this.upsertRule(r));
  }

  private async upsertRule(r: NewCuratorRule): Promise<string> {
    const key = ruleKey(conditionsFor(r));
    const existing = (await this.rules()).find(x => x.conditionsOp === 'and' && ruleKey(x.conditions) === key);
    if (!existing) return this.insertRule(r);
    await api.updateRule({ id: existing.id, stage: existing.stage, conditionsOp: 'and', conditions: existing.conditions,
      actions: [{ op: 'set', field: 'category', value: r.categoryId }] } as never);
    return existing.id;
  }

  /** Points every category action of rule `id` at `categoryId`, leaving its conditions as they are. */
  async retargetRule(id: string, categoryId: string): Promise<void> {
    return this.locked(async () => {
      const r = (await this.rules()).find(x => x.id === id);
      if (!r) return;
      await api.updateRule({ id: r.id, stage: r.stage, conditionsOp: r.conditionsOp, conditions: r.conditions,
        actions: r.actions.map(a => (a.field === 'category' && a.op === 'set' ? { ...a, value: categoryId } : a)) } as never);
    });
  }

  async deleteRule(id: string): Promise<boolean> {
    return this.locked(() => api.deleteRule(id));
  }

  /** Every month Actual holds a budget for, oldest first (measured on 26.10.0: six back to eleven ahead). */
  async budgetMonths(): Promise<string[]> {
    return api.getBudgetMonths();
  }

  /**
   * One month of the budget, hidden groups and categories included and flagged: the caller decides
   * what to show. Throws for a month Actual holds no budget for. Envelope budgeting only: a tracking
   * budget has no `toBudget`, and that is an error rather than a zero.
   */
  async budgetMonth(month: string): Promise<BudgetMonth> {
    const m = await api.getBudgetMonth(month);
    if (typeof m.toBudget !== 'number') throw new Error(`month ${month} has no toBudget: the budget is not envelope budgeting`);
    return {
      month: m.month,
      toBudget: m.toBudget,
      // Actual reports total-budgeted as a negative sheet value; the sum of what was budgeted is its negation.
      totalBudgeted: -m.totalBudgeted,
      totalSpent: m.totalSpent,
      totalBalance: m.totalBalance,
      totalIncome: m.totalIncome,
      forNextMonth: m.forNextMonth,
      groups: m.categoryGroups.map(g => ({
        id: g.id as string,
        name: g.name as string,
        isIncome: Boolean(g.is_income),
        hidden: Boolean(g.hidden),
        // A category's own is_income is false for one created in the income group, so the group decides.
        categories: (g.categories ?? []).map(c => ({
          id: c.id as string,
          name: c.name as string,
          label: `${g.name} / ${c.name}`,
          isIncome: Boolean(g.is_income),
          hidden: Boolean(g.hidden) || Boolean(c.hidden),
          budgeted: (c.budgeted as number | undefined) ?? 0,
          // Income categories carry `received` (positive) instead of `spent`.
          spent: ((g.is_income ? c.received : c.spent) as number | undefined) ?? 0,
          balance: (c.balance as number | undefined) ?? 0,
          carryover: Boolean(c.carryover),
        })),
      })),
    };
  }

  /**
   * Sets each item's budgeted amount for `month` in one batch, then reads the month back until every
   * item shows its amount. Actual's `setBudgetAmount` answers success for a month with no budget and
   * for an unknown category id (both measured on 26.10.0), so the caller validates first and this
   * read-back is what proves the write. On any failure every item is put back to `restore` before
   * the error is thrown; the error says whether that restore itself held.
   */
  async setBudgets(month: string, items: { category: string; amount: number }[],
                   restore: { category: string; amount: number }[]): Promise<void> {
    await this.locked(async () => {
      const write = async (xs: { category: string; amount: number }[]) => {
        await api.batchBudgetUpdates(async () => {
          for (const x of xs) await api.setBudgetAmount(month, x.category, x.amount);
        });
        await this.waitFor(month, xs);
      };
      try {
        await write(items);
      } catch (e) {
        let restored = 'restored the previous amounts';
        try { await write(restore); } catch (r) { restored = `COULD NOT restore the previous amounts (${(r as Error).message})`; }
        throw new BudgetWriteError(`budget write for ${month} failed (${(e as Error).message}); ${restored}`);
      }
    });
  }

  async setCarryover(month: string, category: string, flag: boolean): Promise<void> {
    await this.locked(async () => {
      await api.setBudgetCarryover(month, category, flag);
      for (let waited = 0; ; waited += 25) {
        const c = (await this.budgetMonth(month)).groups.flatMap(g => g.categories).find(x => x.id === category);
        if (c?.carryover === flag) return;
        if (waited >= 2000) throw new Error(`Actual did not apply the carryover change to ${category} in ${month}`);
        await new Promise(r => setTimeout(r, 25));
      }
    });
  }

  /**
   * Holds `amount` of this month's to-budget for next month, replacing any earlier hold; 0 releases
   * the hold. `holdBudgetForNextMonth` answers true even for an amount far above to-budget (measured),
   * so the caller bounds it and the month is read back until `forNextMonth` shows it.
   */
  async holdForNextMonth(month: string, amount: number): Promise<void> {
    await this.locked(async () => {
      await api.resetBudgetHold(month);
      if (amount > 0 && !(await api.holdBudgetForNextMonth(month, amount))) {
        throw new Error(`Actual refused to hold ${amount} in ${month}`);
      }
      for (let waited = 0; ; waited += 25) {
        if ((await this.budgetMonth(month)).forNextMonth === amount) return;
        if (waited >= 2000) throw new Error(`Actual did not apply the hold for ${month}`);
        await new Promise(r => setTimeout(r, 25));
      }
    });
  }

  private async waitFor(month: string, xs: { category: string; amount: number }[]): Promise<void> {
    for (let waited = 0; ; waited += 25) {
      const cats = new Map((await this.budgetMonth(month)).groups.flatMap(g => g.categories).map(c => [c.id, c]));
      const off = xs.filter(x => cats.get(x.category)?.budgeted !== x.amount);
      if (!off.length) return;
      if (waited >= 2000) throw new Error(`Actual did not apply the amount for ${off.map(x => x.category).join(', ')}`);
      await new Promise(r => setTimeout(r, 25));
    }
  }

  /** `exclude` holds category ids left out of every report (one-off money such as a house purchase). */
  private async reportRows(from: string, to: string, exclude: readonly string[] = []): Promise<Raw[]> {
    const rows = await this.query(api.q('transactions')
      .filter({ ...dateRange(from, to), 'account.offbudget': false, transfer_id: null, is_parent: false })
      .options({ splits: 'all' })
      .select(['amount', 'notes', 'category', 'category.name', 'category.group.id', 'category.group.name',
        'category.group.is_income']));
    return exclude.length ? rows.filter(r => !exclude.includes(r.category as string)) : rows;
  }

  /** Net spend (refunds reduce it), excluding transfers, off-budget accounts and income categories. */
  async spend(q: { from: string; to: string; by: 'category' | 'group' | 'tag'; exclude?: readonly string[] }): Promise<ReportRow[]> {
    const rows = (await this.reportRows(q.from, q.to, q.exclude)).filter(r => !r['category.group.is_income']);
    const totals = new Map<string | null, ReportRow>();
    const add = (key: string | null, label: string, amount: number) => {
      const t = totals.get(key) ?? { key, label, amount: 0 };
      t.amount += amount;
      totals.set(key, t);
    };
    for (const r of rows) {
      const amount = r.amount as number;
      if (q.by === 'tag') {
        for (const tag of tagsOf(r.notes as string | null)) add(tag, `#${tag}`, amount);
      } else if (!r.category) {
        add(null, 'Uncategorized', amount);
      } else if (q.by === 'group') {
        add(r['category.group.id'] as string, r['category.group.name'] as string, amount);
      } else {
        add(r.category as string, `${r['category.group.name']} / ${r['category.name']}`, amount);
      }
    }
    return [...totals.values()].sort((a, b) => a.amount - b.amount);
  }

  async income(q: { from: string; to: string; exclude?: readonly string[] }): Promise<ReportRow[]> {
    const totals = new Map<string, ReportRow>();
    for (const r of await this.reportRows(q.from, q.to, q.exclude)) {
      if (!r['category.group.is_income']) continue;
      const key = r.category as string;
      const t = totals.get(key) ?? { key, label: `${r['category.group.name']} / ${r['category.name']}`, amount: 0 };
      t.amount += r.amount as number;
      totals.set(key, t);
    }
    return [...totals.values()].sort((a, b) => b.amount - a.amount);
  }
}

/**
 * Inclusive date range. Actual's AQL keeps only one operator of `{ date: { $gte, $lte } }` and
 * silently drops `$lte`, so each bound is its own condition.
 */
function dateRange(from: string, to: string): Raw {
  return { $and: [{ date: { $gte: from } }, { date: { $lte: to } }] };
}

/** Every trailing `#word` token: reports slice by any tag the user wrote, not only the vocabulary. */
function tagsOf(notes: string | null): string[] {
  return parseTags(notes ?? '', { has: () => true } as unknown as Set<string>).tags
    .filter(t => t !== 'auto' && t !== 'review');
}
