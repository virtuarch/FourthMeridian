/**
 * lib/liquidity/historical-splice.ts  (LIQ-H1 — historical Liquidity splice)
 *
 * THE pure marketable-value splice at the heart of the historical Liquidity
 * engine. It answers ONE composition question and NO valuation question:
 *
 *   "Given the as-of account universe (getAccountsAsOf — cash/card walked back,
 *    everything else held flat) AND the canonical historical investment
 *    valuation (getInvestmentValueAsOf, scope 'all' — A8 price×qty×FX), what is
 *    the honest per-account Liquidity input row set at date T?"
 *
 * It REPLACES (never adds to) each investment/crypto account's held-flat estimate
 * with that account's A8 reporting value, and restamps its trust tier from the A8
 * per-instrument tiers. This is what makes marketable liquidity DERIVED-where-
 * covered instead of estimated-held-flat — WITHOUT inventing a second valuation
 * authority (A8 owns every price, quantity, and FX) and WITHOUT a second account
 * classifier: the splice is driven purely by which accounts A8 produced components
 * for. Only investment/crypto accounts carry PositionObservations, so A8's
 * component account-ids ARE the covered marketable set — the type partition stays
 * inside computeLiquidity, never re-derived here.
 *
 * ── Crypto counted exactly once (load-bearing — the historical Wealth bug) ─────
 * The prior net-worth cliff double-counted BTC by valuing it as an INVESTMENT (A8)
 * AND again as a DIGITAL ASSET. This splice cannot repeat that: each account
 * appears once in the getAccountsAsOf universe and is emitted once here; A8 values
 * only ever REPLACE that one row's balance — there is no parallel digital-asset
 * total to add. A crypto wallet with positions contributes its A8 value ONCE,
 * through the same 'crypto' → marketable bucket computeLiquidity already owns.
 * (Shared PositionObservation spine ≠ shared bucket.)
 *
 * PURE: no DB, no clock, no Prisma. Imports only the engine trust vocabulary and
 * the Liquidity core's row type. Unit-testable under tsx.
 */

import { worstTier } from "@/lib/perspective-engine/completeness";
import type { CompletenessTier } from "@/lib/perspective-engine/types";
import type { LiquidityAccountRow } from "@/lib/perspective-engine/lenses/liquidity.core";

/**
 * One account resolved to the as-of date by getAccountsAsOf, projected to exactly
 * the fields the splice needs — a LiquidityAccountRow plus the S2-stamped `tier`
 * (the honest trust of the walked-back / held-flat balance). No names, ever.
 */
export interface AsOfLiquidityRow extends LiquidityAccountRow {
  /** getAccountsAsOf tier: cash/card 'derived', held-flat 'estimated', pre-floor 'incomplete', present 'observed'. */
  tier: CompletenessTier;
}

/**
 * The only fields the splice reads from an A8 `InvestmentValuationView.components`
 * entry (an `InstrumentValuation`). A narrow structural input keeps this module
 * pure and lets the test drive it without the valuation engine.
 */
export interface MarketableComponent {
  accountId: string;
  /** Σ target-currency value of the instrument at T; null when unvalued (no price/quantity reached the date). */
  reportingValue: number | null;
  /** The instrument's worst contributing tier (A8 `overallTier`). */
  overallTier: CompletenessTier;
}

/** Spliced Liquidity rows plus their post-splice trust stamps (fed to buildLiquidityCompleteness). */
export interface SplicedLiquidity {
  rows: LiquidityAccountRow[];
  /** accountId → { tier, type } for EVERY emitted row (spliced or passed through). */
  stamps: Map<string, { tier: CompletenessTier; type: string }>;
}

interface AccountCoverage {
  valuedSum: number;
  anyValued: boolean;
  tiers: CompletenessTier[];
}

/**
 * Group A8 components by owning account: the valued subtotal (Σ over VALUED
 * components only — an unvalued instrument contributes NO number, exactly as A8
 * itself refuses to fold a null into a subtotal), whether ANY instrument valued,
 * and every instrument's tier (so an account with one unvalued instrument
 * restamps to `incomplete` via worstTier — the honest partial signal).
 */
function coverageByAccount(components: readonly MarketableComponent[]): Map<string, AccountCoverage> {
  const out = new Map<string, AccountCoverage>();
  for (const c of components) {
    const e = out.get(c.accountId) ?? { valuedSum: 0, anyValued: false, tiers: [] };
    e.tiers.push(c.overallTier);
    if (c.reportingValue != null && Number.isFinite(c.reportingValue)) {
      e.valuedSum += c.reportingValue;
      e.anyValued = true;
    }
    out.set(c.accountId, e);
  }
  return out;
}

/**
 * Splice the canonical historical investment valuation into the as-of account
 * universe. PURE.
 *
 * @param asOfRows          getAccountsAsOf rows, projected to AsOfLiquidityRow.
 * @param components        getInvestmentValueAsOf(scope 'all').components.
 * @param reportingCurrency the A8 view's reporting currency — spliced rows are
 *                          stamped in THIS currency so the downstream
 *                          ConversionContext (which targets the same Space
 *                          reporting currency) identity-converts them, never
 *                          double-FX'ing an already-reported value.
 *
 * Rule, per account:
 *   • A8 produced a VALUED component for it → REPLACE balance with the A8
 *     valued subtotal, currency := reportingCurrency, tier := worst A8 tier
 *     (derived when fully covered, incomplete when any instrument unvalued).
 *   • otherwise (no A8 value: balance-only investment/crypto, all-unvalued at
 *     this date, or a non-investment account) → PASS THROUGH unchanged: the
 *     getAccountsAsOf balance + tier stand (cash/card derived, held-flat
 *     estimated). NEVER zeroed — a balance-bearing account is never dropped for
 *     lack of position evidence (REG-1/REG-2 held-flat doctrine).
 */
export function spliceLiquidityRows(
  asOfRows: readonly AsOfLiquidityRow[],
  components: readonly MarketableComponent[],
  reportingCurrency: string,
): SplicedLiquidity {
  const coverage = coverageByAccount(components);
  const rows: LiquidityAccountRow[] = [];
  const stamps = new Map<string, { tier: CompletenessTier; type: string }>();

  for (const r of asOfRows) {
    const cov = coverage.get(r.id);
    if (cov && cov.anyValued) {
      // SPLICE — honest historical marketable value replaces the held-flat estimate.
      const tier = worstTier(cov.tiers);
      rows.push({
        id: r.id,
        type: r.type,
        balance: cov.valuedSum,
        currency: reportingCurrency, // already reported → identity-convert downstream
        creditLimit: r.creditLimit,
        lastUpdated: r.lastUpdated,
        visibilityLevel: r.visibilityLevel,
      });
      stamps.set(r.id, { tier, type: r.type });
    } else {
      // PASS THROUGH — getAccountsAsOf already resolved this row honestly.
      rows.push({
        id: r.id,
        type: r.type,
        balance: r.balance,
        currency: r.currency ?? null,
        creditLimit: r.creditLimit,
        lastUpdated: r.lastUpdated,
        visibilityLevel: r.visibilityLevel,
      });
      stamps.set(r.id, { tier: r.tier, type: r.type });
    }
  }

  return { rows, stamps };
}
