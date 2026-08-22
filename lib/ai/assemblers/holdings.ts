/**
 * lib/ai/assemblers/holdings.ts
 *
 * AI Context Assembler — 'holdings_summary' domain.
 *
 * DB binding for the HOLDINGS_SUMMARY socket. It gathers investment facts from the
 * CANONICAL investment truth spine and hands them to the pure shaper
 * (holdings-core.ts::buildHoldingsSummary):
 *
 *   - FULL-visibility position DETAIL  → getCurrentPositions({spaceId})
 *       The A10-at-today seam. Visibility (KD-21a / TRANSACTION_DETAIL_VISIBILITY)
 *       is enforced INSIDE the seam, so this assembler NEVER re-implements the
 *       BALANCE_ONLY / SUMMARY_ONLY filter and can never expose a hidden position.
 *   - All-visibility aggregate VALUE   → getInvestmentValueAsOf({visibilityScope:"all"})
 *       The canonical wealth-scope valuation. This is where the VALUE (never the
 *       detail) of BALANCE_ONLY / SUMMARY_ONLY accounts legitimately enters.
 *   - Crypto (BTC wallets)             → the SAME two seams above (W5 — P2-6 executed)
 *       A wallet's position is a PositionObservation valued through the dated
 *       archive price like any other instrument. The legacy `Holding` bridge
 *       (lib/investments/legacy-crypto-holdings.ts) was DELETED per its own
 *       deletion condition; a wallet with NO spine observation is HONESTLY
 *       ABSENT from this domain — never back-filled from a legacy row, never
 *       re-valued from an undated sync-time spot quote.
 *
 * ── P2-4/W5 read-path invariant ──────────────────────────────────────────────
 * This assembler reads NO `Holding` row of any kind — not for brokerage, not
 * for crypto — and re-implements NO visibility branch. Source-scan tests
 * (holdings.test.ts) and scripts/audit-crypto-holding-tombstone.ts guard the
 * regression in both directions.
 *
 * ── Scope boundaries ─────────────────────────────────────────────────────────
 * No cost basis surfaced, no realized/unrealized gains, no returns/performance,
 * no asset-class/sector breakdown (see holdings-core baseDataLimits). Strictly
 * additive: no schema, Plaid sync, or UI changes.
 *
 * ── Security invariants ──────────────────────────────────────────────────────
 * - Does NOT import lib/plaid/encryption or call any decrypt function.
 * - Does NOT query WorkspaceAccountShare.
 * - Every query is filtered by spaceCtx.spaceId — no cross-Space data.
 * - Only plaintext fields are selected; no credential fields.
 */

import { registerAssembler } from '@/lib/ai/assembler-registry';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  AssemblerOptions,
  ContextDomainSection,
} from '@/lib/ai/types';
import type { SpaceContext } from '@/lib/space';
import { getCurrentPositions } from '@/lib/investments/current-positions';
import { getInvestmentValueAsOf } from '@/lib/investments/valuation';
import {
  buildHoldingsSummary,
  type AllScopeAggregate,
  type CanonicalPositionRow,
} from './holdings-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// REVIEW-3 B-6 — the shared clock for both canonical valuations is THE clock
// (lib/time/clock.ts); this assembler no longer carries a private "today".
import { todayUTCISO } from '@/lib/time/clock';

// ---------------------------------------------------------------------------
// Assembler implementation
// ---------------------------------------------------------------------------

async function assembleHoldings(
  spaceCtx: SpaceContext,
  options:  AssemblerOptions,
): Promise<ContextDomainSection | null> {
  const { spaceId } = spaceCtx;
  const { scopeHint = 'full' } = options;
  const assembledAt = new Date().toISOString();
  const asOf = todayUTCISO();

  // FULL detail (visibility inside the seam) + all-visibility aggregate value —
  // read together. W5: crypto arrives through these SAME two seams (spine
  // observations valued at dated archive prices); there is no separate crypto
  // read, and a wallet without observations is honestly absent.
  const [current, allView] = await Promise.all([
    getCurrentPositions({ spaceId }, { asOf }),
    getInvestmentValueAsOf({ spaceId, asOf, visibilityScope: 'all' }),
  ]);

  const fullRows: CanonicalPositionRow[] = current.rows.map((r) => ({
    instrumentId:   r.instrumentId,
    symbol:         r.symbol,
    name:           r.name,
    reportingValue: r.reportingValue,
    isCash:         r.isCash,
    // W5 — valuation dating for the staleness disclosure (holdings-core).
    priceDate:      r.priceDate,
    staleDays:      r.staleDays,
  }));

  // All-visibility aggregate derived from the canonical "all"-scope valuation view.
  let allCash = 0, anyFxEstimated = false;
  for (const c of allView.components) {
    if (c.reportingValue == null) continue;
    if (c.basisUsed === 'cash') allCash += c.reportingValue;
    if (c.fxTier === 'estimated') anyFxEstimated = true;
  }
  const allScope: AllScopeAggregate = {
    valuedSubtotal: allView.valuedSubtotal,
    cashValue:      allCash,
    anyFxEstimated,
    hasAny:         allView.components.length > 0,
  };

  const data = buildHoldingsSummary({ scopeHint, fullRows, allScope });
  if (!data) return null;

  return {
    domain: FinanceDomains.HOLDINGS_SUMMARY,
    assembledAt,
    data,
  };
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerAssembler(FinanceDomains.HOLDINGS_SUMMARY, assembleHoldings);
