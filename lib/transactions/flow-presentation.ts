/**
 * lib/transactions/flow-presentation.ts   (v2.6-TRUTH-7)
 *
 * THE single authority for what a transaction row is CALLED.
 *
 * Pure: no DB, no React, no clock. Zero runtime imports beyond the canonical
 * label map it extends.
 *
 * ── What this module is, and is not ─────────────────────────────────────────
 *
 * It decides NOTHING financial. Every input is a verdict some other authority
 * already reached — `flowType` (the classifier), `incomeSubtype` / `incomeClass`
 * (lib/transactions/income-source.ts, via the serializer), the sign of the
 * amount (a provider fact). This module maps those verdicts onto words and a
 * visual tone, and that is its entire job.
 *
 * ⚠️ There is NO merchant string, NO description, NO date proximity and NO
 * category string anywhere in this file, and a probe asserts it. The moment a
 * label is derived from a descriptor, presentation has become a second
 * classifier — which is the defect this module exists to remove.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 *
 * Three FlowType label maps had drifted apart:
 *
 *     lib/transactions/flow-predicates.ts   FLOW_TYPE_LABEL   canonical, 2 consumers
 *     TransactionSliceDrawer.tsx            FLOW_GROUP_LABEL  a second copy
 *     TransactionDetailDrawer.tsx           humanize()        mechanical "_"→space
 *
 * The drawer — the surface a user opens to ask "what IS this?" — used the
 * weakest of the three. It rendered `humanize("INCOME")` → "Income" for four
 * live rows the income authority had already classified ISSUER_CREDIT: a
 * Microsoft rebate, an Uber credit, a HungerStation credit and an EasyTime
 * credit, all landing on a CREDIT CARD. The authority was right; nothing read
 * it.
 *
 * ── Precedence, and why this order ──────────────────────────────────────────
 *
 * The income taxonomy OUTRANKS `flowType` for inflows, because it is strictly
 * more informed: it already consulted the transfer authority (owned
 * counterparty), the issuer-credit authority (v2.6-TRUTH-3) and the provider
 * family before returning. `flowType` says INCOME for all five of salary,
 * interest, a rewards redemption, an issuer credit and an internal transfer.
 * Preferring the coarser field would discard work already done.
 *
 * Where no attribution was emitted, the row falls back to its FlowType label —
 * which is honest, not a silent fallback: FLOW_TYPE_LABEL is itself canonical,
 * and `basis` records which one answered.
 */

import { FLOW_TYPE_LABEL } from "@/lib/transactions/flow-predicates";

/**
 * What a row IS, for presentation. One member per distinct thing a user needs
 * to tell apart — deliberately finer than FlowType on inflows (where FlowType
 * conflates five things) and identical to it elsewhere.
 */
export type RowNature =
  | "EARNED_INCOME" | "INTEREST" | "DIVIDEND" | "OTHER_INCOME"
  | "REFUND" | "ISSUER_CREDIT"
  | "TRANSFER_IN" | "TRANSFER_OUT" | "INTERNAL_TRANSFER"
  | "DEBT_PAYMENT" | "SPENDING" | "FEE" | "INTEREST_CHARGE"
  | "INVESTMENT" | "ADJUSTMENT" | "UNKNOWN";

/**
 * How a surface should COLOUR the row. Presentation only.
 *
 * ⚠️ Tone answers "is this a gain, a cost, or neither" — nothing else. It used to
 * answer a second question it has no business answering ("should the amount show
 * a direction?"), and three components read it that way: `tone === "neutral" ? ""
 * : …`. Every transfer is neutral, so better transfer evidence made a movement
 * LESS legible — a −$650 outflow and its +$650 counterpart both rendered
 * "$650.00". Direction is `RowDirection`, below.
 */
export type RowTone = "positive" | "negative" | "neutral";

