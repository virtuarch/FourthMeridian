/**
 * lib/ai/assemblers/snapshot.ts
 *
 * AI Context Assembler — 'snapshot_history' domain (D4 Slice 3).
 *
 * Assembles a ContextDomainSection for FinanceDomains.SNAPSHOT_HISTORY
 * containing bounded SpaceSnapshot history for the validated Space.
 *
 * ── What this does ───────────────────────────────────────────────────────────
 * Reads existing SpaceSnapshot rows — does NOT recompute them. Snapshots
 * are written once per day by the background sync job (lib/snapshots/
 * regenerate.ts). This assembler is a pure read over whatever history exists.
 *
 * Returns:
 *   - Up to SNAPSHOT_HISTORY_LIMIT data points, newest-last
 *   - Net-worth trend (absolute and percentage delta across the window)
 *   - Latest snapshot values for quick reference
 *   - When scopeHint='brief': latest + trend only, no history array
 *
 * ── Permissions ──────────────────────────────────────────────────────────────
 * buildContext() validates Space membership before invoking any assembler.
 * All queries are filtered by spaceCtx.spaceId — no cross-Space data possible.
 * SpaceSnapshot rows belong directly to the Space (spaceId FK) so no
 * additional permission layer is required.
 *
 * ── Security invariants ──────────────────────────────────────────────────────
 * - Does NOT import lib/plaid/encryption or call any decrypt function.
 * - Does NOT query WorkspaceAccountShare.
 * - Queries are always filtered by spaceCtx.spaceId.
 */

import { db } from '@/lib/db';

import { registerAssembler } from '@/lib/ai/assembler-registry';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  AssemblerOptions,
  ContextDomainSection,
  SnapshotSectionData,
  SnapshotDataPoint,
} from '@/lib/ai/types';
import type { SpaceContext } from '@/lib/space';

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
// Assembler implementation
// ---------------------------------------------------------------------------

async function assembleSnapshot(
  spaceCtx: SpaceContext,
  options:  AssemblerOptions,
): Promise<ContextDomainSection | null> {
  const { spaceId } = spaceCtx;
  const { scopeHint = 'full' } = options;
  const assembledAt = new Date().toISOString();

  // ── Query ─────────────────────────────────────────────────────────────────
  // Bounded read: last SNAPSHOT_HISTORY_LIMIT rows, ascending by date so
  // history is oldest→newest and trend calculation is straightforward.
  // Filtered exclusively to this Space — no cross-Space data possible.

  const rows = await db.spaceSnapshot.findMany({
    where:   { spaceId },
    orderBy: { date: 'asc' },
    take:    -SNAPSHOT_HISTORY_LIMIT, // negative take = last N rows in Prisma
    select: {
      date:        true,
      netWorth:    true,
      totalAssets: true,
      debt:        true,
      cash:        true,
      savings:     true,
      stocks:      true,
      crypto:      true,
      cashOnHand:  true,
      netLiquid:   true,
    },
  });

  // No history yet (brand-new Space) — return null so the domain is noted
  // as empty rather than surfacing a section with all-zero values.
  if (rows.length === 0) return null;

  // ── Normalize ─────────────────────────────────────────────────────────────

  const points: SnapshotDataPoint[] = rows.map((r) => ({
    date:          r.date.toISOString().split('T')[0],
    netWorth:      r.netWorth,
    totalAssets:   r.totalAssets,
    liabilities:   r.debt,          // rename for semantic clarity
    liquid:        r.cash + r.savings,
    investments:   r.stocks,        // rename for semantic clarity
    digitalAssets: r.crypto,        // rename for semantic clarity
    cashOnHand:    r.cashOnHand,
    netLiquid:     r.netLiquid,
  }));

  const oldest = points[0];
  const latest = points[points.length - 1];

  // ── Trend ─────────────────────────────────────────────────────────────────

  let netWorthTrend:    number | null = null;
  let netWorthTrendPct: number | null = null;

  if (points.length >= 2) {
    netWorthTrend = latest.netWorth - oldest.netWorth;
    if (oldest.netWorth !== 0) {
      netWorthTrendPct = Math.round((netWorthTrend / Math.abs(oldest.netWorth)) * 10000) / 100;
    }
  }

  // ── Payload ───────────────────────────────────────────────────────────────
  // scopeHint='brief' omits the history array — the aggregator only needs
  // the latest snapshot and trend delta to generate a summary sentence.

  const data: SnapshotSectionData = {
    snapshotCount:    rows.length,
    oldestDate:       oldest.date,
    newestDate:       latest.date,
    netWorthTrend,
    netWorthTrendPct,
    latest,
    history: scopeHint === 'brief' ? [] : points,
  };

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
