/**
 * lib/data/snapshot-summary.core.ts
 *
 * REVIEW-3 B-4 (E4, matrix row 13) — the PURE half of the snapshot read
 * boundary, shared by BOTH readers in lib/data/snapshots.ts:
 *
 *   getRecentSnapshots         the full-row boundary (charts, AI, export)
 *   getSpaceNetWorthSummaries  the Spaces-launcher card
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * The launcher card used to raw-read `netWorth` with correct FX-stamp handling
 * and NOTHING else: no aggregate authorisation, no crypto assertability, no
 * completeness, and its canonical window change ran over unfiltered points. A
 * row the Wealth workspace refuses to plot and the AI receives as `null` was
 * rendered on the launcher as a plain number.
 *
 * The admissibility interpretation now lives HERE, once —
 * `resolveSnapshotRowProvenance` is the same call getRecentSnapshots makes per
 * row — so the outer card and the inner workspace cannot reach different
 * verdicts about the same stored row. Pure (no DB, no clock, no server-only in
 * the import graph), for the same reason lib/data/snapshot-window.ts moved out
 * of snapshots.ts: an authority tests and audits cannot reach gets duplicated,
 * not respected.
 *
 * ── The launcher's honest-presentation rule (REVIEW-3, pre-approved) ────────
 *   1. A snapshot point enters the card series only when it is ADMISSIBLE:
 *      its `netWorth` aggregate is assertable under the same
 *      `authoriseAggregates` verdict the full boundary resolves, AND it is
 *      expressible in the effective display currency (a genuine rate miss
 *      drops that point only — never a native magnitude relabelled).
 *   2. The card shows the most recent ADMISSIBLE point; `asOf` is that point's
 *      date — the date of the number actually shown, never a fresher
 *      inadmissible row's.
 *   3. Reconstructed/estimated values carry their marker (`estimated`).
 *   4. No admissible point ⇒ the explicit no-figure state (netWorth 0,
 *      trend [], asOf null) — the card's existing "—" presentation.
 *   5. The canonical window change is computed over the ADMISSIBLE series, so
 *      the card's "1M" claim can never open or close on a point the inner
 *      surfaces refuse to assert.
 */

import { convertStampedValues } from "@/lib/snapshots/stamp-conversion";
import { resolveSnapshotCompleteness, type SnapshotCompleteness } from "@/lib/snapshots/snapshot-completeness.core";
import {
  resolveCryptoValuationState, isCryptoAssertable, isAssetSideContaminated,
  cryptoUnavailableReason, type CryptoValuationState,
} from "@/lib/snapshots/crypto-valuation-status.core";
import { authoriseAggregates, type AggregateAuthorisationMap } from "@/lib/snapshots/aggregate-authorisation.core";
import { canonicalWindowChange, type CanonicalWindowChange } from "@/lib/data/snapshot-window";
import type { ConversionContext } from "@/lib/money/types";

/** The stored columns the row authority reads. Structural — no Prisma import. */
export interface RawSnapshotRow {
  date:    Date;
  stocks:  number;
  crypto:  number;
  total:   number;
  cash:    number;
  savings: number;
  debt:    number;
  netWorth:    number;
  totalAssets: number;
  netLiquid:   number;
  cashOnHand:  number;
  isEstimated?:                boolean | null;
  reportingCurrency?:          string | null;
  cryptoValuationStatus?:      string | null;
  completenessTier?:           string | null;
  contributingComponentCount?: number | null;
  totalComponentCount?:        number | null;
}

export interface SnapshotRowProvenance {
  completeness: SnapshotCompleteness;
  cryptoState:  CryptoValuationState;
  aggregates:   AggregateAuthorisationMap;
  /** The exact provenance fields the read boundary spreads onto each Snapshot DTO. */
  provenance: {
    completenessTier:           SnapshotCompleteness["tier"];
    completenessRecorded:       boolean;
    contributingComponentCount: number | null;
    totalComponentCount:        number | null;
    cryptoValuationState:       CryptoValuationState;
    cryptoAssertable:           boolean;
    assetSideContaminated:      boolean;
    aggregateAuthorisation:     AggregateAuthorisationMap;
    cryptoUnavailableReason?:   string;
  };
}

/**
 * Resolve ONE stored row's authority — completeness, crypto assertability and
 * aggregate authorisation — exactly once, for every reader.
 *
 * Deliberately computed on the STORED (pre-conversion) values: authorisation is
 * a statement about EVIDENCE, not presentation, so a display conversion can
 * never change the verdict (see getRecentSnapshots' original comment, which
 * this preserves verbatim in behaviour).
 */
