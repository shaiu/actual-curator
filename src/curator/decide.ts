// The pure decision for one row: which category (if any) to write, and which tags.
import type { CuratorRow } from '../actual/types.ts';
import type { CategoryOption, Classification } from '../classifier/types.ts';
import type { DecisionKind } from '../log.ts';
import type { Vocabulary } from '../vocabulary.ts';

export type Thresholds = { category: number; tagDefault: number; exclusive: number };

export type DecideResult = { category: string | null; addTags: string[]; review: boolean; kind: DecisionKind; reason?: string };

export function passingTags(tags: Record<string, number>, vocab: Vocabulary, thresholds: Thresholds): string[] {
  const pass = new Set(vocab.tags.filter(t => (tags[t.tag] ?? 0) >= (t.threshold ?? thresholds.tagDefault)).map(t => t.tag));
  for (const [a, b] of vocab.exclusive) {
    pass.delete(a); pass.delete(b);
    const [winner, p] = (tags[a] ?? 0) >= (tags[b] ?? 0) ? [a, tags[a] ?? 0] : [b, tags[b] ?? 0];
    if (p >= thresholds.exclusive) pass.add(winner);
  }
  return vocab.tags.map(t => t.tag).filter(t => pass.has(t));
}

export function decide(input: { row: CuratorRow; classification: Classification | undefined; vocab: Vocabulary;
  thresholds: Thresholds; categories: CategoryOption[] }): DecideResult {
  const { row, classification: c, vocab, thresholds, categories } = input;
  if (!c) return { category: row.category, addTags: [], review: false, kind: 'skipped' };
  const tags = passingTags(c.tags, vocab, thresholds);
  if (row.category) return { category: row.category, addTags: [...tags, 'auto'], review: false, kind: 'rule-hit' };

  const review = (reason: string): DecideResult =>
    ({ category: null, addTags: [...tags, 'auto', 'review'], review: true, kind: 'review', reason });
  const payee = (row.importedPayee ?? '').trim().toLocaleLowerCase();
  if (vocab.reviewPayees.some(p => p.trim().toLocaleLowerCase() === payee)) return review(`payee ${payee} is always reviewed`);
  if (!c.category) return review('no category answer');
  if (c.category.confidence < thresholds.category) {
    return review(`confidence ${c.category.confidence.toFixed(2)} below ${thresholds.category}`);
  }
  const chosen = categories.find(x => x.id === c.category!.id);
  if (!chosen) return review(`category ${c.category.id} was not offered`);
  if (chosen.isIncome && row.amount < 0) return review(`income category ${chosen.label} on an outflow`);
  return { category: chosen.id, addTags: [...tags, 'auto'], review: false, kind: 'classified' };
}
