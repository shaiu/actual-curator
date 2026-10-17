import { expect, test, vi } from 'vitest';
import { createClassifier } from '../../src/classifier/index.ts';
import type { CategoryOption, RowState } from '../../src/classifier/types.ts';

const state: RowState = { payee: 'ארומה', memo: '', amount: -2550, currency: 'ILS', account: 'Max',
  weekday: 'Tuesday', month: 'October', priorCategories: [] };
const categories: CategoryOption[] = [
  { id: 'c1', label: 'Needs / Coffee', isIncome: false },
  { id: 'c2', label: 'Wants / Dining out', isIncome: false },
];
const tags = [{ tag: 'kids', meaning: 'for a child' }];
const cfg = { provider: 'openai-compatible' as const, apiKey: 'ok', model: 'anthropic/claude-haiku-5-5',
  baseUrl: 'https://openrouter.ai/api/v1/' };

const reply = (content: string, extra: Record<string, unknown> = {}) => vi.fn(async (_url: string, _init: RequestInit) =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], ...extra }), { status: 200 }));

test('openai-compatible maps the JSON answer', async () => {
  const fetchImpl = reply(JSON.stringify({ category: { id: 'c1', confidence: 0.86 }, tags: { kids: 0.12 } }),
    { usage: { cost: 0.0002 } });
  const c = createClassifier(cfg, fetchImpl);
  expect(c.name).toBe('openai-compatible:anthropic/claude-haiku-5-5');
  const r = await c.classify(state, { categories, tags });
  expect(r.category).toEqual({ id: 'c1', confidence: 0.86, probabilities: { c1: 0.86 } });
  expect(r.tags).toEqual({ kids: 0.12 });
  expect(r.cost).toBe(0.0002);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer ok');
  const body = JSON.parse(init.body as string);
  expect(body.response_format.type).toBe('json_schema');
  expect(body.response_format.json_schema.strict).toBe(true);
  expect(body.response_format.json_schema.schema.properties.category.properties.id.enum).toEqual(['c1', 'c2']);
});

test('openai-compatible: no key means no authorization header (Ollama)', async () => {
  const fetchImpl = reply(JSON.stringify({ tags: { kids: 0.5 } }));
  await createClassifier({ ...cfg, apiKey: '' }, fetchImpl).classify(state, { tags });
  expect(new Headers(fetchImpl.mock.calls[0][1].headers).has('authorization')).toBe(false);
});

test('openai-compatible: a category id outside the options is a non-retryable error', async () => {
  const c = createClassifier(cfg, reply(JSON.stringify({ category: { id: 'zzz', confidence: 0.9 }, tags: { kids: 0.1 } })));
  await expect(c.classify(state, { categories, tags })).rejects.toMatchObject({ name: 'ClassifierError', retryable: false });
});

test('openai-compatible: confidence outside [0,1] is clamped', async () => {
  const r = await createClassifier(cfg, reply(JSON.stringify({ category: { id: 'c2', confidence: 7 }, tags: { kids: -1 } })))
    .classify(state, { categories, tags });
  expect(r.category?.confidence).toBe(1);
  expect(r.tags.kids).toBe(0);
});

test('openai-compatible: non-JSON content is malformed; 503 is retryable', async () => {
  await expect(createClassifier(cfg, reply('sure! here you go')).classify(state, { tags }))
    .rejects.toMatchObject({ retryable: false });
  await expect(createClassifier(cfg, vi.fn(async () => new Response('down', { status: 503 }))).classify(state, { tags }))
    .rejects.toMatchObject({ retryable: true });
});
