// One curator run: sync, settle review state, file the backlog with the curator's own rules,
// classify what is left, write, promote. Every write is preceded by its decision-log line.
import { type ActualStore, StaleRowError } from '../actual/store.ts';
import type { CuratorRow, CuratorRule, NewCuratorRule } from '../actual/types.ts';
import type { Classification, Classifier, RowState } from '../classifier/types.ts';
import type { Config } from '../config.ts';
import type { Decision, DecisionLog } from '../log.ts';
import { hasTag, parseTags, withTags } from '../notes.ts';
import type { Vocabulary } from '../vocabulary.ts';
import { decide } from './decide.ts';
import { categoryOf, firstMatch, ruleForRow } from './rules.ts';

export type CuratorStore = Pick<ActualStore, 'sync' | 'candidates' | 'categories' | 'rules' | 'priorCategories'
  | 'update' | 'createRule' | 'replaceRule' | 'deleteRule'>;

export type RunSummary = {
  synced: boolean;
  /** False when the sync failed or every row the run tried failed; the scheduler alerts on a streak. */
  ok: boolean;
  seen: number; ruleHits: number; classified: number; review: number;
  settled: number; corrections: number; promoted: number; errors: number;
};

export type CurateDeps = {
  store: CuratorStore;
  classifier: Classifier;
  log: DecisionLog;
  vocab: Vocabulary;
  cfg: Pick<Config, 'thresholds' | 'promoteAfter' | 'lookbackDays' | 'dryRun' | 'currency'>;
  now?: () => Date;
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
const norm = (s: string | null | undefined) => (s ?? '').trim().toLocaleLowerCase();

export async function curate(deps: CurateDeps): Promise<RunSummary> {
  const { store, classifier, log, vocab, cfg } = deps;
  const now = deps.now ?? (() => new Date());
  const s: RunSummary = { synced: false, ok: false, seen: 0, ruleHits: 0, classified: 0, review: 0, settled: 0,
    corrections: 0, promoted: 0, errors: 0 };
  const known = new Set([...vocab.tags.map(t => t.tag), ...vocab.reserved]);
  const generic = new Set(vocab.genericPayees.map(norm));
  const memoOf = (r: CuratorRow) => parseTags(r.notes, known).memo;
  let changed = false; // anything written to the local budget copy that the server must receive

  const base = (r: CuratorRow) => ({ at: now().toISOString(), txId: r.id, importedPayee: r.importedPayee ?? r.payee ?? '',
    memo: memoOf(r), amount: r.amount, before: { category: r.category, notes: r.notes ?? '' }, dryRun: cfg.dryRun });

  /** Log, then write if anything changed. A failed write gets its own error line after the claim. */
  async function write(r: CuratorRow, d: Omit<Decision, 'at' | 'txId' | 'importedPayee' | 'memo' | 'amount' | 'before' | 'dryRun'>) {
    const decision: Decision = { ...base(r), ...d };
    await log.append(decision);
    const after = d.after;
    if (cfg.dryRun || !after) return;
    const fields: { category?: string | null; notes?: string } = {};
    if (after.category !== r.category) fields.category = after.category;
    if (after.notes !== (r.notes ?? '')) fields.notes = after.notes;
    if (!Object.keys(fields).length) return;
    try {
      await store.update(r.id, fields, { category: r.category, notes: r.notes ?? '' });
      changed = true;
    } catch (e) {
      if (e instanceof StaleRowError) {
        await log.append({ ...base(r), kind: 'skipped', reason: 'row changed in Actual after this run read it; left alone' });
        return;
      }
      s.errors++;
      await log.append({ ...base(r), kind: 'error', reason: `write failed: ${(e as Error).message}` });
    }
  }

  /**
   * In dry run nothing is written, so no row ever gets #auto. Treat the log as the marker instead:
   * a row already decided in dry run, unchanged since, is not decided (or paid for) again.
   */
  async function decidedInDryRun(r: CuratorRow, kinds: Decision['kind'][]): Promise<boolean> {
    if (!cfg.dryRun) return false;
    const last = await log.lastFor(r.id, d => d.dryRun && kinds.includes(d.kind));
    return Boolean(last && last.before.category === r.category && last.before.notes === (r.notes ?? ''));
  }

  const asRule = (id: string, nr: NewCuratorRule): CuratorRule => ({ id, stage: null, conditionsOp: 'and',
    conditions: [{ field: 'imported_payee', op: 'is', value: nr.importedPayee },
      ...(nr.notesContains ? [{ field: 'notes', op: 'contains', value: nr.notesContains }] : [])],
    actions: [{ field: 'category', op: 'set', value: nr.categoryId }] });

  // 1. Sync. Nothing is read or written from a budget that may be stale.
  try {
    await store.sync();
  } catch (e) {
    await log.append({ at: now().toISOString(), txId: '', importedPayee: '', memo: '', amount: 0, kind: 'error',
      before: { category: null, notes: '' }, reason: `sync failed: ${(e as Error).message}`, dryRun: cfg.dryRun });
    return s;
  }
  s.synced = true;

  const rows = await store.candidates({ lookbackDays: cfg.lookbackDays, today: now() });
  const offered = await store.categories();
  const labels = new Map((await store.categories({ includeHidden: true })).map(c => [c.id, c.label]));
  const rules: CuratorRule[] = await store.rules();

  // 2. Settle review state.
  for (const r of rows) {
    try {
      if (hasTag(r.notes, 'review') && r.category) {
        if (await decidedInDryRun(r, ['settled-review'])) continue;
        const rule = ruleForRow(r, r.category, vocab);
        let reason = 'answered in Actual';
        if (rule && !cfg.dryRun) {
          const id = await store.replaceRule(rule);
          changed = true;
          // visible to this run's backlog step: the payee's other rows follow the answer at once
          const i = rules.findIndex(x => x.id === id);
          if (i >= 0) rules.splice(i, 1);
          rules.push(asRule(id, rule));
          await log.rules.record(id, 'human', { importedPayee: rule.importedPayee, notesContains: rule.notesContains });
          reason += `; rule ${id}`;
        } else if (!rule) {
          reason += '; no rule (row has no payee or memo to match on)';
        }
        await write(r, { kind: 'settled-review', reason,
          after: { category: r.category, notes: withTags(r.notes, [], ['review'], known) } });
        s.settled++;
      } else if (hasTag(r.notes, 'auto') && !hasTag(r.notes, 'review')) {
        const last = await log.lastFor(r.id);
        if (!last?.after || last.dryRun || last.after.category === r.category) continue;
        for (const rule of rules) {
          const payeeCond = rule.conditions.find(c => c.field === 'imported_payee' && c.op === 'is');
          if (!payeeCond || norm(String(payeeCond.value)) !== norm(r.importedPayee)) continue;
          if ((await log.rules.originOf(rule.id)) !== 'promoted') continue;
          if (!cfg.dryRun) {
            await store.deleteRule(rule.id);
            changed = true;
            await log.rules.forget(rule.id);
          }
        }
        await log.append({ ...base(r), kind: 'ui-correction', after: { category: r.category, notes: r.notes ?? '' },
          reason: `category changed from ${last.after.category ?? 'none'} in Actual` });
        s.corrections++;
      }
    } catch (e) {
      s.errors++;
      await log.append({ ...base(r), kind: 'error', reason: `settle failed: ${(e as Error).message}` });
    }
  }

  // 3. Backlog and classification for rows the curator has not touched.
  const work: CuratorRow[] = [];
  for (const r of rows) {
    if (!hasTag(r.notes, 'auto') && !(await decidedInDryRun(r, ['rule-hit', 'classified', 'review']))) work.push(r);
  }
  s.seen = work.length;
  let attempted = 0;
  let failed = 0;
  for (const original of work) {
    let r = original;
    attempted++;
    try {
      let ruleHit: CuratorRule | undefined;
      if (!r.category) {
        ruleHit = firstMatch(rules, r);
        const cat = ruleHit && categoryOf(ruleHit);
        if (cat) r = { ...r, category: cat };
      }
      const state: RowState = {
        payee: r.payee ?? r.importedPayee ?? '', memo: memoOf(r), amount: r.amount, currency: cfg.currency,
        account: r.accountName, weekday: DAYS[new Date(`${r.date}T12:00:00Z`).getUTCDay()],
        month: MONTHS[new Date(`${r.date}T12:00:00Z`).getUTCMonth()],
        priorCategories: r.importedPayee
          ? (await store.priorCategories(r.importedPayee, 3)).map(id => labels.get(id) ?? id) : [],
      };
      let classification: Classification;
      try {
        // An outflow is never income, so income categories are not even offered for it.
        const choices = r.amount < 0 ? offered.filter(c => !c.isIncome) : offered;
        classification = await classifier.classify(state, { tags: vocab.tags, ...(r.category ? {} : { categories: choices }) });
      } catch (e) {
        failed++; s.errors++;
        await log.append({ ...base(original), kind: 'skipped', reason: `classifier: ${(e as Error).message}` });
        continue;
      }
      const d = decide({ row: r, classification, vocab, thresholds: cfg.thresholds, categories: offered });
      const { raw: _raw, ...logged } = classification;
      await write(original, {
        kind: d.kind, after: { category: d.category, notes: withTags(r.notes, d.addTags, [], known) },
        classification: logged as Classification,
        ...(classification.category ? { categoryConfidence: classification.category.confidence } : {}),
        reason: d.reason ?? (ruleHit ? `rule ${ruleHit.id}` : undefined),
      });
      if (d.kind === 'rule-hit') s.ruleHits++;
      if (d.kind === 'review') s.review++;
      if (d.kind === 'classified') {
        s.classified++;
        // 4. Promotion: a machine answer becomes a rule only after repeated agreement, never for generic payees.
        const payee = r.importedPayee?.trim();
        if (!cfg.dryRun && payee && !generic.has(norm(payee)) && d.category && !firstMatch(rules, r)
          && (await log.confidentHits(payee, d.category)) >= cfg.promoteAfter) {
          const id = await store.createRule({ importedPayee: payee, categoryId: d.category });
          changed = true;
          await log.rules.record(id, 'promoted', { importedPayee: payee });
          rules.push(asRule(id, { importedPayee: payee, categoryId: d.category }));
          s.promoted++;
        }
      }
    } catch (e) {
      failed++; s.errors++;
      await log.append({ ...base(original), kind: 'error', reason: (e as Error).message });
    }
  }
  // 5. Push this run's writes so they show in Actual now, not after the next interval.
  if (changed) {
    try {
      await store.sync();
    } catch (e) {
      s.errors++;
      await log.append({ at: now().toISOString(), txId: '', importedPayee: '', memo: '', amount: 0, kind: 'error',
        before: { category: null, notes: '' }, reason: `sync after writes failed: ${(e as Error).message}`, dryRun: cfg.dryRun });
    }
  }
  s.ok = !(attempted > 0 && failed === attempted);
  return s;
}
