import { expect, test, vi } from 'vitest';
import type { RunSummary } from '../src/curator/run.ts';
import { startScheduler } from '../src/scheduler.ts';

const good: RunSummary = { synced: true, ok: true, seen: 0, ruleHits: 0, classified: 0, review: 0, settled: 0,
  corrections: 0, promoted: 0, errors: 0 };
const bad: RunSummary = { ...good, ok: false, synced: false };

test('runNow while a run is in flight returns the in-flight promise', async () => {
  let release!: () => void;
  const run = vi.fn(() => new Promise<RunSummary>(r => { release = () => r(good); }));
  const s = startScheduler(run, { intervalMinutes: 15, notifier: { alert: vi.fn() }, autoStart: false });
  const a = s.runNow();
  const b = s.runNow();
  expect(run).toHaveBeenCalledTimes(1);
  release();
  expect(await a).toBe(await b);
  s.stop();
});

test('alert once after 60 minutes of continuous failure, once more on recovery', async () => {
  let t = 0;
  const alert = vi.fn(async (_title: string, _body: string) => {});
  const results: (RunSummary | Error)[] = [bad, new Error('boom'), bad, bad, good, good];
  const run = vi.fn(async () => { const r = results.shift()!; if (r instanceof Error) throw r; return r; });
  const s = startScheduler(run, { intervalMinutes: 15, notifier: { alert }, autoStart: false, now: () => new Date(t * 60_000) });
  t = 0; await s.runNow();
  t = 30; await s.runNow();
  expect(alert).not.toHaveBeenCalled();
  t = 61; await s.runNow();
  expect(alert).toHaveBeenCalledTimes(1);
  expect(alert.mock.calls[0][0]).toMatch(/failing/i);
  t = 75; await s.runNow();
  expect(alert).toHaveBeenCalledTimes(1);
  t = 90; await s.runNow();
  expect(alert).toHaveBeenCalledTimes(2);
  expect(alert.mock.calls[1][0]).toMatch(/recovered/i);
  t = 105; await s.runNow();
  expect(alert).toHaveBeenCalledTimes(2);
  expect(s.status()).toMatchObject({ lastRunOk: true, lastRunAt: new Date(105 * 60_000).toISOString() });
  s.stop();
});

test('a short failure that recovers within the hour alerts nothing', async () => {
  let t = 0;
  const alert = vi.fn(async (_title: string, _body: string) => {});
  const results = [bad, good];
  const s = startScheduler(async () => results.shift()!, { intervalMinutes: 15, notifier: { alert }, autoStart: false,
    now: () => new Date(t * 60_000) });
  await s.runNow(); t = 15; await s.runNow();
  expect(alert).not.toHaveBeenCalled();
  s.stop();
});

test('lastSyncAt only moves on a synced run', async () => {
  let t = 0;
  const results = [good, bad];
  const s = startScheduler(async () => results.shift()!, { intervalMinutes: 15, notifier: { alert: vi.fn() }, autoStart: false,
    now: () => new Date(t * 60_000) });
  await s.runNow(); t = 15; await s.runNow();
  expect(s.status()).toMatchObject({ lastSyncAt: new Date(0).toISOString(), lastRunAt: new Date(15 * 60_000).toISOString(), lastRunOk: false });
  s.stop();
});

test('idle() waits for an in-flight run and never starts one', async () => {
  const run = vi.fn(async () => good);
  const s = startScheduler(run, { intervalMinutes: 15, notifier: { alert: vi.fn() }, autoStart: false });
  await s.idle();
  expect(run).not.toHaveBeenCalled();
  const p = s.runNow();
  await s.idle();
  expect(run).toHaveBeenCalledTimes(1);
  await p;
  s.stop();
});
