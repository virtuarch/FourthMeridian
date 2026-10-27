/**
 * lib/transactions/resolved-nature.ts
 *
 * v2.7-P0 — THE RESOLVED TRANSACTION NATURE CONTRACT. Pure, deterministic, no I/O.
 *
 * ONE answer to "what kind of movement was this row, and did it reduce debt?" for
 * every consumer that NARRATES or FILTERS a row (Daily Brief, AI tools, AI prose).
 * Contract document: docs/plans/RESOLVED-TRANSACTION-NATURE-CONTRACT-2026-10-27.md.
 *
 * ── The rule this exists to enforce ─────────────────────────────────────────
 *
 *     A transfer between two OWNED depository accounts NEVER reduces debt.
 *
 * The persisted `flowType` cannot be trusted alone for that: Plaid tags an ACH
 * pull initiated by a bank-and-card issuer `LOAN_PAYMENTS`, the context-free
 * classifier persists `DEBT_PAYMENT`, and only the transfer authority (which sees
 * the other leg) knows the money went to the owner's own savings. The write-time
 * correction (transfer-debt-payment-correction.ts) fixes NEW rows after each sync;
 * historical rows stay `DEBT_PAYMENT` until the owner-approved repair runs. This
 * contract makes every reader correct BEFORE and AFTER that repair.
 *
 * ── Precedence (first rung that speaks wins) ────────────────────────────────
 *
 *   1. USER     — `categorySource ∈ {USER_OVERRIDE, USER_RULE}`: the human's
 *                 flowType is the row's nature. A human "Payment" is a liability
 *                 payment whatever the evidence says.
 *   2. TRANSFER_AUTHORITY — `flowAuthority = TRANSFER_AUTHORITY`: the persisted
 *                 flowType IS the transfer authority's cross-row verdict.
 *   3. TRANSFER_EVIDENCE — the read-time evidence: the maturity (SAVINGS_TRANSFER /
 *                 CASH_TRANSFER / INVESTMENT_TRANSFER / INTERNAL_TRANSFER ⇒ an
 *                 owned non-liability destination ⇒ INTERNAL transfer; external
 *                 leaves ⇒ EXTERNAL transfer), the owned counterparty's account
 *                 type, and the debt-payment ATTESTATION rule
 *                 (debt-payment-attestation.ts: liability counterparty or
 *                 DEBT_PAYMENT maturity) — or, for the liability-side leg, the own
 *                 account being a liability (structurally certain).
 *   4. PROVIDER — the stored flowType / provider category. For a movement it can
 *                 never, alone, establish a liability payment: an unattested
 *                 `DEBT_PAYMENT` cash leg is an UNCLASSIFIED_MOVEMENT (purpose not
 *                 established), exactly as the money layer already refuses to
 *                 count it (liquidity.ts → classifyTransfer).
 *
 * ── Invariant (pinned by resolved-nature.test.ts) ───────────────────────────
 *
 * For every non-USER row, `reducesDebt && leg === "CASH"` holds EXACTLY when the
 * debt-payment authority (`selectDebtPaymentCashLegs`) counts the row. So a
 * sentence built from this contract can never claim a debt reduction the money
 * totals do not contain. (A USER "Payment" is the human's statement and is
 * honoured in narration; money totals keep their attestation rule — unchanged.)
 *
 * ⚠️ NO descriptor, merchant, institution or category string is read here. Every
 * input is a verdict of another authority, an account TYPE, or provenance.
 */

import { accountTier, type AccountTier } from "@/lib/account-classifier";
import { isDebtPaymentAttested } from "@/lib/transactions/debt-payment-attestation";
import { USER_CATEGORY_SOURCES } from "@/lib/transactions/transfer-debt-payment-correction";
import { EXTERNAL_MATURITIES, type TransferMaturity } from "@/lib/transactions/transfer-maturation";

