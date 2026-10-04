/**
 * lib/ai/conversation/fixtures/goal-seek-dogfood.ts
 *
 * The short-horizon goal-seek dogfood, as fixture reads: asOf 2026-10-03, a
 * 31 December deadline 89 days away, investments 25,385, cash 20,000, steady pay
 * and spending. No DB, no network. Shared by the deterministic suite
 * (goal-seek-return-representation.test.ts) and the narration check
 * (scripts/ai-baseline/goal-seek-return.check.ts) so both read the same Space.
 */

import type { CashSpineReads } from '../tools';

type Rec = Record<string, unknown>;

export const GOAL_SEEK_FIXTURE = {
  ASOF: '2026-10-03',
  DEC31: '2026-12-31',
  OPENING_INV: 25_385,
} as const;

export async function goalSeekFixtureReads(investments: number = GOAL_SEEK_FIXTURE.OPENING_INV): Promise<CashSpineReads> {
  const { ASOF } = GOAL_SEEK_FIXTURE;
  const { buildMonthlyBreakdown } = await import('@/lib/ai/assemblers/transactions');
  const pays: string[] = [];
  for (let d = Date.parse('2026-05-01T00:00:00Z'); d <= Date.parse('2026-10-02T00:00:00Z'); d += 14 * 86_400_000) {
    pays.push(new Date(d).toISOString().slice(0, 10));
  }
  const incomeRows = pays.map((date, i) => ({ id: `pay${i}`, date, amount: 3_000, merchant: 'ACME PAYROLL',
    merchantDisplayName: 'ACME PAYROLL', accountId: 'chk', flowType: 'INCOME' }));
  const rows: Rec[] = [];
  for (const m of ['2026-06', '2026-07', '2026-08', '2026-09']) {
    rows.push({ id: `${m}a`, date: new Date(`${m}-05T12:00:00Z`), amount: -2_000, currency: 'USD', category: 'Dining', flowType: 'SPENDING' });
    rows.push({ id: `${m}b`, date: new Date(`${m}-15T12:00:00Z`), amount: -2_500, currency: 'USD', category: 'Shopping', flowType: 'SPENDING' });
  }
  for (const r of incomeRows) rows.push({ id: r.id, date: new Date(`${r.date}T12:00:00Z`), amount: r.amount, currency: 'USD', category: 'Income', flowType: 'INCOME' });
  const monthlyBreakdown = buildMonthlyBreakdown(rows as never, [], '2026-06-01', ASOF, null);
  return {
    incomeTransactions: (async () => ({ rows: incomeRows, nextCursor: null })) as never,
    incomeAccountTypes: async (ids) => ids.map((id) => ({ id, type: 'checking' })),
    accounts: async () => ({
      totalLiquid: 20_000, totalInvestments: investments, totalDigitalAssets: 0, totalAssets: 20_000 + investments,
      totalLiabilities: 0, netWorth: 20_000 + investments, redactedCount: 0, totalsUnconverted: false,
      counts: { liquid: 1, investments: 1, digitalAssets: 0, realAssets: 0, liabilities: 0 },
      accounts: [],
    }) as never,
    transactionsSummary: async () => ({ monthlyBreakdown, startDate: '2026-06-01', endDate: ASOF,
      windowDays: 125, transactionCount: rows.length, truncated: false }) as never,
  };
}
