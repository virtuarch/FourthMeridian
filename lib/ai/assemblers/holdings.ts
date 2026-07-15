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
 *   - Crypto (BTC wallets)             → readLegacyCryptoWalletPositions() [TRANSITIONAL]
 *       Crypto rides the SHARED, crypto-only (walletChain-gated, FULL-detail) bridge
 *       in lib/investments/legacy-crypto-holdings.ts — the SAME reader the data
 *       Export uses (P2-5) — never a general brokerage Holding read. P2-6 now ALSO
 *       writes BTC balances to the PositionObservation spine, so a wallet can be in
 *       BOTH sources; CANONICAL WINS — any custody account already present in the
 *       getCurrentPositions rows is excluded from the bridge (dedup by
 *       FinancialAccount identity, not symbol), so no wallet is ever counted twice.
 *       Removed entirely once P2-6 completes.
 *
 * ── P2-4 read-path invariant ─────────────────────────────────────────────────
 * This assembler no longer reads `Holding` for A-track (Plaid / brokerage / CSV)
 * positions and re-implements NO visibility branch. It performs NO direct
 * `db.holding` read at all — crypto comes through the shared legacy-crypto-holdings
 * bridge. A source-scan test (holdings.test.ts) guards against a regression to
 * general Holding / current-holdings reads.
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

import { db } from '@/lib/db';
import { DEFAULT_DISPLAY_CURRENCY } from '@/lib/currency';
import { convertMoney } from '@/lib/money/convert';
import { buildSpaceConversionContext } from '@/lib/money/server-context';
import { yesterdayUTCISO } from '@/lib/fx/config';

import { registerAssembler } from '@/lib/ai/assembler-registry';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  AssemblerOptions,
  ContextDomainSection,
} from '@/lib/ai/types';
import type { SpaceContext } from '@/lib/space';
import { getCurrentPositions } from '@/lib/investments/current-positions';
import { getInvestmentValueAsOf } from '@/lib/investments/valuation';
import { readLegacyCryptoWalletPositions } from '@/lib/investments/legacy-crypto-holdings';
import {
  buildHoldingsSummary,
  excludeCanonicalCryptoAccounts,
  type AllScopeAggregate,
  type CanonicalPositionRow,
  type CryptoHoldingsInput,
} from './holdings-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Today (UTC), YYYY-MM-DD. Shared clock for both canonical valuations. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * TRANSITIONAL crypto arm (convergence P2-6). Reuses the SHARED, crypto-only
 * bridge `readLegacyCryptoWalletPositions` (walletChain-gated, FULL-detail — the
 * exact set btc-sync writes) that the data Export uses (P2-5). This function does
 * NOT read Holding directly; it only converts the bridge's native/quote values
 * into the reporting currency (the bridge is a passthrough by design) and
 * aggregates FULL non-cash positions by symbol. Deleted at P2-6 with the bridge.
 *
 * CANONICAL WINS: `canonicalAccountIds` is the set of FinancialAccount ids already
 * present on the spine (from getCurrentPositions().rows). Any wallet in that set is
 * excluded here (dedup by custody account, not symbol), so a wallet on the spine is
 * counted ONCE via canonical and never double-counted through this bridge.
 */
async function readCryptoHoldings(
  spaceId: string,
  reportingCurrency: string,
  canonicalAccountIds: ReadonlySet<string>,
): Promise<CryptoHoldingsInput> {
  const empty: CryptoHoldingsInput = {
    total: 0, invested: 0, cash: 0, fullPositions: [], anyEstimated: false, hasAny: false,
  };

  const bridgePositions = await readLegacyCryptoWalletPositions({ spaceId });
  // CANONICAL WINS — drop any wallet already on the PositionObservation spine.
  const positions = excludeCanonicalCryptoAccounts(bridgePositions, canonicalAccountIds);
  if (positions.length === 0) return empty;

  // Convert the bridge's native/quote values into the reporting currency at the
  // latest close (identity for a USD Space). Positions with a null value carry no
  // value contribution but are still real holdings (hasAny stays true).
  const moneyCtx = await buildSpaceConversionContext(
    { reportingCurrency },
    { currencies: positions.map((p) => p.currency ?? null), dates: [yesterdayUTCISO()] },
  );
  const closeISO = yesterdayUTCISO();
  let anyEstimated = false;
  const toTarget = (value: number, currency: string | null): number => {
    const c = convertMoney({ amount: value, currency: currency ?? null }, closeISO, moneyCtx);
    if (c.estimated) anyEstimated = true;
    return c.amount;
  };

  let total = 0, invested = 0, cash = 0;
  const fullBySymbol = new Map<string, { symbol: string; name: string; value: number }>();

  for (const p of positions) {
    if (p.value == null) continue;
    const v = toTarget(p.value, p.currency);
    total += v;
    if (p.isCash) { cash += v; continue; } // crypto is not cash, but respect the flag
    invested += v;
    const symbol = p.symbol ?? p.name ?? p.financialAccountId;
    const name   = p.name ?? p.symbol ?? symbol;
    const existing = fullBySymbol.get(symbol);
    if (existing) existing.value += v;
    else fullBySymbol.set(symbol, { symbol, name, value: v });
  }

  return {
    total, invested, cash,
    fullPositions: [...fullBySymbol.values()],
    anyEstimated, hasAny: true,
  };
}

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
  const asOf = todayIso();

  // Reporting currency (also used for the crypto arm's conversions). The two
  // canonical valuations resolve the same currency from the Space internally.
  const spaceRow = await db.space.findUnique({
    where:  { id: spaceId },
    select: { reportingCurrency: true },
  });
  const reportingCurrency = spaceRow?.reportingCurrency ?? DEFAULT_DISPLAY_CURRENCY;

  // FULL detail (visibility inside the seam) + all-visibility aggregate value —
  // read together. The crypto transitional arm depends on the canonical rows
  // (CANONICAL WINS: it excludes wallets already on the spine), so it reads next.
  const [current, allView] = await Promise.all([
    getCurrentPositions({ spaceId }, { asOf }),
    getInvestmentValueAsOf({ spaceId, asOf, visibilityScope: 'all' }),
  ]);

  // Custody accounts already represented canonically — the exclusion set for the
  // legacy crypto bridge, so an on-spine wallet is never counted twice.
  const canonicalAccountIds = new Set(current.rows.map((r) => r.accountId));
  const crypto = await readCryptoHoldings(spaceId, reportingCurrency, canonicalAccountIds);

  const fullRows: CanonicalPositionRow[] = current.rows.map((r) => ({
    instrumentId:   r.instrumentId,
    symbol:         r.symbol,
    name:           r.name,
    reportingValue: r.reportingValue,
    isCash:         r.isCash,
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

  const data = buildHoldingsSummary({ scopeHint, fullRows, allScope, crypto });
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