/** What a row IS, for narration and filtering. */
export type TransactionNature =
  /** A payment toward an owned card or loan — the only nature that reduces debt. */
  | "LIABILITY_PAYMENT"
  /** Moved to an owned SAVINGS account. */
  | "INTERNAL_SAVINGS_TRANSFER"
  /** Moved to an owned CHECKING / cash-management account. */
  | "INTERNAL_CHECKING_TRANSFER"
  /** Moved to an owned investment / crypto account. */
  | "BROKERAGE_TRANSFER"
  /** Moved between owned accounts; the destination's type is not named. */
  | "INTERNAL_TRANSFER"
  /** Positive evidence the other side is not an owned account (a person, a venue, a provider-attested external counterparty). */
  | "EXTERNAL_TRANSFER"
  /** v2.7 owner ruling: a transfer to a bank account not connected here, derived
   *  only from the provider's generic bank-transfer venue — the destination is
   *  NOT confirmed (it may be the user's own, unconnected or not yet matched).
   *  Still a transfer (never spending/income/debt), never claimed external. */
  | "TRANSFER_DESTINATION_UNCONFIRMED"
  /** Money changed form (cash withdrawal / deposit). */
  | "CASH_MOVEMENT"
  /** A movement whose purpose is NOT established. Never narrated as anything more. */
  | "UNCLASSIFIED_MOVEMENT"
  | "SPENDING" | "INCOME" | "REFUND" | "ISSUER_CREDIT"
  | "INVESTMENT_ACTIVITY" | "ADJUSTMENT"
  /** Not classified at all (flowType UNKNOWN / null, no transfer evidence). */
  | "UNCLASSIFIED";

export type NatureBasis = "USER" | "TRANSFER_AUTHORITY" | "TRANSFER_EVIDENCE" | "LIABILITY_LEG" | "PROVIDER";

export interface NatureEvidence {
  /** Persisted Transaction.flowType. */
  flowType: string | null | undefined;
  /** Signed amount (provider fact): negative = money left the row's own account. */
  amount: number;
  /** Persisted Transaction.flowAuthority (CLASSIFIER | TRANSFER_AUTHORITY | CRYPTO_LEDGER). */
  flowAuthority?: string | null;
  /** Persisted Transaction.categorySource — USER_OVERRIDE / USER_RULE mark a human's choice. */
  categorySource?: string | null;
  /** The transfer authority's destination verdict (read-time maturity). */
  transferMaturity?: string | null;
  /** Projected transfer disposition, where no maturity exists. */
  transferDisposition?: string | null;
  /** FinancialAccount.type of the row's OWN account, when the caller can resolve it. */
  ownAccountType?: string | null;
  /** FinancialAccount.type of the owned, visible counterparty, when there is one. */
  counterpartyAccountType?: string | null;
  /** True when an owned counterparty exists (persisted or read-time), type known or not. */
  hasOwnedCounterparty?: boolean;
  /** Canonical income subtype (income-source.ts), on inflows. */
  incomeSubtype?: string | null;
}

export interface ResolvedTransactionNature {
  nature: TransactionNature;
  basis: NatureBasis;
  /**
   * The FlowType a consumer should FILTER and NARRATE this row as. Equals the
   * persisted flowType except for movements: DEBT_PAYMENT only for a liability
   * payment; every other movement of a stored DEBT_PAYMENT/TRANSFER row is TRANSFER.
   */
  flow: string | null;
  /** True only for a liability payment (paid toward a card or loan). */
  reducesDebt: boolean;
  /**
   * Which leg of a two-legged payment this is: CASH (the leg debt totals count) or
   * LIABILITY (money arriving on the card — the same payment, never counted twice).
   */
  leg: "CASH" | "LIABILITY" | null;
  /** True when the evidence establishes both sides are the user's own accounts. */
  betweenOwnAccounts: boolean;
}

/** Natures that are a movement of the user's money between places (never spending/income). */
export const MOVEMENT_NATURES: ReadonlySet<TransactionNature> = new Set<TransactionNature>([
  "LIABILITY_PAYMENT", "INTERNAL_SAVINGS_TRANSFER", "INTERNAL_CHECKING_TRANSFER",
  "BROKERAGE_TRANSFER", "INTERNAL_TRANSFER", "EXTERNAL_TRANSFER", "TRANSFER_DESTINATION_UNCONFIRMED",
  "CASH_MOVEMENT", "UNCLASSIFIED_MOVEMENT",
]);

/** Natures established as between the user's own accounts. */
export const INTERNAL_NATURES: ReadonlySet<TransactionNature> = new Set<TransactionNature>([
  "INTERNAL_SAVINGS_TRANSFER", "INTERNAL_CHECKING_TRANSFER", "BROKERAGE_TRANSFER", "INTERNAL_TRANSFER",
]);

