import { CATEGORY_KEY, buildQuestions, jevState, tagKey } from './questions.ts';
import { type Classification, type Classifier, ClassifierError, type ClassifyOptions, type FetchLike, type RowState } from './types.ts';

const DEFAULT_BASE = 'https://openrouter.ai';

type JevAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function createJev(cfg: { apiKey: string; model: string; baseUrl?: string },
                          fetchImpl: FetchLike = fetch): Classifier {
  const url = `${(cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')}/api/alpha/decisions`;
  return {
    name: `openrouter-jev:${cfg.model}`,
    async classify(state: RowState, opts: ClassifyOptions): Promise<Classification> {
      const questions = buildQuestions(opts);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, state: jevState(state), questions }),
        });
      } catch (e) {
        throw new ClassifierError(`Jev request failed: ${(e as Error).message}`, true, { cause: e });
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300);
        throw new ClassifierError(`Jev HTTP ${res.status}: ${text}`, res.status === 429 || res.status >= 500);
      }
      let raw: unknown;
      try { raw = await res.json(); } catch (e) {
        throw new ClassifierError('Jev returned a body that is not JSON', false, { cause: e });
      }
      return parse(raw, opts);
    },
  };
}

function parse(raw: unknown, opts: ClassifyOptions): Classification {
  const malformed = (why: string) => new ClassifierError(`Jev returned a malformed body: ${why}`, false);
  const answers = (raw as { answers?: Record<string, JevAnswer> } | null)?.answers;
  if (!answers || typeof answers !== 'object') throw malformed('no answers');
  const out: Classification = { tags: {}, raw };
  const cost = (raw as { usage?: { cost?: unknown } }).usage?.cost;
  if (isNum(cost)) out.cost = cost;

  if (opts.categories?.length) {
    const a = answers[CATEGORY_KEY];
    if (a?.type !== 'choice' || !isNum(a.confidence) || typeof a.probabilities !== 'object') throw malformed('category');
    if (!opts.categories.some(c => c.id === a.choice)) throw malformed(`category "${a.choice}" was not offered`);
    out.category = { id: a.choice, confidence: a.confidence, probabilities: a.probabilities };
  }
  for (const t of opts.tags) {
    const a = answers[tagKey(t.tag)];
    if (a?.type !== 'noul' || !isNum(a.noul)) throw malformed(`tag ${t.tag}`);
    out.tags[t.tag] = a.noul;
  }
  return out;
}