/**
 * WHICH WAY the money moved on this row's own account. Presentation only.
 *
 * A separate axis from `RowTone`, deliberately. An internal transfer is neutral
 * in tone (it is neither a gain nor a cost) AND directional in fact (it left one
 * account and arrived in another). Collapsing the two lost the second.
 *
 * `NONE` is reserved for a genuinely directionless row — a zero amount. It is
 * never a fallback for "we could not tell": the sign of a stored amount is a
 * provider fact that is always present.
 */
export type RowDirection = "IN" | "OUT" | "NONE";

export interface RowNatureResult {
  nature: RowNature;
  /** The word a surface prints. */
  label: string;
  tone: RowTone;
  /**
   * WHICH WAY the money moved. Derived from the row's own signed amount, so it
   * is a FACT and is available for every nature — including the ones the transfer
   * ladder resolves, which is precisely where it used to be discarded.
   *
   * ⚠️ THE canonical source of a rendered +/−. A surface must not re-derive it
   * from `amount`, and must not gate it on `tone`. Pinned by
   * lib/transactions/flow-presentation.direction.test.ts.
   */
  direction: RowDirection;
  /**
   * WHICH authority answered. Recorded so a surface can never be wrong about
   * where its label came from, and so a probe can assert coverage.
   *
   *   INCOME_TAXONOMY — lib/transactions/income-source.ts decided it
   *   FLOW_TYPE       — no attribution was emitted; the canonical FlowType map
   *   TRANSFER_MATURITY — the transfer authority named the destination
   *   TRANSFER_SIGN   — a TRANSFER, directed by the sign of the amount
   */
  basis: "INCOME_TAXONOMY" | "TRANSFER_MATURITY" | "FLOW_TYPE" | "TRANSFER_SIGN";
}

/** The words. One entry per RowNature — exhaustive by type, so a new nature
 *  cannot ship without a label. */
export const ROW_NATURE_LABEL: Record<RowNature, string> = {
  EARNED_INCOME:   "Income",
  INTEREST:        "Interest earned",
  DIVIDEND:        "Dividend",
  OTHER_INCOME:    "Other income",
  REFUND:          "Refund",
  ISSUER_CREDIT:   "Issuer credit",
  TRANSFER_IN:     "Transfer in",
  TRANSFER_OUT:    "Transfer out",
  INTERNAL_TRANSFER: "Internal transfer",
  DEBT_PAYMENT:    "Debt payment",
  SPENDING:        "Spending",
  FEE:             "Fee",
  INTEREST_CHARGE: "Interest charged",
  INVESTMENT:      "Investment",
  ADJUSTMENT:      "Adjustment",
  UNKNOWN:         "Unclassified",
};

/**
 * Plural headings, for a surface that GROUPS rows by nature (the slice drawer).
 * Same keys, same authority — a group heading and a row chip can never disagree.
 */
export const ROW_NATURE_GROUP_LABEL: Record<RowNature, string> = {
  EARNED_INCOME:   "Income",
  INTEREST:        "Interest earned",
  DIVIDEND:        "Dividends",
  OTHER_INCOME:    "Other income",
  REFUND:          "Refunds",
  ISSUER_CREDIT:   "Issuer credits",
  TRANSFER_IN:     "Transfers in",
  TRANSFER_OUT:    "Transfers out",
  INTERNAL_TRANSFER: "Internal transfers",
  DEBT_PAYMENT:    "Debt payments",
  SPENDING:        "Spending",
  FEE:             "Fees",
  INTEREST_CHARGE: "Interest charged",
  INVESTMENT:      "Investment activity",
  ADJUSTMENT:      "Adjustments",
  UNKNOWN:         "Unclassified",
};

/** Stable display order for grouped views. Money out, then money back, then
 *  money in, then movement, then residue. */
export const ROW_NATURE_ORDER: readonly RowNature[] = [
  "SPENDING", "FEE", "INTEREST_CHARGE", "DEBT_PAYMENT",
  "REFUND", "ISSUER_CREDIT",
  "EARNED_INCOME", "INTEREST", "DIVIDEND", "OTHER_INCOME",
  "TRANSFER_IN", "TRANSFER_OUT", "INTERNAL_TRANSFER",
  "INVESTMENT", "ADJUSTMENT", "UNKNOWN",
];

