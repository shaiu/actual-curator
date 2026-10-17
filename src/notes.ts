// Curator tags live as a trailing run of ` #tag` tokens after the bank memo.
// Only tokens from the known set count, and only at the very end: a bank's own
// `#1234` reference, or a known word earlier in the memo, is memo text.

const TRAILING_TAG = /(?:^|\s+)#([\p{L}\p{N}_-]+)\s*$/u;

function split(notes: string, isTag: (word: string) => boolean): { memo: string; tags: string[] } {
  let memo = notes;
  const tags: string[] = [];
  for (let m = TRAILING_TAG.exec(memo); m && isTag(m[1]); m = TRAILING_TAG.exec(memo)) {
    tags.unshift(m[1]);
    memo = memo.slice(0, m.index);
  }
  return { memo: tags.length ? memo : notes, tags };
}

export function parseTags(notes: string | undefined, known: Set<string>): { memo: string; tags: string[] } {
  return split(notes ?? '', w => known.has(w));
}

export function withTags(notes: string | undefined, add: string[], remove: string[], known: Set<string>): string {
  const { memo, tags } = parseTags(notes, known);
  const drop = new Set(remove);
  const want = new Set([...tags, ...add.filter(t => known.has(t))].filter(t => !drop.has(t)));
  const ordered = [...known].filter(t => want.has(t));
  if (ordered.length === tags.length && ordered.every((t, i) => t === tags[i])) return notes ?? '';
  const suffix = ordered.map(t => `#${t}`).join(' ');
  const base = memo.trimEnd();
  if (!suffix) return base;
  return base ? `${base} ${suffix}` : suffix;
}

export function hasTag(notes: string | undefined, tag: string): boolean {
  return split(notes ?? '', () => true).tags.includes(tag);
}