export function resolveSnapshotRowProvenance(r: RawSnapshotRow): SnapshotRowProvenance {
  const completeness = resolveSnapshotCompleteness(r);
  const cryptoState = resolveCryptoValuationState({
    crypto:                r.crypto,
    isEstimated:           r.isEstimated ?? false,
    cryptoValuationStatus: r.cryptoValuationStatus ?? null,
  });
  const aggregates = authoriseAggregates({
    values: {
      stocks: r.stocks, crypto: r.crypto, cash: r.cash, savings: r.savings, debt: r.debt,
      total: r.total, totalAssets: r.totalAssets, netWorth: r.netWorth,
      netLiquid: r.netLiquid, cashOnHand: r.cashOnHand,
    },
    componentAssertable: { crypto: isCryptoAssertable(cryptoState) },
    isEstimated: r.isEstimated ?? false,
  });

  return {
    completeness,
    cryptoState,
    aggregates,
    provenance: {
      completenessTier:           completeness.tier,
      completenessRecorded:       completeness.recorded,
      contributingComponentCount: completeness.contributingComponentCount,
      totalComponentCount:        completeness.totalComponentCount,
      cryptoValuationState:       cryptoState,
      cryptoAssertable:           isCryptoAssertable(cryptoState),
      // RETAINED — several consumers read it today (Wealth, AI, export); it and
      // `aggregates.netWorth.assertable` agree by construction (test-pinned).
      assetSideContaminated:      isAssetSideContaminated(cryptoState),
      aggregateAuthorisation:     aggregates,
      ...(cryptoUnavailableReason(cryptoState)
        ? { cryptoUnavailableReason: cryptoUnavailableReason(cryptoState)! }
        : {}),
    },
  };
}

/** One admissible launcher point: display-converted, authority-cleared. */
export interface AdmissibleNetWorthPoint {
  date:  Date;
  value: number;
  /** Row reconstruction OR display-conversion estimation — the card's marker. */
  estimated: boolean;
}

/**
 * Filter + convert one Space's stored rows into the ADMISSIBLE launcher series
 * (rules 1 and 3 of the header). `stampCtx` is null on the homogeneous fast
 * path (every stamp already matches `target`) — the universal all-USD case,
 * where no conversion runs and no rate is ever resolved.
 */
export function admissibleNetWorthSeries(
  rows: readonly RawSnapshotRow[],
  target: string,
  stampCtx: ConversionContext | null,
): AdmissibleNetWorthPoint[] {
  const points: AdmissibleNetWorthPoint[] = [];
  for (const r of rows) {
    // Rule 1a — the SAME aggregate authorisation the full read boundary
    // resolves. A non-assertable netWorth never becomes a plain number here.
    const { aggregates } = resolveSnapshotRowProvenance(r);
    if (!aggregates.netWorth.assertable) continue;

    const stamp = r.reportingCurrency ?? "USD";
    if (!stampCtx || stamp === target) {
      points.push({ date: r.date, value: r.netWorth, estimated: r.isEstimated ?? false });
      continue;
    }
    // Rule 1b — off-stamp: convert at THIS point's own date. A genuine rate
    // miss drops the point only (a native magnitude would mix units — the
    // honesty contract: excluded, never relabelled).
    const conv = convertStampedValues(
      { v: r.netWorth }, stamp, r.date.toISOString().slice(0, 10), stampCtx,
    );
    if (conv.missed) continue;
    points.push({
      date: r.date, value: conv.values.v,
      estimated: (r.isEstimated ?? false) || conv.estimated,
    });
  }
  return points;
}

/** How many trailing admissible points feed the card SPARKLINE (shape only). */
export const LAUNCHER_SPARKLINE_POINTS = 14;

export interface NetWorthSeriesSummary {
  netWorth: number;
  trend:    number[];
  /** The latest ADMISSIBLE snapshot date — the date of the number shown. */
  asOf:     string | null;
  /** True when the value shown is reconstructed/estimated (rule 3's marker). */
  estimated: boolean;
  change:   CanonicalWindowChange | null;
}

/** Rules 2, 4 and 5: summarize an admissible series for one launcher card. */
export function summarizeNetWorthSeries(points: readonly AdmissibleNetWorthPoint[]): NetWorthSeriesSummary {
  const latest = points[points.length - 1];
  return {
    netWorth:  latest?.value ?? 0,
    trend:     points.slice(-LAUNCHER_SPARKLINE_POINTS).map((p) => p.value),
    asOf:      latest?.date.toISOString() ?? null,
    estimated: latest?.estimated ?? false,
    change:    canonicalWindowChange(points.map((p) => ({ date: p.date, value: p.value }))),
  };
}
