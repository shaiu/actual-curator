import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, TOOL_NAME, answerSchema, parseAnswer, userPrompt } from './llm.ts';
import { type Classification, type Classifier, ClassifierError, type ClassifyOptions, type FetchLike, type RowState } from './types.ts';

export function createAnthropic(cfg: { apiKey: string; model: string; baseUrl?: string },
                                fetchImpl: FetchLike = fetch): Classifier {
  // The curator retries on its own schedule; the SDK must not hide a failing endpoint.
  const client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 0, timeout: 30_000,
    fetch: fetchImpl as unknown as typeof fetch, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  const name = `anthropic:${cfg.model}`;
  return {
    name,
    async classify(state: RowState, opts: ClassifyOptions): Promise<Classification> {
      let msg: Anthropic.Message;
      try {
        msg = await client.messages.create({
          model: cfg.model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          tools: [{ name: TOOL_NAME, description: 'Record the classification of the transaction.', strict: true,
            input_schema: answerSchema(opts) as Anthropic.Tool.InputSchema }],
          tool_choice: { type: 'tool', name: TOOL_NAME },
          messages: [{ role: 'user', content: userPrompt(state, opts) }],
        });
      } catch (e) {
        if (e instanceof Anthropic.APIConnectionError) throw new ClassifierError(`${name}: ${e.message}`, true, { cause: e });
        if (e instanceof Anthropic.APIError) {
          const s = e.status ?? 0;
          throw new ClassifierError(`${name} HTTP ${s}: ${e.message}`, s === 429 || s >= 500, { cause: e });
        }
        throw e;
      }
      if (msg.stop_reason === 'refusal') throw new ClassifierError(`${name} declined the request`, false);
      const tool = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL_NAME);
      if (!tool) throw new ClassifierError(`${name} returned no ${TOOL_NAME} call (stop_reason ${msg.stop_reason})`, false);
      return parseAnswer(tool.input, opts, msg, name);
    },
  };
}
