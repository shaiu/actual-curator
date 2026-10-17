import { SYSTEM_PROMPT, TOOL_NAME, answerSchema, parseAnswer, userPrompt } from './llm.ts';
import { type Classification, type Classifier, ClassifierError, type ClassifyOptions, type FetchLike, type RowState } from './types.ts';

// Any OpenAI-compatible chat completions endpoint: OpenAI, OpenRouter, Groq, Ollama.
export function createOpenAiCompatible(cfg: { apiKey: string; model: string; baseUrl?: string },
                                       fetchImpl: FetchLike = fetch): Classifier {
  if (!cfg.baseUrl) throw new Error('openai-compatible classifier needs a base URL');
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const name = `openai-compatible:${cfg.model}`;
  return {
    name,
    async classify(state: RowState, opts: ClassifyOptions): Promise<Classification> {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      let res: Response;
      try {
        res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt(state, opts) }],
          response_format: { type: 'json_schema', json_schema: { name: TOOL_NAME, strict: true, schema: answerSchema(opts) } },
        }) });
      } catch (e) {
        throw new ClassifierError(`${name} request failed: ${(e as Error).message}`, true, { cause: e });
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300);
        throw new ClassifierError(`${name} HTTP ${res.status}: ${text}`, res.status === 429 || res.status >= 500);
      }
      let raw: { choices?: { message?: { content?: unknown } }[]; usage?: { cost?: unknown } };
      try { raw = await res.json(); } catch (e) {
        throw new ClassifierError(`${name} returned a body that is not JSON`, false, { cause: e });
      }
      const content = raw.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new ClassifierError(`${name} returned no message content`, false);
      let answer: unknown;
      try { answer = JSON.parse(content); } catch (e) {
        throw new ClassifierError(`${name} returned content that is not JSON`, false, { cause: e });
      }
      const out = parseAnswer(answer, opts, raw, name);
      if (typeof raw.usage?.cost === 'number') out.cost = raw.usage.cost;
      return out;
    },
  };
}
