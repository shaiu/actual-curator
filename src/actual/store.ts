import * as api from '@actual-app/api';
import type { CategoryOption } from '../classifier/types.ts';
import { parseTags } from '../notes.ts';
import type { CuratorRow, CuratorRule, NewCuratorRule, ReportRow, RuleAction, RuleCondition } from './types.ts';

type Raw = Record<string, unknown>;

const ROW_FIELDS = ['id', 'date', 'account', 'account.name', 'amount', 'payee.name', 'imported_payee', 'notes',
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

  async deleteRule(id: string): Promise<boolean> {
    return this.locked(() => api.deleteRule(id));
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
