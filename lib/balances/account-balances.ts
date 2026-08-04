/**
 * lib/balances/account-balances.ts   (V27-L2 — BALANCE AUTHORITY)
 *
 * THE canonical current-balance authority, and **the only module in the product
 * permitted to read `FinancialAccount.availableBalance` as a value.** Every other
 * surface asks this module and receives a NAMED quantity or an explicit refusal.
 * lib/balances/balance-boundary.test.ts enforces that boundary repo-wide.
 *
 * Pure: no DB, no React, no clock. Freshness is COMPOSED from the V27-L1
 * authority (`AccountFreshness`), never re-derived here — this module knows
 * nothing about ageing a timestamp, and that is deliberate.
 *
 * ── The account-type rules, and the evidence behind each ────────────────────
 *
 * FinancialAccount.type is coarse (checking | savings | investment | crypto |
 * debt | other), so the rules key on `type` plus whatever additional evidence
 * the row actually carries. Plaid's `depository/cash management` maps to
 * `checking` (lib/plaid/account-type.ts), so cash-management accounts are
 * covered by the depository rule.
 *
 *   checking · savings  (incl. cash management)
 *       observed = ledger balance
 *       available = AVAILABLE_CASH — reachable cash, a DIFFERENT quantity from
 *       the ledger balance and never a substitute for it. CHASE COLLEGE holds
 *       $5,106.77 on the ledger and $1,106.77 reachable; showing the first where
 *       the second belongs overstates spendable money by $4,000.
 *
 *   debt
 *       observed = the signed liability balance; `debt.owed` is amountOwed()
 *       through lib/debt/balance-semantics — never recomputed here.
 *       available = AVAILABLE_CREDIT, and ONLY when the row carries evidence
 *       that it is a revolving line (a creditLimit, or a revolving debtSubtype).
 *       ⚠️ Both live Plaid cards have debtSubtype NULL — Chase CREDIT CARD and
 *       the Amex Platinum — so keying this on debtSubtype alone would have
 *       silently mis-typed exactly the two accounts that matter. creditLimit is
 *       the evidence that actually exists.
 *       An INSTALLMENT loan (mortgage / auto / student / personal) has no
 *       available quantity: NOT_APPLICABLE.
 *
 *   investment
 *       observed = account value.
 *       available = SETTLED_CASH — uninvested cash INSIDE the account, never the
 *       account's value. Schwab Individual: $901.66 of value, $0.00 settled cash
 *       (all six holdings are securities). Robinhood: $484.25 value, $471.21
 *       settled cash, $13.09 of positions. Schwab LLC reports settled cash equal
 *       to its value — because it holds no securities at all; that is the
 *       provider's own number, not a substitution by us.
 *
 *   crypto
 *       No amount ever escapes. A self-custodied wallet has no provider concept
 *       of "available" at all (NOT_APPLICABLE); an exchange row that does carry a
 *       figure is SEMANTICS_UNATTESTED, because FM's `crypto` type does not
 *       record whether that figure is settled cash, withdrawable balance, or
 *       something else. Naming it would be inventing semantics.
 *
 *   other  (manual assets, seed rows)
 *       observed = the stated value. NOT_APPLICABLE — a house has no available
 *       balance.
 *
 * ── Null stays null ─────────────────────────────────────────────────────────
 *
 * A null `availableBalance` NEVER falls back to the observed balance. The
 * UNAVAILABLE arm of AvailableClaim carries no `amount` field, so that fallback
 * is not expressible, let alone accidental.
 */

import { amountOwed, creditBalance, liabilityState, type LiabilityState } from "@/lib/debt/balance-semantics";
import type { AccountFreshness } from "@/lib/freshness/observation";
import { resolveAccountFreshness, type AccountFreshnessInput } from "@/lib/freshness/observation";
import {
  availableClaim, claim, unavailable,
  type AvailableClaim, type QuantityClaim,
} from "./quantities";
import { NO_PENDING, type PendingContribution } from "./pending-evidence";

/** Debt subtypes whose `available` figure is an unused credit line. */
const REVOLVING_SUBTYPES = new Set(["credit_card", "line_of_credit", "heloc"]);
/** Debt subtypes that amortise — no "available" quantity exists. */
const INSTALLMENT_SUBTYPES = new Set(["mortgage", "auto_loan", "student_loan", "personal_loan"]);