/**
 * The character a surface prints in front of an amount, per direction.
 *
 * ⚠️ THE only sanctioned way to render a +/− on a transaction amount. It exists
 * so no component writes `amount > 0 ? "+" : "−"` — that expression is how the
 * sign got tangled with tone in the first place, and it is what let a neutral
 * tone suppress a real direction.
 *
 * Exhaustive by type: a new RowDirection cannot ship without a glyph.
 */
export const DIRECTION_SIGN: Record<RowDirection, string> = {
  IN:   "+",
  // U+2212 MINUS SIGN, not a hyphen — the glyph the ledger already rendered.
  OUT:  "−",
  NONE: "",
};

const TONE_OF: Record<RowNature, RowTone> = {
  EARNED_INCOME: "positive", INTEREST: "positive", DIVIDEND: "positive", OTHER_INCOME: "positive",
  // ⚠️ A refund and an issuer credit are NEUTRAL, deliberately. They put money
  // back that you had already spent; colouring them like income is the visual
  // form of the same error the income taxonomy fixed in the data.
  REFUND: "neutral", ISSUER_CREDIT: "neutral",
  TRANSFER_IN: "neutral", TRANSFER_OUT: "neutral", INTERNAL_TRANSFER: "neutral",
  DEBT_PAYMENT: "neutral", ADJUSTMENT: "neutral", UNKNOWN: "neutral", INVESTMENT: "neutral",
  SPENDING: "negative", FEE: "negative", INTEREST_CHARGE: "negative",
};

/** Income subtype → nature. Keys are the canonical `IncomeSubtype` values;
 *  this map introduces no membership of its own. */
const NATURE_OF_SUBTYPE: Record<string, RowNature> = {
  SALARY: "EARNED_INCOME", WAGES: "EARNED_INCOME", CONTRACT: "EARNED_INCOME", BUSINESS: "EARNED_INCOME",
  DEPOSIT_INTEREST: "INTEREST", CASH_SWEEP_INTEREST: "INTEREST",
  SECURITY_DIVIDEND: "DIVIDEND", FUND_DISTRIBUTION: "DIVIDEND",
  REWARDS_AS_INCOME: "OTHER_INCOME", MISC_INFLOW: "OTHER_INCOME", UNRESOLVED_INCOME: "OTHER_INCOME",
  // NOT_INCOME — each named, never lumped. This is the whole point.
  ISSUER_CREDIT: "ISSUER_CREDIT",
  REFUND_REVERSAL: "REFUND",
  INTERNAL_TRANSFER: "INTERNAL_TRANSFER",
  LOAN_PROCEEDS: "OTHER_INCOME",
  SALE_PROCEEDS: "OTHER_INCOME",
  CAPITAL_CONTRIBUTION: "OTHER_INCOME",
};

/** FlowType → nature, for rows the income taxonomy did not attribute. */
const NATURE_OF_FLOW: Record<string, RowNature> = {
  SPENDING: "SPENDING", FEE: "FEE", INTEREST: "INTEREST_CHARGE",
  REFUND: "REFUND", DEBT_PAYMENT: "DEBT_PAYMENT", INCOME: "EARNED_INCOME",
  INVESTMENT: "INVESTMENT", ADJUSTMENT: "ADJUSTMENT", UNKNOWN: "UNKNOWN",
};

/** The canonical verdicts a row carries. Every field is another authority's
 *  output — this module reads them, and adds nothing. */
/**
 * Canonical transfer maturity → nature. v2.6-TRUTH-8.
 *
 * ⚠️ A mapping, not a decision: every key is a verdict
 * lib/transactions/transfer-maturation.ts already reached about the movement's
 * DESTINATION. A maturity absent from this map falls through rather than
 * inventing a nature.
 */
