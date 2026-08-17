/**
 * lib/ai/assemblers/snapshot.ts
 *
 * AI Context Assembler — 'snapshot_history' domain (D4 Slice 3).
 *
 * Assembles a ContextDomainSection for FinanceDomains.SNAPSHOT_HISTORY
 * containing bounded SpaceSnapshot history for the validated Space.
 *
 * ── What this does ───────────────────────────────────────────────────────────
 * Reads existing SpaceSnapshot rows THROUGH THE CANONICAL AUTHORITY — it does
 * NOT query the SpaceSnapshot table and does NOT recompute snapshots.
 *
 * V26-PRE (B2) — this assembler previously ran its own `db.spaceSnapshot`
 * query without selecting `reportingCurrency`, then folded net-worth trends
 * across rows that may be stamped in different currencies (a Space that ever
 * changed reporting currency produced a fabricated trend). It now consumes
 * `getRecentSnapshots()` (lib/data/snapshots.ts), the stamp-aware read every
 * other snapshot surface uses:
 *   - off-stamp rows are converted at each snapshot's OWN date;
 *   - a genuine rate MISS marks the row `fxMiss` — those points are EXCLUDED
 *     here (never mixed native magnitudes) and the exclusion is DISCLOSED via
 *     `excludedFxMissPoints`;
 *   - any converted/reconstructed point sets `estimated` on the section.
 *
 * Returns:
 *   - Up to SNAPSHOT_HISTORY_LIMIT data points, newest-last
 *   - Net-worth trend (absolute and percentage delta across the window)
 *   - Latest snapshot values for quick reference
 *   - When scopeHint='brief': latest + trend only, no history array
 *
 * ── Permissions ──────────────────────────────────────────────────────────────
 * buildContext() validates Space membership before invoking any assembler.
 * All reads are scoped by spaceCtx.spaceId — no cross-Space data possible.
 * SpaceSnapshot rows belong directly to the Space (spaceId FK) so no
 * additional permission layer is required.
 *
 * ── Security invariants ──────────────────────────────────────────────────────
 * - Does NOT import lib/plaid/encryption or call any decrypt function.
 * - Does NOT query WorkspaceAccountShare.
 * - Reads are always scoped by spaceCtx.spaceId.
 */

import { getRecentSnapshots } from '@/lib/data/snapshots';
// v2.6-WINDOW-1 — imported from the PURE module, not through the server-only
// read, so the projection below stays reachable from a probe.
import { canonicalWindowChange, seriesSpanDays } from '@/lib/data/snapshot-window';

import { registerAssembler } from '@/lib/ai/assembler-registry';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  AssemblerOptions,
  ContextDomainSection,
  SnapshotSectionData,
  SnapshotDataPoint,
} from '@/lib/ai/types';
import type { SpaceContext } from '@/lib/space';
import type { Snapshot } from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of snapshot ROWS returned in the `history` array.
 *
 * ⚠️ v2.6-WINDOW-1 — a ROW CAP, not a date range. `getRecentSnapshots` uses its
 * `days` parameter as `take: -days`, so this is "the last 90 rows", and the
 * comment that used to read "→ ~90 days of history" was an ASSUMPTION about
 * snapshot cadence, not a fact about the read. On a daily contiguous corpus 90
 * rows span 89 days; on any other cadence they span whatever they span. Nothing
 * downstream may call this number a duration — `spanDays` is the measured one.
 */
export const SNAPSHOT_HISTORY_LIMIT = 90;

/**
 * The window every context consumer states when it reports a net-worth change.
 *
 * PAST_MONTH, matching the Space launcher (`getSpaceNetWorthSummaries`) and the
 * inside-Space selector's default. One preset, three surfaces, one number.
 */
const CANONICAL_CHANGE_PRESET = "PAST_MONTH" as const;

// ---------------------------------------------------------------------------
// Pure projection (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Project canonical Snapshot DTOs into the AI section payload. Pure — the
 * whole semantic surface of this assembler lives here so it is unit-testable
 * without a database.
 *
 * fxMiss rows are excluded (they carry native, unconverted magnitudes and
 * would corrupt every delta they touch) and the exclusion is disclosed.
 */
