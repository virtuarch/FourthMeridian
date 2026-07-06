/**
 * lib/data/snapshots.ts
 *
 * Server-only snapshot / history queries.
 * Uses SpaceSnapshot (renamed from DailySnapshot) with spaceId.
 *
 * MC1 Phase 4 Slice 4 (plan D-6) — stamp-aware chart reads: rows are stored
 * in the currency they were stamped with at write time
 * (SpaceSnapshot.reportingCurrency); when the Space's CURRENT reporting
 * currency differs (the Space changed currency mid-history), off-stamp
 * points are converted at each snapshot's OWN date and flagged estimated.
 * HOMOGENEOUS FAST PATH: when every stamp matches the current target — the
 * universal case — the mapping below is byte-identical to the pre-MC1 shape
 * and no rate is ever resolved. Stored rows are never rewritten.
 */

import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { buildSpaceConversionContext } from "@/lib/money/server-context";
import { convertStampedValues } from "@/lib/snapshots/stamp-conversion";
import type { ConversionContext } from "@/lib/money/types";
import { Snapshot } from "@/types";

/**
 * Resolve the stamp-conversion context for a set of snapshot rows.
 * Returns `{ target, ctx: null }` on the homogeneous fast path (every stamp
 * already matches the Space's current reporting currency) — callers then map
 * rows exactly as they always have.
 */
async function resolveStampContext(
  spaceId: string,
  rows: { date: Date; reportingCurrency?: string | null }[],
): Promise<{ target: string; ctx: ConversionContext | null }> {
  const space = await db.space.findUnique({
    where:  { id: spaceId },
    select: { reportingCurrency: true },
  });
  const target = space?.reportingCurrency ?? "USD";

  const offStamp = rows.filter((r) => (r.reportingCurrency ?? "USD") !== target);
  if (offStamp.length === 0) return { target, ctx: null };

  const ctx = await buildSpaceConversionContext(
    { reportingCurrency: target },
    {
      currencies: [...new Set(offStamp.map((r) => r.reportingCurrency ?? null))],
      dates:      [...new Set(offStamp.map((r) => r.date.toISOString().slice(0, 10)))],
    },
  );
  return { target, ctx };
}

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

  const { target, ctx: stampCtx } = await resolveStampContext(spaceId, rows);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => {
    const stamp = r.reportingCurrency ?? "USD";
    const raw = {
      netWorth:         r.netWorth,
      totalAssets:      r.totalAssets,
      totalDebt:        r.debt,
      totalCash:        r.cash,
      totalSavings:     r.savings,
      totalInvestments: r.stocks,
      totalCrypto:      r.crypto,
      cashOnHand:       r.cashOnHand,
    };

    // Homogeneous fast path (stampCtx null) or on-stamp row → pre-MC1 mapping.
    if (!stampCtx || stamp === target) {
      return {
        date: r.date.toISOString().split("T")[0],
        ...raw,
        // D2.x Slice 4 — provenance for the estimated-history badge.
        isEstimated: r.isEstimated ?? false,
      };
    }

    // Off-stamp: convert every total at THIS row's own date (historical FX);
    // the display-estimation flag joins the existing badge mechanism.
    const converted = convertStampedValues(raw, stamp, r.date.toISOString().slice(0, 10), stampCtx);
    return {
      date: r.date.toISOString().split("T")[0],
      ...converted.values,
      isEstimated: (r.isEstimated ?? false) || converted.estimated,
    };
  });
}

/**
 * Net worth + sparkline trend per space — used by the Spaces landing
 * page's cards. Pure read against the existing SpaceSnapshot model, no
 * schema/business-logic changes. One query covers every space card on
 * the page instead of N round trips.
 *
 * MC1 note: deliberately NOT stamp-aware — the whole SpacesClient card
 * surface (values, labels, and these sparklines) is deferred together
 * (recorded at the Phase 4 closeout); mixing a converted sparkline with
 * unconverted labels would be worse than the status quo.
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
 * Returns all rows oldest-first. Stamp-aware per the module header; the
 * optional per-point `estimated` flag is present only on off-stamp points
 * (homogeneous histories emit exactly the pre-MC1 objects).
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
    /** MC1 P4 Slice 4 — off-stamp point converted at its own date (display estimation). */
    estimated?: boolean;
  }[]
> {
  const { spaceId } = await getSpaceContext();

  const rows = await db.spaceSnapshot.findMany({
    where:   { spaceId },
    orderBy: { date: "asc" },
  });

  const { target, ctx: stampCtx } = await resolveStampContext(spaceId, rows);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => {
    const stamp = r.reportingCurrency ?? "USD";
    const raw = {
      stocks:    r.stocks,
      crypto:    r.crypto,
      total:     r.total,
      cash:      r.cash,
      savings:   r.savings,
      debt:      r.debt,
      netLiquid: r.netLiquid,
    };

    if (!stampCtx || stamp === target) {
      return { date: r.date.toISOString().split("T")[0], ...raw };
    }

    const converted = convertStampedValues(raw, stamp, r.date.toISOString().slice(0, 10), stampCtx);
    return { date: r.date.toISOString().split("T")[0], ...converted.values, estimated: converted.estimated };
  });
}
