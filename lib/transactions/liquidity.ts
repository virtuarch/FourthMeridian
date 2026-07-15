/**
 * lib/transactions/liquidity.ts
 *
 * Cash Flow LIQUIDITY axis — the derived, spendable-cash view that sits ALONGSIDE
 * the existing economic view (aggregateCashFlow), never replacing it. Pure and
 * importable (no DB/React/next), unit-testable under tsx.
 *
 * Doctrine (see the liquidity-axis investigation): the economic KIND of a row is
 * a stable, persisted fact (Transaction.flowType). Whether the row moved
 * SPENDABLE cash is a RELATIONAL, tier-dependent projection over
 * (flowType, flowDirection, own-account tier, counterparty-account tier) — so it
 * is DERIVED here, never stored, and self-heals when accounts are reclassified or
 * a counterparty is linked later.
 *
 * Anchoring rule (avoids double-counting two-legged transfers): a transfer's
 * spendable effect is attributed to the LIQUID-tier leg. When the row's own
 * account is the non-liquid side, the spendable effect (if any) belongs to the
 * other leg, so this row is NEUTRAL. When the counterparty tier is unknown, we
 * do NOT guess — the row is UNRESOLVED.
 *
 * This file does NOT modify aggregateCashFlow; deriveCashFlowAxes calls it for
 * the economic axis and adds the liquidity axis next to it.
 */

import {
  isIncome,
  isRefund,
  isCostFlow,
  isDebtPayment,
  isInvestmentFlow,
  isTransfer,
} from "@/lib/transactions/flow-predicates";
import { accountTier, type AccountTier } from "@/lib/account-classifier";
import {
  aggregateCashFlow,
  type CashFlowTotals,
} from "@/lib/transactions/cash-flow";
import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal transaction shape the liquidity classifier reads. A superset of the
 * client `Transaction` (which lacks the server-only counterparty/financial-
 * account ids), so both the DTO and a Prisma row satisfy it. Nothing here is
 * persisted — these are inputs to a pure derivation.
 */
export type LiquidityTx = Transaction & {
  financialAccountId?:    string | null;
  counterpartyAccountId?: string | null;
};

/** Net spendable-cash effect of a single row. */
export type LiquidityEffect = "CASH_IN" | "CASH_OUT" | "NEUTRAL" | "UNRESOLVED";

/** Why the effect was assigned — the durable, explainable label for AI. */
export type LiquidityReason =
  | "EARNED_INCOME"      // INCOME arriving in a spendable (liquid) account
  | "REAL_COST"          // SPENDING / FEE / INTEREST leaving the liquid tier
  | "REFUND"             // reversal of prior spend, cash back
  | "ASSET_LIQUIDATION"  // asset tier → liquid (crypto/stock sale proceeds to bank)
  | "ASSET_DEPLOYMENT"   // liquid → asset tier (brokerage/crypto contribution)
  | "INVESTMENT_INFLOW"  // CF-2: liquid ← investment venue, resolved by transfer EVIDENCE
                         // (brokerage/exchange) when no owned account matched. Cash in,
                         // but NOT a proven sale — labeled "From investments", not liquidation.
  | "INVESTMENT_OUTFLOW" // CF-2: liquid → investment venue via evidence — "Money invested".
  | "PAYMENT_APP_INFLOW" // CF-2B: liquid ← payment-app rail (evidence), purpose unknown — "From payment apps".
  | "PAYMENT_APP_OUTFLOW"// CF-2B: liquid → payment-app rail (evidence), purpose unknown — "Payments through apps".
  | "ASSET_CONVERSION"   // INVESTMENT activity within the asset tier (sale kept on platform)
  | "DEBT_PROCEEDS"      // liability tier → liquid (loan/advance funded to cash)
  | "DEBT_PAYMENT"       // liquid → liability tier (card/loan payment)
  | "INTERNAL_TRANSFER"  // liquidity-neutral movement (liquid↔liquid, or non-liquid leg)
  | "NON_CASH"           // ADJUSTMENT / non-economic artifact
  | "UNRESOLVED";        // counterparty / tier unknowable → not guessed

export interface LiquidityClassification {
  effect:       LiquidityEffect;
  reason:       LiquidityReason;
  confidence:   number;            // 0..1
  economicKind: string | null;     // the row's flowType, for explainability
}

/** Resolver from an account id to its liquidity tier (caller owns the accounts). */
export interface LiquidityContext {
  tierOf: (accountId: string | null | undefined) => AccountTier;
}

// ─── Tier resolver convenience ─────────────────────────────────────────────────

/** Build a LiquidityContext from the user's accounts (id + type). Pure. */
export function tierResolver(accounts: { id: string; type: string }[]): LiquidityContext {
  const byId = new Map(accounts.map((a) => [a.id, accountTier(a.type)]));
  return { tierOf: (id) => (id ? byId.get(id) ?? "unknown" : "unknown") };
}

// ─── Classification ─────────────────────────────────────────────────────────────

