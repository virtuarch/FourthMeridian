/**
 * lib/ai/signals/detectors/snapshot.ts
 *
 * Signal detectors for the 'snapshot_history' domain.
 *
 * Signals emitted:
 *   NET_WORTH_INCREASED — net worth rose over the CANONICAL window
 *   NET_WORTH_DECLINED  — net worth fell over the CANONICAL window
 *
 * REVIEW-3 C-5 — the detector fires off `canonicalChange`, the net-worth change
 * over the window the product DEFINES (PAST_MONTH via compareToForPreset — the
 * same authority behind the Space launcher and the inside-Space selector). It
 * previously read `netWorthTrend`, oldest→newest of whatever rows were fetched:
 * a real number over an ACCIDENTAL window, which produced sentences whose
 * figure disagreed with every product surface stating "the same" change — and,
 * because the Brief gated a canonical percentage on this differently-windowed
 * sign, sentences like "Net worth is up -3.2%".
 *
 * Rules are deterministic:
 *   - At least MIN_SNAPSHOTS snapshots must exist (density guard).
 *   - The oldest→newest date span must be at least MIN_SPAN_DAYS days.
 *   - canonicalChange must exist (history reaches back a full window) with a
 *     non-zero change. Exactly one of INCREASED or DECLINED fires; never both.
 *   - The title's verb follows the SIGN of the same figure it prints — the
 *     window, the number, and the verb come from one object by construction.
 *
 * REVIEW-3 C-6 — money in titles is formatted in the section's own currency
 * (SnapshotSectionData.currency, from the canonical stamp-aware read); no
 * hard-coded currency symbol.
 */

import { FinanceDomains } from '@/lib/ai/types';
import type { ContextDomainSection, ContextSignal, SnapshotSectionData } from '@/lib/ai/types';
import { SignalType } from '@/lib/ai/signals/types';
import { registerDetector } from '@/lib/ai/signals/registry';
import { formatCurrency, DEFAULT_DISPLAY_CURRENCY } from '@/lib/currency';

// ---------------------------------------------------------------------------
// Confidence thresholds
// ---------------------------------------------------------------------------

/** Minimum number of snapshots before emitting any trend signal. */
const MIN_SNAPSHOTS = 3;

/** Minimum calendar-day span (oldest→newest) before emitting any trend signal. */
const MIN_SPAN_DAYS = 7;

/** "Jul 7" — the canonical window's opening date, as a user reads it (UTC). */
function fmtDay(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

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
  //
  // ⚠️ v2.6-WINDOW-1 — `snapshotCount` is correct HERE and only here: this is a
  // density test ("do we have enough observations?"), not a duration.
  if (data.snapshotCount < MIN_SNAPSHOTS) return [];
  if (data.spanDays < MIN_SPAN_DAYS) return [];

  // REVIEW-3 C-5 — the CANONICAL windowed change, or nothing. Null means
  // history does not reach back a full window: the authority refuses rather
  // than comparing against the earliest point it happens to hold, and so does
  // this detector.
  const change = data.canonicalChange;
  if (!change || change.abs === 0) return [];

  const now      = new Date().toISOString();
  const currency = data.currency ?? DEFAULT_DISPLAY_CURRENCY;
  const abs      = formatCurrency(Math.abs(change.abs), currency);
  const pct      = change.pct !== null
    ? ` (${change.pct > 0 ? '+' : ''}${change.pct.toFixed(1)}%)`
    : '';
  const window   = ` since ${fmtDay(change.fromDate)}`;

  // Sign-correct by construction: verb, figure, percentage and window all come
  // from the ONE canonicalChange object.
  if (change.abs > 0) {
    return [{
      id:         `${spaceId}:${SignalType.NET_WORTH_INCREASED}`,
      type:       SignalType.NET_WORTH_INCREASED,
      domain:     FinanceDomains.SNAPSHOT_HISTORY,
      spaceId,
      severity:   'info',
      title:      `Net worth up ${abs}${pct}${window}`,
      value:      change.abs,
      metadata: {
        change:      change.abs,
        changePct:   change.pct,
        fromDate:    change.fromDate,
        toDate:      change.toDate,
        preset:      change.preset,
        currency,
        latestValue: data.latest?.netWorth ?? null,
      },
      detectedAt: now,
    }];
  }

  // change.abs < 0
  return [{
    id:         `${spaceId}:${SignalType.NET_WORTH_DECLINED}`,
    type:       SignalType.NET_WORTH_DECLINED,
    domain:     FinanceDomains.SNAPSHOT_HISTORY,
    spaceId,
    severity:   'warning',
    title:      `Net worth down ${abs}${pct}${window}`,
    value:      change.abs, // negative — consumers can abs() as needed
    metadata: {
      change:      change.abs,
      changePct:   change.pct,
      fromDate:    change.fromDate,
      toDate:      change.toDate,
      preset:      change.preset,
      currency,
      latestValue: data.latest?.netWorth ?? null,
    },
    detectedAt: now,
  }];
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerDetector(detectSnapshotSignals);
