/**
 * lib/ai/signals/detectors/transactions.ts
 *
 * Signal detectors for the 'transactions_summary' domain.
 *
 * Signals emitted:
 *   PENDING_CREDIT — pending inflows exist
 *   PENDING_DEBIT  — pending outflows exist
 *
 * Rules are deterministic: a signal fires if and only if the relevant
 * pending count in TransactionsSummaryData is greater than zero.
 */

import { FinanceDomains } from '@/lib/ai/types';
import type { ContextDomainSection, ContextSignal, TransactionsSummaryData } from '@/lib/ai/types';
import { SignalType } from '@/lib/ai/signals/types';
import { registerDetector } from '@/lib/ai/signals/registry';

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

function detectTransactionSignals(
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

  return signals;
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerDetector(detectTransactionSignals);