function make(
  economicKind: string | null,
  effect: LiquidityEffect,
  reason: LiquidityReason,
  confidence: number,
): LiquidityClassification {
  return { effect, reason, confidence, economicKind };
}

/**
 * Classify one transaction's spendable-cash effect. Uses FlowType predicates for
 * the economic kind, then the own/counterparty account tiers to resolve the
 * liquidity face. Crypto/stock sales are NEVER income: an INVESTMENT row is an
 * asset conversion (NEUTRAL on this axis); its cash face only appears on the
 * transfer leg that lands the proceeds in a liquid account.
 */
export function classifyLiquidity(tx: LiquidityTx, ctx: LiquidityContext): LiquidityClassification {
  const ft = tx.flowType ?? null;
  const ownTier = ctx.tierOf(tx.financialAccountId ?? tx.accountId ?? null);

  // INCOME — new economic value. Spendable only when it lands in the liquid tier;
  // income routed into an asset account (e.g. reinvested dividend) is earned but
  // not spendable, so it's neutral on the liquidity axis.
  if (isIncome(ft)) {
    return ownTier === "liquid"
      ? make(ft, "CASH_IN", "EARNED_INCOME", 1)
      : make(ft, "NEUTRAL", "EARNED_INCOME", 0.7);
  }

  // REFUND — reversal of prior spend; small cash back when it hits liquid.
  if (isRefund(ft)) {
    return ownTier === "liquid"
      ? make(ft, "CASH_IN", "REFUND", 0.9)
      : make(ft, "NEUTRAL", "REFUND", 0.6);
  }

  // Cost flows (SPENDING / FEE / INTEREST) — real costs. They only drain
  // spendable cash when paid from the liquid tier; a credit-card purchase raises
  // debt instead, so the spendable drain happens later at debt payment.
  if (isCostFlow(ft)) {
    if (ownTier === "liquid")    return make(ft, "CASH_OUT", "REAL_COST", 1);
    if (ownTier === "liability") return make(ft, "NEUTRAL", "REAL_COST", 0.8);
    return make(ft, "NEUTRAL", "REAL_COST", 0.6);
  }

  // DEBT_PAYMENT — paying down a liability. Cash out when it leaves the liquid
  // tier; the liability-side leg (payment received on the card) is neutral.
  if (isDebtPayment(ft)) {
    return ownTier === "liquid"
      ? make(ft, "CASH_OUT", "DEBT_PAYMENT", 1)
      : make(ft, "NEUTRAL", "DEBT_PAYMENT", 0.8);
  }

  // INVESTMENT — asset conversion / security activity (net-worth-neutral). The
  // spendable movement, if any, is the transfer leg to/from a liquid account, so
  // this row itself is neutral. Never income.
  if (isInvestmentFlow(ft)) {
    return make(ft, "NEUTRAL", "ASSET_CONVERSION", 0.9);
  }

  // TRANSFER — the genuinely two-legged case; resolved by tiers.
  if (isTransfer(ft)) {
    return classifyTransfer(tx, ownTier, ctx);
  }

  // ADJUSTMENT — non-economic artifact.
  if (ft === "ADJUSTMENT") return make(ft, "NEUTRAL", "NON_CASH", 0.8);

  // null / UNKNOWN — cannot classify.
  return make(ft, "UNRESOLVED", "UNRESOLVED", 0.2);
}

