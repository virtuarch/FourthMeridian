/**
 * lib/ai/signals/detectors/transactions.ts
 *
 * Signal detectors for the 'transactions_summary' domain.
 *
 * Signals emitted:
 *   PENDING_CREDIT       — pending inflows exist
 *   PENDING_DEBIT        — pending outflows exist
 *   NEEDS_CLASSIFICATION — one or more rows genuinely need human classification
 *
 * Rules are deterministic: the pending signals fire iff the relevant pending
 * count is > 0; NEEDS_CLASSIFICATION fires iff needsClassification.count > 0,
 * escalating info → warning when the unidentified-inflow share is material.
 */

import { FinanceDomains, MATERIAL_UNIDENTIFIED_INFLOW_SHARE, deriveUnidentifiedInflowShare } from '@/lib/ai/types';
import type { ContextDomainSection, ContextSignal, TransactionsSummaryData } from '@/lib/ai/types';
import { SignalType } from '@/lib/ai/signals/types';
import { registerDetector } from '@/lib/ai/signals/registry';

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

// Exported for TI2-W2 regression tests (transactions.ti2.test.ts) — the runtime
// consumer registers it below via registerDetector.
export function detectTransactionSignals(
  domains: Record<string, ContextDomainSection>,
  spaceId: string,
): ContextSignal[] {
  const section = domains[FinanceDomains.TRANSACTIONS_SUMMARY];
  if (!section) return [];

  const data    = section.data as TransactionsSummaryData;
  const now     = new Date().toISOString();
  const signals: ContextSignal[] = [];

  // ── PENDING_CREDIT ────────────────────────────────────────────────────────
  // Rule: pendingCreditCount > 0

  if (data.pendingCreditCount > 0) {
    const n = data.pendingCreditCount;
    signals.push({
      id:         `${spaceId}:${SignalType.PENDING_CREDIT}`,
      type:       SignalType.PENDING_CREDIT,
      domain:     FinanceDomains.TRANSACTIONS_SUMMARY,
      spaceId,
      severity:   'info',
      title:      `${n} pending credit${n > 1 ? 's' : ''} — $${data.pendingCreditTotal.toFixed(2)} incoming`,
      value:      data.pendingCreditTotal,
      metadata: {
        count: n,
        total: data.pendingCreditTotal,
      },
      detectedAt: now,
    });
  }

  // ── PENDING_DEBIT ─────────────────────────────────────────────────────────
  // Rule: pendingDebitCount > 0

  if (data.pendingDebitCount > 0) {
    const n = data.pendingDebitCount;
    signals.push({
      id:         `${spaceId}:${SignalType.PENDING_DEBIT}`,
      type:       SignalType.PENDING_DEBIT,
      domain:     FinanceDomains.TRANSACTIONS_SUMMARY,
      spaceId,
      severity:   'info',
      title:      `${n} pending debit${n > 1 ? 's' : ''} — $${data.pendingDebitTotal.toFixed(2)} outgoing`,
      value:      data.pendingDebitTotal,
      metadata: {
        count: n,
        total: data.pendingDebitTotal,
      },
      detectedAt: now,
    });
  }

  // ── NEEDS_CLASSIFICATION (TI2-W2) ─────────────────────────────────────────
  // Rule: needsClassification.count > 0. Severity escalates to `warning` only
  // when the unidentified-inflow share is material — the SAME threshold the
  // Brief's savings-rate caveat uses (MATERIAL_UNIDENTIFIED_INFLOW_SHARE), so an
  // info-severity flag stays out of the "Needs Attention" section (which skips
  // info signals) until the unidentified income is large enough to matter.
  // Defensive against pre-W1 fixtures lacking the aggregate block.

  const nc = data.needsClassification;
  if (nc && nc.count > 0) {
    const share    = deriveUnidentifiedInflowShare(data);
    const material = share !== null && share >= MATERIAL_UNIDENTIFIED_INFLOW_SHARE;
    const parts: string[] = [];
    if (nc.unknownInflowCount > 0) {
      parts.push(`$${nc.unknownInflowTotal.toFixed(2)} of income has no identified source`);
    }
    if (nc.unknownPaymentAppCount > 0) {
      parts.push(`$${nc.unknownPaymentAppTotal.toFixed(2)} moved via payment apps, purpose unknown`);
    }
    signals.push({
      id:       `${spaceId}:${SignalType.NEEDS_CLASSIFICATION}`,
      type:     SignalType.NEEDS_CLASSIFICATION,
      domain:   FinanceDomains.TRANSACTIONS_SUMMARY,
      spaceId,
      severity: material ? 'warning' : 'info',
      title:    `${nc.count} transaction${nc.count > 1 ? 's' : ''} need classification`,
      value:    nc.count,
      metadata: {
        count:                  nc.count,
        unknownInflowCount:     nc.unknownInflowCount,
        unknownInflowTotal:     nc.unknownInflowTotal,
        unknownPaymentAppCount: nc.unknownPaymentAppCount,
        unknownPaymentAppTotal: nc.unknownPaymentAppTotal,
        unidentifiedInflowShare: share,
        detail:                 parts.join('; '),
      },
      detectedAt: now,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerDetector(detectTransactionSignals);
