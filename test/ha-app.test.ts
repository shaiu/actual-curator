import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { optionsToEnv } from '../actual_curator/options.ts';
import { ENV_VARS } from '../src/config.ts';

const app = parse(readFileSync('actual_curator/config.yaml', 'utf8')) as {
  version: string; slug: string; options: Record<string, unknown>; schema: Record<string, string>; ports: Record<string, number>;
};

test('options map to the env vars the app reads; empty optionals are left out', () => {
  expect(optionsToEnv({ actual_server_url: 'http://a:5006', actual_password: 'p', dry_run: true, confidence_threshold: 0.95,
    telegram_bot_token: '', anthropic_api_key: null })).toEqual({
    ACTUAL_SERVER_URL: 'http://a:5006', ACTUAL_PASSWORD: 'p', DRY_RUN: 'true', CONFIDENCE_THRESHOLD: '0.95',
    DATA_DIR: '/data', PORT: '5007' });
});

test('config.yaml exposes every app setting except the two the app fixes', () => {
  const fixed = ['DATA_DIR', 'PORT'];
  expect(Object.keys(app.schema).map(k => k.toUpperCase()).sort())
    .toEqual(ENV_VARS.filter(v => !fixed.includes(v)).sort());
  for (const k of Object.keys(app.options)) expect(app.schema).toHaveProperty(k);
});

test('secrets are password fields; version tracks package.json; port 5007', () => {
  for (const k of ['actual_password', 'curator_token', 'openrouter_api_key', 'anthropic_api_key', 'openai_api_key', 'telegram_bot_token']) {
    expect(app.schema[k]).toMatch(/^password\??$/);
  }
  expect(app.version).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
  expect(app.slug).toBe('actual_curator');
  expect(app.ports).toEqual({ '5007/tcp': 5007 });
});

test('config.yaml follows the Home Assistant app guidelines', () => {
  const raw = parse(readFileSync('actual_curator/config.yaml', 'utf8')) as Record<string, unknown>;
  expect(readFileSync('actual_curator/config.yaml', 'utf8')).toMatch(/^version: "\d+\.\d+\.\d+"$/m); // quoted
  expect(raw).not.toHaveProperty('init'); // our image has no S6, so keep the default init: true
  expect(raw.image).toBe('ghcr.io/shaiu/actual-curator-ha'); // one multi-arch image, no {arch}
  expect(raw.map).toEqual([{ type: 'app_config', read_only: false }]);
  expect(raw).not.toHaveProperty('ports_description'); // port text lives in translations
  const tr = parse(readFileSync('actual_curator/translations/en.yaml', 'utf8')) as { network: Record<string, string> };
  expect(Object.keys(tr.network)).toEqual(Object.keys(raw.ports as object));
  expect(readFileSync('actual_curator/Dockerfile', 'utf8')).toContain('io.hass.type="app"');
});