function classifyTransfer(
  tx: LiquidityTx,
  ownTier: AccountTier,
  ctx: LiquidityContext,
): LiquidityClassification {
  const ft = tx.flowType ?? null;
  const cpId = tx.counterpartyAccountId ?? null;
  const cpTier = cpId ? ctx.tierOf(cpId) : "unknown";
  // Money INTO the own account? amount sign is primary; flowDirection breaks a 0 tie.
  const into = tx.amount > 0 || (tx.amount === 0 && tx.flowDirection === "INFLOW");

  // CF-2 — evidence-aware venue resolution. When the counterparty ACCOUNT is unknown
  // (no owned match) but canonical transfer evidence identifies an investment venue
  // (TransferDisposition = ASSET_VENUE_TRANSFER, derived from brokerage/exchange
  // evidence), the counterparty tier IS known — it is an asset venue — so the
  // spendable-cash crossing is recognized instead of left UNRESOLVED. Provider-neutral
  // (reads the derived disposition, never a provider string). Conservative labels:
  // "From investments" / "Money invested" — never a claimed sale (see doctrine).
  const disposition = (tx as { transferDisposition?: string | null }).transferDisposition ?? null;
  const venueEvidence = cpTier === "unknown" && disposition === "ASSET_VENUE_TRANSFER";
  // CF-2B — payment-app rail is HOW money moved, not its purpose. On a LIQUID account
  // the spendable cash genuinely moved (directional Cash In/Out); purpose stays unknown.
  // On a non-liquid (liability) account this branch never runs — a card charge is the
  // neutral leg, so Customg6w5n-style rows never enter Cash In/Out. Provider-neutral.
  const appEvidence = cpTier === "unknown" && disposition === "PAYMENT_APP_MOVEMENT";

  // Anchor to the liquid leg — only when the OWN account is liquid does this row
  // represent a spendable-cash movement. Otherwise the spendable effect (if any)
  // belongs to the other leg → neutral here.
  if (ownTier === "liquid") {
    if (into) {
      switch (cpTier) {
        case "asset":     return make(ft, "CASH_IN", "ASSET_LIQUIDATION", 1);
        case "liability": return make(ft, "CASH_IN", "DEBT_PROCEEDS", 1);
        case "liquid":    return make(ft, "NEUTRAL", "INTERNAL_TRANSFER", 1);
        default:
          if (venueEvidence) return make(ft, "CASH_IN", "INVESTMENT_INFLOW", 0.9);
          if (appEvidence)   return make(ft, "CASH_IN", "PAYMENT_APP_INFLOW", 0.9);
          return make(ft, "UNRESOLVED", "UNRESOLVED", 0.3);
      }
    }
    switch (cpTier) {
      case "asset":     return make(ft, "CASH_OUT", "ASSET_DEPLOYMENT", 1);
      case "liability": return make(ft, "CASH_OUT", "DEBT_PAYMENT", 1);
      case "liquid":    return make(ft, "NEUTRAL", "INTERNAL_TRANSFER", 1);
      default:
        if (venueEvidence) return make(ft, "CASH_OUT", "INVESTMENT_OUTFLOW", 0.9);
        if (appEvidence)   return make(ft, "CASH_OUT", "PAYMENT_APP_OUTFLOW", 0.9);
        return make(ft, "UNRESOLVED", "UNRESOLVED", 0.3);
    }
  }

  if (ownTier === "asset" || ownTier === "liability") {
    // Non-liquid leg of a transfer — neutral for the spendable axis.
    return make(ft, "NEUTRAL", "INTERNAL_TRANSFER", 0.8);
  }

  // Own tier unknown → cannot resolve.
  return make(ft, "UNRESOLVED", "UNRESOLVED", 0.2);
}

// ─── Two-axis aggregation ───────────────────────────────────────────────────────

const REASON_KEYS: LiquidityReason[] = [
  "EARNED_INCOME", "REAL_COST", "REFUND", "ASSET_LIQUIDATION", "ASSET_DEPLOYMENT",
  "INVESTMENT_INFLOW", "INVESTMENT_OUTFLOW", "PAYMENT_APP_INFLOW", "PAYMENT_APP_OUTFLOW",
  "ASSET_CONVERSION", "DEBT_PROCEEDS", "DEBT_PAYMENT", "INTERNAL_TRANSFER",
  "NON_CASH", "UNRESOLVED",
];

export interface CashFlowAxes {
  // ── Liquidity axis (spendable tier) ──
  cashIn:      number;   // Σ|amount| of CASH_IN rows
  cashOut:     number;   // Σ|amount| of CASH_OUT rows
  netCash:     number;   // cashIn − cashOut
  unresolved:  number;   // Σ|amount| of UNRESOLVED rows (transparency, not summed into net)
  byReason:    Record<LiquidityReason, number>;   // |amount| grouped by reason
  // ── Economic axis (reuses aggregateCashFlow, unmodified) ──
  economic:    CashFlowTotals;   // { income, spend, refunds, net }
}

/** Converted magnitude of a row at its own date; absent ctx ⇒ raw amount. */
function rowMagnitude(t: LiquidityTx, ctx?: ConversionContext): number {
  const amt = ctx
    ? convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, ctx).amount
    : t.amount;
  return Math.abs(amt);
}

/**
 * Both Cash Flow axes over a set of transactions. The economic axis is the
 * EXISTING aggregateCashFlow (untouched); the liquidity axis is derived per-row
 * via classifyLiquidity and summed, with a per-reason breakdown so callers/AI can
 * say "$16,044 cash in = $6,000 earned income + $10,044 asset liquidation".
 */
export function deriveCashFlowAxes(
  transactions: LiquidityTx[],
  liquidityCtx: LiquidityContext,
  moneyCtx?: ConversionContext,
): CashFlowAxes {
  const byReason = Object.fromEntries(REASON_KEYS.map((k) => [k, 0])) as Record<LiquidityReason, number>;
  let cashIn = 0, cashOut = 0, unresolved = 0;

  for (const t of transactions) {
    const c = classifyLiquidity(t, liquidityCtx);
    const amt = rowMagnitude(t, moneyCtx);
    byReason[c.reason] += amt;
    if (c.effect === "CASH_IN") cashIn += amt;
    else if (c.effect === "CASH_OUT") cashOut += amt;
    else if (c.effect === "UNRESOLVED") unresolved += amt;
  }

  return {
    cashIn,
    cashOut,
    netCash: cashIn - cashOut,
    unresolved,
    byReason,
    economic: aggregateCashFlow(transactions, moneyCtx),
  };
}
