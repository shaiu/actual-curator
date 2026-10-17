// Shared prompt, schema and answer parsing for the chat-model providers
// (Anthropic, OpenAI-compatible). These models have no native calibrated
// confidence, so `confidence` is the model's own estimate; the docs say so.
import { jevState } from './questions.ts';
import { type Classification, ClassifierError, type ClassifyOptions, type RowState } from './types.ts';

export const TOOL_NAME = 'classify';

export const SYSTEM_PROMPT = [
  'You file household bank and card transactions into budget categories and tags.',
  'Payees and memos come from Israeli banks and are often in Hebrew. Amounts are text with sign and currency;',
  'negative is money out. priorCategories lists the categories this payee received before, newest first.',
  'For the category, give your probability (0 to 1) that it is the one the household would choose.',
  'Be calibrated: a transfer to a named person through PAYBOX or BIT, or a payee you cannot identify, rarely',
  'deserves more than 0.5. For each tag, give the probability (0 to 1) that the tag applies.',
].join(' ');

export function userPrompt(state: RowState, opts: ClassifyOptions): string {
  const parts = [`Transaction:\n${JSON.stringify(jevState(state), null, 1)}`];
  if (opts.categories?.length) {
    parts.push('Categories (id: label — hint):\n' + opts.categories.map(c =>
      `${c.id}: ${c.label}${c.hint ? ` — ${c.hint}` : ''}${c.isIncome ? ' (income)' : ''}`).join('\n'));
  }
  if (opts.tags.length) parts.push('Tags:\n' + opts.tags.map(t => `${t.tag}: ${t.meaning}`).join('\n'));
  return parts.join('\n\n');
}

export function answerSchema(opts: ClassifyOptions): Record<string, unknown> {
  const tagProps = Object.fromEntries(opts.tags.map(t => [t.tag, { type: 'number' }]));
  const properties: Record<string, unknown> = {
    tags: { type: 'object', properties: tagProps, required: opts.tags.map(t => t.tag), additionalProperties: false },
  };
  if (opts.categories?.length) {
    properties.category = {
      type: 'object',
      properties: { id: { type: 'string', enum: opts.categories.map(c => c.id) }, confidence: { type: 'number' } },
      required: ['id', 'confidence'],
      additionalProperties: false,
    };
  }
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseAnswer(answer: unknown, opts: ClassifyOptions, raw: unknown, provider: string): Classification {
  const malformed = (why: string) => new ClassifierError(`${provider} returned a malformed answer: ${why}`, false);
  const a = answer as { category?: { id?: unknown; confidence?: unknown }; tags?: Record<string, unknown> } | null;
  if (!a || typeof a !== 'object') throw malformed('not an object');
  const out: Classification = { tags: {}, raw };
  if (opts.categories?.length) {
    const id = a.category?.id, conf = a.category?.confidence;
    if (typeof id !== 'string' || !isNum(conf)) throw malformed('category');
    if (!opts.categories.some(c => c.id === id)) throw malformed(`category "${id}" was not offered`);
    out.category = { id, confidence: clamp(conf), probabilities: { [id]: clamp(conf) } };
  }
  for (const t of opts.tags) {
    const p = a.tags?.[t.tag];
    if (!isNum(p)) throw malformed(`tag ${t.tag}`);
    out.tags[t.tag] = clamp(p);
  }
  return out;
}
