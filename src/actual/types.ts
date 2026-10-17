export type CuratorRow = {
  id: string;
  date: string;
  account: string;
  accountName: string;
  /** Signed, minor units. */
  amount: number;
  payee: string | null;
  importedPayee: string | null;
  notes: string | undefined;
  category: string | null;
  transferId: string | null;
};

export type RuleCondition = { field: string; op: string; value: unknown };
export type RuleAction = { field?: string; op: string; value: unknown };

/** An Actual rule, normalized. Rules the curator did not write may have any shape. */
export type CuratorRule = {
  id: string;
  stage: string | null;
  conditionsOp: 'and' | 'or';
  conditions: RuleCondition[];
  actions: RuleAction[];
};

export type RuleOrigin = 'human' | 'promoted' | 'bootstrap';

export type NewCuratorRule = { importedPayee: string; notesContains?: string; categoryId: string };

export type ReportRow = { key: string | null; label: string; amount: number };