const NATURE_OF_MATURITY: Record<string, RowNature> = {
  SAVINGS_TRANSFER:    "INTERNAL_TRANSFER",
  CASH_TRANSFER:       "INTERNAL_TRANSFER",
  INTERNAL_TRANSFER:   "INTERNAL_TRANSFER",
  INVESTMENT_TRANSFER: "INTERNAL_TRANSFER",
  DEBT_PAYMENT:        "DEBT_PAYMENT",
  ISSUER_CREDIT:       "ISSUER_CREDIT",
};

export interface RowNatureEvidence {
  flowType: string | null | undefined;
  /**
   * The transfer authority's verdict about the DESTINATION. Outranks `flowType`,
   * which is frequently just the provider's category — a live $4,000 movement
   * into a savings account carried a card-payment category because the
   * institution also issues a card, and rendered "Debt payment" until this was
   * consulted.
   */
  transferMaturity?: string | null;
  /** lib/transactions/income-source.ts, via the serializer. */
  incomeSubtype?: string | null;
  /**
   * Signed amount — a provider fact. Sets `direction` for EVERY row, and
   * additionally names the nature of an unmatured transfer (rung 3).
   */
  amount: number;
  /** True when the transfer authority established an owned counterparty. */
  hasOwnedCounterparty?: boolean;
}

/**
 * What is this row?
 *
 * Precedence: the income taxonomy, then the transfer direction, then the
 * canonical FlowType label. Never a descriptor.
 */
export function describeRowNature(e: RowNatureEvidence): RowNatureResult {
  // The direction is settled BEFORE the nature and independently of it. It is the
  // sign of the row's own amount — a provider fact — so no rung below can reach
  // it, and none can suppress it. This is the whole repair: `nature` says WHAT the
  // movement was, `direction` says WHICH WAY, and answering the first no longer
  // erases the second.
  const direction: RowDirection = e.amount > 0 ? "IN" : e.amount < 0 ? "OUT" : "NONE";
  const mk = (nature: RowNature, basis: RowNatureResult["basis"]): RowNatureResult =>
    ({ nature, label: ROW_NATURE_LABEL[nature], tone: TONE_OF[nature], direction, basis });

  // 1 — the income taxonomy, where it spoke. Strictly more informed than
  //     flowType: it already consulted the transfer and issuer-credit
  //     authorities before returning.
  if (e.incomeSubtype) {
    const n = NATURE_OF_SUBTYPE[e.incomeSubtype];
    if (n) return mk(n, "INCOME_TAXONOMY");
  }

  // 2 — the transfer authority's destination verdict. More informed than
  //     `flowType`: it weighed the counterparty, the matched leg and the venue.
  if (e.transferMaturity) {
    const n = NATURE_OF_MATURITY[e.transferMaturity];
    if (n) return mk(n, "TRANSFER_MATURITY");
  }

  // 3 — an UNMATURED transfer takes its NATURE from the sign too, so the label
  //     itself reads "Transfer in"/"Transfer out". Note this is about the LABEL:
  //     `direction` above is already set for every row, matured or not.
  if (e.flowType === "TRANSFER") {
    if (e.hasOwnedCounterparty === true) return mk("INTERNAL_TRANSFER", "TRANSFER_SIGN");
    return mk(e.amount > 0 ? "TRANSFER_IN" : "TRANSFER_OUT", "TRANSFER_SIGN");
  }

  // 4 — the canonical FlowType label.
  const n = e.flowType ? NATURE_OF_FLOW[e.flowType] : undefined;
  return mk(n ?? "UNKNOWN", "FLOW_TYPE");
}

/**
 * The canonical FlowType label, re-exported so a surface that genuinely wants
 * the FlowType word (a filter chip listing the enum) has ONE import to reach
 * for and never writes its own map.
 */
export function flowTypeLabel(flowType: string | null | undefined): string {
  if (!flowType) return FLOW_TYPE_LABEL.UNKNOWN;
  return FLOW_TYPE_LABEL[flowType] ?? flowType;
}
