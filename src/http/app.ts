import { Hono } from 'hono';
import { z } from 'zod';
import { type ActualStore, StaleRowError } from '../actual/store.ts';
import type { CuratorRow, CuratorRule, ReportRow, RuleOrigin } from '../actual/types.ts';
import type { Config } from '../config.ts';
import { categoryOf, isSupported, ruleForRow } from '../curator/rules.ts';
import type { RunSummary } from '../curator/run.ts';
import type { DecisionLog } from '../log.ts';
import { hasTag, parseTags, withTags } from '../notes.ts';
import type { Vocabulary } from '../vocabulary.ts';
import { bearer } from './auth.ts';
import { money } from './format.ts';

export type ApiStore = Pick<ActualStore, 'sync' | 'categories' | 'transactions' | 'transaction' | 'update' | 'rules'
  | 'replaceRule' | 'deleteRule' | 'spend' | 'income'>;

export type ApiStatus = { lastSyncAt?: string; lastRunAt?: string; lastRunOk?: boolean };

export type ApiDeps = {
  store: ApiStore;
  log: DecisionLog;
  vocab: Vocabulary;
  cfg: Pick<Config, 'token' | 'currency'>;
  classifierName: string;
  runNow: () => Promise<RunSummary>;
  status: () => ApiStatus;
  versions: { curator: string; actualApi: string; server: string };
  now?: () => Date;
};

