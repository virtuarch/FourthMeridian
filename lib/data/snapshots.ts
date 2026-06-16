/**
 * lib/data/snapshots.ts
 *
 * Server-only snapshot / history queries.
 * Uses WorkspaceSnapshot (renamed from DailySnapshot) with workspaceId.
 */

import { db } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { Snapshot } from "@/types";

/**
 * Last N days of snapshots — used by the 30-day net-worth chart on the dashboard.
 * Returns newest-last so chart renders left→right in time order.
 */
export async function getRecentSnapshots(days = 30, ctx?: { workspaceId: string }): Promise<Snapshot[]> {
  const { workspaceId } = ctx ?? (await getWorkspaceContext());

  const rows = await db.workspaceSnapshot.findMany({
    where:   { workspaceId },
    orderBy: { date: "asc" },
    take:    -days, // last N rows
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => ({
    date:             r.date.toISOString().split("T")[0],
    netWorth:         r.netWorth,
    totalAssets:      r.totalAssets,
    totalDebt:        r.debt,
    totalCash:        r.cash,
    totalSavings:     r.savings,
    totalInvestments: r.stocks,
    totalCrypto:      r.crypto,
    cashToPlay:       r.cashToPlay,
  }));
}

/**
 * Full portfolio history — used by the area charts on Banking and Investments.
 * Returns all rows oldest-first.
 */
export async function getPortfolioHistory(): Promise<
  {
    date:      string;
    stocks:    number;
    crypto:    number;
    total:     number;
    cash:      number;
    savings:   number;
    debt:      number;
    netLiquid: number;
  }[]
> {
  const { workspaceId } = await getWorkspaceContext();

  const rows = await db.workspaceSnapshot.findMany({
    where:   { workspaceId },
    orderBy: { date: "asc" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => ({
    date:      r.date.toISOString().split("T")[0],
    stocks:    r.stocks,
    crypto:    r.crypto,
    total:     r.total,
    cash:      r.cash,
    savings:   r.savings,
    debt:      r.debt,
    netLiquid: r.netLiquid,
  }));
}
