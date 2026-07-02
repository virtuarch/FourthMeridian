/**
 * lib/snapshots/regenerate.ts
 *
 * Regenerates today's SpaceSnapshot row for a space from current
 * FinancialAccount balances.
 *
 * Root cause this fixes: the Cash History / Banking History / Net Worth
 * charts (lib/data/snapshots.ts: getRecentSnapshots, getPortfolioHistory)
 * read exclusively from SpaceSnapshot. Before this file existed, the
 * only code path that ever wrote a SpaceSnapshot row was prisma/seed.ts
 * — there was no production writer, so real (non-seeded) spaces had no
 * rows and the charts rendered blank regardless of how fresh balances or
 * transactions were.
 *
 * Call this after any balance-changing operation. It's wired into
 * lib/plaid/refresh.ts today (manual Refresh button, and — unchanged at
 * call sites — the future cron/webhook that reuse the same function).
 *
 * Idempotent: upserts on the [spaceId, date] unique constraint, so
 * calling it multiple times in one day updates that day's row instead of
 * creating duplicates.
 *
 * totalAssets/netWorth = stocks + crypto + cash + savings + realAssets
 * (± debt). realAssets (AccountType.other — manual/real assets: property,
 * vehicles, equipment) is included here even though the SpaceSnapshot
 * schema field comments predate this and only mention stocks/crypto/cash/
 * savings. Without it, this formula silently diverged from
 * classifyAccounts() (lib/account-classifier.ts), the single source of
 * truth every live dashboard total uses, so a Space's /dashboard/spaces
 * card could never reflect manual assets no matter how often this
 * function ran. netLiquid intentionally still excludes realAssets —
 * manual assets aren't liquid.
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
 * Recomputes and upserts today's SpaceSnapshot row for one space
 * from its current FinancialAccount balances (via getAccounts, the same
 * live data source the dashboard's "Banking" card already renders from).
 */
export async function regenerateSpaceSnapshot(
  spaceId: string,
  date: Date = todayUTC(),
): Promise<void> {
  const accounts = await getAccounts({ spaceId });
  const c = classifyAccounts(accounts);

  const stocks     = c.totalInvestments;
  const crypto     = c.totalDigitalAssets;
  const total      = stocks + crypto;
  const cash       = c.totalChecking;
  const savings    = c.totalSavings;
  const debt       = c.totalLiabilities;
  const realAssets = c.totalRealAssets;

  const totalAssets = total + cash + savings + realAssets;
  const netWorth    = totalAssets - debt;
  const netLiquid   = cash + savings - debt;
  // No "expense buffer" setting exists yet (schema comment: max(cash -
  // expense_buffer, 0)) — until one is added, cashOnHand is plain checking
  // cash rather than an invented buffer amount.
  const cashOnHand  = Math.max(cash, 0);

  await db.spaceSnapshot.upsert({
    where: { spaceId_date: { spaceId, date } },
    create: {
      spaceId, date,
      stocks, crypto, total, cash, savings, debt,
      netWorth, totalAssets, netLiquid, cashOnHand,
    },
    update: {
      stocks, crypto, total, cash, savings, debt,
      netWorth, totalAssets, netLiquid, cashOnHand,
    },
  });
}

/**
 * Regenerates snapshots for every space that links any of the given
 * FinancialAccount ids via an ACTIVE SpaceAccountLink. Used by the
 * Plaid refresh pipeline so refreshing one item keeps every space it's
 * shared into up to date — not just a single "current" space.
 *
 * D3 Step 4A read cutover: this used to query WorkspaceAccountShare.
 * SpaceAccountLink is kept in sync with it by the D3 Step 3 dual-write
 * (lib/accounts/space-account-link.ts) at every mutation site, so this
 * read returns the same space ids either way. WorkspaceAccountShare
 * remains the write system of record — see
 * docs/initiatives/d3/D3_STEP4_READ_CUTOVER_REVIEW.md for the cutover plan and rollback.
 *
 * @returns the distinct space ids that were regenerated.
 */
export async function regenerateSnapshotsForAccounts(
  financialAccountIds: string[],
): Promise<string[]> {
  if (financialAccountIds.length === 0) return [];

  const links = await db.spaceAccountLink.findMany({
    where:  { financialAccountId: { in: financialAccountIds }, status: ShareStatus.ACTIVE },
    select: { spaceId: true },
  });

  const spaceIds = [...new Set(links.map((l) => l.spaceId))];
  await Promise.all(spaceIds.map((id) => regenerateSpaceSnapshot(id)));
  return spaceIds;
}
