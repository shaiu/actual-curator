// Builds a scratch Actual budget on disk (no server) for store integration tests.
import * as api from '@actual-app/api';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

export type Fixture = { dataDir: string; ids: Record<string, string> };

export async function buildBudget(): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), 'curator-test-'));
  const ids: Record<string, string> = {};
  await api.init({ dataDir });
  await api.runImport('curator-test', async () => {
    ids.bank = await api.createAccount({ name: 'Bank', offbudget: false } as never, 0);
    ids.card = await api.createAccount({ name: 'Card', offbudget: false } as never, 0);
    ids.invest = await api.createAccount({ name: 'Invest', offbudget: true } as never, 0);
    ids.needs = await api.createCategoryGroup({ name: 'Needs' } as never);
    ids.coffee = await api.createCategory({ name: 'Coffee', group_id: ids.needs } as never);
    ids.groceries = await api.createCategory({ name: 'Groceries', group_id: ids.needs } as never);
    ids.old = await api.createCategory({ name: 'Old stuff', group_id: ids.needs, hidden: true } as never);
    const income = (await api.getCategoryGroups()).find(g => g.is_income)!;
    ids.salary = await api.createCategory({ name: 'Salary', group_id: income.id } as never);

    const payees = await api.getPayees();
    const toCard = payees.find(p => p.transfer_acct === ids.card)!.id;
    await api.importTransactions(ids.bank, [
      { date: daysAgo(5), amount: -2550, payee_name: 'ארומה', notes: 'cappuccino', imported_id: 'a1' },
      { date: daysAgo(4), amount: -1200, payee_name: 'ארומה', notes: 'latte #kids', imported_id: 'a2', category: ids.coffee },
      { date: daysAgo(3), amount: -1800, payee_name: 'ארומה', notes: '', imported_id: 'a3', category: ids.groceries },
      { date: daysAgo(2), amount: 500, payee_name: 'ארומה', notes: 'refund #kids', imported_id: 'a4', category: ids.coffee },
      { date: daysAgo(90), amount: -999, payee_name: 'ישן', notes: '', imported_id: 'old1' },
      { date: daysAgo(6), amount: -10000, payee: toCard, notes: 'card payment', imported_id: 'tr1' },
      { date: daysAgo(7), amount: 1500000, payee_name: 'Employer', notes: 'salary', imported_id: 's1', category: ids.salary },
      { date: daysAgo(8), amount: -3000, payee_name: 'Split shop', notes: 'split', imported_id: 'sp1',
        subtransactions: [{ amount: -1000, category: ids.coffee }, { amount: -2000, category: ids.groceries }] },
    ] as never);
    await api.importTransactions(ids.invest, [
      { date: daysAgo(5), amount: -5000, payee_name: 'Broker', notes: '', imported_id: 'i1' },
    ] as never);
  });
  await api.shutdown();
  return { dataDir, ids };
}
