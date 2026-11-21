// THROWAWAY: checks that Actual's envelope rollover behaves the way the budget engine assumes. Read-only, not tested, not shipped.
//
// The engine reads `carryIn = balance - budgeted - spent` as "what the previous month left in this envelope" and expects
// it to equal max(0, previous month's balance) (an overspend does not roll over). For each month this prints To budget
// and, per visible expense category, budgeted / spent / balance / carriedIn, and flags:
//   (a) carriedIn of month M differs from max(0, balance of month M-1)
//   (b) a hidden category with a non-zero balance
//   (c) a negative balance in the last month
//   (d) carriedIn > 0 (a starting balance a set-aside will count)
//
//   node --env-file=$HOME/.config/actual-curator/env scripts/rollover-check.ts --months 2026-09,2026-10,2026-11
//
// Reads ACTUAL_SERVER_URL, ACTUAL_PASSWORD and ACTUAL_SYNC_ID. Downloads the budget into a fresh temp dir. Never writes to Actual:
// it calls only budgetMonth() and close().

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ActualStore } from '../src/actual/store.ts';
import { previousMonth } from '../src/budget/dates.ts';
import type { MonthSnapshot } from '../src/budget/types.ts';

const { values: args } = parseArgs({ options: { months: { type: 'string' } } });
if (!args.months) throw new Error('--months YYYY-MM,YYYY-MM,... is required (ascending, consecutive)');
const months = args.months.split(',').map(m => m.trim()).sort();
for (const m of months) if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error(`bad month: ${m}`);
const env = (k: string) => process.env[k]?.trim() || (() => { throw new Error(`${k} is not set`); })();

const fmt = (minor: number) => (minor / 100).toFixed(2);
const flags: string[] = [];
const flag = (s: string) => { flags.push(s); return `  <-- ${s}`; };

const dataDir = mkdtempSync(join(tmpdir(), 'rollover-check-'));
const store = await ActualStore.open({ serverUrl: env('ACTUAL_SERVER_URL'), password: env('ACTUAL_PASSWORD'), syncId: env('ACTUAL_SYNC_ID'), dataDir });
try {
  const snaps = new Map<string, MonthSnapshot>();
  for (const m of months) snaps.set(m, await store.budgetMonth(m));
  const last = months[months.length - 1]!;

  for (const m of months) {
    const snap = snaps.get(m)!;
    const prev = months.includes(previousMonth(m)) ? snaps.get(previousMonth(m)) : undefined;
    console.log(`\n== ${m}  toBudget ${fmt(snap.toBudget)}`);
    for (const c of snap.categories.filter(x => !x.isIncome)) {
      const carriedIn = c.balance - c.budgeted - c.spent;
      if (c.hidden) {
        if (c.balance !== 0) console.log(`  [hidden] ${c.label}  balance ${fmt(c.balance)}${flag(`(b) ${m} hidden category "${c.label}" holds ${fmt(c.balance)}`)}`);
        continue;
      }
      let note = '';
      const before = prev?.categories.find(x => x.id === c.id);
      if (before && carriedIn !== Math.max(0, before.balance)) {
        note += flag(`(a) ${m} "${c.label}" carriedIn ${fmt(carriedIn)} != max(0, ${previousMonth(m)} balance ${fmt(before.balance)})`);
      }
      if (carriedIn > 0) note += flag(`(d) ${m} "${c.label}" starts with ${fmt(carriedIn)}`);
      if (m === last && c.balance < 0) note += flag(`(c) ${m} "${c.label}" balance ${fmt(c.balance)}`);
      console.log(`  ${c.label}  budgeted ${fmt(c.budgeted)}  spent ${fmt(c.spent)}  balance ${fmt(c.balance)}  carriedIn ${fmt(carriedIn)}${note}`);
    }
  }
  console.log(`\n${flags.length} flag(s)`);
  for (const f of flags) console.log(`  ${f}`);
} finally {
  await store.close();
}