/**
 * Plain words for a nature — the ONLY phrasing an AI surface may attach to a row.
 * Internal transfers say "moved between your accounts"; nothing but a liability
 * payment mentions debt.
 */
export const NATURE_DESCRIPTION: Record<TransactionNature, string> = {
  LIABILITY_PAYMENT:          "Payment toward a card or loan (lowers what is owed)",
  INTERNAL_SAVINGS_TRANSFER:  "Moved between your own accounts (to savings) — not a debt payment, not spending",
  INTERNAL_CHECKING_TRANSFER: "Moved between your own accounts (to checking) — not a debt payment, not spending",
  BROKERAGE_TRANSFER:         "Moved between your own accounts (to investments) — not a debt payment, not spending",
  INTERNAL_TRANSFER:          "Moved between your own accounts — not a debt payment, not spending",
  EXTERNAL_TRANSFER:          "Sent to or received from an account that is not yours — purpose not stated",
  TRANSFER_DESTINATION_UNCONFIRMED: "Moved to or from a bank account not connected here — destination not yet confirmed; not spending, not a debt payment",
  CASH_MOVEMENT:              "Cash withdrawal or deposit",
  UNCLASSIFIED_MOVEMENT:      "Money movement whose purpose is not established — do not call it a debt payment, spending or income",
  SPENDING:                   "Spending",
  INCOME:                     "Income",
  REFUND:                     "Refund",
  ISSUER_CREDIT:              "Credit from a card issuer",
  INVESTMENT_ACTIVITY:        "Investment activity",
  ADJUSTMENT:                 "Balance adjustment",
  UNCLASSIFIED:               "Not classified",
};

const MOVEMENT_FLOWS = new Set(["DEBT_PAYMENT", "TRANSFER"]);

/** Maturity → internal/external nature. A maturity outside the map names nothing here. */
const NATURE_OF_MATURITY: Partial<Record<TransferMaturity, TransactionNature>> = {
  SAVINGS_TRANSFER:    "INTERNAL_SAVINGS_TRANSFER",
  CASH_TRANSFER:       "INTERNAL_CHECKING_TRANSFER",
  INVESTMENT_TRANSFER: "BROKERAGE_TRANSFER",
  INTERNAL_TRANSFER:   "INTERNAL_TRANSFER",
  CASH_MOVEMENT:       "CASH_MOVEMENT",
};

/** Owned counterparty account type → internal nature (liability handled separately). */
function natureOfCounterpartyType(type: string | null | undefined): TransactionNature | null {
  switch (type) {
    case "savings":    return "INTERNAL_SAVINGS_TRANSFER";
    case "checking":   return "INTERNAL_CHECKING_TRANSFER";
    case "investment":
    case "crypto":     return "BROKERAGE_TRANSFER";
    case "other":      return "INTERNAL_TRANSFER";
    default:           return null;
  }
}

/**
 * The non-liability kind of a movement, from the transfer evidence. Null when the
 * evidence establishes nothing (⇒ UNCLASSIFIED_MOVEMENT for the caller).
 */
function transferKind(e: NatureEvidence): TransactionNature | null {
  const m = e.transferMaturity as TransferMaturity | null | undefined;
  if (m) {
    const n = NATURE_OF_MATURITY[m];
    if (n) return n;
    if (m === "EXTERNAL_DEPOSITORY_TRANSFER") return "TRANSFER_DESTINATION_UNCONFIRMED";
    if (EXTERNAL_MATURITIES.has(m)) return "EXTERNAL_TRANSFER";
  }
  const byType = natureOfCounterpartyType(e.counterpartyAccountType);
  if (byType) return byType;
  // An owned counterparty whose TYPE is not known: internal, but which kind of
  // account is not stated. On a provider DEBT_PAYMENT row that is not enough — the
  // unseen account could be the card — so the row stays unclassified (the money
  // layer leaves it UNRESOLVED for the same reason).
  if (e.hasOwnedCounterparty === true && accountTier(e.counterpartyAccountType) === "unknown"
      && e.flowType !== "DEBT_PAYMENT") {
    return "INTERNAL_TRANSFER";
  }
  switch (e.transferDisposition) {
    case "INTERNAL_TRANSFER":      return "INTERNAL_TRANSFER";
    // The disposition is the same derived bank-venue evidence ⇒ not confirmed.
    case "EXTERNAL_BANK_TRANSFER": return "TRANSFER_DESTINATION_UNCONFIRMED";
    case "CASH_MOVEMENT":          return "CASH_MOVEMENT";
    default:                       return null;
  }
}

