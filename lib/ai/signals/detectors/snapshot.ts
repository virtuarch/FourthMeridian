/**
 * lib/ai/signals/detectors/snapshot.ts
 *
 * Signal detectors for the 'snapshot_history' domain.
 *
 * Signals emitted:
 *   NET_WORTH_INCREASED — net worth trended up across the snapshot window
 *   NET_WORTH_DECLINED  — net worth trended down across the snapshot window
 *
 * Rules are deterministic:
 *   - At least MIN_SNAPSHOTS snapshots must exist.
 *   - The oldest→newest date span must be at least MIN_SPAN_DAYS days.
 *   - Exactly one of INCREASED or DECLINED fires per assembly; never both.
 *   - A zero trend emits no signal (no meaningful change to report).
 *
 * Confidence guards (added Slice 6):
 *   Sparse or very-short-span histories (e.g. after a fresh account import)
 *   produced misleading signals like "Net worth down $1490 (-62%) over 2 days."
 *   The guards below suppress signals until there is enough history to be
 *   meaningful.
 */

import { FinanceDomains } from '@/lib/ai/types';
import type { ContextDomainSection, ContextSignal, SnapshotSectionData } from '@/lib/ai/types';
import { SignalType } from '@/lib/ai/signals/types';
import { registerDetector } from '@/lib/ai/signals/registry';

// ---------------------------------------------------------------------------
// Confidence thresholds
// ---------------------------------------------------------------------------

/** Minimum number of snapshots before emitting any trend signal. */
const MIN_SNAPSHOTS = 3;

/** Minimum calendar-day span (oldest→newest) before emitting any trend signal. */
const MIN_SPAN_DAYS = 7;

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

function detectSnapshotSignals(
  domains: Record<string, ContextDomainSection>,
  spaceId: string,
): ContextSignal[] {
  const section = domains[FinanceDomains.SNAPSHOT_HISTORY];
  if (!section) return [];

  const data = section.data as SnapshotSectionData;

  // Require enough snapshots and a sufficient date span before signalling a
  // trend. Sparse histories (e.g. right after an account import) can show
  // large-percentage swings over 1-2 days that are not genuine trends.
  if (data.snapshotCount < MIN_SNAPSHOTS) return [];

  if (data.oldestDate !== null && data.newestDate !== null) {
    const spanMs   = Date.parse(data.newestDate) - Date.parse(data.oldestDate);
    const spanDays = spanMs / 86_400_000;
    if (spanDays < MIN_SPAN_DAYS) return [];
  }

  if (data.netWorthTrend === null || data.netWorthTrend === 0) return [];

  const now  = new Date().toISOString();
  const abs  = Math.abs(data.netWorthTrend).toFixed(2);
  const pct  = data.netWorthTrendPct !== null
    ? ` (${data.netWorthTrendPct > 0 ? '+' : ''}${data.netWorthTrendPct.toFixed(1)}%)`
    : '';

  if (data.netWorthTrend > 0) {
    return [{
      id:         `${spaceId}:${SignalType.NET_WORTH_INCREASED}`,
      type:       SignalType.NET_WORTH_INCREASED,
      domain:     FinanceDomains.SNAPSHOT_HISTORY,
      spaceId,
      severity:   'info',
      title:      `Net worth up $${abs}${pct} over ${data.snapshotCount} days`,
      value:      data.netWorthTrend,
      metadata: {
        trend:       data.netWorthTrend,
        trendPct:    data.netWorthTrendPct,
        latestValue: data.latest?.netWorth ?? null,
        oldestDate:  data.oldestDate,
        newestDate:  data.newestDate,
      },
      detectedAt: now,
    }];
  }

  // netWorthTrend < 0
  return [{
    id:         `${spaceId}:${SignalType.NET_WORTH_DECLINED}`,
    type:       SignalType.NET_WORTH_DECLINED,
    domain:     FinanceDomains.SNAPSHOT_HISTORY,
    spaceId,
    severity:   'warning',
    title:      `Net worth down $${abs}${pct} over ${data.snapshotCount} days`,
    value:      data.netWorthTrend, // negative — consumers can abs() as needed
    metadata: {
      trend:       data.netWorthTrend,
      trendPct:    data.netWorthTrendPct,
      latestValue: data.latest?.netWorth ?? null,
      oldestDate:  data.oldestDate,
      newestDate:  data.newestDate,
    },
    detectedAt: now,
  }];
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerDetector(detectSnapshotSignals);