class ApiError extends Error {
  readonly status: 400 | 404;
  readonly code: string;
  constructor(status: 400 | 404, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function createApp(deps: ApiDeps): Hono {
  const { store, log, vocab } = deps;
  const now = deps.now ?? (() => new Date());
  const known = new Set([...vocab.tags.map(t => t.tag), ...vocab.reserved]);
  const app = new Hono().basePath('/v1');

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof StaleRowError) return c.json({ error: { code: 'conflict', message: `${err.message}; read it again` } }, 409);
    if (err instanceof z.ZodError) {
      return c.json({ error: { code: 'bad_request', message: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') } }, 400);
    }
    console.error(err);
    return c.json({ error: { code: 'internal', message: err.message } }, 500);
  });
  app.notFound(c => c.json({ error: { code: 'not_found', message: `No route ${c.req.method} ${c.req.path}` } }, 404));

  const labels = async () => new Map((await store.categories({ includeHidden: true })).map(c => [c.id, c.label]));
  const view = (r: CuratorRow, lbl: Map<string, string>) => {
    const { memo, tags } = parseTags(r.notes, known);
    return { id: r.id, date: r.date, account: r.account, accountName: r.accountName, payee: r.payee,
      importedPayee: r.importedPayee, memo, tags, notes: r.notes ?? '', ...money(r.amount), category: r.category,
      categoryLabel: r.category ? lbl.get(r.category) ?? null : null };
  };
  const report = (rows: ReportRow[]) => ({ rows: rows.map(r => ({ ...r, ...money(r.amount) })),
    total: money(rows.reduce((s, r) => s + r.amount, 0)) });
  const range = (q: Record<string, string | undefined>) => {
    const today = now();
    return z.object({ from: day.default(`${iso(today).slice(0, 7)}-01`), to: day.default(iso(today)) }).parse(q);
  };
  /** Push a human change to the server now; a failure only delays it to the next run's sync. */
  const push = () => store.sync().catch(e => console.error(`sync after API write failed: ${(e as Error).message}`));
  const reviewRows = () => store.transactions({ from: '1970-01-01', to: iso(now()), tag: 'review', limit: 10_000 });

  app.get('/health', async c => {
    const st = deps.status();
    return c.json({ ok: st.lastRunOk !== false, lastSyncAt: st.lastSyncAt ?? null, lastRunAt: st.lastRunAt ?? null,
      pendingReview: (await reviewRows()).length,
      classifier: { name: deps.classifierName, reachable: st.lastRunOk ?? null }, versions: deps.versions });
  });

  app.use('*', bearer(deps.cfg.token));

  app.get('/categories', async c => c.json({ categories: await store.categories() }));

  app.get('/tags', c => c.json({ tags: vocab.tags, reserved: vocab.reserved, exclusive: vocab.exclusive }));

  app.get('/transactions', async c => {
    const q = c.req.query();
    const { from, to } = range({ from: q.from ?? iso(new Date(now().getTime() - 30 * 864e5)), to: q.to });
    const limit = z.coerce.number().int().min(1).max(1000).default(100).parse(q.limit);
    const rows = await store.transactions({ from, to, limit, ...(q.category ? { category: q.category } : {}),
      ...(q.tag ? { tag: q.tag.replace(/^#/, '') } : {}), ...(q.account ? { account: q.account } : {}),
      ...(q.q ? { text: q.q } : {}) });
    const lbl = await labels();
    return c.json({ transactions: rows.map(r => view(r, lbl)) });
  });

  app.get('/review', async c => {
    const lbl = await labels();
    const rows = (await reviewRows()).sort((a, b) => a.date.localeCompare(b.date));
    const out = [];
    for (const r of rows) {
      const d = await log.lastFor(r.id, x => Boolean(x.classification?.category));
      const probs = d?.classification?.category?.probabilities ?? {};
      const candidates = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([id, p]) => ({ id, label: lbl.get(id) ?? id, p }));
      const rule = ruleForRow(r, '', vocab);
      out.push({ ...view(r, lbl), candidates,
        rule: rule ? { payee: rule.importedPayee, ...(rule.notesContains ? { notesContains: rule.notesContains } : {}) } : null });
    }
    return c.json({ rows: out });
  });

  app.get('/report/spend', async c => {
    const q = c.req.query();
    const { from, to } = range(q);
    const by = z.enum(['category', 'group', 'tag']).default('category').parse(q.by);
    return c.json({ from, to, by, ...report(await store.spend({ from, to, by })) });
  });

  app.get('/report/income', async c => {
    const { from, to } = range(c.req.query());
    return c.json({ from, to, ...report(await store.income({ from, to })) });
  });

  app.get('/report/compare', async c => {
    const period = z.enum(['month', 'year']).default('month').parse(c.req.query('period'));
    const t = now();
    const y = t.getUTCFullYear(), m = t.getUTCMonth();
    const [curFrom, prevFrom, prevTo] = period === 'month'
      ? [new Date(Date.UTC(y, m, 1)), new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 0))]
      : [new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y - 1, 0, 1)), new Date(Date.UTC(y - 1, 11, 31))];
    const [cur, prev] = await Promise.all([
      store.spend({ from: iso(curFrom), to: iso(t), by: 'category' }),
      store.spend({ from: iso(prevFrom), to: iso(prevTo), by: 'category' }),
    ]);
    const keys = new Map<string | null, string>([...prev, ...cur].map(r => [r.key, r.label]));
    const amt = (rows: ReportRow[], k: string | null) => rows.find(r => r.key === k)?.amount ?? 0;
    return c.json({ period, current: { from: iso(curFrom), to: iso(t) }, previous: { from: iso(prevFrom), to: iso(prevTo) },
      rows: [...keys].map(([key, label]) => ({ key, label, current: money(amt(cur, key)), previous: money(amt(prev, key)) }))
        .sort((a, b) => a.current.amount - b.current.amount) });
  });

