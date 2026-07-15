/**
 * lib/ai/assemblers/holdings.ts
 *
 * AI Context Assembler — 'holdings_summary' domain (D6.3C-1).
 *
 * Fills the previously-empty HOLDINGS_SUMMARY socket with deterministic,
 * value-based investment intelligence computed from existing Holding rows.
 * The domain was already declared (lib/ai/types.ts), requested by intent
 * routing for INVESTMENT / RETIREMENT questions (lib/ai/domain-manifest.ts),
 * and probed by Investment Readiness via `holdingsDomainPresent` — but no
 * assembler was registered, so it was always skipped. This module registers it.
 *
 * Assembles a ContextDomainSection for FinanceDomains.HOLDINGS_SUMMARY:
 *   - Aggregate value totals: portfolio value, invested vs cash, cash %
 *   - Aggregated-by-symbol top positions (FULL visibility only)
 *   - Concentration metrics (top weight, top-5, Herfindahl, effective holdings)
 *   - dataLimits describing what this domain deliberately cannot answer
 *
 * ── Scope boundaries (D6.3C-1) ───────────────────────────────────────────────
 * No cost basis, no realized/unrealized gains, no returns/performance, and no
 * asset-class or sector breakdown. Those require investment transaction sync or
 * persisting security type (deferred to later D6.3C slices). This assembler is
 * strictly additive: no schema, Plaid sync, or UI changes.
 *
 * ── Permissions and visibility (mirrors accounts.ts) ─────────────────────────
 * Holdings are read through SpaceAccountLink (status ACTIVE, account not
 * soft-deleted). SpaceAccountLink.visibilityLevel controls fidelity:
 *
 *   FULL         — positions (symbol/name/value) may be exposed and feed the
 *                  concentration analysis.
 *   BALANCE_ONLY — holding values contribute to the aggregate portfolio totals
 *   SUMMARY_ONLY   only; individual positions and symbols are never exposed and
 *   (and any        never feed concentration. This prevents a holding's
 *    non-FULL)      existence/identity leaking across Space membership.
 *
 * This mirrors accounts.ts exactly: only `=== VisibilityLevel.FULL` is treated
 * as full fidelity; every other level is sanitized.
 *
 * ── Security invariants ──────────────────────────────────────────────────────
 * - Does NOT import lib/plaid/encryption or call any decrypt function.
 * - Does NOT query WorkspaceAccountShare.
 * - Queries are always filtered by spaceCtx.spaceId — no cross-Space data.
 * - Only plaintext holding fields are selected; no credential fields.
 */

import { db } from '@/lib/db';
import { DEFAULT_DISPLAY_CURRENCY } from '@/lib/currency';
import { convertMoney, identityContext } from '@/lib/money/convert';
import { buildSpaceConversionContext } from '@/lib/money/server-context';
import { yesterdayUTCISO } from '@/lib/fx/config';
import { ShareStatus, VisibilityLevel } from '@prisma/client';

import { registerAssembler } from '@/lib/ai/assembler-registry';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  AssemblerOptions,
  ContextDomainSection,
  HoldingsSummaryData,
  HoldingPosition,
} from '@/lib/ai/types';
import type { SpaceContext } from '@/lib/space';
import { computeConcentration } from '@/lib/investments/concentration';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Maximum number of top positions surfaced in the context payload. */
const HOLDINGS_TOP_N = 10;

/**
 * Concentration classification thresholds. A band triggers when EITHER the
 * single-name top weight OR the Herfindahl index crosses its floor — so a
 * portfolio dominated by one position and one dominated by a few positions are
 * both caught. Bands are checked most-severe first. See
 * docs/investigations/D6_3C_INVESTMENT_INTELLIGENCE_INVESTIGATION.md §5.
 *
 * The band table + the concentration formula now live in the shared pure module
 * lib/investments/concentration.ts (reused by the Investments Allocation panel);
 * this assembler delegates to it so the thresholds have one home.
 */

// ---------------------------------------------------------------------------
// Internal query result types
// ---------------------------------------------------------------------------

type HoldingRow = {
  currency: string | null; // MC1 P4 Slice 5 — Phase 0 stamp; conversion input
  symbol: string;
  name:   string;
  value:  number;
  isCash: boolean;
};