function make(
  nature: TransactionNature, basis: NatureBasis, stored: string | null,
  leg: ResolvedTransactionNature["leg"] = null,
  e?: NatureEvidence,
): ResolvedTransactionNature {
  const amount = e?.amount ?? 0;
  const ownedOtherSide = e?.hasOwnedCounterparty === true || accountTier(e?.counterpartyAccountType) !== "unknown";
  const isPayment = nature === "LIABILITY_PAYMENT";
  const flow = stored != null && MOVEMENT_FLOWS.has(stored)
    ? (isPayment ? "DEBT_PAYMENT" : "TRANSFER")
    : stored;
  return {
    nature, basis, flow,
    // The liability-side leg lowers what is owed only when money ARRIVES on it.
    reducesDebt: isPayment && (leg !== "LIABILITY" || amount > 0),
    leg: isPayment ? leg : null,
    betweenOwnAccounts: INTERNAL_NATURES.has(nature) || (isPayment && ownedOtherSide),
  };
}

/** Economic (non-movement) flows: the stored flowType, refined by the income taxonomy. */
function economicNature(e: NatureEvidence, stored: string | null, basis: NatureBasis): ResolvedTransactionNature | null {
  switch (stored) {
    case "SPENDING": case "FEE": case "INTEREST":
      // v2.7-B — a cost flow with money IN (a fee rebate, an interest reversal) is a
      // reversal of spending: the economic fold nets it as a credit and liquidity
      // calls it REFUND (FM-AUDIT-006). Narrating it as "Spending" contradicted both.
      return make(e.amount > 0 ? "REFUND" : "SPENDING", basis, stored);
    case "REFUND":     return make("REFUND", basis, stored);
    case "INVESTMENT": return make("INVESTMENT_ACTIVITY", basis, stored);
    case "ADJUSTMENT": return make("ADJUSTMENT", basis, stored);
    case "INCOME": {
      if (basis !== "USER") {
        if (e.incomeSubtype === "INTERNAL_TRANSFER") return make("INTERNAL_TRANSFER", "TRANSFER_EVIDENCE", stored, null, e);
        if (e.incomeSubtype === "ISSUER_CREDIT") return make("ISSUER_CREDIT", "TRANSFER_EVIDENCE", stored);
        if (e.incomeSubtype === "REFUND_REVERSAL") return make("REFUND", "TRANSFER_EVIDENCE", stored);
      }
      return make("INCOME", basis, stored);
    }
    default: return null;
  }
}

/**
 * THE contract. Total and pure: same evidence, same answer; never throws.
 */