/** Everything the authority needs, in provider-neutral terms. */
export interface AccountBalanceInput {
  accountId: string;
  /** FinancialAccount.type: checking | savings | investment | crypto | debt | other. */
  accountType: string;
  /** FinancialAccount.debtSubtype. Null on both live Plaid cards — see header. */
  debtSubtype?: string | null;
  currency: string;
  /** FinancialAccount.balance — the observed ledger balance, sign as stored. */
  balance: number;
  /**
   * FinancialAccount.availableBalance, forwarded RAW. This parameter is the one
   * sanctioned crossing point for that column; interpreting it is this module's
   * whole job. Undefined is treated exactly as null.
   */
  availableBalance?: number | null;
  /** FinancialAccount.creditLimit — evidence that a debt row is revolving. */
  creditLimit?: number | null;
  /**
   * True when this is a self-custodied wallet (FinancialAccount.walletAddress
   * set). An on-chain balance has no provider "available" concept.
   */
  isSelfCustodyWallet?: boolean;
  /** From V27-L1. Composed, never re-derived. */
  freshness: AccountFreshness;
}

/** Debt-only exposure, through the existing balance-semantics authority. */
export interface DebtClaims {
  /** amountOwed(balance) — a credit balance is ZERO debt, never negative debt. */
  owed: QuantityClaim;
  /** creditBalance(balance) when the issuer owes the user; null otherwise. */
  issuerCredit: QuantityClaim | null;
  state: LiabilityState;
}

/** The canonical current-balance answer for one account. */
export interface AccountBalances {
  accountId: string;
  accountType: string;
  currency: string;
  /** Always present. The provider's last ledger figure, quantity-named. */
  observed: QuantityClaim;
  /** The type-aware reading of availableBalance, or an explicit refusal. */
  available: AvailableClaim;
  /** Present only for `type === "debt"`. */
  debt: DebtClaims | null;
  /** Travels with every claim so no surface can show a figure without its age. */
  freshness: AccountFreshness;
}

/**
 * Resolve one account's current balances. Pure and clock-free — the clock
 * already entered via `freshness`.
 */
export function resolveAccountBalances(input: AccountBalanceInput): AccountBalances {
  const observed = claim("OBSERVED_LEDGER", input.balance);
  const isDebt = input.accountType === "debt";

  return {
    accountId:   input.accountId,
    accountType: input.accountType,
    currency:    input.currency,
    observed,
    available:   resolveAvailable(input),
    debt: isDebt
      ? {
          owed:         claim("AMOUNT_OWED", amountOwed(input.balance)),
          issuerCredit: creditBalance(input.balance) > 0
            ? claim("ISSUER_CREDIT", creditBalance(input.balance))
            : null,
          state: liabilityState(input.balance),
        }
      : null,
    freshness: input.freshness,
  };
}

/**
 * The type-aware interpretation. Every branch either names a quantity or
 * refuses; none returns the observed balance.
 */
function resolveAvailable(input: AccountBalanceInput): AvailableClaim {
  const raw = input.availableBalance ?? null;

  switch (input.accountType) {
    // ── Depository — reachable cash ─────────────────────────────────────────
    case "checking":
    case "savings":
      return raw === null
        ? unavailable("PROVIDER_DID_NOT_REPORT")
        : availableClaim("AVAILABLE_CASH", raw);

    // ── Investment — settled cash inside the account, never its value ────────
    case "investment":
      return raw === null
        ? unavailable("PROVIDER_DID_NOT_REPORT")
        : availableClaim("SETTLED_CASH", raw);

    // ── Crypto — no amount ever escapes ─────────────────────────────────────
    case "crypto":
      // A self-custodied wallet: the chain reports a balance, and nothing else.
      if (input.isSelfCustodyWallet) return unavailable("NOT_APPLICABLE");
      // An exchange row: a figure may exist, but FM's coarse `crypto` type does
      // not record what it represents. Refusing is the honest answer.
      return raw === null
        ? unavailable("PROVIDER_DID_NOT_REPORT")
        : unavailable("SEMANTICS_UNATTESTED");

    // ── Debt — available CREDIT, and only with evidence of a revolving line ──
    case "debt": {
      const subtype = input.debtSubtype ?? null;
      if (subtype !== null && INSTALLMENT_SUBTYPES.has(subtype)) {
        // An amortising loan has no available quantity, whatever arrived.
        return unavailable("NOT_APPLICABLE");
      }
      const revolving =
        (subtype !== null && REVOLVING_SUBTYPES.has(subtype)) ||
        input.creditLimit != null;
      if (raw === null) return unavailable("PROVIDER_DID_NOT_REPORT");
      // A figure with no evidence of what kind of liability this is: refuse
      // rather than assume it is credit headroom.
      return revolving
        ? availableClaim("AVAILABLE_CREDIT", raw)
        : unavailable("SEMANTICS_UNATTESTED");
    }

    // ── Manual assets and anything unrecognised ─────────────────────────────
    default:
      return unavailable("NOT_APPLICABLE");
  }
}

