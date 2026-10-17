import { expect, test } from 'vitest';
import type { CuratorRow, CuratorRule } from '../../src/actual/types.ts';
import { categoryOf, firstMatch, matchRule, memoKeyPhrase } from '../../src/curator/rules.ts';
import { loadVocabulary } from '../../src/vocabulary.ts';

const row = (over: Partial<CuratorRow> = {}): CuratorRow => ({ id: 't', date: '2026-10-10', account: 'a', accountName: 'Bank',
  amount: -100, payee: 'ארומה', importedPayee: 'ארומה', notes: '', category: null, transferId: null, ...over });
const rule = (conditions: CuratorRule['conditions'], category = 'c1', id = 'r'): CuratorRule =>
  ({ id, stage: null, conditionsOp: 'and', conditions, actions: [{ field: 'category', op: 'set', value: category }] });

test('payee match is case-insensitive and trimmed', () => {
  expect(matchRule(rule([{ field: 'imported_payee', op: 'is', value: ' paybox ' }]), row({ importedPayee: 'PAYBOX' }))).toBe(true);
  expect(matchRule(rule([{ field: 'imported_payee', op: 'is', value: 'PAYBOX' }]), row({ importedPayee: 'PAYBOXX' }))).toBe(false);
});

test('notes contains on a Hebrew phrase', () => {
  const r = rule([{ field: 'imported_payee', op: 'is', value: 'הוראת-קבע' }, { field: 'notes', op: 'contains', value: 'שכר דירה' }]);
  expect(matchRule(r, row({ importedPayee: 'הוראת-קבע', notes: 'לטובת: פלוני. עבור: שכר דירה' }))).toBe(true);
  expect(matchRule(r, row({ importedPayee: 'הוראת-קבע', notes: 'עבור: ארנונה' }))).toBe(false);
});

test('a rule with an amount condition, an or-rule, or no category action is ignored', () => {
  expect(matchRule(rule([{ field: 'imported_payee', op: 'is', value: 'ארומה' }, { field: 'amount', op: 'gt', value: 0 }]), row())).toBe(false);
  expect(matchRule({ ...rule([{ field: 'imported_payee', op: 'is', value: 'ארומה' }]), conditionsOp: 'or' }, row())).toBe(false);
  expect(matchRule({ ...rule([{ field: 'imported_payee', op: 'is', value: 'ארומה' }]), actions: [{ field: 'payee', op: 'set', value: 'p' }] }, row())).toBe(false);
});

test('firstMatch prefers the more specific rule', () => {
  const broad = rule([{ field: 'imported_payee', op: 'is', value: 'PAYBOX' }], 'gifts', 'broad');
  const narrow = rule([{ field: 'imported_payee', op: 'is', value: 'PAYBOX' }, { field: 'notes', op: 'contains', value: 'דנה' }], 'beauty', 'narrow');
  const m = firstMatch([broad, narrow], row({ importedPayee: 'PAYBOX', notes: 'העברה להארנק של דנה' }));
  expect(m?.id).toBe('narrow');
  expect(categoryOf(m!)).toBe('beauty');
  expect(firstMatch([broad], row())).toBeUndefined();
});

test('memoKeyPhrase: the recipient (לטובת) is tried first, as the example config orders it', () => {
  const { memoKeyPatterns } = loadVocabulary('config/curator.example.yaml');
  expect(memoKeyPhrase('לטובת: ישראל ישראלי. עבור: שכירות 31-022.', memoKeyPatterns)).toBe('ישראל ישראלי');
  expect(memoKeyPhrase('עבור: מתנה לחג', memoKeyPatterns)).toBe('מתנה לחג');
  expect(memoKeyPhrase('העברה להארנק של דנה', memoKeyPatterns)).toBeUndefined();
});

test('ruleForRow: payee rule; generic payee adds the memo phrase or the whole memo; nothing to match → undefined', async () => {
  const { ruleForRow } = await import('../../src/curator/rules.ts');
  const v = loadVocabulary('config/curator.example.yaml');
  expect(ruleForRow(row({ importedPayee: ' ארומה ' }), 'c1', v)).toEqual({ importedPayee: 'ארומה', categoryId: 'c1' });
  expect(ruleForRow(row({ importedPayee: 'PAYBOX', notes: 'לטובת: דנה. #auto #review' }), 'c1', v))
    .toEqual({ importedPayee: 'PAYBOX', notesContains: 'דנה', categoryId: 'c1' });
  expect(ruleForRow(row({ importedPayee: 'PAYBOX', notes: 'העברה להארנק של דנה #auto' }), 'c1', v))
    .toEqual({ importedPayee: 'PAYBOX', notesContains: 'העברה להארנק של דנה', categoryId: 'c1' });
  expect(ruleForRow(row({ importedPayee: 'PAYBOX', notes: '#review' }), 'c1', v)).toBeUndefined();
  expect(ruleForRow(row({ importedPayee: null }), 'c1', v)).toBeUndefined();
});
