import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export const RESERVED_TAGS = ['auto', 'review'] as const;

const TAG_NAME = /^[\p{L}\p{N}_-]+$/u;

const schema = z.object({
  tags: z.array(z.object({
    tag: z.string().regex(TAG_NAME, 'a tag is one word without "#"'),
    meaning: z.string().min(1),
    threshold: z.number().min(0).max(1).optional(),
  })).min(1),
  exclusive: z.array(z.tuple([z.string(), z.string()])).default([]),
  categoryHints: z.record(z.string(), z.string()).default({}),
  genericPayees: z.array(z.string()).default([]),
  reviewPayees: z.array(z.string()).default([]),
  memoKeyPatterns: z.array(z.string()).default([]),
});

export type TagDef = { tag: string; meaning: string; threshold?: number };

export type Vocabulary = {
  tags: TagDef[];
  exclusive: [string, string][];
  categoryHints: Record<string, string>;
  genericPayees: string[];
  reviewPayees: string[];
  memoKeyPatterns: string[];
  reserved: string[];
};

export function parseVocabulary(text: string): Vocabulary {
  const v = schema.parse(parse(text));
  const names = new Set<string>();
  for (const { tag } of v.tags) {
    if ((RESERVED_TAGS as readonly string[]).includes(tag)) {
      throw new Error(`Tag "${tag}" is reserved for the curator; remove it from the vocabulary`);
    }
    if (names.has(tag)) throw new Error(`Tag "${tag}" is listed twice`);
    names.add(tag);
  }
  for (const pair of v.exclusive) {
    for (const tag of pair) if (!names.has(tag)) throw new Error(`exclusive names unknown tag "${tag}"`);
  }
  for (const p of v.memoKeyPatterns) {
    try { new RegExp(p, 'u'); } catch (e) { throw new Error(`memoKeyPatterns: invalid regex ${p}: ${(e as Error).message}`); }
  }
  return { ...v, reserved: [...RESERVED_TAGS] };
}

export function loadVocabulary(path: string): Vocabulary {
  return parseVocabulary(readFileSync(path, 'utf8'));
}