export function resolveTransactionNature(e: NatureEvidence): ResolvedTransactionNature {
  const stored = e.flowType ?? null;
  const ownTier: AccountTier = accountTier(e.ownAccountType);
  const cpTier: AccountTier = accountTier(e.counterpartyAccountType);

  // ── 1. USER ────────────────────────────────────────────────────────────────
  if (e.categorySource && USER_CATEGORY_SOURCES.has(e.categorySource)) {
    if (stored === "DEBT_PAYMENT") {
      return make("LIABILITY_PAYMENT", "USER", stored, ownTier === "liability" ? "LIABILITY" : "CASH", e);
    }
    const eco = economicNature(e, stored, "USER");
    if (eco) return eco;
    // A human "Transfer": the evidence may still name where it went (rung 3 below).
  }

  // Non-movement flows never become a movement here, except an UNKNOWN row the
  // transfer authority matured to a named owned destination (describeRowNature
  // already labels it so). Never a liability payment: the money layer leaves an
  // UNKNOWN row unresolved.
  if (stored == null || !MOVEMENT_FLOWS.has(stored)) {
    const eco = economicNature(e, stored, "PROVIDER");
    if (eco) return eco;
    const kind = transferKind(e);
    return kind && INTERNAL_NATURES.has(kind)
      ? make(kind, "TRANSFER_EVIDENCE", stored, null, e)
      : make("UNCLASSIFIED", "PROVIDER", stored);
  }

  // ── 2. TRANSFER_AUTHORITY — its persisted DEBT_PAYMENT is a cross-row verdict ──
  if (e.flowAuthority === "TRANSFER_AUTHORITY" && stored === "DEBT_PAYMENT") {
    return make("LIABILITY_PAYMENT", "TRANSFER_AUTHORITY", stored,
      ownTier === "liability" ? "LIABILITY" : "CASH", e);
  }
  const movementBasis: NatureBasis = e.flowAuthority === "TRANSFER_AUTHORITY" ? "TRANSFER_AUTHORITY" : "TRANSFER_EVIDENCE";

  // ── 3. TRANSFER_EVIDENCE ────────────────────────────────────────────────────
  if (stored === "DEBT_PAYMENT") {
    // The liability-side leg: money arriving on (or leaving) the card itself.
    // Structurally certain — the destination IS the own account (liquidity.ts).
    if (ownTier === "liability") return make("LIABILITY_PAYMENT", "LIABILITY_LEG", stored, "LIABILITY", e);
    // The cash leg: a debt payment only when POSITIVELY attested.
    if (isDebtPaymentAttested({ counterpartyTier: cpTier, transferMaturity: e.transferMaturity ?? null })) {
      return make("LIABILITY_PAYMENT", "TRANSFER_EVIDENCE", stored, "CASH", e);
    }
  } else {
    // A TRANSFER-typed cash leg out of a liquid account into an owned liability IS a
    // payment — the money layer counts it (classifyTransfer → DEBT_PAYMENT).
    const into = e.amount > 0;
    if (ownTier === "liquid" && !into && cpTier === "liability") {
      return make("LIABILITY_PAYMENT", "TRANSFER_EVIDENCE", stored, "CASH", e);
    }
  }
  const kind = transferKind(e);
  if (kind) return make(kind, movementBasis, stored, null, e);

  // ── 4. PROVIDER — nothing establishes the purpose. Never invented. ──────────
  return make("UNCLASSIFIED_MOVEMENT", "PROVIDER", stored);
}

/** Convenience: does this row reduce debt under the contract? */
export function reducesDebt(e: NatureEvidence): boolean {
  return resolveTransactionNature(e).reducesDebt;
}

/**
 * The category that goes with a resolved nature. A provider `Payment` label on a
 * stored DEBT_PAYMENT row the contract resolved to a non-payment movement reads
 * `Transfer` (the structural truth: money moved between accounts). A human's
 * category, and every other category, is returned unchanged.
 */
export function categoryForNature<C extends string | null | undefined>(
  category: C,
  e: NatureEvidence,
  resolved: ResolvedTransactionNature = resolveTransactionNature(e),
): C | "Transfer" {
  if (category !== "Payment") return category;
  if (e.categorySource && USER_CATEGORY_SOURCES.has(e.categorySource)) return category;
  return e.flowType === "DEBT_PAYMENT" && !resolved.reducesDebt && resolved.nature !== "LIABILITY_PAYMENT"
    ? "Transfer"
    : category;
}

/**
 * Build contract evidence from a list-row DTO plus an account-type lookup over the
 * accounts the viewer may see. The lookup is the caller's (it owns visibility); an
 * id it cannot resolve contributes no type, never a guess.
 */
export function natureEvidenceFromRow(
  r: {
    flowType?: string | null; amount: number; accountId: string;
    flowAuthority?: string | null; categorySource?: string | null;
    transferMaturity?: string | null; transferDisposition?: string | null;
    counterpartyAccountId?: string | null; incomeSubtype?: string | null;
  },
  accountTypeOf?: (accountId: string) => string | undefined,
): NatureEvidence {
  return {
    flowType: r.flowType ?? null,
    amount: r.amount,
    flowAuthority: r.flowAuthority ?? null,
    categorySource: r.categorySource ?? null,
    transferMaturity: r.transferMaturity ?? null,
    transferDisposition: r.transferDisposition ?? null,
    ownAccountType: accountTypeOf?.(r.accountId) ?? null,
    counterpartyAccountType: r.counterpartyAccountId ? accountTypeOf?.(r.counterpartyAccountId) ?? null : null,
    hasOwnedCounterparty: r.counterpartyAccountId != null,
    incomeSubtype: r.incomeSubtype ?? null,
  };
}
