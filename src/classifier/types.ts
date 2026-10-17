import type { TagDef } from '../vocabulary.ts';

export type RowState = {
  payee: string;
  memo: string;
  /** Signed, in minor units as Actual stores it. */
  amount: number;
  currency: 'ILS' | string;
  account: string;
  weekday: string;
  month: string;
  priorCategories: string[];
};

export type CategoryOption = { id: string; label: string /* "Group / Name" */; hint?: string; isIncome: boolean };

export type Classification = {
  category?: { id: string; confidence: number; probabilities: Record<string, number> };
  tags: Record<string, number>;
  /** Provider-reported cost in USD, when the provider returns one. */
  cost?: number;
  raw: unknown;
};

export type ClassifyOptions = { categories?: CategoryOption[]; tags: TagDef[] };

export interface Classifier {
  classify(state: RowState, opts: ClassifyOptions): Promise<Classification>;
  name: string;
}

export class ClassifierError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ClassifierError';
    this.retryable = retryable;
  }
}

/** The slice of `fetch` the providers use; real `fetch` satisfies it. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
