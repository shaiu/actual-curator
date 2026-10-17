import { expect, test } from 'vitest';
import { hasTag, parseTags, withTags } from '../src/notes.ts';

const known = new Set(['kids', 'recurring', 'auto', 'review']);

test('appends after memo and preserves it', () =>
  expect(withTags('עבור: שכירות 31-022', ['recurring', 'auto'], [], known)).toBe('עבור: שכירות 31-022 #recurring #auto'));

test('removes only the named tag', () =>
  expect(withTags('memo #kids #auto #review', [], ['review'], known)).toBe('memo #kids #auto'));

test('a bank #1234 reference is not a curator tag and survives', () => { // Review Focus 1
  expect(parseTags('ref #1234 #kids', known)).toEqual({ memo: 'ref #1234', tags: ['kids'] });
  expect(withTags('ref #1234', ['auto'], [], known)).toBe('ref #1234 #auto');
});

test('a known #word inside the memo, before other text, stays memo', () =>
  expect(parseTags('#kids party at school', known)).toEqual({ memo: '#kids party at school', tags: [] }));

test('idempotent add', () => expect(withTags('m #auto', ['auto'], [], known)).toBe('m #auto'));

test('undefined notes', () => expect(withTags(undefined, ['auto'], [], known)).toBe('#auto'));

test('removing the last tag leaves the memo byte for byte', () =>
  expect(withTags('  spaced  memo #review', [], ['review'], known)).toBe('  spaced  memo'));

test('tags keep the order of the known set', () =>
  expect(withTags('m #auto', ['kids'], [], known)).toBe('m #kids #auto'));

test('hasTag sees only trailing curator tags', () => {
  expect(hasTag('m #kids #auto', 'auto')).toBe(true);
  expect(hasTag('m #autos', 'auto')).toBe(false);
  expect(hasTag(undefined, 'auto')).toBe(false);
});
