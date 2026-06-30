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
 *   - At least 2 snapshots must exist (netWorthTrend !== null).
 *   - Exactly one of INCREASED or DECLINED fires per assembly; never both.
 *   - A zero trend emits no signal (no meaningful change to report).
 */

import { FinanceDomains } from '@/lib/ai/types';
import type { ContextDomainSection, ContextSignal, SnapshotSectionData } from '@/lib/ai/types';
import { SignalType } from '@/lib/ai/signals/types';
import { registerDetector } from '@/lib/ai/signals/registry';

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

  // Require at least 2 snapshots for a meaningful trend.
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