/** A FinancialAccount-shaped row, as every caller already selects it. */
export interface AccountBalanceRow {
  id: string;
  type: string;
  currency: string;
  balance: number;
  availableBalance?: number | null;
  creditLimit?: number | null;
  debtSubtype?: string | null;
  walletAddress?: string | null;
  /** Fourth Meridian's write clock. */
  lastUpdated: Date | string | null;
  /** The institution's own clock. Null stays null. */
  balanceLastUpdatedAt?: Date | string | null;
  /** Optional ledger evidence, forwarded to the freshness authority. */
  ledgerThroughDate?: Date | string | null;
  ledgerQueried?: boolean;
}

/**
 * Convenience: resolve freshness and balances together from a row. `now` is
 * required — it is the freshness authority's clock and there is no default.
 */
export function resolveRowBalances(row: AccountBalanceRow, now: Date): AccountBalances {
  const freshnessInput: AccountFreshnessInput = {
    accountId:         row.id,
    ingestedAt:        row.lastUpdated,
    providerBalanceAt: row.balanceLastUpdatedAt ?? null,
    ledgerThroughDate: row.ledgerThroughDate ?? null,
    ledgerQueried:     row.ledgerQueried,
    balance:           row.balance,
  };
  return resolveAccountBalances({
    accountId:           row.id,
    accountType:         row.type,
    debtSubtype:         row.debtSubtype ?? null,
    currency:            row.currency,
    balance:             row.balance,
    availableBalance:    row.availableBalance ?? null,
    creditLimit:         row.creditLimit ?? null,
    isSelfCustodyWallet: !!row.walletAddress,
    freshness:           resolveAccountFreshness(freshnessInput, now),
  });
}


// ── Reconciliation (V27-L3) ──────────────────────────────────────────────────

/**
 * The canonical reconciliation vocabulary, reused verbatim from the historical
 * engine — NOT a parallel confidence model.
 */
export type ReconciliationState =
  /** Evidence and the provider's own figure agree to the cent. */
  | "EXACT"
  /** Part of the gap is explained by pending; a residual remains UNEXPLAINED and
   *  is reported, never absorbed. */
  | "PARTIALLY_ATTRIBUTED"
  /** No attested provider figure to reconcile against. Not a failure. */
  | "UNAVAILABLE"
  /** The provider reports MORE reachable than observed-plus-pending can support.
   *  Pending movements cannot produce this direction, so the two disagree. */
  | "CONTRADICTORY";

/** Which identity was applied. `NONE` means no identity fits this account shape. */
export type ReconciliationBasis = "DEPOSITORY" | "REVOLVING_CREDIT" | "NONE";

/** A cent. Below this, float noise — above it, a real residual. */
export const RECONCILIATION_TOLERANCE = 0.01;

export interface Reconciliation {
  basis: ReconciliationBasis;
  state: ReconciliationState;
  /** The provider-observed pending movements counted, and their ids. */
  pending: PendingContribution;
  /**
   * Observed plus pending. NULL unless at least one pending row exists — with no
   * pending evidence there is nothing to predict FROM, and relabelling an
   * untouched observed balance "predicted" would be a claim without a basis.
   */
  predicted: QuantityClaim | null;
  /**
   * The residual, in the account's native currency, or null when it could not be
   * computed. POSITIVE means the provider shows less reachable than our evidence
   * accounts for — money held back that no transaction explains.
   */
  unexplained: number | null;
  /**
   * What a liquidity surface may claim is reachable, or null when unknown. Only
   * ever populated for cash accounts.
   */
  reachable: QuantityClaim | null;
  /** One deterministic sentence, safe to render. Never contains an account name. */
  explanation: string;
}

