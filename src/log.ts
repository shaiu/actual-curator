// Append-only decision log: one JSONL file per month under $DATA_DIR/decisions,
// plus rules.json recording who made each rule (Actual rules carry no metadata).
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuleOrigin } from './actual/types.ts';
import type { Classification } from './classifier/types.ts';

export type DecisionKind = 'rule-hit' | 'classified' | 'review' | 'settled-review' | 'ui-correction' | 'skipped' | 'error';

export type Decision = {
  at: string;
  txId: string;
  importedPayee: string;
  memo: string;
  amount: number;
  kind: DecisionKind;
  before: { category: string | null; notes: string };
  after?: { category: string | null; notes: string };
  classification?: Classification;
  categoryConfidence?: number;
  reason?: string;
  dryRun: boolean;
};

export type RuleRecord = { origin: RuleOrigin; importedPayee: string; notesContains?: string; at: string };

export class DecisionLog {
  private readonly dir: string;
  private readonly rulesPath: string;
  private cache: Decision[] | undefined;
  private rulesCache: Record<string, RuleRecord> | undefined;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'decisions');
    this.rulesPath = join(dataDir, 'rules.json');
  }

  private async all(): Promise<Decision[]> {
    if (this.cache) return this.cache;
    const out: Decision[] = [];
    if (existsSync(this.dir)) {
      for (const f of (await readdir(this.dir)).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort()) {
        for (const line of (await readFile(join(this.dir, f), 'utf8')).split('\n')) {
          if (line.trim()) out.push(JSON.parse(line) as Decision);
        }
      }
    }
    return (this.cache = out);
  }

  async append(d: Decision): Promise<void> {
    const all = await this.all();
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, `${d.at.slice(0, 7)}.jsonl`), `${JSON.stringify(d)}\n`);
    all.push(d);
  }

  async since(iso: string): Promise<Decision[]> {
    return (await this.all()).filter(d => d.at >= iso);
  }

  async lastFor(txId: string, where: (d: Decision) => boolean = () => true): Promise<Decision | undefined> {
    return (await this.all()).findLast(d => d.txId === txId && where(d));
  }

  /**
   * Distinct transactions the classifier filed confidently under this payee and category. Dry-run
   * decisions wrote nothing (those rows are classified again once writes are on), and a UI correction
   * for the payee resets the count, so a rule the human just contradicted is not promoted back.
   */
  async confidentHits(importedPayee: string, categoryId: string): Promise<number> {
    const all = await this.all();
    const reset = all.findLastIndex(d => d.kind === 'ui-correction' && d.importedPayee === importedPayee);
    const tx = new Set<string>();
    for (const d of all.slice(reset + 1)) {
      if (d.kind === 'classified' && !d.dryRun && d.importedPayee === importedPayee && d.after?.category === categoryId) {
        tx.add(d.txId);
      }
    }
    return tx.size;
  }

  readonly rules = {
    record: async (ruleId: string, origin: RuleOrigin, cond: { importedPayee: string; notesContains?: string }) => {
      const r = await this.loadRules();
      r[ruleId] = { origin, ...cond, at: new Date().toISOString() };
      await this.saveRules(r);
    },
    originOf: async (ruleId: string): Promise<RuleOrigin | undefined> => (await this.loadRules())[ruleId]?.origin,
    forget: async (ruleId: string) => {
      const r = await this.loadRules();
      if (!(ruleId in r)) return;
      delete r[ruleId];
      await this.saveRules(r);
    },
  };

  private async loadRules(): Promise<Record<string, RuleRecord>> {
    if (!this.rulesCache) {
      this.rulesCache = existsSync(this.rulesPath)
        ? JSON.parse(await readFile(this.rulesPath, 'utf8')) as Record<string, RuleRecord>
        : {};
    }
    return this.rulesCache;
  }

  private async saveRules(r: Record<string, RuleRecord>): Promise<void> {
    await mkdir(join(this.rulesPath, '..'), { recursive: true });
    const tmp = `${this.rulesPath}.tmp`;
    await writeFile(tmp, JSON.stringify(r, null, 2));
    await rename(tmp, this.rulesPath);
  }
}