  const setBody = z.object({
    category: z.string().min(1).optional(),
    tags: z.object({ add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) }).optional(),
    rule: z.boolean().default(true),
  });

  app.post('/transactions/:id', async c => {
    const body = setBody.parse(await c.req.json().catch(() => ({})));
    const row = await store.transaction(c.req.param('id'));
    if (!row) throw new ApiError(404, 'not_found', `No transaction ${c.req.param('id')}`);
    const lbl = await labels();
    if (body.category && !lbl.has(body.category)) throw new ApiError(400, 'bad_request', `Unknown category ${body.category}`);
    const strip = (t: string) => t.replace(/^#/, '');
    const add = (body.tags?.add ?? []).map(strip), remove = (body.tags?.remove ?? []).map(strip);
    const unknown = [...add, ...remove].filter(t => !vocab.tags.some(v => v.tag === t) && !vocab.reserved.includes(t));
    if (unknown.length) throw new ApiError(400, 'bad_request', `Unknown tags: ${unknown.join(', ')}`);

    const category = body.category ?? row.category;
    const notes = withTags(row.notes, add, body.category ? [...remove, 'review'] : remove, known);
    let ruleId: string | undefined;
    if (body.category && body.rule) {
      const rule = ruleForRow(row, body.category, vocab);
      if (rule) {
        ruleId = await store.replaceRule(rule);
        await log.rules.record(ruleId, 'human', { importedPayee: rule.importedPayee, notesContains: rule.notesContains });
      }
    }
    await log.append({ at: now().toISOString(), txId: row.id, importedPayee: row.importedPayee ?? row.payee ?? '',
      memo: parseTags(row.notes, known).memo, amount: row.amount,
      kind: body.category && hasTag(row.notes, 'review') ? 'settled-review' : 'ui-correction',
      before: { category: row.category, notes: row.notes ?? '' }, after: { category, notes },
      reason: `set via API${ruleId ? `; rule ${ruleId}` : ''}`, dryRun: false });
    const fields: { category?: string | null; notes?: string } = {};
    if (category !== row.category) fields.category = category;
    if (notes !== (row.notes ?? '')) fields.notes = notes;
    if (Object.keys(fields).length) {
      try {
        await store.update(row.id, fields, { category: row.category, notes: row.notes ?? '' });
      } catch (e) {
        await log.append({ at: now().toISOString(), txId: row.id, importedPayee: row.importedPayee ?? row.payee ?? '',
          memo: parseTags(row.notes, known).memo, amount: row.amount, kind: 'error',
          before: { category: row.category, notes: row.notes ?? '' }, reason: `write failed: ${(e as Error).message}`, dryRun: false });
        throw e;
      }
    }
    if (ruleId || Object.keys(fields).length) await push();
    return c.json({ transaction: view({ ...row, category, notes }, lbl), ...(ruleId ? { ruleId } : {}) });
  });

  const ruleView = async (r: CuratorRule, lbl: Map<string, string>) => {
    const payee = r.conditions.find(x => x.field === 'imported_payee' && x.op === 'is')?.value;
    const notesContains = r.conditions.find(x => x.field === 'notes' && x.op === 'contains')?.value;
    const category = categoryOf(r);
    return { id: r.id, ...(payee !== undefined ? { payee } : {}), ...(notesContains !== undefined ? { notesContains } : {}),
      ...(category ? { category, categoryLabel: lbl.get(category) } : {}),
      origin: (await log.rules.originOf(r.id)) ?? null, supported: isSupported(r), conditions: r.conditions, actions: r.actions };
  };

  app.get('/rules', async c => {
    const lbl = await labels();
    return c.json({ rules: await Promise.all((await store.rules()).map(r => ruleView(r, lbl))) });
  });

  app.post('/rules', async c => {
    const b = z.object({ payee: z.string().trim().min(1), notesContains: z.string().trim().min(1).optional(),
      category: z.string().min(1), origin: z.enum(['human', 'bootstrap', 'promoted']).default('human') })
      .parse(await c.req.json().catch(() => ({})));
    if (!(await labels()).has(b.category)) throw new ApiError(400, 'bad_request', `Unknown category ${b.category}`);
    const id = await store.replaceRule({ importedPayee: b.payee, categoryId: b.category,
      ...(b.notesContains ? { notesContains: b.notesContains } : {}) });
    await log.rules.record(id, b.origin as RuleOrigin, { importedPayee: b.payee, notesContains: b.notesContains });
    await push();
    return c.json({ id });
  });

  app.delete('/rules/:id', async c => {
    const id = c.req.param('id');
    if (!(await store.deleteRule(id))) throw new ApiError(404, 'not_found', `No rule ${id}`);
    await log.rules.forget(id);
    await push();
    return c.json({ deleted: id });
  });

  app.post('/curate/run', async c => c.json(await deps.runNow()));

  app.get('/decisions', async c => {
    const since = z.string().min(4).default(new Date(now().getTime() - 864e5).toISOString()).parse(c.req.query('since'));
    return c.json({ decisions: await log.since(since) });
  });

  return app;
}
