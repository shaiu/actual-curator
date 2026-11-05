export type CuratorRow = {
  id: string;
  date: string;
  account: string;
  accountName: string;
  /** Signed, minor units. */
  amount: number;
  payee: string | null;
  /** Actual's payee id: Actual's own rules match on it. */
  payeeId?: string | null;
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

/** One category in one budget month. Amounts are signed minor units: `spent` is negative for money out. */
export type BudgetCategory = {
  id: string;
  name: string;
  label: string;
  isIncome: boolean;
  /** The category or its group is hidden. */
  hidden: boolean;
  budgeted: number;
  spent: number;
  balance: number;
  carryover: boolean;
};

export type BudgetMonth = {
  month: string;
  toBudget: number;
  /** Positive: the sum of what was budgeted. */
  totalBudgeted: number;
  totalSpent: number;
  totalBalance: number;
  totalIncome: number;
  /** What is held for next month. */
  forNextMonth: number;
  groups: { id: string; name: string; isIncome: boolean; hidden: boolean; categories: BudgetCategory[] }[];
};
