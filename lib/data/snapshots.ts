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
import { buildSpaceConversionContext, resolveEffectiveSpaceConversion } from "@/lib/money/server-context";
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
  const requested = space?.reportingCurrency ?? "USD";

  const offStamp = rows.filter((r) => (r.reportingCurrency ?? "USD") !== requested);
  if (offStamp.length === 0) return { target: requested, ctx: null };

  // V25-CLOSE-3A — resolve the EFFECTIVE display currency. When the requested
  // currency cannot be satisfied for these off-stamp rows (e.g. the Space was
  // switched to a currency the archive has no rates for), the display reverts to
  // USD. History then reads in USD: rows stamped USD become on-stamp (fast path,
  // no false fxMiss), so the Wealth/Debt/Liquidity trends render honestly rather
  // than collapsing to a fabricated "No history yet". The stored currency is not
  // touched — this is read-time only.
  const resolved = await resolveEffectiveSpaceConversion(
    { reportingCurrency: requested },
    {
      currencies: [...new Set(offStamp.map((r) => r.reportingCurrency ?? null))],
      dates:      [...new Set(offStamp.map((r) => r.date.toISOString().slice(0, 10)))],
    },
  );
  const target = resolved.effective;

  // Re-derive off-stamp against the EFFECTIVE target (under USD, USD-stamped rows
  // are on-stamp). If nothing is off-stamp now, take the fast path.
  const offStampEff = rows.filter((r) => (r.reportingCurrency ?? "USD") !== target);
  if (offStampEff.length === 0) return { target, ctx: null };
  return { target, ctx: resolved.ctx };
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
      // MC1 QA Q4b — additive: only a genuine rate MISS (native pass-through)
      // sets this; resolving off-stamp rows omit it, so homogeneous histories
      // stay byte-identical. The hero series drops these points downstream.
      ...(converted.missed ? { fxMiss: true as const } : {}),
    };
  });
}

/**
 * Net worth + sparkline trend per space — used by the Spaces landing
 * page's cards. Pure read against the existing SpaceSnapshot model, no
 * schema/business-logic changes. One query covers every space card on
 * the page instead of N round trips.
 *
 * MC1 QA Q5 — each card labels in ITS OWN Space.reportingCurrency (never the
 * active Space's currency), returned here as `currency`.
 *
 * MC1 QA Q5b — the card is stamp-aware WITH conversion (fixing Q5's regression,
 * where a hard filter to current-currency rows blanked a Space recently
 * switched to a currency with zero snapshots stamped in it). Each off-stamp
 * point converts read-time at its OWN date via the Space's conversion context;
 * only genuinely unconvertible points (a rate miss) are omitted — never the
 * whole card — so the series stays single-unit without ever blanking. The
 * homogeneous fast path is preserved: a Space whose rows are all stamped in its
 * current currency (every all-USD Space) builds no context and maps values
 * byte-identically to the pre-MC1 shape.
 *
 * Returns a map keyed by spaceId. Spaces with no convertible history yet
 * resolve to netWorth: 0, trend: [], asOf: null — the card renders its
 * "no history yet" state from that.
 */
export async function getSpaceNetWorthSummaries(
  spaceIds: string[]
): Promise<Record<string, { netWorth: number; currency: string; trend: number[]; asOf: string | null }>> {
  if (spaceIds.length === 0) return {};

  // Each Space's own reporting currency (the card label source). Selected here
  // so no card ever borrows the active Space's currency.
  const spaces = await db.space.findMany({
    where:  { id: { in: spaceIds } },
    select: { id: true, reportingCurrency: true },
  });
  const currencyById = new Map(spaces.map((s) => [s.id, s.reportingCurrency ?? "USD"]));

  const rows = await db.spaceSnapshot.findMany({
    where:   { spaceId: { in: spaceIds } },
    orderBy: { date: "asc" },
    select:  { spaceId: true, date: true, netWorth: true, reportingCurrency: true },
  });

  const bySpace = new Map<string, { date: Date; netWorth: number; stamp: string }[]>();
  for (const r of rows) {
    const list = bySpace.get(r.spaceId) ?? [];
    list.push({ date: r.date, netWorth: r.netWorth, stamp: r.reportingCurrency ?? "USD" });
    bySpace.set(r.spaceId, list);
  }

  const result: Record<string, { netWorth: number; currency: string; trend: number[]; asOf: string | null }> = {};
  for (const id of spaceIds) {
    const currency = currencyById.get(id) ?? "USD";
    const series   = bySpace.get(id) ?? [];

    // Build a conversion context only when the Space has off-stamp rows; a
    // homogeneous Space (all rows already in `currency`) keeps the fast path
    // and never touches the FX archive.
    const offStamp = series.filter((s) => s.stamp !== currency);
    const stampCtx = offStamp.length > 0
      ? await buildSpaceConversionContext(
          { reportingCurrency: currency },
          {
            currencies: [...new Set(offStamp.map((s) => s.stamp))],
            dates:      [...new Set(offStamp.map((s) => s.date.toISOString().slice(0, 10)))],
          },
        )
      : null;

    // Convert each point at its own date; keep on-stamp rows as-is. Omit ONLY
    // the points whose rate missed (they would be native-magnitude, mixing
    // units) — every convertible point stays, so the card never blanks merely
    // because its history predates the currency switch.
    const points: { date: Date; value: number }[] = [];
    for (const s of series) {
      if (!stampCtx || s.stamp === currency) {
        points.push({ date: s.date, value: s.netWorth });
        continue;
      }
      const conv = convertStampedValues({ v: s.netWorth }, s.stamp, s.date.toISOString().slice(0, 10), stampCtx);
      if (conv.missed) continue; // unconvertible — drop this point only
      points.push({ date: s.date, value: conv.values.v });
    }

    const recent = points.slice(-14); // last ~2 weeks for the card sparkline
    const latest = points[points.length - 1];
    result[id] = {
      netWorth: latest?.value ?? 0,
      currency,
      trend:    recent.map((p) => p.value),
      asOf:     latest?.date.toISOString() ?? null,
    };
  }
  return result;
}
