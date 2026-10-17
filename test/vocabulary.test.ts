import { expect, test } from 'vitest';
import { loadVocabulary, parseVocabulary } from '../src/vocabulary.ts';

test('example vocabulary parses and reserves auto/review', () => {
  const v = loadVocabulary('config/curator.example.yaml');
  expect(v.tags.map(t => t.tag)).toContain('kids');
  expect(v.tags.some(t => t.tag === 'auto')).toBe(false);
  expect(v.reserved).toEqual(['auto', 'review']);
  expect(v.exclusive).toContainEqual(['essential', 'discretionary']);
  expect(Object.keys(v.categoryHints)).toContain('Needs / Coffee');
  expect(v.genericPayees).toContain('PAYBOX');
  expect(v.reviewPayees).toEqual(expect.arrayContaining(['PAYBOX', 'BIT']));
  expect(new RegExp(v.memoKeyPatterns[1]).exec('עבור: שכירות 31-022')?.[1]).toBe('שכירות 31-022');
});

test('a tag named auto is rejected', () =>
  expect(() => parseVocabulary('tags:\n  - tag: auto\n    meaning: x\n')).toThrow(/reserved/));

test('an exclusive pair naming an unknown tag is rejected', () =>
  expect(() => parseVocabulary('tags:\n  - tag: a\n    meaning: x\nexclusive: [[a, b]]\n')).toThrow(/unknown tag/));
