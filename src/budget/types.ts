import { z } from 'zod';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');

const categorySchema = z.object({
  categoryId: z.string().min(1),
  kind: z.enum(['fixed', 'variable', 'setaside', 'excluded']),
  priority: z.number().int(),
  /** Shekels per month (fixed, variable). */
  amount: z.number().nonnegative().optional(),
  /** Shekels to reach by `due` (setaside). */
  target: z.number().nonnegative().optional(),
  due: month.optional(),
  protected: z.boolean().optional(),
  note: z.string().optional(),
});

const incomeSourceSchema = z.object({
  name: z.string().min(1),
  payee: z.string().min(1),
  expectedAmount: z.number().nonnegative(),
  expectedDay: z.number().int().min(1).max(31),
  fixedTransfer: z.boolean().optional(),
});

const thresholdsSchema = z.object({
  watchPct: z.number().default(15),
  watchMin: z.number().default(150),
  offPct: z.number().default(10),
  projectFromDay: z.number().int().min(1).max(31).default(7),
});

/** Shekel fields stay shekels in the stored plan (human-edited); the engine converts to minor units. */
export const planSchema = z.object({
  version: z.literal(1),
  categories: z.array(categorySchema),
  incomeSources: z.array(incomeSourceSchema),
  thresholds: thresholdsSchema.default(() => thresholdsSchema.parse({})),
}).superRefine((plan, ctx) => {
  const seen = new Set<string>();
  plan.categories.forEach((c, i) => {
    const issue = (key: string, message: string) => ctx.addIssue({ code: 'custom', path: ['categories', i, key], message });
    if (seen.has(c.categoryId)) issue('categoryId', `duplicate categoryId ${c.categoryId}`);
    seen.add(c.categoryId);
    if (c.kind === 'fixed' || c.kind === 'variable') {
      if (c.amount === undefined) issue('amount', `${c.kind} needs amount`);
    } else if (c.kind === 'setaside') {
      if (c.target === undefined) issue('target', 'setaside needs target');
      if (c.due === undefined) issue('due', 'setaside needs due');
    } else if (c.amount !== undefined || c.target !== undefined || c.due !== undefined) {
      issue('kind', 'excluded takes no amount, target or due');
    }
  });
});

export type Plan = z.output<typeof planSchema>;
export type PlanInput = z.input<typeof planSchema>;
export type PlanCategory = Plan['categories'][number];
export type Kind = PlanCategory['kind'];
export type IncomeSource = Plan['incomeSources'][number];
export type Thresholds = Plan['thresholds'];

/** All amounts in minor units. */
export type CategoryMonth = {
  id: string; label: string; hidden: boolean; isIncome: boolean;
  budgeted: number; spent: number /* <= 0 */; balance: number;
};
export type MonthSnapshot = { month: string; toBudget: number; categories: CategoryMonth[] };
