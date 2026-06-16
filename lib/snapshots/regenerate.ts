/**
 * lib/snapshots/regenerate.ts
 *
 * Regenerates today's WorkspaceSnapshot row for a workspace from current
 * FinancialAccount balances.
 *
 * Root cause this fixes: the Cash History / Banking History / Net Worth
 * charts (lib/data/snapshots.ts: getRecentSnapshots, getPortfolioHistory)
 * read exclusively from WorkspaceSnapshot. Before this file existed, the
 * only code path that ever wrote a WorkspaceSnapshot row was prisma/seed.ts
 * — there was no production writer, so real (non-seeded) workspaces had no
 * rows and the charts rendered blank regardless of how fresh balances or
 * transactions were.
 *
 * Call this after any balance-changing operation. It's wired into
 * lib/plaid/refresh.ts today (manual Refresh button, and — unchanged at
 * call sites — the future cron/webhook that reuse the same function).
 *
 * Idempotent: upserts on the [workspaceId, date] unique constraint, so
 * calling it multiple times in one day updates that day's row instead of
 * creating duplicates.
 *
 * Formula mirrors the field comments on WorkspaceSnapshot in
 * prisma/schema.prisma exactly: totalAssets/netWorth are stocks + crypto +
 * cash + savings (± debt) — manual/real assets (AccountType.other) are
 * intentionally excluded, matching the existing seed data convention.
 */

import { db } from "@/lib/db";
import { getAccounts } from "@/lib/data/accounts";
import { classifyAccounts } from "@/lib/account-classifier";
import { ShareStatus } from "@prisma/client";

function todayUTC(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Recomputes and upserts today's WorkspaceSnapshot row for one workspace
 * from its current FinancialAccount balances (via getAccounts, the same
 * live data source the dashboard's "Banking" card already renders from).
 */
export async function regenerateWorkspaceSnapshot(
  workspaceId: string,
  date: Date = todayUTC(),
): Promise<void> {
  const accounts = await getAccounts({ workspaceId });
  const c = classifyAccounts(accounts);

  const stocks  = c.totalInvestments;
  const crypto  = c.totalDigitalAssets;
  const total   = stocks + crypto;
  const cash    = c.totalChecking;
  const savings = c.totalSavings;
  const debt    = c.totalLiabilities;

  const totalAssets = total + cash + savings;
  const netWorth    = totalAssets - debt;
  const netLiquid   = cash + savings - debt;
  // No "expense buffer" setting exists yet (schema comment: max(cash -
  // expense_buffer, 0)) — until one is added, cashToPlay is plain checking
  // cash rather than an invented buffer amount.
  const cashToPlay  = Math.max(cash, 0);

  await db.workspaceSnapshot.upsert({
    where: { workspaceId_date: { workspaceId, date } },
    create: {
      workspaceId, date,
      stocks, crypto, total, cash, savings, debt,
      netWorth, totalAssets, netLiquid, cashToPlay,
    },
    update: {
      stocks, crypto, total, cash, savings, debt,
      netWorth, totalAssets, netLiquid, cashToPlay,
    },
  });
}

/**
 * Regenerates snapshots for every workspace that shares any of the given
 * FinancialAccount ids via an ACTIVE WorkspaceAccountShare. Used by the
 * Plaid refresh pipeline so refreshing one item keeps every workspace it's
 * shared into up to date — not just a single "current" workspace.
 *
 * @returns the distinct workspace ids that were regenerated.
 */
export async function regenerateSnapshotsForAccounts(
  financialAccountIds: string[],
): Promise<string[]> {
  if (financialAccountIds.length === 0) return [];

  const shares = await db.workspaceAccountShare.findMany({
    where:  { financialAccountId: { in: financialAccountIds }, status: ShareStatus.ACTIVE },
    select: { workspaceId: true },
  });

  const workspaceIds = [...new Set(shares.map((s) => s.workspaceId))];
  await Promise.all(workspaceIds.map((id) => regenerateWorkspaceSnapshot(id)));
  return workspaceIds;
}
