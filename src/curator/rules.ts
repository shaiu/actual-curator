// The subset of Actual's rule language the curator evaluates itself, for backlog rows that landed
// before a rule existed. Anything else is left to Actual, which runs every rule at import.
import type { CuratorRow, CuratorRule, NewCuratorRule } from '../actual/types.ts';
import { parseTags } from '../notes.ts';
import type { Vocabulary } from '../vocabulary.ts';

const norm = (v: unknown) => String(v ?? '').trim().toLocaleLowerCase();

export function categoryOf(rule: CuratorRule): string | undefined {
  const sets = rule.actions.filter(a => a.op === 'set' && a.field === 'category');
  return sets.length === 1 && typeof sets[0].value === 'string' ? sets[0].value : undefined;
}

/** Whether the curator can evaluate this rule itself (Actual runs every rule at import regardless). */
export function isSupported(rule: CuratorRule): boolean {
  return rule.conditionsOp === 'and' && rule.conditions.length > 0 && categoryOf(rule) !== undefined
    && rule.conditions.every(c => (c.field === 'imported_payee' && c.op === 'is') || (c.field === 'notes' && c.op === 'contains'));
}

export function matchRule(rule: CuratorRule, row: CuratorRow): boolean {
  if (!isSupported(rule)) return false;
  return rule.conditions.every(c => c.field === 'imported_payee'
    ? norm(row.importedPayee) === norm(c.value)
    : norm(row.notes).includes(norm(c.value)));
}

/**
 * Rules that point this row at a category outside `visible` (a hidden one). Unlike matchRule this also reads
 * Actual's own payee-id conditions, the shape YNAB-era rules have, since those are the ones Actual runs at import.
 */
export function staleRulesFor(rules: CuratorRule[], row: CuratorRow, visible: Set<string>): CuratorRule[] {
  return rules.filter(r => {
    const cat = categoryOf(r);
    if (r.conditionsOp !== 'and' || !r.conditions.length || cat === undefined || visible.has(cat)) return false;
    return r.conditions.every(c => {
      if (c.field === 'payee' && c.op === 'is') return Boolean(row.payeeId) && c.value === row.payeeId;
      if (c.field === 'imported_payee' && c.op === 'is') return norm(row.importedPayee) === norm(c.value);
      if (c.field === 'notes' && c.op === 'contains') return norm(row.notes).includes(norm(c.value));
      return false;
    });
  });
}

/** The most specific matching rule (most conditions), so a payee + memo rule beats a bare payee rule. */
export function firstMatch(rules: CuratorRule[], row: CuratorRow): CuratorRule | undefined {
  return [...rules].sort((a, b) => b.conditions.length - a.conditions.length).find(r => matchRule(r, row));
}

/** First pattern (in config order) that matches; its first capture group, trimmed. */
export function memoKeyPhrase(memo: string, patterns: string[]): string | undefined {
  for (const p of patterns) {
    const phrase = new RegExp(p, 'u').exec(memo)?.[1]?.trim();
    if (phrase) return phrase;
  }
  return undefined;
}

/**
 * The rule a human answer (or a promotion) creates for this row: the payee, plus, for a generic
 * payee, the memo key phrase or else the whole memo. Undefined when there is nothing to match on.
 */
export function ruleForRow(row: CuratorRow, categoryId: string, vocab: Vocabulary): NewCuratorRule | undefined {
  const importedPayee = row.importedPayee?.trim();
  if (!importedPayee) return undefined;
  if (!vocab.genericPayees.some(g => norm(g) === norm(importedPayee))) return { importedPayee, categoryId };
  const known = new Set([...vocab.tags.map(t => t.tag), ...vocab.reserved]);
  const memo = parseTags(row.notes, known).memo.trim();
  const notesContains = memoKeyPhrase(memo, vocab.memoKeyPatterns) ?? memo;
  return notesContains ? { importedPayee, notesContains, categoryId } : undefined;
}
