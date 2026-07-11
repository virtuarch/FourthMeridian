/**
 * lib/perspective-engine/lenses/asof-completeness.ts
 *
 * A5-P2/P3 — the PURE trust-envelope builders for the as-of-aware Liquidity and
 * Debt lens bindings. Kept out of the bindings themselves for the same reason
 * the lens math lives in *.core.ts: the bindings touch the DB (getAccountsAsOf,
 * conversion context) and cannot be unit-tested with tsx, whereas this module
 * imports ONLY the A5-S1 vocabulary + propagation helpers, so it fixture-tests
 * DB-free (liquidity.asof.test.ts / debt.asof.test.ts).
 *
 * It owns no resolution semantics — S2's getAccountsAsOf already stamped every
 * row with a { method, tier } drawn from the canonical CompletenessTier
 * vocabulary. This module only *propagates* those per-row tiers up to a single
 * Perspective-level `Completeness` envelope, using the S1 helpers (worstTier,
 * propagateCompleteness) rather than re-deriving the ordering or the OR.
 *
 * Pure: imports only ../completeness and ../types, so it trips none of the
 * engine's import-graph guards (no Prisma, no LLM, no request coupling) — see
 * engine.test.ts §4.
 */

import { propagateCompleteness, worstTier } from "../completeness";
import type { Completeness, CompletenessTier } from "../types";

/**
 * One contributing account's trust, reduced to exactly what the envelope needs:
 * its resolved tier and which per-Perspective bucket it belongs to. Names,
 * balances, and methods never reach here — only the tier and a bucket label.
 */
export interface AsOfComponentStamp {
  tier:      CompletenessTier;
  /** Bucket key in the lens's byComponent breakdown (e.g. "cash", "revolving"). */
  component: string;
}

/**
 * Which Liquidity bucket an account type contributes to. Mirrors the type
 * partitions in liquidity.core.ts (cash / marketable / illiquid / credit) so
 * the byComponent breakdown lines up with the metrics the lens reports. Any
 * unrecognised type fails to a generic "other" bucket rather than being dropped.
 */
export function liquidityComponent(accountType: string): string {
  switch (accountType) {
    case "checking":
    case "savings":    return "cash";
    case "investment":
    case "crypto":     return "marketable";
    case "other":      return "illiquid";
    case "debt":       return "credit";
    default:           return "other";
  }
}

/**
 * Which Debt bucket a row contributes to, keyed off the S2 resolution method
 * (the honest signal for revolving-vs-installment: a card walked back through
 * transactions is `card-walkback`; an installment loan with no history is
 * `held-flat`; a date before the account's floor is `before-coverage`).
 */
export function debtComponent(method: string): string {
  switch (method) {
    case "card-walkback":   return "revolving";
    case "held-flat":       return "installment";
    case "before-coverage": return "beyond-coverage";
    default:                return "debt"; // observed (present-day) / any other
  }
}

/**
 * Deterministic, name-free explanation of a Liquidity envelope's worst tier.
 * User-facing copy stays in the UI layer; this is the internal `reason` string.
 */
export function liquidityReason(tier: CompletenessTier, asOf: string): string {
  switch (tier) {
    case "observed":
      return `Balances are as reported on ${asOf}.`;
    case "derived":
      return `Cash and card balances are reconstructed from your transaction history as of ${asOf}.`;
    case "estimated":
      return `Cash and card balances are reconstructed as of ${asOf}; other holdings are held at their current value.`;
    case "incomplete":
      return `Balance history does not reach ${asOf} for every account, so the total is incomplete.`;
    case "unknown":
    default:
      return `Balances as of ${asOf} could not be determined.`;
  }
}

/** Debt counterpart of liquidityReason — revolving reconstructed, installment held flat. */
export function debtReason(tier: CompletenessTier, asOf: string): string {
  switch (tier) {
    case "observed":
      return `Debt balances are as reported on ${asOf}.`;
    case "derived":
      return `Revolving-card balances are reconstructed from your transaction history as of ${asOf}.`;
    case "estimated":
      return `Revolving-card balances are reconstructed as of ${asOf}; installment loans are held at their current balance.`;
    case "incomplete":
      return `Debt history does not reach ${asOf} for every account, so the total is incomplete.`;
    case "unknown":
    default:
      return `Debt balances as of ${asOf} could not be determined.`;
  }
}

/**
 * Reduce a set of per-account stamps to a single `Completeness` envelope:
 *   - tier         = the worst contributing tier (propagateCompleteness / worstTier)
 *   - conflict     = OR of the parts' conflict flags (none today — S2 emits no
 *                    conflict signal — so this is currently always false, but the
 *                    plumbing is honest for when reconciliation conflicts arrive)
 *   - byComponent  = per-bucket worst tier, never collapsed away (a Liquidity
 *                    result can be `derived` for cash and `estimated` for
 *                    marketable and must say so)
 *   - reason       = the lens-specific sentence for the overall tier
 *
 * `stamps` MUST be the CONTRIBUTING accounts only (summary-only rows are
 * excluded from the lens's provenance.accountIds and so never reach here — a
 * withheld account's trust tier can never leak into the envelope). Determinism:
 * byComponent's key order follows `stamps` order, which the binding drives from
 * the sorted provenance.accountIds, so equal inputs serialize identically.
 */
export function buildAsOfCompleteness(
  asOf:      string,
  stamps:    readonly AsOfComponentStamp[],
  reasonFor: (tier: CompletenessTier, asOf: string) => string,
): Completeness {
  const { tier, conflict } = propagateCompleteness(stamps.map((s) => ({ tier: s.tier })));
  const byComponent: Record<string, CompletenessTier> = {};
  for (const s of stamps) {
    byComponent[s.component] =
      s.component in byComponent ? worstTier([byComponent[s.component], s.tier]) : s.tier;
  }
  return { tier, conflict, reason: reasonFor(tier, asOf), byComponent };
}

/** Liquidity envelope over contributing rows. */
export function buildLiquidityCompleteness(
  asOf:   string,
  stamps: readonly AsOfComponentStamp[],
): Completeness {
  return buildAsOfCompleteness(asOf, stamps, liquidityReason);
}

/** Debt envelope over contributing rows. */
export function buildDebtCompleteness(
  asOf:   string,
  stamps: readonly AsOfComponentStamp[],
): Completeness {
  return buildAsOfCompleteness(asOf, stamps, debtReason);
}
