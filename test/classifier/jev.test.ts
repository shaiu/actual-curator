import { expect, test, vi } from 'vitest';
import { ClassifierError, createClassifier } from '../../src/classifier/index.ts';
import type { CategoryOption, RowState } from '../../src/classifier/types.ts';

const state: RowState = { payee: 'ארומה', memo: '', amount: -2550, currency: 'ILS', account: 'Max',
  weekday: 'Tuesday', month: 'October', priorCategories: [] };
const categories: CategoryOption[] = [
  { id: 'c1', label: 'Needs / Coffee', isIncome: false },
  { id: 'c2', label: 'Wants / Dining out', isIncome: false },
];
const tags = [{ tag: 'kids', meaning: 'for a child' }];
const cfg = { provider: 'openrouter-jev' as const, apiKey: 'k', model: 'typesafe/jev-1.14' };

const ok = (body: unknown) => vi.fn(async (_url: string, _init: RequestInit) =>
  new Response(JSON.stringify(body), { status: 200 }));

test('jev maps answers', async () => {
  const fetchImpl = ok({ answers: {
    category: { type: 'choice', choice: 'c1', probabilities: { c1: 0.9, c2: 0.1 }, confidence: 0.86 },
    tag_kids: { type: 'noul', noul: 0.12 } }, usage: { cost: 0.00001 } });
  const c = createClassifier(cfg, fetchImpl);
  expect(c.name).toBe('openrouter-jev:typesafe/jev-1.14');
  const r = await c.classify(state, { categories, tags });
  expect(r.category).toEqual({ id: 'c1', confidence: 0.86, probabilities: { c1: 0.9, c2: 0.1 } });
  expect(r.tags).toEqual({ kids: 0.12 });
  expect(r.cost).toBe(0.00001);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer k');
  const body = JSON.parse(init.body as string);
  expect(body.model).toBe('typesafe/jev-1.14');
  expect(body.state.amount).toBe('-25.50 ILS');
  expect(body.state.payee).toBe('ארומה');
});

test('baseUrl override is honoured', async () => {
  const fetchImpl = ok({ answers: { tag_kids: { type: 'noul', noul: 0.5 } } });
  await createClassifier({ ...cfg, baseUrl: 'http://gw.local/' }, fetchImpl).classify(state, { tags });
  expect(fetchImpl.mock.calls[0][0]).toBe('http://gw.local/api/alpha/decisions');
});

test('tags-only call has no category', async () => {
  const r = await createClassifier(cfg, ok({ answers: { tag_kids: { type: 'noul', noul: 0.5 } } }))
    .classify(state, { tags });
  expect(r.category).toBeUndefined();
});

test('429 is a retryable ClassifierError; malformed body is not', async () => { // Review Focus 3
  const r429 = createClassifier(cfg, vi.fn(async () => new Response('slow down', { status: 429 })));
  await expect(r429.classify(state, { categories, tags })).rejects.toMatchObject({ name: 'ClassifierError', retryable: true });
  const r503 = createClassifier(cfg, vi.fn(async () => new Response('down', { status: 503 })));
  await expect(r503.classify(state, { categories, tags })).rejects.toMatchObject({ retryable: true });
  const r400 = createClassifier(cfg, vi.fn(async () => new Response('bad', { status: 400 })));
  await expect(r400.classify(state, { categories, tags })).rejects.toMatchObject({ retryable: false });
  const junk = createClassifier(cfg, ok({ nope: 1 }));
  await expect(junk.classify(state, { categories, tags })).rejects.toBeInstanceOf(ClassifierError);
  await expect(junk.classify(state, { categories, tags })).rejects.toMatchObject({ retryable: false });
});

test('a choice outside the offered categories is malformed', async () => {
  const c = createClassifier(cfg, ok({ answers: {
    category: { type: 'choice', choice: 'zzz', probabilities: { zzz: 1 }, confidence: 0.99 },
    tag_kids: { type: 'noul', noul: 0.1 } } }));
  await expect(c.classify(state, { categories, tags })).rejects.toMatchObject({ retryable: false });
});

test('network failure is retryable', async () => {
  const c = createClassifier(cfg, vi.fn(async () => { throw new TypeError('fetch failed'); }));
  await expect(c.classify(state, { tags })).rejects.toMatchObject({ retryable: true });
});