/**
 * Reconcile one account's current state against provider-observed pending
 * movements. Pure; `pending` is supplied by loadPendingEvidence.
 *
 * ── The depository identity, in the signs this repository actually stores ────
 *
 * Fourth Meridian stores NEGATIVE for money out (Plaid's opposite convention is
 * flipped once, at ingest). So a pending outflow is already negative and the
 * identity adds rather than subtracts:
 *
 *     predicted   = observed + Σpending
 *     unexplained = observed + Σpending − availableCash      ( = predicted − available )
 *
 * Proven on the corpus:
 *     CHASE COLLEGE   5,106.77 + (−4,000.00) − 1,106.77 =     0.00  → EXACT
 *     Amex HYSA       6,315.04 +      0.00   − 2,315.04 = 4,000.00  → PARTIALLY_ATTRIBUTED
 *
 * ── The revolving-credit identity is DIFFERENT, and must be ─────────────────
 *
 * Available CREDIT is not available cash, and a card's pending charges consume
 * the credit line rather than a cash balance. Forcing the depository formula
 * onto a card compares a $562 debt against a $33,022 credit line. Instead:
 *
 *     pendingCharges = −Σpending                      (charges stored negative)
 *     predictedOwed  = amountOwed(observed) + pendingCharges
 *     impliedCredit  = creditLimit − predictedOwed
 *     unexplained    = impliedCredit − availableCredit
 *
 * Proven on the corpus (Chase CREDIT CARD):
 *     owed 562.37 + charges 77.60 = 639.97 owed predicted
 *     33,700.00 − 639.97 = 33,060.03 implied, against 33,022.48 reported
 *     → 37.55 of credit line consumed that no pending row explains.
 *
 * The identity needs a USABLE limit. The Amex Platinum reports creditLimit 0.00
 * (a charge card with no preset limit), which is not a ceiling to subtract from —
 * that account reconciles UNAVAILABLE rather than producing a nonsense residual.
 *
 * ── Everything else ─────────────────────────────────────────────────────────
 *
 * Investment, crypto, manual and installment-loan accounts get basis NONE. In
 * particular an investment account is NOT reconciled: its settled cash and its
 * value are different quantities, and their difference is invested positions —
 * running the depository identity over Schwab Individual would report $901.66 of
 * securities as an "unexplained hold".
 */
export function reconcileAccount(
  b: AccountBalances,
  pending: PendingContribution = NO_PENDING,
  creditLimit?: number | null,
): Reconciliation {
  const isCash = b.accountType === "checking" || b.accountType === "savings";
  const avail = b.available;

  // ── Depository ────────────────────────────────────────────────────────────
  if (isCash) {
    const predicted = pending.count > 0
      ? claim("PREDICTED_CASH", b.observed.amount + pending.sum)
      : null;

    // Reachable prefers the provider's OWN attestation over our derivation: the
    // institution stating "this much is reachable" outranks a figure we computed.
    // Falls back to predicted, and to null (unknown) — never to the observed
    // ledger balance, which is the figure that overstates.
    const reachable =
      avail.status === "AVAILABLE" && avail.quantity === "AVAILABLE_CASH"
        ? claim("REACHABLE_CASH", avail.amount)
        : predicted
          ? claim("REACHABLE_CASH", predicted.amount)
          : null;

    if (avail.status !== "AVAILABLE" || avail.quantity !== "AVAILABLE_CASH") {
      return {
        basis: "DEPOSITORY",
        state: "UNAVAILABLE",
        pending,
        predicted,
        unexplained: null,
        reachable,
        explanation: predicted
          ? "No available-cash figure was reported, so the prediction from pending activity cannot be checked against the institution."
          : "No available-cash figure was reported, so reachable cash cannot be established.",
      };
    }

    const unexplained = b.observed.amount + pending.sum - avail.amount;
    return {
      basis: "DEPOSITORY",
      state: stateFor(unexplained),
      pending,
      predicted,
      unexplained,
      reachable,
      explanation: depositoryExplanation(unexplained, pending),
    };
  }

  // ── Revolving credit ──────────────────────────────────────────────────────
  if (b.accountType === "debt" && avail.status === "AVAILABLE" && avail.quantity === "AVAILABLE_CREDIT") {
    // ⚠️ The SIGNED balance, deliberately NOT amountOwed().
    //
    // `amountOwed` clamps a credit balance to zero, which is correct for "how
    // much debt do I have" and WRONG as an input here: an overpaid card has MORE
    // credit line available, not the same amount. The Chase card went to −68.78
    // during the V27-L4E refresh and the clamped form understated implied credit
    // by exactly that 68.78. `b.debt.owed` remains the debt figure everywhere it
    // belongs; this identity is about the LINE, not the exposure.
    const owed = b.observed.amount;
    // Charges are stored negative; the magnitude is what consumes the line.
    const pendingCharges = -pending.sum;
    // The PREDICTED figure is still a debt figure, so it clamps: a card in credit
    // owes nothing, and pending charges eat into the credit before they become
    // debt. Two different questions, two different quantities, one identity each.
    const predicted = pending.count > 0
      ? claim("PREDICTED_AMOUNT_OWED", Math.max(owed + pendingCharges, 0))
      : null;

    if (creditLimit == null || creditLimit <= 0) {
      return {
        basis: "REVOLVING_CREDIT",
        state: "UNAVAILABLE",
        pending,
        predicted,
        unexplained: null,
        reachable: null,
        explanation:
          "This card reports no usable credit limit, so available credit cannot be reconciled against what is owed.",
      };
    }

    const impliedCredit = creditLimit - (owed + pendingCharges);
    const unexplained = impliedCredit - avail.amount;
    return {
      basis: "REVOLVING_CREDIT",
      state: stateFor(unexplained),
      pending,
      predicted,
      unexplained,
      // A credit line is never reachable CASH. This stays null on every card.
      reachable: null,
      explanation: creditExplanation(unexplained, pending),
    };
  }

  // ── No identity fits ──────────────────────────────────────────────────────
  return {
    basis: "NONE",
    state: "UNAVAILABLE",
    pending,
    predicted: null,
    unexplained: null,
    reachable: null,
    explanation: noIdentityExplanation(b.accountType),
  };
}

