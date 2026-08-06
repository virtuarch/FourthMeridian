/**
 * lib/transactions/liquidity.ts
 *
 * Cash Flow LIQUIDITY axis — the derived, spendable-cash CLASSIFIER
 * (classifyLiquidity): the single per-row authority for whether a row moved
 * spendable cash (CASH_IN / CASH_OUT / NEUTRAL / UNRESOLVED) and why (reason).
 * Pure and importable (no DB/React/next), unit-testable under tsx. The AGGREGATE
 * fold over this classifier lives in cash-flow-projection.ts (DayFacts); this
 * file only classifies a single row.
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
import type { Transaction } from "@/types";
// v2.6-DEBT-1 — the ONE debt-payment attestation rule.
import { isDebtPaymentAttested } from "@/lib/transactions/debt-payment-attestation";

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
  | "EARNED_INCOME"      // EARNED income arriving in a spendable (liquid) account
  | "INTEREST_INCOME"    // v2.6-TRUTH-5 — interest paid by a deposit account
  | "DIVIDEND_INCOME"    // v2.6-TRUTH-5 — a distribution from a holding
  | "OTHER_INCOME"       // v2.6-TRUTH-5 — income whose source is not established
  | "REAL_COST"          // SPENDING / FEE / INTEREST leaving the liquid tier
  | "REFUND"             // reversal of prior spend, cash back
  | "ISSUER_CREDIT"      // v2.6-TRUTH-7 — a card credit the issuer originated
                         // (rewards, statement credit, purchase reversal). Reduces
                         // what you owe; never income, never spendable cash in.
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
/** Canonical income class → its liquidity reason. One mapping, no re-derivation. */
const INCOME_REASON_BY_CLASS: Record<string, LiquidityReason> = {
  EARNED_INCOME:   "EARNED_INCOME",
  INTEREST_INCOME: "INTEREST_INCOME",
  DIVIDEND_INCOME: "DIVIDEND_INCOME",
  OTHER_INCOME:    "OTHER_INCOME",
};

/**
 * Canonical NOT_INCOME subtype → its liquidity reason. v2.6-TRUTH-7.
 *
 * ⚠️ A mapping, not a decision: every key is a subtype
 * lib/transactions/income-source.ts already assigned. A subtype absent from this
 * map resolves to UNRESOLVED rather than to a guess.
 */
const NOT_INCOME_REASON_BY_SUBTYPE: Record<string, LiquidityReason> = {
  ISSUER_CREDIT:     "ISSUER_CREDIT",
  REFUND_REVERSAL:   "REFUND",
  INTERNAL_TRANSFER: "INTERNAL_TRANSFER",
  LOAN_PROCEEDS:     "DEBT_PROCEEDS",
  SALE_PROCEEDS:     "ASSET_LIQUIDATION",
  CAPITAL_CONTRIBUTION: "OTHER_INCOME",
};

