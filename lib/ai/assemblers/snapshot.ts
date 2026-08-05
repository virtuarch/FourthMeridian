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
 * Maximum number of snapshot rows returned in the `history` array.
 * Daily snapshots → ~90 days of history. Sufficient for trend analysis and
 * compact enough not to bloat the context payload.
 */
const SNAPSHOT_HISTORY_LIMIT = 90;

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

  return {
    snapshotCount:    usable.length,
    oldestDate:       oldest.date,
    newestDate:       latest.date,
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
  const rows = await getRecentSnapshots(SNAPSHOT_HISTORY_LIMIT, { spaceId });

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