function stateFor(unexplained: number): ReconciliationState {
  if (Math.abs(unexplained) <= RECONCILIATION_TOLERANCE) return "EXACT";
  return unexplained > 0 ? "PARTIALLY_ATTRIBUTED" : "CONTRADICTORY";
}

/** Amounts are formatted by the surface; these sentences carry the MEANING. */
function depositoryExplanation(unexplained: number, pending: PendingContribution): string {
  const pendingClause = pending.count === 0
    ? "No pending activity was reported."
    : `${pending.count} pending ${pending.count === 1 ? "movement" : "movements"} reported by the institution.`;
  if (Math.abs(unexplained) <= RECONCILIATION_TOLERANCE) {
    return `${pendingClause} The observed balance and pending activity fully account for the available cash.`;
  }
  if (unexplained > 0) {
    return `${pendingClause} Part of this balance is unavailable and is not yet explained by any transaction.`;
  }
  return `${pendingClause} The institution reports more available cash than the observed balance and pending activity support.`;
}

function creditExplanation(unexplained: number, pending: PendingContribution): string {
  const pendingClause = pending.count === 0
    ? "No pending charges were reported."
    : `${pending.count} pending ${pending.count === 1 ? "charge" : "charges"} reported by the institution.`;
  if (Math.abs(unexplained) <= RECONCILIATION_TOLERANCE) {
    return `${pendingClause} The credit limit, what is owed, and pending charges fully account for the available credit.`;
  }
  if (unexplained > 0) {
    return `${pendingClause} Some of the credit line is consumed by activity no transaction explains yet.`;
  }
  return `${pendingClause} The institution reports more available credit than the limit and what is owed support.`;
}

function noIdentityExplanation(accountType: string): string {
  switch (accountType) {
    case "investment":
      return "Settled cash and account value are different quantities; the difference is invested positions, not an unexplained hold, so no reconciliation is attempted.";
    case "crypto":
      return "No provider figure attests what is reachable for this kind of account, so no reconciliation is attempted.";
    case "debt":
      return "This liability reports no available credit to reconcile against.";
    default:
      return "This kind of account carries no reachable figure to reconcile.";
  }
}

// ── Consumer-facing predicates ───────────────────────────────────────────────

/**
 * Reachable CASH for liquidity purposes, or null when unknown.
 *
 * Deliberately narrow: only AVAILABLE_CASH qualifies. AVAILABLE_CREDIT is a
 * borrowing capacity, not money — treating it as cash on the Chase card would
 * add $33,022.48 of the issuer's money to the user's liquidity. SETTLED_CASH is
 * reachable in principle but sits behind a brokerage's own settlement rules;
 * whether liquidity consumes it is a product decision that belongs with the
 * reconciliation slice, so this returns null for it rather than pre-deciding.
 *
 * Null means UNKNOWN and must never be read as zero.
 */
export function reachableCash(b: AccountBalances): number | null {
  return b.available.status === "AVAILABLE" && b.available.quantity === "AVAILABLE_CASH"
    ? b.available.amount
    : null;
}

/**
 * Unused credit line, or null. Never an asset, never cash, never a debt figure.
 */
export function availableCredit(b: AccountBalances): number | null {
  return b.available.status === "AVAILABLE" && b.available.quantity === "AVAILABLE_CREDIT"
    ? b.available.amount
    : null;
}

/**
 * Settled cash inside an investment account, or null. Never the account value.
 */
export function settledCash(b: AccountBalances): number | null {
  return b.available.status === "AVAILABLE" && b.available.quantity === "SETTLED_CASH"
    ? b.available.amount
    : null;
}
