import type { TagDef } from '../vocabulary.ts';
import type { CategoryOption, RowState } from './types.ts';

export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type NoulQuestion = { type: 'noul'; instructions: string; criteria: { true: string; false: string } };
export type JevQuestions = { category?: ChoiceQuestion } & Record<string, ChoiceQuestion | NoulQuestion>;

export const CATEGORY_KEY = 'category';
export const tagKey = (tag: string) => `tag_${tag}`;

export function buildQuestions(opts: { categories?: CategoryOption[]; tags: TagDef[] }): JevQuestions {
  const q: JevQuestions = {};
  if (opts.categories?.length) {
    q[CATEGORY_KEY] = {
      type: 'choice',
      instructions: 'Which budget category does this bank or card transaction belong to? '
        + 'The payee and memo come from an Israeli bank and may be in Hebrew.',
      criteria: Object.fromEntries(opts.categories.map(c => [c.id,
        c.label + (c.hint ? ` — ${c.hint}` : '') + (c.isIncome ? ' (income)' : '')])),
    };
  }
  for (const t of opts.tags) {
    q[tagKey(t.tag)] = {
      type: 'noul',
      instructions: `Does the tag #${t.tag} apply to this transaction? #${t.tag} means: ${t.meaning}`,
      criteria: { true: t.meaning, false: `Not ${t.meaning.charAt(0).toLowerCase()}${t.meaning.slice(1)}` },
    };
  }
  return q;
}

/** Minor units → "-25.50 ILS". Jev does no arithmetic, so it sees the amount as text. */
export function formatAmount(minor: number, currency: string): string {
  const sign = minor < 0 ? '-' : '+';
  return `${sign}${(Math.abs(minor) / 100).toFixed(2)}${currency ? ` ${currency}` : ''}`;
}

export function jevState(s: RowState): Record<string, unknown> {
  return { ...s, amount: formatAmount(s.amount, s.currency) };
}
