import type { CategoryOption } from '../classifier/types.ts';

export type Exclusions = { ids: string[]; labels: string[] };

/**
 * Resolves the configured report exclusions (category labels or ids) to ids, on every call, so a renamed or
 * new category is picked up without a restart. A name matching no category is warned about once and skipped.
 */
export function exclusionResolver(store: { categories(o?: { includeHidden?: boolean }): Promise<CategoryOption[]> },
  names: string[] = []): () => Promise<Exclusions> {
  const warned = new Set<string>();
  return async () => {
    if (!names.length) return { ids: [], labels: [] };
    const cats = await store.categories({ includeHidden: true });
    const out: Exclusions = { ids: [], labels: [] };
    for (const n of names) {
      const c = cats.find(x => x.id === n || x.label === n);
      if (c) { out.ids.push(c.id); out.labels.push(c.label); }
      else if (!warned.has(n)) { warned.add(n); console.warn(`REPORT_EXCLUDE_CATEGORIES: no category "${n}"; it is not excluded`); }
    }
    return out;
  };
}
