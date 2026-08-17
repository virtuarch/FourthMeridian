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
import { type TimePreset } from "@/lib/perspectives/time-range";
import { getSpaceContext } from "@/lib/space";
import { resolveEffectiveSpaceConversion } from "@/lib/money/server-context";
import { convertStampedValues } from "@/lib/snapshots/stamp-conversion";
import {
  resolveSnapshotRowProvenance, admissibleNetWorthSeries, summarizeNetWorthSeries,
} from "@/lib/data/snapshot-summary.core";
import type { ConversionContext } from "@/lib/money/types";
import { Snapshot } from "@/types";

/**
 * Resolve the stamp-conversion context for a set of snapshot rows against the
 * requested reporting currency (the caller supplies it from its own Space
 * read, so batch callers resolve it once per Space without a second query).
 * Returns `{ target, ctx: null }` on the homogeneous fast path (every stamp
 * already matches the effective target) — callers then map rows exactly as
 * they always have.
 */
async function resolveStampContext(
  requested: string,
  rows: { date: Date; reportingCurrency?: string | null }[],
): Promise<{ target: string; ctx: ConversionContext | null }> {
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
 * How much history to read. A ROW bound — deliberately the only shape available.
 *
 * ── Why this is an object (v2.6-WINDOW-2) ───────────────────────────────────
 *
 * The parameter was `days = 30`, and it was used as `take: -days`: a ROW LIMIT
 * wearing a duration's name. Every caller inherited the misnomer, and one of
 * them — the Daily Brief — published it, telling a user "up 14.9% over the last
 * 90 days" about a 90-ROW window while the Space said 47.4% for the same words
 * (v2.6-WINDOW-1).
 *
 * A positional number cannot say which unit it is. This object can, and a bare
 * `getRecentSnapshots(365)` no longer compiles — so the ambiguity is not fixed
 * by everyone remembering, it is fixed by the type.
 */
export interface SnapshotReadBound {
  /**
   * Read the newest N ROWS.
   *
   * ⚠️ Rows, not days — but safely so, and this is the fact that makes every
   * current caller correct. `SpaceSnapshot` carries `@@unique([spaceId, date])`,
   * so a Space has AT MOST one row per day. N rows therefore always span at
   * least N−1 calendar days: a row cap is a CONSERVATIVE over-cover of the same
   * number of days, never a silent truncation. Measured across the corpus, every
   * Space runs at exactly 1.00 rows/day, and gaps only widen the span (Jane's
   * Space: 366 rows over 371 calendar days).
   *
   * That is why the callers below are all generous caps with client-side
   * clipping and none of them needs a date-bounded read. A surface that wants to
   * make a CLAIM about a window must not count rows to do it — it resolves the
   * window through `canonicalWindowChange` (lib/data/snapshot-window.ts), which
   * is what the Brief now does.
   */
  rows: number;
}

/**
 * Snapshot history for a Space, oldest-first so a chart renders left→right in
 * time order. Bounded by ROW COUNT — see `SnapshotReadBound`.
 */
export async function getRecentSnapshots(
  bound: SnapshotReadBound,
  ctx?: { spaceId: string },
): Promise<Snapshot[]> {
  const { spaceId } = ctx ?? (await getSpaceContext());

  const rows = await db.spaceSnapshot.findMany({
    where:   { spaceId },
    orderBy: { date: "asc" },
    take:    -bound.rows, // the newest N rows (negative take = from the end)
  });

  const space = await db.space.findUnique({
    where:  { id: spaceId },
    select: { reportingCurrency: true },
  });
  const { target, ctx: stampCtx } = await resolveStampContext(space?.reportingCurrency ?? "USD", rows);

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
      total:            r.total,
      cashOnHand:       r.cashOnHand,
      // V26-PRE (B2) — rides the same stamp-aware conversion as every other
      // total (convertStampedValues converts all keys of this object).
      netLiquid:        r.netLiquid,
    };

    // V26-INVESTMENTS-HISTORY / V26-CRYPTO-STATUS-1 / v2.6-A — the row's
    // confidence, crypto authority and AGGREGATE AUTHORISATION, resolved ONCE.
    //
    // REVIEW-3 B-4 (E4): the resolution moved verbatim into
    // lib/data/snapshot-summary.core.ts (`resolveSnapshotRowProvenance`) so the
    // Spaces-launcher reader below shares the SAME per-row interpretation
    // instead of bypassing it. Everything the original inline block asserted
    // still holds: downstream surfaces never see the raw
    // (isEstimated, completenessTier, cryptoValuationStatus) fields;
    // authorisation is computed on the STORED (pre-conversion) values, because
    // it is a statement about EVIDENCE, not presentation; and `crypto` is the
    // only component carrying authorisation today.
    const { provenance } = resolveSnapshotRowProvenance(r);

    // Homogeneous fast path (stampCtx null) or on-stamp row → pre-MC1 mapping.
    if (!stampCtx || stamp === target) {
      return {
        date: r.date.toISOString().split("T")[0],
        ...raw,
        // D2.x Slice 4 — provenance for the estimated-history badge.
        isEstimated: r.isEstimated ?? false,
        // v2.6-B — the EFFECTIVE currency these totals are in, stated rather than
        // assumed. On the fast path it is the row's own stamp.
        currency: target,
        ...provenance,
      };
    }

    // Off-stamp: convert every total at THIS row's own date (historical FX);
    // the display-estimation flag joins the existing badge mechanism.
    const converted = convertStampedValues(raw, stamp, r.date.toISOString().slice(0, 10), stampCtx);
    return {
      date: r.date.toISOString().split("T")[0],
      ...converted.values,
      isEstimated: (r.isEstimated ?? false) || converted.estimated,
      currency: target,
      ...provenance,
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
// v2.6-WINDOW-1 — the canonical windowed change now lives in a module with no
// `server-only` in its import graph, so an audit and the AI context layer can
// both reach it. Re-exported here so no existing consumer moved. See that
// module's header for what the unreachability cost.
export { canonicalWindowChange, seriesSpanDays } from "@/lib/data/snapshot-window";

export interface SpaceNetWorthSummary {
  netWorth: number;
  currency: string;
  trend: number[];
  /**
   * The latest ADMISSIBLE snapshot date — the date of the number the card
   * actually shows (REVIEW-3: a fresher row whose netWorth may not be asserted
   * never becomes the card figure, so this is never that row's date either).
   * A history fact — never a freshness claim.
   */
  asOf: string | null;
  /**
   * REVIEW-3 B-4 — true when the value shown is a reconstruction/estimate
   * (row `isEstimated`, or display-converted off its stamp). The card renders
   * its marker from this; a reconstructed value never poses as an observation.
   */
  estimated: boolean;
  /**
   * v2.6-L4F — the CANONICAL 1M change, resolved through the same authority the
   * inside-Space view uses (`compareToForPreset("PAST_MONTH", asOf)` from
   * lib/perspectives/time-range), so the outer card and the inner hero cannot
   * disagree. Null when there is no comparison point.
   *
   * This replaces a card-local `trendDeltaPct(trend)` that ran over the last 14
   * SNAPSHOT ROWS — neither a month nor 30 days. On Chris' Space that read 25.0%
   * against the inside view's 49.2%, for the same Space on the same day.
   */
  change: {
    /** YYYY-MM-DD — the window's opening point (the resolved compare-to). */
    fromDate: string;
    /** YYYY-MM-DD — the window's closing point (asOf). */
    toDate: string;
    fromValue: number;
    toValue: number;
    /** (to − from) / |from| × 100. Null when `from` is 0. */
    pct: number | null;
    abs: number;
    /**
     * The preset this window represents.
     *
     * v2.6-WINDOW-1 — widened from the literal `"PAST_MONTH"` when
     * `canonicalWindowChange` became the shared authority. It stays PAST_MONTH
     * for every caller today; the field exists so a surface RENDERS the window
     * it was given rather than assuming which one it received.
     */
    preset: TimePreset;
  } | null;
}

export async function getSpaceNetWorthSummaries(
  spaceIds: string[]
): Promise<Record<string, SpaceNetWorthSummary>> {
  if (spaceIds.length === 0) return {};

  // Each Space's own reporting currency (the card label source). Selected here
  // so no card ever borrows the active Space's currency.
  const spaces = await db.space.findMany({
    where:  { id: { in: spaceIds } },
    select: { id: true, reportingCurrency: true },
  });
  const currencyById = new Map(spaces.map((s) => [s.id, s.reportingCurrency ?? "USD"]));

  // REVIEW-3 B-4 (E4, matrix row 13) — this reader now goes THROUGH the read
  // boundary's per-row authority instead of bypassing it. One batch query still
  // covers every card on the page; it selects the full component/authority
  // columns because admissibility (aggregate authorisation, crypto
  // assertability, completeness) is resolved per row by the SAME
  // `resolveSnapshotRowProvenance` getRecentSnapshots uses — see
  // lib/data/snapshot-summary.core.ts for the launcher's honest-presentation
  // rule this implements.
  const rows = await db.spaceSnapshot.findMany({
    where:   { spaceId: { in: spaceIds } },
    orderBy: { date: "asc" },
    select:  {
      spaceId: true, date: true, reportingCurrency: true,
      stocks: true, crypto: true, total: true, cash: true, savings: true, debt: true,
      netWorth: true, totalAssets: true, netLiquid: true, cashOnHand: true,
      isEstimated: true, cryptoValuationStatus: true,
      completenessTier: true, contributingComponentCount: true, totalComponentCount: true,
    },
  });

  type SummaryRow = (typeof rows)[number];
  const bySpace = new Map<string, SummaryRow[]>();
  for (const r of rows) {
    const list = bySpace.get(r.spaceId) ?? [];
    list.push(r);
    bySpace.set(r.spaceId, list);
  }

  const result: Record<string, SpaceNetWorthSummary> = {};
  for (const id of spaceIds) {
    const series = bySpace.get(id) ?? [];

    // The SAME effective-currency resolution getRecentSnapshots uses
    // (V25-CLOSE-3A): a Space switched to a currency the archive cannot satisfy
    // reads its history in USD — on the launcher exactly as inside the Space —
    // instead of dropping every point. Homogeneous Spaces (all-USD today) take
    // the fast path and never touch the FX archive.
    const { target, ctx: stampCtx } = await resolveStampContext(currencyById.get(id) ?? "USD", series);

    // Admissibility + per-point stamp conversion + summary, all shared with
    // the read boundary (snapshot-summary.core.ts). Non-assertable rows and
    // genuine rate misses are omitted — never rendered as plain numbers, never
    // native magnitudes relabelled. No admissible point ⇒ the card's explicit
    // "no figure" state (netWorth 0, trend [], asOf null).
    const summary = summarizeNetWorthSeries(admissibleNetWorthSeries(series, target, stampCtx));
    result[id] = { currency: target, ...summary };
  }
  return result;
}
