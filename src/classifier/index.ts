import type { ClassifierConfig } from '../config.ts';
import { createAnthropic } from './anthropic.ts';
import { createJev } from './jev.ts';
import { createOpenAiCompatible } from './openai.ts';
import type { Classifier, FetchLike } from './types.ts';

export { buildQuestions } from './questions.ts';
export * from './types.ts';

export function createClassifier(cfg: ClassifierConfig, fetchImpl: FetchLike = fetch): Classifier {
  switch (cfg.provider) {
    case 'openrouter-jev':
      return createJev(cfg, fetchImpl);
    case 'anthropic':
      return createAnthropic(cfg, fetchImpl);
    case 'openai-compatible':
      return createOpenAiCompatible(cfg, fetchImpl);
  }
}