export function projectSnapshotSection(
  rows: Snapshot[],
  scopeHint: 'brief' | 'full',
): SnapshotSectionData | null {
  const usable   = rows.filter((r) => !r.fxMiss);
  const excluded = rows.length - usable.length;

  // No usable history (brand-new Space, or every point unconvertible) — return
  // null so the domain is noted as empty rather than surfacing zeros.
  if (usable.length === 0) return null;

  // V26-CRYPTO-STATUS-1 — a point whose crypto may not be asserted is INCLUDED
  // with explicit nulls and a reason, never dropped and never zeroed. Dropping
  // would leave a silent hole the model reads as "no data"; zeroing would state
  // an absence no evidence supports. Nulls plus a reason say the one true thing:
  // this figure is unknown, and here is why.
  //
  // `netWorth` and `totalAssets` are nulled alongside it because both are
  // arithmetically composed WITH the crypto component — on the affected rows it
  // is 41.7%–99.9% of totalAssets. `liabilities`, `liquid`, `investments`,
  // `cashOnHand` and `netLiquid` never involved crypto and stay factual.
  const points: SnapshotDataPoint[] = usable.map((r) => {
    // v2.6-A/B — the AGGREGATE's verdict decides, not one component's boolean.
    // A model must never receive an unassertable Net Worth as a fact, and after
    // Slice A the aggregate itself says whether it may be asserted. The boolean
    // remains the fallback for a DTO built before Slice A.
    const netWorthRefused = r.aggregateAuthorisation
      ? r.aggregateAuthorisation.netWorth.assertable === false
      : r.assetSideContaminated === true;
    const contaminated = netWorthRefused;
    return {
      date:          r.date,
      netWorth:      contaminated ? null : r.netWorth,
      totalAssets:   contaminated ? null : r.totalAssets,
      liabilities:   r.totalDebt,                    // rename for semantic clarity
      liquid:        r.totalCash + r.totalSavings,
      investments:   r.totalInvestments,             // rename for semantic clarity
      digitalAssets: contaminated ? null : r.totalCrypto,  // rename for semantic clarity
      cashOnHand:    r.cashOnHand,
      netLiquid:     r.netLiquid ?? 0,
      ...(contaminated
        ? { digitalAssetsUnavailableReason: r.cryptoUnavailableReason ?? "HISTORICAL_CRYPTO_VALUATION_UNAVAILABLE" }
        : {}),
    };
  });

  const oldest = points[0];
  const latest = points[points.length - 1];

  let netWorthTrend:    number | null = null;
  let netWorthTrendPct: number | null = null;

  // V26-CRYPTO-STATUS-1 — a trend across an unassertable endpoint is not a
  // weaker trend, it is not a trend at all. Both endpoints must be assertable;
  // otherwise the calculation is REFUSED (null) rather than computed from a
  // number the payload itself declares unknown.
  const unassertablePoints = points.filter((p) => p.netWorth === null).length;
  if (points.length >= 2 && oldest.netWorth !== null && latest.netWorth !== null) {
    netWorthTrend = latest.netWorth - oldest.netWorth;
    if (oldest.netWorth !== 0) {
      netWorthTrendPct = Math.round((netWorthTrend / Math.abs(oldest.netWorth)) * 10000) / 100;
    }
  }

  const estimated = usable.some((r) => r.isEstimated === true);

  // v2.6-WINDOW-1 — the TRUE calendar distance the points cover, and the change
  // over a window the product DEFINES.
  //
  // `snapshotCount` is a ROW COUNT (`getRecentSnapshots` uses its `days`
  // parameter as `take: -days`). Four surfaces rendered it as a number of days,
  // which is only true when snapshots are daily AND contiguous — a property
  // nothing enforces. `spanDays` is derived from the dates the section already
  // carries, so the count is never again pressed into service as a duration.
  //
  // `canonicalChange` exists because `netWorthTrend` above is oldest→newest of
  // whatever rows were fetched: a real number over an ACCIDENTAL window. The
  // Daily Brief published it as "over the last 90 days" and landed on a baseline
  // three days from the canonical one, across a $4,985 debt paydown — 14.9%
  // where the Space said 47.4% for the same words. This is the same figure the
  // Space launcher and the inside-Space selector show, from the same authority
  // (`compareToForPreset`), so a consumer can state a window instead of inventing
  // one. It is null when history does not reach back that far — a refusal, not a
  // fallback to the earliest available point.
  const series = points
    .filter((p): p is typeof p & { netWorth: number } => p.netWorth !== null)
    .map((p) => ({ date: new Date(p.date), value: p.netWorth }));
  const spanDays = seriesSpanDays(points.map((p) => ({ date: new Date(p.date), value: 0 })));
  const canonicalChange = canonicalWindowChange(series, CANONICAL_CHANGE_PRESET);

  return {
    // REVIEW-3 C-6 — the effective currency of these figures, from the newest
    // usable row's stamp (the canonical read boundary resolves it). Consumers
    // that render money format with THIS, never a hard-coded symbol. Absent on
    // fixtures whose rows carry no stamp.
    ...(usable[usable.length - 1].currency
      ? { currency: usable[usable.length - 1].currency }
      : {}),
    snapshotCount:    usable.length,
    spanDays,
    canonicalChange,
    oldestDate:       oldest.date,
    newestDate:       latest.date,
    // ⚠️ REVIEW-3 C-5 — the accidental fetched-row window. RETAINED in the
    // payload ONLY because a snapshot-authority guard outside this slice's
    // write scope pins its refusal semantics (crypto-valuation-status: a trend
    // across an unassertable endpoint is null); NO detector or Brief sentence
    // reads it any more — the signal detector migrated to canonicalChange.
    // Nothing user-facing may consume these two fields.
    netWorthTrend,
    netWorthTrendPct,
    latest,
    history: scopeHint === 'brief' ? [] : points,
    // Disclosure — additive; absent on clean homogeneous histories.
    ...(estimated ? { estimated: true } : {}),
    ...(excluded > 0 ? { excludedFxMissPoints: excluded } : {}),
    // Disclosure — how many points carry an unassertable digital-asset figure.
    ...(unassertablePoints > 0 ? { unassertableCryptoPoints: unassertablePoints } : {}),
  };
}

// ---------------------------------------------------------------------------
// Assembler implementation
// ---------------------------------------------------------------------------

async function assembleSnapshot(
  spaceCtx: SpaceContext,
  options:  AssemblerOptions,
): Promise<ContextDomainSection | null> {
  const { spaceId } = spaceCtx;
  const { scopeHint = 'full' } = options;
  const assembledAt = new Date().toISOString();

  // Canonical, stamp-aware, bounded read (newest-last, ascending by date).
  const rows = await getRecentSnapshots({ rows: SNAPSHOT_HISTORY_LIMIT }, { spaceId });

  const data = projectSnapshotSection(rows, scopeHint === 'brief' ? 'brief' : 'full');
  if (data === null) return null;

  return {
    domain:      FinanceDomains.SNAPSHOT_HISTORY,
    assembledAt,
    data,
  };
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerAssembler(FinanceDomains.SNAPSHOT_HISTORY, assembleSnapshot);
