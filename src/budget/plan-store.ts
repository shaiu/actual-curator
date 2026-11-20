import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planSchema, type Plan } from './types.ts';

export type BudgetState = { acked: Record<string, string /* iso */> };

/** File-backed budget state under `<dataDir>/budget/`. JSON files are written to *.tmp, then renamed. */
export class BudgetFiles {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'budget');
  }

  private path(name: string): string {
    mkdirSync(this.dir, { recursive: true });
    return join(this.dir, name);
  }

  private writeAtomic(name: string, data: unknown): void {
    const file = this.path(name);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, file);
  }

  private append(name: string, entry: object): void {
    appendFileSync(this.path(name), `${JSON.stringify(entry)}\n`);
  }

  plan(): Plan | null {
    const file = join(this.dir, 'plan.json');
    if (!existsSync(file)) return null;
    return planSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  }

  savePlan(plan: Plan, meta: { by: string; why: string }, at: Date): void {
    this.writeAtomic('plan.json', plan);
    this.append('plan-history.jsonl', { at: at.toISOString(), by: meta.by, why: meta.why, plan });
  }

  /** When the plan was first saved (first plan-history line), or null if never. */
  firstSavedAt(): Date | null {
    const file = join(this.dir, 'plan-history.jsonl');
    if (!existsSync(file)) return null;
    const first = readFileSync(file, 'utf8').split('\n').find((l) => l.trim() !== '');
    return first ? new Date((JSON.parse(first) as { at: string }).at) : null;
  }

  journal(entry: object, at: Date): void {
    this.append('writes.jsonl', { at: at.toISOString(), ...entry });
  }

  state(): BudgetState {
    const file = join(this.dir, 'state.json');
    if (!existsSync(file)) return { acked: {} };
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BudgetState>;
    return { acked: raw.acked ?? {} };
  }

  ack(ids: string[], at: Date): void {
    const state = this.state();
    for (const id of ids) state.acked[id] = at.toISOString();
    this.writeAtomic('state.json', state);
  }
}
