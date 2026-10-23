// Entry point: config → budget → classifier → scheduler + HTTP API. Run with `node src/main.ts`.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ActualStore } from './actual/store.ts';
import { createClassifier } from './classifier/index.ts';
import { loadConfig } from './config.ts';
import { curate } from './curator/run.ts';
import { accessVerifier } from './http/access.ts';
import { createApp } from './http/app.ts';
import { exclusionResolver } from './http/exclusions.ts';
import { createMoneyPage } from './http/money.ts';
import { DecisionLog } from './log.ts';
import { createNotifier } from './notify.ts';
import { startScheduler } from './scheduler.ts';
import { packageVersion } from './version.ts';
import { loadVocabulary } from './vocabulary.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const cfg = loadConfig(process.env);
  mkdirSync(cfg.dataDir, { recursive: true });
  if (!existsSync(cfg.vocabPath)) {
    copyFileSync(join(root, 'config', 'curator.example.yaml'), cfg.vocabPath);
    console.log(`No vocabulary at ${cfg.vocabPath}; copied the example there. Edit it to taste.`);
  }
  const vocab = loadVocabulary(cfg.vocabPath);

  const budgetDir = join(cfg.dataDir, 'actual');
  mkdirSync(budgetDir, { recursive: true });
  const store = await ActualStore.open({ serverUrl: cfg.actual.serverUrl, password: cfg.actual.password,
    syncId: cfg.actual.syncId, dataDir: budgetDir });
  const classifier = createClassifier(cfg.classifier);
  const log = new DecisionLog(cfg.dataDir);
  const notifier = createNotifier(cfg.notify);
  const versions = { curator: packageVersion(), actualApi: packageVersion('@actual-app/api'),
    server: await store.serverVersion() };

  console.log(`actual-curator ${versions.curator} · @actual-app/api ${versions.actualApi} · server ${versions.server}`
    + ` · classifier ${classifier.name} · threshold ${cfg.thresholds.category} · every ${cfg.runIntervalMinutes} min`
    + `${cfg.dryRun ? ' · DRY RUN (decisions logged, nothing written)' : ''}`);

  const scheduler = startScheduler(async () => {
    const s = await curate({ store, classifier, log, vocab, cfg });
    console.log(`run: ${JSON.stringify(s)}`);
    return s;
  }, { intervalMinutes: cfg.runIntervalMinutes, notifier });

  const app = createApp({ store, log, vocab, cfg, classifierName: classifier.name, runNow: scheduler.runNow,
    status: scheduler.status, versions });
  const page = createMoneyPage({ store, exclusions: exclusionResolver(store, cfg.reportExclude), watch: cfg.moneyWatch,
    pending: async () => (await store.transactions({ from: '1970-01-01', to: '9999-12-31', tag: 'review', limit: 10_000 })).length,
    ...(cfg.access ? { verify: accessVerifier(cfg.access) } : {}) });
  // /money is its own small app; everything else is the API, with its JSON 404s.
  const fetch = (req: Request) => (new URL(req.url).pathname === '/money' ? page.fetch(req) : app.fetch(req));
  const server = serve({ fetch, port: cfg.port, hostname: '0.0.0.0' },
    info => console.log(`HTTP API on :${info.port}/v1${cfg.access ? ' · /money behind Cloudflare Access' : ''}`));

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: stopping`);
    scheduler.stop();
    server.close();
    await scheduler.idle(); // let an in-flight run finish rather than cut it mid-write
    await store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(e => {
  console.error(`actual-curator failed to start: ${(e as Error).message}`);
  process.exit(1);
});
