import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';

const base = { ACTUAL_SERVER_URL: 'http://a:5006', ACTUAL_PASSWORD: 'p', ACTUAL_SYNC_ID: 's',
  CURATOR_TOKEN: 't', OPENROUTER_API_KEY: 'k', DATA_DIR: '/tmp/x' };

test('defaults and required keys', () => {
  const c = loadConfig(base);
  expect(c.port).toBe(5007);
  expect(c.classifier).toEqual({ provider: 'openrouter-jev', apiKey: 'k', model: 'typesafe/jev-1.14' });
  expect(c.thresholds).toEqual({ category: 0.95, tagDefault: 0.7, exclusive: 0.7 }); // spike 2026-10-16
  expect(c.promoteAfter).toBe(3); expect(c.lookbackDays).toBe(60); expect(c.runIntervalMinutes).toBe(15);
  expect(c.vocabPath).toBe('/tmp/x/curator.yaml');
  expect(c.dryRun).toBe(false);
  expect(c.notify).toEqual({ haPersistent: false });
});

test('missing ACTUAL_PASSWORD names the variable', () =>
  expect(() => loadConfig({ ACTUAL_SERVER_URL: 'x', ACTUAL_SYNC_ID: 's', CURATOR_TOKEN: 't', DATA_DIR: '/tmp' }))
    .toThrow(/ACTUAL_PASSWORD/));

test('anthropic provider needs its key', () =>
  expect(() => loadConfig({ ...base, CLASSIFIER_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/));

test('anthropic provider defaults its model', () =>
  expect(loadConfig({ ...base, CLASSIFIER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' }).classifier)
    .toEqual({ provider: 'anthropic', apiKey: 'a', model: 'claude-haiku-5-5' }));

test('openai-compatible needs a base url', () =>
  expect(() => loadConfig({ ...base, CLASSIFIER_PROVIDER: 'openai-compatible', OPENAI_MODEL: 'm' })).toThrow(/OPENAI_BASE_URL/));

test('overrides parse as numbers and booleans', () => {
  const c = loadConfig({ ...base, PORT: '8080', CONFIDENCE_THRESHOLD: '0.9', DRY_RUN: 'true',
    TELEGRAM_BOT_TOKEN: 'b', TELEGRAM_CHAT_ID: '1', NOTIFY_HA_PERSISTENT: 'true', VOCAB_PATH: '/v.yaml' });
  expect(c.port).toBe(8080); expect(c.thresholds.category).toBe(0.9); expect(c.dryRun).toBe(true);
  expect(c.notify).toEqual({ telegram: { token: 'b', chatId: '1' }, haPersistent: true });
  expect(c.vocabPath).toBe('/v.yaml');
});

test('currency is optional and empty by default', () => {
  expect(loadConfig(base).currency).toBe('');
  expect(loadConfig({ ...base, CURRENCY: 'ILS' }).currency).toBe('ILS');
});

test('ENV_VARS lists every variable loadConfig reads', async () => {
  const { ENV_VARS } = await import('../src/config.ts');
  const read = new Set<string>();
  const spy = (env: Record<string, string>) => new Proxy(env, { get: (t, k: string) => { read.add(k); return t[k]; } });
  loadConfig(spy({ ...base, TELEGRAM_BOT_TOKEN: 'b', TELEGRAM_CHAT_ID: '1' }));
  loadConfig(spy({ ...base, CLASSIFIER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' }));
  loadConfig(spy({ ...base, CLASSIFIER_PROVIDER: 'openai-compatible', OPENAI_BASE_URL: 'u', OPENAI_MODEL: 'm' }));
  expect([...read].sort()).toEqual([...ENV_VARS].sort());
});
