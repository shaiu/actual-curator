// Payees whose rows always go to review, because one merchant sells many kinds of things (a rule would file the
// next purchase wrongly). The config's `reviewPayees` are fixed; this adds the ones chosen through the API and
// keeps `vocab.reviewPayees` (the list `decide` and `ruleForRow` read) equal to config ∪ api.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Vocabulary } from '../vocabulary.ts';

export type ReviewPayeeEntry = { payee: string; source: 'config' | 'api'; by?: string; at?: string };
type Stored = { payee: string; by: string; at: string };

export const normPayee = (v: unknown) => String(v ?? '').trim().toLocaleLowerCase();

export class ReviewPayees {
  private readonly file: string;
  private readonly config: string[];
  private api: Stored[] = [];
  private readonly vocab: Vocabulary;

  constructor(dataDir: string, vocab: Vocabulary) {
    this.vocab = vocab;
    this.file = join(dataDir, 'review-payees.json');
    this.config = [...vocab.reviewPayees];
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { payees?: Partial<Stored>[] };
        for (const p of raw.payees ?? []) {
          if (typeof p.payee === 'string' && p.payee.trim() && !this.has(p.payee)) {
            this.api.push({ payee: p.payee.trim(), by: String(p.by ?? ''), at: String(p.at ?? '') });
          }
        }
      } catch (e) {
        console.error(`ignoring unreadable ${this.file}: ${(e as Error).message}`);
      }
    }
    this.sync();
  }

  private has(payee: string): boolean {
    const n = normPayee(payee);
    return [...this.config, ...this.api.map(p => p.payee)].some(p => normPayee(p) === n);
  }

  /** Mutate the shared array in place: `curate` and `createApp` hold this same object. */
  private sync(): void {
    this.vocab.reviewPayees.splice(0, this.vocab.reviewPayees.length, ...this.config, ...this.api.map(p => p.payee));
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ payees: this.api }, null, 2)}\n`);
    renameSync(tmp, this.file);
  }

  list(): ReviewPayeeEntry[] {
    return [...this.config.map(payee => ({ payee, source: 'config' as const })),
      ...this.api.map(p => ({ payee: p.payee, source: 'api' as const, by: p.by, at: p.at }))];
  }

  /** True when the payee was new. */
  add(payee: string, by: string, at: Date): boolean {
    const p = payee.trim();
    if (!p || this.has(p)) return false;
    this.api.push({ payee: p, by, at: at.toISOString() });
    this.save();
    this.sync();
    return true;
  }

  remove(payee: string): 'removed' | 'absent' | 'config' {
    const n = normPayee(payee);
    if (this.config.some(p => normPayee(p) === n)) return 'config';
    const i = this.api.findIndex(p => normPayee(p.payee) === n);
    if (i < 0) return 'absent';
    this.api.splice(i, 1);
    this.save();
    this.sync();
    return 'removed';
  }
}