type HoldingsLinkRow = {
  visibilityLevel: VisibilityLevel;
  financialAccount: {
    holdings: HoldingRow[];
  };
};

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

  // ── Query ─────────────────────────────────────────────────────────────────
  // Same visibility source as accounts.ts: ACTIVE SpaceAccountLinks for this
  // Space, excluding soft-deleted accounts. Holdings are read via the
  // FinancialAccount relation. Legacy Account-anchored holdings are out of
  // scope here — consistent with the accounts assembler being FinancialAccount
  // only during the D11 migration.
  const links: HoldingsLinkRow[] = await db.spaceAccountLink.findMany({
    where: {
      spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    select: {
      visibilityLevel: true,
      financialAccount: {
        select: {
          holdings: {
            select: { symbol: true, name: true, value: true, isCash: true, currency: true },
          },
        },
      },
    },
  });

  // ── Aggregate totals + FULL-visibility position map ─────────────────────────
  // MC1 Phase 4 Slice 5 (F-5) — aggregate value totals convert into the
  // Space's reporting currency at the latest close; per-position rows keep
  // their native values (itemized rule). Unresolvable conversions degrade per
  // D-3 (native + totalsEstimated taint). Identity fallback if the Space row
  // vanished mid-request. All-USD Spaces are numerically identical.
  const spaceRow = await db.space.findUnique({
    where:  { id: spaceId },
    select: { reportingCurrency: true },
  });
  const allHoldings = links.flatMap((l) => l.financialAccount.holdings);
  const moneyCtx = spaceRow
    ? await buildSpaceConversionContext(spaceRow, {
        currencies: allHoldings.map((h) => h.currency ?? null),
        dates:      [yesterdayUTCISO()],
      })
    : identityContext(DEFAULT_DISPLAY_CURRENCY);
  const closeISO = yesterdayUTCISO();
  let totalsEstimated = false;
  const valueInTarget = (h: { value: number; currency: string | null }): number => {
    const c = convertMoney({ amount: h.value, currency: h.currency ?? null }, closeISO, moneyCtx);
    if (c.estimated) totalsEstimated = true;
    return c.amount;
  };

  let totalPortfolioValue = 0;
  let investedValue       = 0;
  let cashValue           = 0;
  let anyHolding          = false;
  let positionsPartiallyHidden = false;

  // Aggregate FULL-visibility, non-cash positions by symbol (VTI held in two
  // brokerages collapses to one weighted position).
  const fullPositions = new Map<string, { symbol: string; name: string; value: number }>();

  for (const link of links) {
    const isFull   = link.visibilityLevel === VisibilityLevel.FULL;
    const holdings = link.financialAccount.holdings;

    if (holdings.length > 0) anyHolding = true;

    for (const h of holdings) {
      // Aggregate value totals include every visibility level — sums only.
      // MC1 P4 Slice 5 — converted into the reporting currency (identity for USD).
      const v = valueInTarget(h);
      totalPortfolioValue += v;
      if (h.isCash) {
        cashValue += v;
      } else {
        investedValue += v;
      }

      // Position/concentration detail: FULL, non-cash only.
      if (!isFull) {
        if (!h.isCash) positionsPartiallyHidden = true;
        continue;
      }
      if (h.isCash) continue;

      const existing = fullPositions.get(h.symbol);
      if (existing) {
        existing.value += h.value;
      } else {
        fullPositions.set(h.symbol, { symbol: h.symbol, name: h.name, value: h.value });
      }
    }
  }

  // No holdings at all across any visible account — domain is cleanly empty.
  if (!anyHolding) return null;

  const cashPct = totalPortfolioValue > 0 ? cashValue / totalPortfolioValue : 0;

  // ── Positions, sorted by value descending ──────────────────────────────────
  const analyzedInvestedValue = Array.from(fullPositions.values())
    .reduce((sum, p) => sum + p.value, 0);

  const rankedPositions: HoldingPosition[] = Array.from(fullPositions.values())
    .map((p): HoldingPosition => ({
      symbol: p.symbol,
      name:   p.name,
      value:  p.value,
      weight: analyzedInvestedValue > 0 ? p.value / analyzedInvestedValue : 0,
    }))
    .sort((a, b) => b.value - a.value);

  // ── Concentration ───────────────────────────────────────────────────────────
  const concentration = computeConcentration(rankedPositions, analyzedInvestedValue);

  // ── dataLimits ──────────────────────────────────────────────────────────────
  const dataLimits: string[] = [
    'No cost basis — unrealized/realized gains cannot be computed.',
    'No returns or performance metrics (requires investment transaction history).',
    'Asset-class and sector breakdown unavailable until security type is persisted.',
  ];
  if (positionsPartiallyHidden) {
    dataLimits.push(
      'Some accounts are shared below full visibility; their individual positions ' +
      'are excluded from position and concentration analysis.',
    );
  }

  // ── Assemble payload ──────────────────────────────────────────────────────
  const data: HoldingsSummaryData = {
    totalPortfolioValue,
    investedValue,
    cashValue,
    totalsEstimated, // MC1 P4 Slice 5 (D-7) — data-only until the AI-presentation slice
    cashPct,
    positionCount: rankedPositions.length,
    analyzedInvestedValue,
    positionsPartiallyHidden,
    concentration,
    dataLimits,
    // topPositions omitted for the Daily Brief aggregator to keep payload lean.
    ...(scopeHint !== 'brief'
      ? { topPositions: rankedPositions.slice(0, HOLDINGS_TOP_N) }
      : {}),
  };

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
