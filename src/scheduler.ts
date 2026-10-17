import type { RunSummary } from './curator/run.ts';
import type { Notifier } from './notify.ts';

const ALERT_AFTER_MS = 60 * 60_000;

export type SchedulerStatus = { lastRunAt?: string; lastSyncAt?: string; lastRunOk?: boolean; lastSummary?: RunSummary;
  lastError?: string };

export function startScheduler(run: () => Promise<RunSummary>, opts: { intervalMinutes: number; notifier: Notifier;
  now?: () => Date; autoStart?: boolean }) {
  const now = opts.now ?? (() => new Date());
  const status: SchedulerStatus = {};
  let inFlight: Promise<RunSummary> | undefined;
  let failingSince: number | undefined;
  let alerted = false;

  async function once(): Promise<RunSummary> {
    let summary: RunSummary | undefined;
    let error: string | undefined;
    try {
      summary = await run();
    } catch (e) {
      error = (e as Error).message;
      console.error(`curator run failed: ${error}`);
    }
    const t = now();
    status.lastRunAt = t.toISOString();
    status.lastRunOk = Boolean(summary?.ok);
    status.lastSummary = summary;
    status.lastError = error;
    if (summary?.synced) status.lastSyncAt = t.toISOString();

    if (status.lastRunOk) {
      if (alerted) await opts.notifier.alert('actual-curator recovered', `Runs succeed again (${JSON.stringify(summary)}).`);
      failingSince = undefined;
      alerted = false;
    } else {
      failingSince ??= t.getTime();
      if (!alerted && t.getTime() - failingSince >= ALERT_AFTER_MS) {
        alerted = true;
        const why = error ?? (summary && !summary.synced ? 'sync with the Actual server failed'
          : 'every row failed to classify; see /v1/decisions');
        await opts.notifier.alert('actual-curator failing for over an hour', why);
      }
    }
    // A run that threw still answers /v1/curate/run with a summary; the reason is in status().lastError.
    return summary ?? { synced: false, ok: false, seen: 0, ruleHits: 0, classified: 0, review: 0, settled: 0,
      corrections: 0, promoted: 0, errors: 1 };
  }

  function runNow(): Promise<RunSummary> {
    inFlight ??= once().finally(() => { inFlight = undefined; });
    return inFlight;
  }

  const timer = opts.autoStart === false ? undefined
    : setInterval(() => { runNow().catch(() => {}); }, opts.intervalMinutes * 60_000);
  if (opts.autoStart !== false) setTimeout(() => { runNow().catch(() => {}); }, 0);

  return {
    runNow,
    /** Resolves when no run is in flight; never starts one (used on shutdown). */
    idle: async (): Promise<void> => { await inFlight?.catch(() => {}); },
    status: (): SchedulerStatus => ({ ...status }),
    stop() { if (timer) clearInterval(timer); },
  };
}
