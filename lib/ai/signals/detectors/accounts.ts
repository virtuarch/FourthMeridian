/**
 * lib/ai/signals/detectors/accounts.ts
 *
 * Signal detectors for the 'accounts' domain.
 *
 * Signals emitted:
 *   STALE_CONNECTION — one or more manual accounts not updated in 30+ days
 *   NEEDS_REAUTH     — one or more Plaid connections require re-authentication
 *
 * Rules are deterministic — both conditions are pre-computed by the accounts
 * assembler and stored in AccountsSectionData.health. No additional
 * calculation is needed here.
 */

import { FinanceDomains } from '@/lib/ai/types';
import type { ContextDomainSection, ContextSignal, AccountsSectionData } from '@/lib/ai/types';
import { SignalType } from '@/lib/ai/signals/types';
import { registerDetector } from '@/lib/ai/signals/registry';

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

function detectAccountSignals(
  domains: Record<string, ContextDomainSection>,
  spaceId: string,
): ContextSignal[] {
  const section = domains[FinanceDomains.ACCOUNTS];
  if (!section) return [];

  const data    = section.data as AccountsSectionData;
  const now     = new Date().toISOString();
  const signals: ContextSignal[] = [];

  // ── STALE_CONNECTION ──────────────────────────────────────────────────────
  // Rule: health.staleCount > 0
  // Condition pre-computed by accounts assembler: manual account with
  // syncStatus='manual' and lastUpdated > 30 days ago.

  if (data.health.staleCount > 0) {
    const n = data.health.staleCount;
    signals.push({
      id:         `${spaceId}:${SignalType.STALE_CONNECTION}`,
      type:       SignalType.STALE_CONNECTION,
      domain:     FinanceDomains.ACCOUNTS,
      spaceId,
      severity:   'warning',
      title:      `${n} manual account${n > 1 ? 's' : ''} not updated in 30+ days`,
      value:      n,
      metadata: {
        count:        n,
        accountNames: data.health.staleAccountNames,
      },
      detectedAt: now,
    });
  }

  // ── NEEDS_REAUTH ──────────────────────────────────────────────────────────
  // Rule: health.needsReauthCount > 0
  // Condition pre-computed by accounts assembler: current user has an
  // AccountConnection with PlaidItem.status = NEEDS_REAUTH.

  if (data.health.needsReauthCount > 0) {
    const n = data.health.needsReauthCount;
    signals.push({
      id:         `${spaceId}:${SignalType.NEEDS_REAUTH}`,
      type:       SignalType.NEEDS_REAUTH,
      domain:     FinanceDomains.ACCOUNTS,
      spaceId,
      severity:   'warning',
      title:      `${n} account${n > 1 ? 's' : ''} need${n === 1 ? 's' : ''} re-authentication`,
      value:      n,
      metadata: {
        count:        n,
        accountNames: data.health.needsReauthAccountNames,
      },
      detectedAt: now,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerDetector(detectAccountSignals);
