/**
 * lib/data/snapshots.ts
 *
 * Server-only snapshot / history queries.
 * Uses SpaceSnapshot (renamed from DailySnapshot) with spaceId.
 */

import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { Snapshot } from "@/types";

/**
 * Last N days of snapshots — used by the 30-day net-worth chart on the dashboard.
 * Returns newest-last so chart renders left→right in time order.
 */
export async function getRecentSnapshots(days = 30, ctx?: { spaceId: string }): Promise<Snapshot[]> {
  const { spaceId } = ctx ?? (await getSpaceContext());

  const rows = await db.spaceSnapshot.findMany({
    where:   { spaceId },
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
    // D2.x Slice 4 — provenance for the estimated-history badge.
    isEstimated:      r.isEstimated ?? false,
  }));
}

/**
 * Net worth + sparkline trend per space — used by the Spaces landing
 * page's cards. Pure read against the existing SpaceSnapshot model, no
 * schema/business-logic changes. One query covers every space card on
 * the page instead of N round trips.
 *
 * Returns a map keyed by spaceId. Spaces with no snapshot history
 * yet (brand new) resolve to netWorth: 0, trend: [], asOf: null — the card
 * renders its "no history yet" state from that.
 */
export async function getSpaceNetWorthSummaries(
  spaceIds: string[]
): Promise<Record<string, { netWorth: number; trend: number[]; asOf: string | null }>> {
  if (spaceIds.length === 0) return {};

  const rows = await db.spaceSnapshot.findMany({
    where:   { spaceId: { in: spaceIds } },
    orderBy: { date: "asc" },
    select:  { spaceId: true, date: true, netWorth: true },
  });

  const bySpace = new Map<string, { date: Date; netWorth: number }[]>();
  for (const r of rows) {
    const list = bySpace.get(r.spaceId) ?? [];
    list.push({ date: r.date, netWorth: r.netWorth });
    bySpace.set(r.spaceId, list);
  }

  const result: Record<string, { netWorth: number; trend: number[]; asOf: string | null }> = {};
  for (const id of spaceIds) {
    const series = bySpace.get(id) ?? [];
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
  const { spaceId } = await getSpaceContext();

  const rows = await db.spaceSnapshot.findMany({
    where:   { spaceId },
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