export function classifyLiquidity(tx: LiquidityTx, ctx: LiquidityContext): LiquidityClassification {
  const ft = tx.flowType ?? null;
  const ownTier = ctx.tierOf(tx.financialAccountId ?? tx.accountId ?? null);

  // INCOME — new economic value. Spendable only when it lands in the liquid tier;
  // income routed into an asset account (e.g. reinvested dividend) is earned but
  // not spendable, so it's neutral on the liquidity axis.
  if (isIncome(ft)) {
    // v2.6-TRUTH-5 — the reason follows the CANONICAL income class, not the bare
    // flow type. Every income row previously reported EARNED_INCOME, so the
    // Income-by-source card rendered "Earned income · 100.0%" over a window that
    // was $10,573.03 earned and $6.01 of deposit interest. The class is read off
    // the DTO; nothing is re-derived here.
    //
    // v2.6-TRUTH-7 — a NOT_INCOME row now reports WHICH not-income it is, from the
    // taxonomy's own subtype. It previously returned OTHER_INCOME, so a Microsoft
    // rebate on a credit card was filed under an income reason while the taxonomy
    // had already called it ISSUER_CREDIT. The effect (NEUTRAL) was right; the
    // word was not, and the word is what a surface prints.
    if (tx.incomeClass === "NOT_INCOME") {
      return make(ft, "NEUTRAL", NOT_INCOME_REASON_BY_SUBTYPE[tx.incomeSubtype ?? ""] ?? "UNRESOLVED", 0.9);
    }
    // ⚠️ This read `?? "EARNED_INCOME"` — a row whose read did not supply an income
    // class was ASSERTED to be salary. OTHER_INCOME is the reason that already
    // means exactly "income whose source is not established", so the uncertainty
    // is stated instead of hidden, and the cash effect is unchanged (both are
    // side "in", so no money leaves the Cash In total).
    //
    // Measured: 0 of 136 live INCOME rows lack an attribution — the serializer
    // emits one for every positive income row, and there are no negative ones.
    // This branch is reachable only from a read that did not select the evidence.
    const reason = INCOME_REASON_BY_CLASS[tx.incomeClass ?? ""] ?? "OTHER_INCOME";
    const confidence = tx.incomeClass ? 1 : 0.5;
    return ownTier === "liquid"
      ? make(ft, "CASH_IN", reason, confidence)
      : make(ft, "NEUTRAL", reason, Math.min(confidence, 0.7));
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
    // ⚠️ DEBT_PAYMENT is a claim about the DESTINATION, and `flowType` alone does
    // not attest one — it is frequently just the provider's own category, which
    // is derived from a descriptor and is wrong whenever an institution issues
    // both a card and a deposit account. A live $4,000 movement from checking
    // into a SAVINGS account carried a card-payment category for exactly that
    // reason; this branch returned CASH_OUT/DEBT_PAYMENT at confidence 1 for it,
    // so a savings transfer entered both household Cash Out and the Debt Payments
    // card while the transfer authority had already resolved its destination to
    // that savings account.
    //
    // On the CASH-side leg the counterparty IS the destination. When the
    // counterparty authority has named an owned account that is not a liability,
    // it contradicts the provider outright, and the structural fact wins — the
    // same precedence the income taxonomy already takes over `flowType`.
    //
    // ⚠️ Only the liquid side. On the LIABILITY-side leg the counterparty is the
    // SOURCE (money arriving on a card from checking), so its tier says nothing
    // about the destination and this must not fire — 109 live rows are in that
    // shape and stay NEUTRAL/DEBT_PAYMENT.
    //
    // Measured: exactly ONE row in the corpus is diverted by this.
    const destinationTier = ctx.tierOf(tx.counterpartyAccountId ?? null);

    // v2.6-DEBT-1 — POSITIVE ATTESTATION, not absence of contradiction.
    //
    // This branch used to divert a row only when the destination was KNOWN and
    // NOT a liability; an UNKNOWN destination fell through and was counted, at
    // confidence 1. A row was therefore admitted because nothing had disproved
    // it — and "nothing disproved it" is not evidence. The only thing standing
    // behind such a row is `flowType = DEBT_PAYMENT`, which is frequently just
    // the provider's category, derived from descriptor text, and wrong whenever
    // an institution issues both a card and a deposit account.
    //
    // Membership now requires the transfer authority to positively attest the
    // destination: an OWNED LIABILITY counterparty, or a proven liability
    // destination TYPE. `isDebtPaymentAttested` states that once
    // (lib/transactions/debt-payment-authority.ts).
    //
    // ⚠️ Only the CASH leg. On the LIABILITY-side leg the destination IS the own
    // account — money arriving on a card — which is structurally certain and
    // needs no counterparty evidence. Requiring attestation there would refuse
    // 109 live rows whose destination is not in question.
    if (ownTier === "liquid") {
      const attested = isDebtPaymentAttested({
        counterpartyTier: destinationTier,
        transferMaturity: (tx as { transferMaturity?: string | null }).transferMaturity ?? null,
      });
      // Unattested — including the previously-admitted "unknown destination" —
      // is a movement whose purpose is not established. It is resolved as the
      // transfer it structurally is, which leaves it UNRESOLVED when the
      // destination is genuinely unknown rather than asserting a debt payment.
      if (!attested) return classifyTransfer(tx, ownTier, ctx);
      return make(ft, "CASH_OUT", "DEBT_PAYMENT", 1);
    }
    return make(ft, "NEUTRAL", "DEBT_PAYMENT", 0.8);
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


/**
 * reason → the transaction ids classified into it, for one effect.
 *
 * Exists so a drill-down looks rows up by identity instead of re-running
 * `classifyLiquidity` in a React closure. The classification stays here, in the
 * authority, and is performed ONCE over the row set — which is what keeps a
 * slice incapable of disagreeing with the total beside it.
 */
export function liquidityIdsByReason(
  rows: readonly LiquidityTx[],
  ctx: Parameters<typeof classifyLiquidity>[1],
  effect: "CASH_IN" | "CASH_OUT",
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of rows) {
    const c = classifyLiquidity(t, ctx);
    if (c.effect !== effect) continue;
    out.set(c.reason, [...(out.get(c.reason) ?? []), t.id]);
  }
  return out;
}
