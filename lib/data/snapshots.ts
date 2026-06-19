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
    cashOnHand:       r.cashOnHand,
  }));
}

/**
 * Net worth + sparkline trend per workspace — used by the Spaces landing
 * page's cards. Pure read against the existing WorkspaceSnapshot model, no
 * schema/business-logic changes. One query covers every workspace card on
 * the page instead of N round trips.
 *
 * Returns a map keyed by workspaceId. Workspaces with no snapshot history
 * yet (brand new) resolve to netWorth: 0, trend: [], asOf: null — the card
 * renders its "no history yet" state from that.
 */
export async function getWorkspaceNetWorthSummaries(
  workspaceIds: string[]
): Promise<Record<string, { netWorth: number; trend: number[]; asOf: string | null }>> {
  if (workspaceIds.length === 0) return {};

  const rows = await db.workspaceSnapshot.findMany({
    where:   { workspaceId: { in: workspaceIds } },
    orderBy: { date: "asc" },
    select:  { workspaceId: true, date: true, netWorth: true },
  });

  const byWorkspace = new Map<string, { date: Date; netWorth: number }[]>();
  for (const r of rows) {
    const list = byWorkspace.get(r.workspaceId) ?? [];
    list.push({ date: r.date, netWorth: r.netWorth });
    byWorkspace.set(r.workspaceId, list);
  }

  const result: Record<string, { netWorth: number; trend: number[]; asOf: string | null }> = {};
  for (const id of workspaceIds) {
    const series = byWorkspace.get(id) ?? [];
    const recent = series.slice(-14); // last ~2 weeks for the card sparkline
    const latest = series[series.length - 1];
    result[id] = {
      netWorth: latest?.netWorth ?? 0,
      trend:    recent.map((s) => s.netWorth),
      asOf:     latest?.date.toISOString() ?? null,
    };
  }
  return result;
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
