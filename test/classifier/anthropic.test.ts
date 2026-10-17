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
const cfg = { provider: 'anthropic' as const, apiKey: 'ak', model: 'claude-haiku-5-5' };

const toolReply = (input: unknown, status = 200) => vi.fn(async (_url: string, _init: RequestInit) =>
  new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
    stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'tool_use', id: 'tu_1', name: 'classify', input }] }),
  { status, headers: { 'content-type': 'application/json' } }));

test('anthropic maps the tool input', async () => {
  const fetchImpl = toolReply({ category: { id: 'c1', confidence: 0.86 }, tags: { kids: 0.12 } });
  const c = createClassifier(cfg, fetchImpl);
  expect(c.name).toBe('anthropic:claude-haiku-5-5');
  const r = await c.classify(state, { categories, tags });
  expect(r.category).toEqual({ id: 'c1', confidence: 0.86, probabilities: { c1: 0.86 } });
  expect(r.tags).toEqual({ kids: 0.12 });
  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
  const body = JSON.parse(init.body as string);
  expect(body.model).toBe('claude-haiku-5-5');
  expect(body.tool_choice).toEqual({ type: 'tool', name: 'classify' });
  expect(body.tools[0].strict).toBe(true);
  expect(body.tools[0].input_schema.properties.category.properties.id.enum).toEqual(['c1', 'c2']);
  expect(JSON.stringify(body.messages)).toContain('-25.50 ILS');
});

test('anthropic: a category id outside the options is a non-retryable error', async () => {
  const c = createClassifier(cfg, toolReply({ category: { id: 'zzz', confidence: 0.9 }, tags: { kids: 0.1 } }));
  await expect(c.classify(state, { categories, tags })).rejects.toMatchObject({ name: 'ClassifierError', retryable: false });
});

test('anthropic: confidence outside [0,1] is clamped', async () => {
  const r = await createClassifier(cfg, toolReply({ category: { id: 'c2', confidence: 1.4 }, tags: { kids: -0.2 } }))
    .classify(state, { categories, tags });
  expect(r.category?.confidence).toBe(1);
  expect(r.tags.kids).toBe(0);
});

test('anthropic: 429 is retryable, 400 is not', async () => {
  const err = (status: number) => vi.fn(async () => new Response(JSON.stringify({ type: 'error',
    error: { type: 'x', message: 'no' } }), { status, headers: { 'content-type': 'application/json' } }));
  await expect(createClassifier(cfg, err(429)).classify(state, { tags })).rejects.toMatchObject({ retryable: true });
  await expect(createClassifier(cfg, err(400)).classify(state, { tags })).rejects.toMatchObject({ retryable: false });
});
