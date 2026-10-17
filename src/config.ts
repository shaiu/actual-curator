import { join } from 'node:path';

export type ClassifierProvider = 'openrouter-jev' | 'anthropic' | 'openai-compatible';

export type ClassifierConfig = {
  provider: ClassifierProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
};

export type Config = {
  actual: { serverUrl: string; password: string; syncId: string };
  dataDir: string;
  port: number;
  token: string;
  classifier: ClassifierConfig;
  thresholds: { category: number; tagDefault: number; exclusive: number };
  promoteAfter: number;
  runIntervalMinutes: number;
  lookbackDays: number;
  dryRun: boolean;
  /** ISO code shown to the classifier next to amounts; empty means none. */
  currency: string;
  vocabPath: string;
  notify: { telegram?: { token: string; chatId: string }; haPersistent: boolean };
};

type Env = Record<string, string | undefined>;

/** Every environment variable the app reads. The Home Assistant app's options schema is checked against this. */
export const ENV_VARS = [
  'ACTUAL_SERVER_URL', 'ACTUAL_PASSWORD', 'ACTUAL_SYNC_ID', 'DATA_DIR', 'PORT', 'CURATOR_TOKEN',
  'CLASSIFIER_PROVIDER', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OPENROUTER_BASE_URL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL',
  'CONFIDENCE_THRESHOLD', 'TAG_THRESHOLD', 'PROMOTE_AFTER', 'RUN_INTERVAL_MINUTES', 'LOOKBACK_DAYS', 'DRY_RUN',
  'CURRENCY', 'VOCAB_PATH', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'NOTIFY_HA_PERSISTENT',
] as const;

const PROVIDERS: ClassifierProvider[] = ['openrouter-jev', 'anthropic', 'openai-compatible'];

function required(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function number(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function bool(env: Env, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return false;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

function classifier(env: Env): ClassifierConfig {
  const provider = (env.CLASSIFIER_PROVIDER?.trim() || 'openrouter-jev') as ClassifierProvider;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`CLASSIFIER_PROVIDER must be one of ${PROVIDERS.join(', ')}, got "${provider}"`);
  }
  switch (provider) {
    case 'openrouter-jev': {
      const c: ClassifierConfig = { provider, apiKey: required(env, 'OPENROUTER_API_KEY'),
        model: env.OPENROUTER_MODEL?.trim() || 'typesafe/jev-1.14' };
      if (env.OPENROUTER_BASE_URL?.trim()) c.baseUrl = env.OPENROUTER_BASE_URL.trim();
      return c;
    }
    case 'anthropic':
      return { provider, apiKey: required(env, 'ANTHROPIC_API_KEY'),
        model: env.ANTHROPIC_MODEL?.trim() || 'claude-haiku-5-5' };
    case 'openai-compatible':
      // Local servers (Ollama) need no key, so the key is optional here.
      return { provider, apiKey: env.OPENAI_API_KEY?.trim() ?? '', model: required(env, 'OPENAI_MODEL'),
        baseUrl: required(env, 'OPENAI_BASE_URL') };
  }
}

export function loadConfig(env: Env): Config {
  const dataDir = required(env, 'DATA_DIR');
  const tgToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const tgChat = env.TELEGRAM_CHAT_ID?.trim();
  if (Boolean(tgToken) !== Boolean(tgChat)) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together');
  }
  return {
    actual: {
      serverUrl: required(env, 'ACTUAL_SERVER_URL'),
      password: required(env, 'ACTUAL_PASSWORD'),
      syncId: required(env, 'ACTUAL_SYNC_ID'),
    },
    dataDir,
    port: number(env, 'PORT', 5007),
    token: required(env, 'CURATOR_TOKEN'),
    classifier: classifier(env),
    thresholds: {
      category: number(env, 'CONFIDENCE_THRESHOLD', 0.95), // Jev spike 2026-10-16: 0.95 is where novel payees are ≥90% right
      tagDefault: number(env, 'TAG_THRESHOLD', 0.7),
      exclusive: 0.7,
    },
    promoteAfter: number(env, 'PROMOTE_AFTER', 3),
    runIntervalMinutes: number(env, 'RUN_INTERVAL_MINUTES', 15),
    lookbackDays: number(env, 'LOOKBACK_DAYS', 60),
    dryRun: bool(env, 'DRY_RUN'),
    currency: env.CURRENCY?.trim() ?? '',
    vocabPath: env.VOCAB_PATH?.trim() || join(dataDir, 'curator.yaml'),
    notify: {
      ...(tgToken && tgChat ? { telegram: { token: tgToken, chatId: tgChat } } : {}),
      haPersistent: bool(env, 'NOTIFY_HA_PERSISTENT'),
    },
  };
}
