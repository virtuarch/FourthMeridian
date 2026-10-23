/**
 * lib/transactions/transfer-maturation.ts   (v2.6-L4C/D)
 *
 * Classification as a CURRENT BEST ASSESSMENT rather than a first-ingest fact.
 * Pure: no DB, no React, no clock. Derived only — nothing is written here, and
 * `counterpartyAccountId` persistence is a separate, separately-approved act.
 *
 * ── The failure this replaces ───────────────────────────────────────────────
 *
 * Live in the corpus right now:
 *
 *   source       Chase CHASE COLLEGE · checking · 2026-08-03 · PENDING · −4,000
 *                "ORIG CO NAME:AMERICANEXPRESS CO ENTRY DESCR:TRANSFER SEC:WEB"
 *                classified DEBT_PAYMENT (PLAID_PFC_PRIMARY, confidence 0.8)
 *   destination  Amex High Yield Savings · SAVINGS · 2026-07-31 · POSTED · +4,000
 *
 * The destination is a savings account, so this is a savings transfer filed as a
 * debt payment — decided from the source descriptor alone, while the row was
 * still pending and its counterparty unknown, because the descriptor contains
 * "AMERICANEXPRESS" and Amex also issues cards.
 *
 * Three compounding faults, all addressed here: it was classified at first
 * sight; the only mechanism that could correct it was gated on it already being
 * TRANSFER; and the match window (2 days) was shorter than the observed skew
 * (3 days, destination FIRST).
 *
 * ── Why a descriptor cannot decide a destination ───────────────────────────
 *
 * The corpus contains the counter-example that makes this concrete. These are
 * BOTH $4,000 outflows from CHASE COLLEGE naming American Express:
 *
 *   2026-03-13  "AMERICAN EXPRESS ACH PMT M9576"  → Amex Platinum Card® (DEBT)
 *   2026-08-03  "…AMERICANEXPRESS CO ENTRY DESCR:TRANSFER"  → Amex HYSA (SAVINGS)
 *
 * Same institution, same amount, same direction, similar text — opposite
 * economic meaning. Only the DESTINATION ACCOUNT TYPE separates them, which is
 * why it is the discriminator here and the descriptor is not consulted at all.
 *
 * ── The maturation ladder ──────────────────────────────────────────────────
 *
 *   0  UNRESOLVED   direction known, destination unknown  ← the honest default
 *   1  INTERNAL     an owned counterparty account matched
 *   2  <leaf>       the counterparty's TYPE names the movement
 *
 * Specificity only increases. `maturityRank` makes that checkable rather than
 * asserted, and `matureClassification` refuses to descend.
 */

import { liabilityInflowIsCustomerPayment } from "@/lib/transactions/liability-inflow";

/** The classification ladder. Rank rises with evidence; it never falls. */
export type TransferMaturity =
  /** Direction known, destination unknown. The least-specific honest answer. */
  | "UNRESOLVED_TRANSFER"
  /** An owned counterparty account matched, but its type does not name a leaf. */
  | "INTERNAL_TRANSFER"
  /** Destination is a savings account. */
  | "SAVINGS_TRANSFER"
  /** Destination is a checking / cash-management account. */
  | "CASH_TRANSFER"
  /** Destination is a liability — a genuine debt payment. */
  | "DEBT_PAYMENT"
  /** Destination is an investment or crypto account. */
  | "INVESTMENT_TRANSFER"
  /**
   * v2.6-TRUTH-1 — money changed FORM (cash out of / into an account). A terminal
   * fact, not an unknown: there is no destination ACCOUNT to find, so this is
   * maximally specific while carrying no counterparty. See CASH_NO_COUNTERPARTY.
   */
  | "CASH_MOVEMENT"
  /**
   * v2.6-TRUTH-3 — a positive liability-side movement the provider attests is NOT
   * a payment: rewards, a statement credit, a fee reimbursement, a purchase
   * reversal. Terminal and evidence-backed. Makes NO transfer claim — see
   * `impliedFlowType`, which returns null for it.
   */
  | "ISSUER_CREDIT"
  /**
   * v2.6-TRUTH-3 — a positive liability-side movement with no family evidence and
   * no owned funding leg. The honest floor: we cannot say it is a payment, and
   * we do not say it is one. Distinct from ISSUER_CREDIT, which is a positive
   * finding, and from UNRESOLVED_TRANSFER, which would assert a transfer.
   */
  | "UNRESOLVED_LIABILITY_INFLOW"
  // ── Phase 4 — EXTERNAL TERMINAL STATES ──────────────────────────────────
  //
  // An external movement is NOT an unresolved internal movement. It is a
  // different, complete fact, and until now the ladder could not say it: 116
  // live payment-app legs ($24,986) reported UNRESOLVED_TRANSFER while their
  // truth — "you sent money to a person" — was fully established.
  //
  // `deriveTransferDisposition` has had EXTERNAL_BANK_TRANSFER,
  // ASSET_VENUE_TRANSFER and PAYMENT_APP_MOVEMENT all along. Two vocabularies
  // existed and only the weaker one classified. These leaves converge them.
  //
  // ⚠️ Each requires POSITIVE evidence of externality — an attested rail, venue,
  // or non-owned counterparty class. "No owned leg matched" is NOT evidence that
  // money left the household; the other side may simply not be synced yet. That
  // case stays UNRESOLVED_TRANSFER, and the distinction is the difference
  // between a terminal fact and a manufactured one.
  //
  // ⚠️ These are rank 2 but carry NO cash-style veto in `adoptIfMonotonic`, and
  // that is deliberate: they are DERIVED, never STAMPED. If the user later
  // connects the institution and a real leg appears, "same rank, different leaf"
  // adopts the correction. An external state must always be free to become
  // internal.
  /** A payment-app rail with no owned counterparty — the other side is a person. */
  | "EXTERNAL_PERSON_TRANSFER"
  /** A depository venue not known to be owned — an external bank account. */
  | "EXTERNAL_DEPOSITORY_TRANSFER"
  /** A brokerage/exchange venue not known to be owned — an unconnected venue. */
  | "EXTERNAL_VENUE_TRANSFER"
  /** The provider attests a counterparty class that is not an owned account,
   *  without naming a rail or venue. The honest floor of the external branch. */
  | "EXTERNAL_UNKNOWN_TRANSFER";

/** The external leaves, in one place, so no consumer re-lists them. */
export const EXTERNAL_MATURITIES: ReadonlySet<TransferMaturity> = new Set<TransferMaturity>([
  "EXTERNAL_PERSON_TRANSFER",
  "EXTERNAL_DEPOSITORY_TRANSFER",
  "EXTERNAL_VENUE_TRANSFER",
  "EXTERNAL_UNKNOWN_TRANSFER",
]);

/** Maturities that are a COMPLETE answer — resolved, though they name no owned
 *  account. A metric that counts these as failures is measuring the wrong thing:
 *  63 cash rows and 8 issuer credits are finished facts, not open questions. */
export const TERMINAL_MATURITIES: ReadonlySet<TransferMaturity> = new Set<TransferMaturity>([
  "CASH_MOVEMENT", "ISSUER_CREDIT", ...EXTERNAL_MATURITIES,
]);

/** Whether the ladder still owes an answer for this row. The ONE predicate the
 *  unresolved metric may use. */
export function isUnresolvedMaturity(m: TransferMaturity): boolean {
  return m === "UNRESOLVED_TRANSFER" || m === "UNRESOLVED_LIABILITY_INFLOW";
}

export function maturityRank(m: TransferMaturity): 0 | 1 | 2 {
  switch (m) {
    case "UNRESOLVED_TRANSFER": return 0;
    // v2.6-TRUTH-3 — "we could not establish this is a payment" is an UNKNOWN, so
    // rank 0: later evidence (a matched funding leg) must be free to raise it.
    case "UNRESOLVED_LIABILITY_INFLOW": return 0;
    case "INTERNAL_TRANSFER":   return 1;
    // CASH_MOVEMENT is rank 2: "this was a form change" is a complete answer, not
    // a partial one. Ranking it 0 would let a later coincidental leg match
    // "raise" specificity and overwrite it — the exact defect this veto exists to
    // prevent.
    //
    // The EXTERNAL_* leaves are rank 2 for the same reason — "this left the
    // household" is a complete answer — but WITHOUT the veto, so a later owned
    // leg can still correct them. See the note on the union above.
    default:                    return 2;
  }
}

/**
 * The money's physical form, where the provider attests it. Provider-neutral by
 * design: adapters map their own vocabulary onto this (Plaid's
 * TRANSFER_IN_DEPOSIT / TRANSFER_OUT_WITHDRAWAL families → CASH, see
 * lib/transactions/plaid-transfer-evidence.ts).
 */
export type TransferMovementForm = "CASH";

/**
 * ± whole days within which an opposite leg may be matched.
 *
 * **5**, and the corpus chose it. Measured over every same-magnitude,
 * opposite-sign, cross-owned-account pair among transfer-shaped rows:
 *
 *     0d 189 · 1d 50 · 2d 21 · 3d 18 · 4d 14 · 5d 6 · 6d 3     ← decaying: settlement lag
 *     7d 16 · 10d 14 · 12d 14 · 13d 14 · 14d 53 · 15d 67 · …   ← RISING: recurrence
 *
 * The head decays monotonically, which is what a settlement delay looks like.
 * From about a week out the density climbs again — the signature of RECURRING
 * same-amount activity (a monthly payment matching last month's), not of a
 * slower transfer. Widening past that regime would not resolve more transfers;
 * it would manufacture pairs between unrelated months.
 *
 * So 5 days: strictly wider than the 3-day skew the known case exhibits (the
 * brief's requirement), and stopping before the recurrence bulge begins.
 * The previous bound was 2 — narrower than the real case, which is why it never
 * matched.
 */
export const TRANSFER_MATCH_WINDOW_DAYS = 5;

/**
 * The DATABASE PREFILTER — flowType values a candidate QUERY must not exclude.
 *
 * ⚠️ This is NOT the admission rule. Admission is
 * `lib/transactions/transfer-admission.ts` `admitTransferCandidate`, which also
 * reads the row's own account type, its category and its attested axes — none of
 * which a `WHERE flowType IN (…)` clause can see.
 *
 * The two are related by ONE invariant, asserted by a standing probe:
 *
 *     admitted ⊆ prefiltered
 *
 * i.e. the prefilter may be broader than admission (and is), but must never drop
 * a row admission would have kept. That is what makes it safe for a query to use
 * this while the in-memory authority uses the real rule. `null` stays here for
 * exactly that reason: a NOT-IN over a nullable column drops nulls under
 * three-valued logic, and a query that excluded them could not be checked against
 * the invariant at all.
 *
 * DEBT_PAYMENT is in the set, and that is the point: the mis-filed leg described
 * above was excluded from its own repair because the resolver required TRANSFER.
 */
export const TRANSFER_PREFILTER_FLOW_TYPES: readonly (string | null)[] = [
  "TRANSFER", "DEBT_PAYMENT", "UNKNOWN", null,
];

/**
 * Whether a candidate QUERY should load this row. Deliberately permissive.
 *
 * ⚠️ Do NOT use this to decide whether a row is a transfer. It admits every
 * unclassified row in the database — 352 of them locally, including payroll,
 * groceries and dining — because a query cannot tell them apart and must not
 * guess. `admitTransferCandidate` is the authority that can.
 */
export function isTransferPrefilterCandidate(flowType: string | null | undefined): boolean {
  return TRANSFER_PREFILTER_FLOW_TYPES.includes(flowType ?? null);
}

/** How the counterparty was established. */
export type CounterpartyEvidence =
  /** A provider link (pendingTransactionRef / counterparty id) — strongest. */
  | "PROVIDER_LINK"
  /** A unique opposite leg matched on amount, direction, date and ownership. */
  | "MATCHED_LEG"
  /** A balance gap on a candidate account is CONSISTENT with this movement.
   *  Supporting evidence only — it can raise confidence in a leg that already
   *  matched; it can never, by itself, establish a counterparty, because a gap
   *  is not a transaction and inventing one would be fabrication. */
  | "BALANCE_GAP_SUPPORT"
  /** Nothing established it. */
  | "NONE";

// ── Destination evidence (v2.6-L4-AUDIT) ─────────────────────────────────────

/**
 * How well the evidence pins down where a movement went.
 *
 * The corpus forced this distinction. A row can have an UNDECIDABLE destination
 * account and a fully DECIDED destination type — every candidate is a card, say
 * — and the type is what names the movement. Collapsing that into "ambiguous"
 * throws away a true claim; collapsing it into "resolved" invents a counterparty.
 * They are different facts and need different names.
 */
export type DestinationEvidenceLevel =
  /**
   * Phase 5 — the PROVIDER asserted that these two rows are one movement.
   * Strictly above `ACCOUNT_CERTAIN`: that level is Fourth Meridian's inference
   * about the corpus, this one is the institution's own statement. Account, type
   * and leg are all known, and all are persistable.
   */
  | "PROVIDER_LINKED"
  /** Exactly one destination LEG qualifies, and that leg sees exactly one
   *  qualifying source — a MUTUAL pairing. Account AND type are known, and
   *  `counterpartyAccountId` may be persisted. See the mutual-uniqueness note. */
  | "ACCOUNT_CERTAIN"
  /**
   * Phase 3 — THE MISSING RUNG. Every qualifying destination leg resolves to
   * ONE owned account, but the pairing is not mutually unique, so which leg is
   * the other side cannot be established.
   *
   * ⚠️ Before this existed, these rows returned `TYPE_CERTAIN_ACCOUNT_AMBIGUOUS`
   * with `accountId: null` — a level whose NAME asserted the account was
   * ambiguous while its own `candidateAccountIds` held exactly one element.
   * 75 live legs, $103,000, thrown away by a gate applied at LEG level to a claim
   * made at ACCOUNT level. That is the same error already recorded once in this
   * repository's history ("the gate must be ACCOUNT-level not leg-level").
   *
   * The account IS a fact and IS persistable. The leg is not, and — uniquely
   * among the refusals — it is not merely unknown but UNKNOWABLE: two identical
   * movements between the same two accounts in the same window are not
   * distinguishable by any evidence that exists. Every downstream consumer
   * (wealth neutrality, debt attribution, cash-flow exclusion, liquidity
   * tiering) asks WHICH ACCOUNT and never WHICH ROW.
   *
   * A later PROVIDER_LINKED claim can still promote this to certainty, so it is
   * a rung and not a dead end.
   */
  | "ACCOUNT_CERTAIN_LEG_AMBIGUOUS"
  /** Several accounts qualify but they all share ONE type. The type names the
   *  movement; the account does NOT, so no counterparty may be persisted. */
  | "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS"
  /** Candidates span more than one destination type. Nothing above "a transfer
   *  happened" is supported. */
  | "TYPE_AMBIGUOUS"
  /** No qualifying opposite leg exists at all. Distinct from TYPE_AMBIGUOUS:
   *  there is nothing to be ambiguous BETWEEN, and inventing one would be
   *  fabrication rather than a guess. */
  | "NO_DESTINATION_EVIDENCE"
  /**
   * v2.6-TRUTH-1 — the money changed FORM. Cash has no destination account to
   * find, so leg matching is not merely inconclusive here, it is inapplicable.
   * Structurally terminal: `accountId` is null and `persistableCounterparty` is
   * false at this level and cannot be otherwise.
   */
  | "CASH_NO_COUNTERPARTY";

/**
 * One candidate destination — a SPECIFIC opposite leg on an owned account.
 *
 * ⚠️ This is a LEG, not an account. The distinction is the whole of v2.6-TRUTH-1.
 * The previous shape carried only `{accountId, accountType}`, which made two
 * legs in the same account indistinguishable from one, and made the reverse
 * direction unrepresentable. The audit that followed the R2 proposal found all
 * three "account-certain" rows were in fact contested from the destination side.
 */
export interface DestinationCandidate {
  /** The opposite leg's own transaction id. Required — see above. */
  legId: string;
  accountId: string;
  /** checking | savings | investment | crypto | debt | other. */
  accountType: string;
  /**
   * How many qualifying SOURCE events this leg sees, counted with the SAME
   * predicate, INCLUDING the row under evaluation. Mutual uniqueness requires
   * exactly 1: the leg must point back at this row and at nothing else.
   *
   * Required, deliberately. Making it optional would let a caller that never
   * computes the reverse direction silently keep the old, wrong answer — and an
   * optional field production never passes is not a safeguard, it is the defect.
   */
  competingSourceCount: number;
  /**
   * Lifecycle supersession, respected structurally rather than by caller
   * discipline: a superseded leg (a pending row replaced by its posted
   * successor) is dropped here, so no caller can forget to filter it.
   */
  superseded: boolean;
  /**
   * v2.6-XFER-1 — does THIS leg positively name the source account?
   *
   * True when the leg's own extracted account mask resolves to the source's
   * account. That is the destination side saying, in the provider's own words,
   * where the money came from — e.g. an AMEX checking credit reading
   * "Internal Transfer Credit: Savings -5336" where 5336 is the source's mask.
   *
   * ⚠️ Optional, and absence means "not known to identify", never "does not".
   * A caller that cannot compute it gets the pre-XFER-1 behaviour rather than a
   * silently weakened tie-break.
   */
  identifiesSource?: boolean;
}

/**
 * WHY the ladder still owes an answer. Every unresolved row carries exactly one,
 * so no surface ever has to render a bare "unknown".
 *
 * ⚠️ `CROSS_OWNER_BOUNDARY` is DETECTION ONLY. `legsQualify` refuses to pair
 * across owners and this proposal does not change that — but a limitation that
 * is invisible cannot be reasoned about, and joint accounts / business Spaces are
 * the largest unmeasured gap in this design. Naming it converts a silent failure
 * into a reported one. It must never become a matching rule.
 */
export type TransferUnresolvedReason =
  /** Candidates span more than one destination TYPE — nothing above "a transfer
   *  happened" is supported. An identifier would settle it. */
  | "CANDIDATES_SPAN_TYPES"
  /** A leg that would otherwise qualify sits on ANOTHER OWNER's account. */
  | "CROSS_OWNER_BOUNDARY"
  /** No qualifying opposite leg on any owned account, and no attested rail,
   *  venue or counterparty class to make an external claim from. */
  | "NO_COUNTERPART_EVIDENCE"
  /** A positive liability movement with no payment family and no owned funding
   *  leg — we decline to call it a payment. */
  | "LIABILITY_INFLOW_UNATTESTED";

export interface DestinationEvidence {
  level: DestinationEvidenceLevel;
  /** Set at PROVIDER_LINKED, ACCOUNT_CERTAIN and ACCOUNT_CERTAIN_LEG_AMBIGUOUS —
   *  every level where the destination ACCOUNT is a fact. Null elsewhere. */
  accountId: string | null;
  /** Set wherever the destination TYPE is known (the above, plus TYPE_CERTAIN). */
  accountType: string | null;
  /** Set ONLY at PROVIDER_LINKED and ACCOUNT_CERTAIN — the levels where the
   *  specific opposing ROW is established. ⚠️ Null at
   *  ACCOUNT_CERTAIN_LEG_AMBIGUOUS by construction: the account is known and the
   *  leg is unknowable, and writing a "best" leg there would be fabrication. */
  legId: string | null;
  candidateAccountIds: string[];
  candidateTypes: string[];
  /** True wherever `accountId` is a fact — the levels at which
   *  `counterpartyAccountId` may be persisted. */
  persistableCounterparty: boolean;
  /** True ONLY where `legId` is a fact. Separate from the above precisely so a
   *  caller cannot persist a leg it was never given. */
  persistableLeg: boolean;
  /**
   * Why a pairing that LOOKED unique was refused. Present only when the demotion
   * happened, so a repair can report the reason instead of silently proposing
   * less. Never used to justify a write.
   */
  mutualityRefusal?: string;
  /** Present whenever the row remains unresolved — never a bare unknown. */
  unresolvedReason?: TransferUnresolvedReason;
  /** How many qualifying legs sit on another OWNER's accounts. Detection only. */
  crossOwnerCandidateCount?: number;
}

/**
 * Resolve the destination evidence level from the candidate LEG set.
 *
 * ── Two structural vetoes (v2.6-TRUTH-1) ─────────────────────────────────────
 *
 * **1. Cash.** When the provider attests the money changed FORM, no amount/date
 * match may attach a financial-account counterparty. An ATM withdrawal
 * (`TRANSFER_OUT_WITHDRAWAL` → form CASH) leaving checking on the 31st and a card
 * payment arriving on the 4th are the same amount by coincidence, not by
 * relation; the corpus contains exactly that pair, across two institutions, while
 * a DIFFERENT row on the same account is explicitly described "AMERICAN EXPRESS
 * ACH PMT" and already carries LOAN_PAYMENTS_CREDIT_CARD_PAYMENT. This mirrors
 * `deriveTransferDisposition`, where CASH is rule 1 and dominates ownership —
 * two authorities disagreeing about cash precedence is how that bug happened.
 *
 * **2. Mutual uniqueness.** ACCOUNT_CERTAIN previously meant "from this source,
 * one destination account" — a ONE-DIRECTIONAL read. Every one of the three R2
 * proposals passed it and every one was contested from the other side: each
 * matched card payment had TWO qualifying funding rows. Certainty now requires
 * the pairing to close in both directions:
 *
 *     exactly one qualifying destination leg   (forward, |candidates| === 1)
 *   ∧ that leg sees exactly one qualifying src (reverse, competingSourceCount === 1)
 *
 * The predicate used in both directions is `legsQualify`, which is symmetric by
 * construction, so "A sees B" and "B sees A" cannot disagree.
 *
 * Refusing mutuality does NOT discard what remains true: a single-typed candidate
 * set still yields TYPE_CERTAIN_ACCOUNT_AMBIGUOUS, which names the movement while
 * persisting nothing.
 */
/**
 * v2.6-XFER-1 — the identification narrowing, in ONE place.
 *
 * A leg that positively names `sourceAccountId` outranks a leg that names
 * nothing. Applies only as a STRICT, non-empty subset: if every candidate
 * identifies the source, or none does, there is no tie to break.
 *
 * Exported so `resolveDestinationEvidenceFor` can compute the pigeonhole union
 * over exactly the set `resolveDestinationEvidence` will judge. Two copies of
 * this predicate would be two definitions of the rung.
 */
export function narrowByIdentification<T extends { maskedDestinationAccountId?: string | null }>(
  candidates: readonly T[],
  sourceAccountId: string,
): readonly T[] {
  const identified = candidates.filter((c) => c.maskedDestinationAccountId === sourceAccountId);
  const silent = candidates.filter((c) => !c.maskedDestinationAccountId);
  return identified.length > 0 && silent.length === candidates.length - identified.length && silent.length > 0
    ? identified
    : candidates;
}

export function resolveDestinationEvidence(
  candidates: readonly DestinationCandidate[],
  opts: {
    /** The SOURCE row's movement form, when the provider attests one. */
    movementForm?: TransferMovementForm | null;
    /**
     * Phase 3 — how many DISTINCT sources compete for this candidate set, counted
     * as a UNION over every candidate leg (including the source under evaluation).
     *
     * Only the corpus-level resolver can count this correctly; when it is absent
     * the per-leg maximum is used, which is an over-estimate and therefore
     * conservative — it can only ever refuse the rung, never grant it wrongly.
     */
    competingSourceCount?: number;
  } = {},
): DestinationEvidence {
  // ── Veto 1 — cash. Before any candidate is even considered. ───────────────
  if (opts.movementForm === "CASH") {
    return {
      level: "CASH_NO_COUNTERPARTY",
      accountId: null, accountType: null, legId: null,
      candidateAccountIds: [], candidateTypes: [],
      persistableCounterparty: false, persistableLeg: false,
    };
  }

  // Supersession is enforced here, not by the caller.
  const all = candidates.filter((c) => !c.superseded);

  // ── v2.6-XFER-1 — IDENTIFICATION OUTRANKS SILENCE. ───────────────────────
  //
  // `legsQualify` already applies the account mask SUBTRACTIVELY: a leg naming
  // an account that is not the other side is disqualified. What it cannot do is
  // PREFER a leg that names the right one — so among the survivors, "names the
  // counterparty" and "names nothing" counted the same, and the ladder saw a tie
  // where the evidence had a winner.
  //
  // Measured on the live corpus, three AMEX savings→checking transfers ($6,500):
  //
  //   source  AMEX High Yield Savings (mask 5336)  −500
  //           "Requested transfer to AMEX checking account"
  //   cand A  AMEX Rewards Checking  +500  "Internal Transfer Credit: Savings -5336"
  //   cand B  AMEX Platinum Card®    +500  "MOBILE PAYMENT - THANK YOU"
  //
  // A names the source account outright. B is a real card payment that coincides
  // in amount, day and institution. Candidates spanned checking + debt, so the
  // ladder returned TYPE_AMBIGUOUS / CANDIDATES_SPAN_TYPES — a refusal, over a
  // pair the provider had already identified.
  //
  // ── Why this is a NARROWING and not a new level ──────────────────────────
  //
  // The identified subset becomes the candidate set and every rung below runs
  // unchanged on it. So the outcome is still ACCOUNT_CERTAIN (mutually unique),
  // ACCOUNT_CERTAIN_LEG_AMBIGUOUS (pigeonhole) or a refusal — the same claims,
  // reached on better-filtered evidence. It can only ever REMOVE a candidate
  // that already passed `legsQualify`; it can never invent one, and it cannot
  // reach a level the surviving evidence does not support.
  //
  // ── The two conditions, both load-bearing ────────────────────────────────
  //
  //   1. STRICT, NON-EMPTY subset. If every candidate identifies the source, or
  //      none does, there is no tie to break and the set is unchanged.
  //   2. Every non-identifying candidate must be SILENT. A leg naming a
  //      DIFFERENT account cannot appear here (legsQualify removed it), so in
  //      practice this holds by construction — but asserting it means a future
  //      change to that predicate degrades to "no narrowing" rather than to
  //      "outrank a leg that contradicted us".
  //
  // Measured before shipping (scripts/audit-transfer-identification.ts): applies
  // to 29 of 1023 legs, changes 27 levels, EVERY change an upgrade toward
  // certainty, ZERO re-pointed ACCOUNT_CERTAIN/PROVIDER_LINKED verdicts, ZERO
  // contradictions against any counterparty an approved repair had persisted.
  const identified = all.filter((c) => c.identifiesSource === true);
  const silent = all.filter((c) => c.identifiesSource !== true);
  const live = identified.length > 0 && silent.length > 0 ? identified : all;

  const accountIds = [...new Set(live.map((c) => c.accountId))].sort();
  const types = [...new Set(live.map((c) => c.accountType))].sort();

  if (accountIds.length === 0) {
    return {
      level: "NO_DESTINATION_EVIDENCE",
      accountId: null, accountType: null, legId: null,
      candidateAccountIds: [], candidateTypes: [],
      persistableCounterparty: false, persistableLeg: false,
      // The external branch decides from the ROW's own attested axes, which this
      // set-level function cannot see. `maturityForEvidence` owns that call.
      unresolvedReason: "NO_COUNTERPART_EVIDENCE",
    };
  }

  // ── Veto 2 — mutual uniqueness. ──────────────────────────────────────────
  if (live.length === 1 && live[0].competingSourceCount === 1) {
    return {
      level: "ACCOUNT_CERTAIN",
      accountId: live[0].accountId, accountType: live[0].accountType,
      legId: live[0].legId,
      candidateAccountIds: accountIds, candidateTypes: types,
      persistableCounterparty: true, persistableLeg: true,
    };
  }

  // Not mutual. Say WHY, then fall to the strongest honest level below.
  const refusal =
    live.length > 1
      ? `${live.length} qualifying destination legs across ${accountIds.length} account(s); the forward direction is not unique.`
      : `The single qualifying leg (${live[0].legId}) is itself matched by ${live[0].competingSourceCount} source events, so the pairing does not close in both directions.`;

  // ── Phase 3 — the missing rung. Check the ACCOUNT before the TYPE. ────────
  //
  // Order matters and is half the fix: `types.length === 1` was tested first, so
  // a candidate set of three legs all sitting in ONE savings account fell through
  // to "the account is ambiguous" — a claim its own candidate list contradicted.
  //
  // ── The OTHER half: one account is NOT sufficient. ────────────────────────
  //
  // A single forward candidate that is itself contested by another source is
  // exactly the shape this rung must REFUSE:
  //
  //     checking −1,000 (S)  ─┐
  //                           ├─▶  savings +1,000 (L)      only ONE arrival
  //     checking −1,000 (T)  ─┘
  //
  // S's only candidate is on savings, so "one account" holds — and yet one of S
  // and T did not go to savings at all, and nothing says which. Persisting
  // savings for both would double-claim L and would be a coin flip wearing an
  // identifier's authority. An earlier draft of this rung did exactly that, and
  // the v2.6-TRUTH-1 mutual-uniqueness probe caught it.
  //
  // The sound condition is PIGEONHOLE: every source competing for this candidate
  // set can be given a DISTINCT leg in it. Then S landed in this account
  // whichever leg was actually its own — which is the precise claim being made.
  //
  //     |competing sources|  ≤  |qualifying legs|
  //
  // With 2 legs in one savings account and only this source competing (1 ≤ 2),
  // the account is a fact and the leg is unknowable. With 1 leg and 2 sources
  // (2 > 1), neither is established.
  const competingSources = opts.competingSourceCount ?? Math.max(
    ...live.map((c) => c.competingSourceCount),
  );
  if (accountIds.length === 1 && competingSources <= live.length) {
    return {
      level: "ACCOUNT_CERTAIN_LEG_AMBIGUOUS",
      accountId: accountIds[0], accountType: types[0],
      // ⚠️ Never a leg. Two identical movements between the same two accounts in
      // the same window are indistinguishable, and picking one would be
      // fabrication dressed as a tie-break.
      legId: null,
      candidateAccountIds: accountIds, candidateTypes: types,
      persistableCounterparty: true, persistableLeg: false,
      mutualityRefusal: refusal,
    };
  }

  if (types.length === 1) {
    return {
      level: "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS",
      // The account is genuinely unknown — never guess one from the set.
      accountId: null, accountType: types[0], legId: null,
      candidateAccountIds: accountIds, candidateTypes: types,
      persistableCounterparty: false, persistableLeg: false,
      mutualityRefusal: refusal,
    };
  }
  return {
    level: "TYPE_AMBIGUOUS",
    accountId: null, accountType: null, legId: null,
    candidateAccountIds: accountIds, candidateTypes: types,
    persistableCounterparty: false, persistableLeg: false,
    mutualityRefusal: refusal,
    unresolvedReason: "CANDIDATES_SPAN_TYPES",
  };
}

// ── The symmetric leg predicate + the corpus-level resolver ──────────────────

/** ± tolerance on |amount| when pairing two legs. */
export const TRANSFER_AMOUNT_EPSILON = 0.005;

/** One transfer-shaped row, as the pairing rules see it. */
export interface TransferLeg {
  id: string;
  accountId: string;
  /** checking | savings | investment | crypto | debt | other. */
  accountType: string;
  /** Ownership boundary — legs may only pair within one owner. */
  ownerId: string;
  /** Signed amount in its own account. Negative is outflow. */
  amount: number;
  currency: string | null;
  /** Epoch milliseconds. */
  dateMs: number;
  /** Lifecycle supersession — a superseded row is never a valid leg. */
  superseded: boolean;
  /** Provider-attested movement form, when known. */
  movementForm?: TransferMovementForm | null;
  /**
   * Phase 5 — the OPAQUE, institution-scoped provider correlation key, when the
   * institution stamped one on this row (see `lib/transactions/provider-link.ts`).
   * Two legs sharing a key are asserted BY THE PROVIDER to be one movement.
   *
   * ⚠️ REQUIRED, and nullable rather than optional. `null` is a real state — most
   * institutions supply nothing, and American Express supplies nothing at all on
   * 147 of 147 measured rows. But an OPTIONAL field would let a caller that
   * simply forgot to extract silently lose 260 legs of deterministic evidence and
   * look identical to an honest absence. Required-nullable makes the compiler ask
   * every caller the question; the same reasoning that made `superseded` and
   * `competingSourceCount` required.
   *
   * ⚠️ Never the raw provider token. See `providerLinkKey`.
   */
  providerLinkKey: string | null;
  /**
   * Phase 5 — the owned account this row's DESCRIPTOR names by account mask
   * ("Online Transfer to SAV ...9516", "card ending in 0202"), when it names
   * exactly one. Null when no mask marker is present, when it matches no owned
   * account, or when it is AMBIGUOUS across two owned accounts — in which case
   * the extractor abstains rather than picking.
   *
   * ⚠️ This is an IDENTIFIER, not a name. `...9516` denotes exactly one account
   * or none; `AMERICANEXPRESS` denotes an institution that issues both cards and
   * savings accounts, and is why descriptor-derived *names* are forbidden. The
   * measurement is unambiguous: mask evidence made 250 claims with 0 errors,
   * institution-name routing resolved 0 legs on its own.
   *
   * ⚠️ It can only ever REMOVE candidates — see `legsQualify`. A mask never
   * creates a pairing, so it cannot fabricate a counterparty even if the four
   * digits were wrong; the worst case is that a real pairing is refused.
   */
  maskedDestinationAccountId: string | null;
  /**
   * The provider-attested RAIL this movement travelled over, when one is
   * attested (`PAYMENT_APP` today). Canonical and provider-neutral — the value
   * comes from a stage-1 adapter, never from a merchant string read here.
   *
   * ⚠️ REQUIRED and nullable, following `movementForm` and `providerLinkKey`.
   * An optional field would let a caller that forgot it silently re-admit the
   * pairing the veto below exists to refuse, and look identical to an
   * institution that attests no rail.
   *
   * Consulted by `legsQualify` ONLY to refuse a structurally impossible pairing.
   * The rail never names a purpose and never resolves a destination.
   */
  railType: string | null;
}

/**
 * Whether two rows may be paired as the two legs of one movement.
 *
 * SYMMETRIC by construction — every clause is symmetric in (a, b) — which is what
 * makes mutual uniqueness well-defined. If this predicate ever became asymmetric,
 * "A sees B" and "B sees A" could disagree and ACCOUNT_CERTAIN would again mean
 * nothing. That property is asserted by a standing test, not just by reading.
 */
export function legsQualify(a: TransferLeg, b: TransferLeg): boolean {
  if (a.id === b.id) return false;
  if (a.superseded || b.superseded) return false;
  if (a.ownerId !== b.ownerId) return false;
  if (a.accountId === b.accountId) return false;
  if ((a.currency ?? null) !== (b.currency ?? null)) return false;
  if (Math.sign(a.amount) !== -Math.sign(b.amount)) return false;
  if (Math.abs(Math.abs(a.amount) - Math.abs(b.amount)) > TRANSFER_AMOUNT_EPSILON) return false;
  // Phase 5 — a descriptor that NAMES the other account restricts who may be it.
  //
  // Both clauses together are symmetric in the PAIR, which is what keeps mutual
  // uniqueness well-defined: swapping (a, b) evaluates the same two conditions in
  // the opposite order and reaches the same verdict. Expressing mask evidence
  // here rather than as a post-filter is what makes it apply to the forward
  // direction, the reverse count and the stratified tiers at once, with no
  // special-casing anywhere — and it can only ever REMOVE a pairing, never
  // invent one.
  if (a.maskedDestinationAccountId && a.maskedDestinationAccountId !== b.accountId) return false;
  if (b.maskedDestinationAccountId && b.maskedDestinationAccountId !== a.accountId) return false;
  // A PAYMENT-APP leg may not pair with a LIABILITY leg. ─────────────────────
  //
  // Payment-app rails settle to a deposit account. You cannot Zelle, Apple Cash,
  // Venmo, Cash App or PayPal a credit card — the card issuer is not reachable
  // as a P2P recipient. So an equal-amount card payment sitting near a
  // payment-app send is a coincidence of amount and date, exactly as an ATM
  // withdrawal near a card payment is, and this refuses it for the same reason
  // the CASH veto does.
  //
  // ⚠️ Discovered by the repair's cross-authority pre-flight, not by any test:
  // `Zelle payment to Mom` (−$1,000) and `APPLE CASH SENT MONE` (−$1,000) were
  // each about to be written DEBT_PAYMENT because stratification had correctly
  // consumed their real savings rivals — leaving a coincidental
  // `Payment Thank You-Mobile` as the sole survivor. The identifier tier did not
  // cause that; it ENABLED it, which is the cascade risk this architecture
  // documented and must therefore defend against structurally.
  //
  // ⚠️ It belongs HERE and not on the maturity leaf. As a qualification rule it
  // is symmetric, it applies to the forward direction, the reverse count and
  // every stratified tier at once, and — decisively — it removes the CANDIDATE,
  // so no counterparty can be persisted from a pairing it rejects. Relabelling
  // after a match would leave the account id already established.
  //
  // ⚠️ It is SUBTRACTIVE only. Refusing this pairing frees the card leg to pair
  // with its real funding row, and leaves the payment-app leg to reach the
  // terminal state its rail already supports (EXTERNAL_PERSON_TRANSFER). Nothing
  // is invented on either side.
  //
  // A genuine checking/savings → card payment carries NO rail attestation and is
  // untouched, which is why this is a rail rule and not a liability rule.
  if (a.railType === "PAYMENT_APP" && b.accountType === "debt") return false;
  if (b.railType === "PAYMENT_APP" && a.accountType === "debt") return false;
  const days = Math.abs(a.dateMs - b.dateMs) / 86_400_000;
  return days <= TRANSFER_MATCH_WINDOW_DAYS;
}

/**
 * `legsQualify` with the OWNERSHIP clause removed — and nothing else.
 *
 * ⚠️ This is a DETECTION probe, never a matching rule. Legs may only pair within
 * one owner and this proposal does not change that. But a joint account, a
 * couple sharing a household, or a personal + business Space produces real
 * transfers that cross the boundary, and today they vanish into a generic
 * "unresolved" with no explanation. Counting them turns the largest unmeasured
 * gap in this design into a NAMED limitation (`CROSS_OWNER_BOUNDARY`).
 *
 * If this ever feeds a pairing decision, the ownership boundary has been
 * silently deleted. A standing probe asserts it does not.
 */
export function legsQualifyIgnoringOwner(a: TransferLeg, b: TransferLeg): boolean {
  if (a.ownerId === b.ownerId) return false;   // same-owner pairs are legsQualify's job
  if (a.id === b.id) return false;
  if (a.superseded || b.superseded) return false;
  if (a.accountId === b.accountId) return false;
  if ((a.currency ?? null) !== (b.currency ?? null)) return false;
  if (Math.sign(a.amount) !== -Math.sign(b.amount)) return false;
  if (Math.abs(Math.abs(a.amount) - Math.abs(b.amount)) > TRANSFER_AMOUNT_EPSILON) return false;
  if (a.maskedDestinationAccountId && a.maskedDestinationAccountId !== b.accountId) return false;
  if (b.maskedDestinationAccountId && b.maskedDestinationAccountId !== a.accountId) return false;
  // Mirrors the payment-app veto above: a cross-owner pairing that the same-owner
  // predicate would refuse must not be COUNTED as a cross-owner limitation either,
  // or the census would report an impossible pairing as a boundary problem.
  if (a.railType === "PAYMENT_APP" && b.accountType === "debt") return false;
  if (b.railType === "PAYMENT_APP" && a.accountType === "debt") return false;
  return Math.abs(a.dateMs - b.dateMs) / 86_400_000 <= TRANSFER_MATCH_WINDOW_DAYS;
}

// ── The stratified corpus index (Phase 2 / Phase 5) ──────────────────────────

/**
 * ± day tolerances applied IN ORDER, each on the legs the previous tier did not
 * claim.
 *
 * ── Why tightening first resolves MORE, not less ───────────────────────────
 *
 * A single ±5 pass asks every leg to be unique against every other leg within
 * five days. Recurring round-number transfers defeat that: `$1,000` appears 154
 * times in a 663-row corpus, so a Monday transfer sees Wednesday's as a rival and
 * mutual uniqueness correctly refuses both.
 *
 * Resolving at ±0 FIRST removes both legs of every same-day pair from the pool,
 * which shrinks the competition set that was defeating the ±5 pass. The tight
 * tier is more restrictive per pair and yet resolves more overall.
 *
 * Measured against 132 legs of provider-issued ground truth:
 *
 *     single tier ±5 (the old rule)   72 correct · 0 wrong · 60 abstained
 *     tiers 0 → 5                    116 correct · 0 wrong · 16 abstained
 *     tiers 0 → 1 → 2 → 3 → 5        116 correct · 0 wrong · 16 abstained
 *
 * So `[0, 5]`, and deliberately not a finer ladder: the intermediate tiers add
 * two claims across the whole corpus, which is noise. This is blocking from
 * record linkage — the one technique from that literature that transfers cleanly,
 * because it changes the ORDER of decisions without weakening any of them.
 *
 * ⚠️ Widening past `TRANSFER_MATCH_WINDOW_DAYS` is NOT a further tier. The gap
 * histogram decays to ~6 days and then RISES again on recurrence; a wider tier
 * manufactures pairs between months. See that constant's own note.
 */
export const STRATIFIED_MATCH_TIERS: readonly number[] = [0, TRANSFER_MATCH_WINDOW_DAYS];

/** How a leg came to be claimed. Mirrors the evidence ladder's top two rungs. */
export type ClaimTier = "PROVIDER_LINKED" | "ACCOUNT_CERTAIN";

export interface CorpusClaim {
  tier: ClaimTier;
  /** The opposing leg. Always a specific row at both of these tiers. */
  mateId: string;
}

/**
 * The corpus-scoped resolution, computed ONCE.
 *
 * Tier order is the whole design: each claim REMOVES both of its legs from every
 * later tier's pool, which is what lets a provider assertion improve structural
 * matching downstream.
 *
 * ⚠️ That cascade is also the main structural risk in this architecture. One
 * wrong provider claim removes two legs and can cause a downstream mis-pairing
 * that would not otherwise occur. The mitigation is that a provider group must
 * survive EVERY validation clause or produce no evidence at all — never weaker
 * evidence. There is no partial credit anywhere in this function.
 */
export interface TransferCorpusIndex {
  claims: ReadonlyMap<string, CorpusClaim>;
  /** Legs consumed by a claim — excluded from every later candidate set. */
  claimed: ReadonlySet<string>;
}

/** Legs of unequal magnitude or differing currency can never pair, so the corpus
 *  splits into closed components and every O(n²) pass runs inside one. */
function componentKey(l: TransferLeg): string {
  return `${l.currency ?? ""}|${Math.round(Math.abs(l.amount) * 100)}`;
}

/** Mutually-unique pairs within one pool at one day tolerance. Deterministic and
 *  order-independent: mutual uniqueness is symmetric, so the result depends only
 *  on the set. */
function mutualPairsAt(pool: readonly TransferLeg[], days: number): [string, string][] {
  const forward = new Map<string, string[]>();
  for (const a of pool) {
    for (const b of pool) {
      if (!legsQualify(a, b)) continue;
      if (Math.abs(a.dateMs - b.dateMs) / 86_400_000 > days) continue;
      const list = forward.get(a.id);
      if (list) list.push(b.id); else forward.set(a.id, [b.id]);
    }
  }
  const out: [string, string][] = [];
  for (const [a, bs] of forward) {
    if (bs.length !== 1) continue;
    const back = forward.get(bs[0]);
    if (!back || back.length !== 1 || back[0] !== a) continue;
    if (a < bs[0]) out.push([a, bs[0]]);      // emit each pair once, deterministically
  }
  return out;
}

/**
 * Build the corpus index: provider links first, then the stratified structural
 * tiers on what remains.
 *
 * Pure and deterministic. Exported so a repair/audit can inspect the claim set
 * directly rather than inferring it from per-row answers.
 */
export function buildTransferCorpusIndex(corpus: readonly TransferLeg[]): TransferCorpusIndex {
  const claims = new Map<string, CorpusClaim>();
  const claimed = new Set<string>();
  const claim = (a: string, b: string, tier: ClaimTier) => {
    if (claimed.has(a) || claimed.has(b)) return;
    claims.set(a, { tier, mateId: b });
    claims.set(b, { tier, mateId: a });
    claimed.add(a); claimed.add(b);
  };

  // ── E1 — provider-asserted counterparty identity ─────────────────────────
  // Cash is excluded first: a provider correlation token on an ATM withdrawal
  // would still not give the money a destination ACCOUNT, and the form veto
  // outranks every leg-derived path by construction.
  const byLinkKey = new Map<string, TransferLeg[]>();
  for (const l of corpus) {
    if (!l.providerLinkKey || l.superseded || l.movementForm === "CASH") continue;
    const g = byLinkKey.get(l.providerLinkKey);
    if (g) g.push(l); else byLinkKey.set(l.providerLinkKey, [l]);
  }
  for (const group of byLinkKey.values()) {
    // Exactly two, and they must satisfy the SAME pairing predicate structural
    // matching uses. A provider assertion earns priority, not an exemption.
    if (group.length !== 2) continue;
    const [a, b] = group;
    if (!legsQualify(a, b)) continue;
    claim(a.id, b.id, "PROVIDER_LINKED");
  }

  // ── E2 — stratified structural determinism ───────────────────────────────
  const components = new Map<string, TransferLeg[]>();
  for (const l of corpus) {
    if (l.superseded || l.movementForm === "CASH") continue;
    const k = componentKey(l);
    const g = components.get(k);
    if (g) g.push(l); else components.set(k, [l]);
  }
  for (const days of STRATIFIED_MATCH_TIERS) {
    for (const group of components.values()) {
      const pool = group.filter((l) => !claimed.has(l.id));
      if (pool.length < 2) continue;
      for (const [a, b] of mutualPairsAt(pool, days)) claim(a, b, "ACCOUNT_CERTAIN");
    }
  }
  return { claims, claimed };
}

/**
 * Memoized index per corpus ARRAY IDENTITY.
 *
 * `resolveDestinationEvidenceFor` is called once per leg with the same corpus, so
 * rebuilding the index each time would make a full-corpus audit O(n³). Keyed on
 * the array reference, which is safe because the corpus is built once and read
 * many times; a caller that mutates a corpus array in place gets a stale index,
 * and must build a new array instead (as every caller already does).
 */
const INDEX_CACHE = new WeakMap<object, TransferCorpusIndex>();
function indexFor(corpus: readonly TransferLeg[]): TransferCorpusIndex {
  const key = corpus as unknown as object;
  const hit = INDEX_CACHE.get(key);
  if (hit) return hit;
  const built = buildTransferCorpusIndex(corpus);
  INDEX_CACHE.set(key, built);
  return built;
}

/**
 * Resolve destination evidence for `source` against the whole corpus.
 *
 * This is the entry point a consumer should use. The set-level
 * `resolveDestinationEvidence` remains available for callers that already hold a
 * candidate set, but only this one applies the provider tier and the stratified
 * structural tiers, and only this one guarantees the reverse direction was
 * actually computed rather than assumed.
 */
export function resolveDestinationEvidenceFor(
  source: TransferLeg,
  corpus: readonly TransferLeg[],
): DestinationEvidence {
  if (source.movementForm === "CASH") {
    return resolveDestinationEvidence([], { movementForm: "CASH" });
  }

  const index = indexFor(corpus);
  const claim = index.claims.get(source.id);
  if (claim) {
    const mate = corpus.find((c) => c.id === claim.mateId);
    if (mate) {
      return {
        level: claim.tier,
        accountId: mate.accountId, accountType: mate.accountType, legId: mate.id,
        candidateAccountIds: [mate.accountId], candidateTypes: [mate.accountType],
        persistableCounterparty: true, persistableLeg: true,
      };
    }
  }

  // Unclaimed. The remaining candidates are the legs no higher tier spoke for —
  // which is precisely why anything still standing here is genuinely contested.
  const forward = corpus.filter((c) => !index.claimed.has(c.id) && legsQualify(source, c));
  const candidates: DestinationCandidate[] = forward.map((leg) => ({
    legId: leg.id,
    accountId: leg.accountId,
    accountType: leg.accountType,
    // The reverse direction, with the same predicate, over the same pool.
    competingSourceCount: corpus.filter(
      (c) => !index.claimed.has(c.id) && legsQualify(leg, c),
    ).length,
    superseded: leg.superseded,
    // v2.6-XFER-1 — does this candidate NAME the source account? The mask was
    // already extracted for `legsQualify`'s subtractive clause; this reads the
    // same fact in the positive direction, so identification and disqualification
    // can never disagree about what a descriptor said.
    identifiesSource: leg.maskedDestinationAccountId === source.accountId,
  }));

  // The UNION of sources competing for ANY candidate leg — the pigeonhole input.
  // Counting per-leg maxima would over-count when two legs share one rival and
  // under-count when they have different ones; only the union is the real
  // constraint, and only this corpus-scoped function can compute it.
  //
  // v2.6-XFER-1 — computed over the set the ladder will actually judge. When
  // identification narrows the candidates, the sources competing for the DROPPED
  // legs are no longer part of the constraint, and counting them would refuse
  // the pigeonhole rung on rivals that are no longer in contention. The
  // narrowing predicate is applied identically here and in
  // `resolveDestinationEvidence`; a single helper keeps them from drifting.
  const judged = narrowByIdentification(forward, source.accountId);
  const competing = new Set<string>([source.id]);
  for (const leg of judged) {
    for (const c of corpus) {
      if (index.claimed.has(c.id)) continue;
      if (legsQualify(leg, c)) competing.add(c.id);
    }
  }
  const evidence = resolveDestinationEvidence(candidates, {
    movementForm: source.movementForm ?? null,
    competingSourceCount: competing.size,
  });

  // Cross-owner DETECTION — never matching. Attached only when nothing owned
  // qualified, so a named limitation replaces a bare unknown.
  if (evidence.level === "NO_DESTINATION_EVIDENCE") {
    const crossOwner = corpus.filter((c) => legsQualifyIgnoringOwner(source, c)).length;
    if (crossOwner > 0) {
      return {
        ...evidence,
        crossOwnerCandidateCount: crossOwner,
        unresolvedReason: "CROSS_OWNER_BOUNDARY",
      };
    }
  }
  return evidence;
}

/**
 * The maturity an evidence level supports.
 *
 * ⚠️ The ROW'S OWN account and direction come first, and the full-corpus audit is
 * why. A destination-only ladder mis-read **103 live rows**: an inflow ARRIVING at
 * a credit card ("MOBILE PAYMENT - THANK YOU", +$980.48 on the Platinum Card®)
 * has a CHECKING counterparty, so destination-type alone called it a cash
 * transfer. It is a debt payment, and the receiving account's own type says so
 * without needing the counterparty at all.
 *
 * The two own-account rules mirror the flow classifier's existing structural
 * veto (`debtPaymentUnlessLiabilityOutflow`), which this must not contradict:
 *
 *   money INTO a liability   → a debt payment. Settled by this account's type.
 *   money OUT of a liability → NEVER a debt payment; that is a charge, and it is
 *                              not a transfer leg this ladder should re-label.
 *
 * Only when the row's own account does not settle the question does the
 * destination type decide.
 *
 * ── Where the CASH veto sits in that precedence (v2.6-TRUTH-1) ───────────────
 *
 * The own-account rule runs FIRST, and the cash veto does not override it,
 * because the two answer different questions. The veto's subject is COUNTERPARTY
 * ATTRIBUTION: cash has no destination account, so no leg match may name one.
 * The own-account rule's subject is what the movement IS: money arriving at a
 * liability reduces what you owe whether it arrived as cash or as ACH, and that
 * conclusion never consults a counterparty — so there is nothing for the veto to
 * veto. A cash deposit onto a card stays a DEBT_PAYMENT, and still carries no
 * counterparty, because `accountId` is null at CASH_NO_COUNTERPARTY.
 *
 * The brief's requirement is that a cash row must not mature to a leaf "merely
 * because an equal opposite leg exists nearby". Every leg-derived path is vetoed.
 * The own-side path is not leg-derived, so it is not covered by that sentence and
 * is deliberately preserved.
 */
export function maturityForEvidence(
  e: DestinationEvidence,
  own?: OwnSideContext,
): TransferMaturity {
  // 1. The row's own account governs a liability inflow.
  //
  //    v2.6-TRUTH-3 — this used to return DEBT_PAYMENT unconditionally, which was
  //    false for every issuer-originated credit. The DEFAULT IS NOW INVERTED: a
  //    debt payment must be positively attested, and anything else declines to
  //    make the claim rather than forcing it.
  if (own && own.accountType === "debt") {
    if (own.amount > 0) {
      const v = liabilityInflowIsCustomerPayment({
        providerFamily: own.providerFamily,
        persistedCounterpartyAccountId: own.persistedCounterpartyAccountId,
        // The authority's OWN mutual-uniqueness verdict, never re-derived here.
        hasMutuallyMatchedOwnedCounterparty: e.persistableCounterparty,
      }).verdict;
      if (v === "YES") return "DEBT_PAYMENT";
      return v === "NO" ? "ISSUER_CREDIT" : "UNRESOLVED_LIABILITY_INFLOW";
    }
    // A liability OUTFLOW is a charge. The ladder has no leaf for that and must
    // not invent one, so it stays at the least-specific honest answer.
    return "UNRESOLVED_TRANSFER";
  }
  // 2. Otherwise the destination type decides, where it is known.
  switch (e.level) {
    // The form IS the answer. Never falls through to a leg-derived leaf.
    case "CASH_NO_COUNTERPARTY":
      return "CASH_MOVEMENT";
    case "PROVIDER_LINKED":
    case "ACCOUNT_CERTAIN":
    case "ACCOUNT_CERTAIN_LEG_AMBIGUOUS":
    case "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS":
      return leafForAccountType(e.accountType as string);
    case "TYPE_AMBIGUOUS":
      // Candidates exist and disagree. There IS an owned counterparty in that
      // set, so an external claim would be false; this is genuinely unresolved.
      return "UNRESOLVED_TRANSFER";
    case "NO_DESTINATION_EVIDENCE":
      // Phase 4 — nothing owned qualified. That is where an EXTERNAL movement
      // lives, but only where the provider attested something about it.
      return own ? externalLeafFor(own) : "UNRESOLVED_TRANSFER";
  }
}

/**
 * The external terminal leaf the row's OWN attested evidence supports — or
 * `UNRESOLVED_TRANSFER` when it supports none.
 *
 * ⚠️ The gate is POSITIVE EVIDENCE OF EXTERNALITY, and this is the line between a
 * terminal fact and a manufactured one. "No owned leg matched" is not evidence
 * that money left the household: the other side may be at an institution the user
 * has not connected yet, or may simply not have synced. Only an attested rail,
 * venue, or non-owned counterparty class licenses the claim.
 *
 * Precedence mirrors `deriveTransferDisposition` exactly — venue above rail —
 * because two authorities disagreeing about precedence is how the original cash
 * bug happened.
 */
function externalLeafFor(own: OwnSideContext): TransferMaturity {
  // An asset venue is capital deployment/liquidation; it outranks the rail.
  if (own.venueClass === "BROKERAGE" || own.venueClass === "EXCHANGE") {
    return "EXTERNAL_VENUE_TRANSFER";
  }
  if (own.venueClass === "DEPOSITORY") return "EXTERNAL_DEPOSITORY_TRANSFER";
  // A payment-app rail with no owned counterparty: the other side is a person.
  // The rail says HOW, and here it also settles WHO — not why, which stays
  // unresolved and is deliberately not claimed.
  if (own.railType === "PAYMENT_APP") return "EXTERNAL_PERSON_TRANSFER";
  // The provider attested a counterparty CLASS that cannot be an owned account.
  //
  // ⚠️ FINANCIAL_INSTITUTION is deliberately NOT in this set. Your own bank is a
  // financial institution, so that class is consistent with an internal transfer
  // whose other leg has not arrived — exactly the case that must stay unresolved.
  if (own.counterpartyClass && EXTERNAL_COUNTERPARTY_CLASSES.has(own.counterpartyClass)) {
    return "EXTERNAL_UNKNOWN_TRANSFER";
  }
  return "UNRESOLVED_TRANSFER";
}

/** Provider counterparty classes that cannot be one of the user's own accounts. */
const EXTERNAL_COUNTERPARTY_CLASSES: ReadonlySet<string> = new Set([
  "MERCHANT", "MARKETPLACE", "INCOME_SOURCE", "PAYMENT_APP", "PAYMENT_TERMINAL",
]);

/** The row's OWN side — its account type, signed amount, and the evidence the
 *  liability-inflow authority needs. */
export interface OwnSideContext {
  /** checking | savings | investment | crypto | debt | other. */
  accountType: string;
  /** Signed amount in the row's own account. Negative is outflow. */
  amount: number;
  /**
   * v2.6-TRUTH-3 — the provider's classification family (Plaid `pfcPrimary`).
   * Consulted ONLY for a positive liability-side movement, and never a merchant
   * string. Absent ⇒ the inflow resolves UNDETERMINED rather than being forced.
   */
  providerFamily?: string | null;
  /** A counterparty already persisted on the row — proof of an owned funding source. */
  persistedCounterpartyAccountId?: string | null;
  // ── Phase 4 — the row's OWN attested axes, for the external terminal leaves ──
  //
  // ⚠️ REQUIRED, not optional, and nullable to express honest absence. These are
  // read ONLY when no owned leg qualified, and they are the difference between
  // "you sent this to a person" and "we could not tell". A caller that omitted
  // them would silently send 116 fully-explained payment-app legs back to
  // UNRESOLVED — the exact defect Phase 4 exists to remove — and would look
  // identical to an institution that genuinely attests nothing.
  /** Provider-attested rail (PAYMENT_APP), when the adapter emitted one. */
  railType: string | null;
  /** Provider-attested venue class (DEPOSITORY / BROKERAGE / EXCHANGE). */
  venueClass: string | null;
  /** Provider counterparty class (Plaid `counterparties[].type`), when attested. */
  counterpartyClass: string | null;
}

export interface MaturationInput {
  /** The row's current flowType, whatever it is. Never a gate — see above. */
  flowType: string | null | undefined;
  /** Signed amount in the row's own account. Negative is outflow. */
  amount: number;
  /** The matched counterparty account, when one was established. */
  counterparty?: {
    accountId: string;
    /** checking | savings | investment | crypto | debt | other. */
    accountType: string;
    evidence: CounterpartyEvidence;
  } | null;
  /**
   * True when a balance gap on the counterparty is consistent with this
   * movement. SUPPORTING only: it may accompany a matched leg, never replace it.
   */
  balanceGapSupports?: boolean;
  /**
   * v2.6-L4-AUDIT — the FULL candidate set's evidence level. When supplied it
   * takes precedence over `counterparty`, because it can express certainty about
   * a destination TYPE without certainty about the account.
   */
  destination?: DestinationEvidence;
  /**
   * v2.6-L4-AUDIT — the ROW'S OWN account type. Supplying it lets the ladder
   * settle a liability inflow from the row itself, which the destination type
   * cannot do (see maturityForEvidence). Strongly recommended.
   */
  ownAccountType?: string;
  /**
   * v2.6-TRUTH-3 — the provider classification FAMILY, for a positive
   * liability-side movement. Without it `matureClassification` would resolve
   * every card credit UNDETERMINED — including genuine payments — and would
   * therefore disagree with `maturityForEvidence`, which the read path calls
   * directly. The two entry points must give the same answer for the same row.
   */
  ownProviderFamily?: string | null;
  /** v2.6-TRUTH-3 — a counterparty already persisted on the row. */
  persistedCounterpartyAccountId?: string | null;
  /** Phase 4 — the row's own attested rail, for the external terminal leaves. */
  ownRailType?: string | null;
  /** Phase 4 — the row's own attested venue class. */
  ownVenueClass?: string | null;
  /** Phase 4 — the row's own attested provider counterparty class. */
  ownCounterpartyClass?: string | null;
}

export interface MaturationResult {
  maturity: TransferMaturity;
  rank: 0 | 1 | 2;
  direction: "OUTFLOW" | "INFLOW";
  counterpartyAccountId: string | null;
  evidence: CounterpartyEvidence;
  /** True when the resolved maturity differs from what flowType currently says. */
  reclassified: boolean;
  /** The audit reason — always present, so a change is never silent. */
  reason: string;
  /**
   * Whether the evidence is strong enough to PERSIST counterpartyAccountId.
   * Requires a provider link or a uniquely matched leg; balance-gap support
   * alone never qualifies.
   */
  persistable: boolean;
  /**
   * Phase 2 — the specific known limitation, whenever the row is still
   * unresolved. Never a bare unknown: a surface that renders "unresolved" without
   * this is reporting less truth than the authority holds.
   */
  unresolvedReason: TransferUnresolvedReason | null;
}

/**
 * The FlowType a matured classification implies, for comparison against the
 * stored column — or NULL when the ladder makes no flowType claim at all.
 *
 * CASH_MOVEMENT implies TRANSFER: a withdrawal is still a transfer out of the
 * account, it simply has no counterparty. The stored vocabulary has no cash
 * member, and inventing one would be a schema change.
 *
 * v2.6-TRUTH-3 — the two liability-inflow leaves return **null**, and the
 * distinction is load-bearing. An issuer credit is not a transfer; saying
 * "implies TRANSFER" would replace one false claim (DEBT_PAYMENT) with another.
 * "No claim" and "a claim of TRANSFER" are different facts, so a caller that
 * compares stored-vs-implied must SKIP a null rather than treat it as a
 * disagreement. The transfer ladder has simply determined that this row is not
 * its business.
 */
export function impliedFlowType(m: TransferMaturity): "TRANSFER" | "DEBT_PAYMENT" | null {
  if (m === "DEBT_PAYMENT") return "DEBT_PAYMENT";
  if (m === "ISSUER_CREDIT" || m === "UNRESOLVED_LIABILITY_INFLOW") return null;
  // Phase 4 — the external leaves imply TRANSFER, unchanged from what these rows
  // already say. An external movement IS a transfer; only its destination is
  // outside the household. Naming it must not trigger a reclassification storm
  // across 137 rows that were already filed correctly.
  return "TRANSFER";
}

/**
 * Resolve the current best classification from the evidence available NOW.
 * Re-runnable: given more evidence it returns a higher rank, given the same
 * evidence it returns the same answer, and it never descends.
 */
export function matureClassification(input: MaturationInput): MaturationResult {
  const direction = input.amount < 0 ? "OUTFLOW" : "INFLOW";

  // v2.6-L4-AUDIT — the evidence-level path. When the caller supplies the whole
  // candidate SET, TYPE_CERTAIN_ACCOUNT_AMBIGUOUS becomes expressible: a rank-2
  // classification with NO persistable counterparty, which the single-counterparty
  // path below cannot represent.
  if (input.destination) {
    const e = input.destination;
    const maturity = maturityForEvidence(
      e,
      input.ownAccountType
        ? {
            accountType: input.ownAccountType,
            amount: input.amount,
            providerFamily: input.ownProviderFamily,
            persistedCounterpartyAccountId: input.persistedCounterpartyAccountId,
            railType: input.ownRailType ?? null,
            venueClass: input.ownVenueClass ?? null,
            counterpartyClass: input.ownCounterpartyClass ?? null,
          }
        : undefined,
    );
    const impliedNow = impliedFlowType(maturity);
    return {
      maturity,
      rank: maturityRank(maturity),
      direction,
      counterpartyAccountId: e.accountId,
      // A leg only counts as evidence where a leg was actually admitted. Neither
      // "nothing qualified" nor "cash, so nothing may qualify" is a matched leg.
      //
      // Phase 5 — a provider assertion is a PROVIDER_LINK, not a matched leg. The
      // distinction is the whole reason `CounterpartyEvidence` has both members:
      // one is the institution's statement, the other is our inference.
      evidence: e.level === "PROVIDER_LINKED" ? "PROVIDER_LINK"
        : e.level === "NO_DESTINATION_EVIDENCE" || e.level === "CASH_NO_COUNTERPARTY"
        ? "NONE" : "MATCHED_LEG",
      // v2.6-TRUTH-3 — a null implication is NO CLAIM, so it can never be a
      // reclassification. Treating it as one would report every issuer credit as
      // a proposed change to nothing in particular.
      reclassified: impliedNow !== null && (input.flowType ?? null) !== impliedNow,
      reason: input.ownAccountType === "debt"
        ? (input.amount > 0
            ? "Money arriving at a liability account is a debt payment; this account's own type settles it without needing the counterparty."
            : "Money leaving a liability account is a charge, never a debt payment, and the transfer ladder has no leaf for it.")
        : EVIDENCE_REASON[e.level](e),
      persistable: e.persistableCounterparty,
      unresolvedReason: unresolvedReasonFor(maturity, e),
    };
  }

  const cp = input.counterparty ?? null;

  // ── Rank 0 — the honest default ─────────────────────────────────────────
  if (cp === null || cp.evidence === "NONE") {
    return {
      maturity: "UNRESOLVED_TRANSFER",
      rank: 0,
      direction,
      counterpartyAccountId: null,
      evidence: "NONE",
      // A DEBT_PAYMENT with no destination evidence is a DEMOTION to honest —
      // the descriptor never justified the leaf in the first place.
      reclassified: input.flowType === "DEBT_PAYMENT",
      reason: input.flowType === "DEBT_PAYMENT"
        ? "No destination account was established, so the movement is an unresolved transfer; a descriptor naming an institution does not identify the destination."
        : "No destination account was established; direction is known, destination is not.",
      persistable: false,
      unresolvedReason: "NO_COUNTERPART_EVIDENCE",
    };
  }

  // A balance gap can support a matched leg but never establish one on its own.
  if (cp.evidence === "BALANCE_GAP_SUPPORT") {
    return {
      maturity: "UNRESOLVED_TRANSFER",
      rank: 0,
      direction,
      counterpartyAccountId: null,
      evidence: "BALANCE_GAP_SUPPORT",
      reclassified: input.flowType === "DEBT_PAYMENT",
      reason: "A balance gap is consistent with this movement, but a gap is not a transaction and cannot establish a destination on its own.",
      persistable: false,
      unresolvedReason: "NO_COUNTERPART_EVIDENCE",
    };
  }

  // ── Rank 1/2 — an owned counterparty exists; its TYPE names the movement ─
  const maturity = leafForAccountType(cp.accountType);
  const rank = maturityRank(maturity);
  const impliedNow = impliedFlowType(maturity);
  const supported = input.balanceGapSupports === true;

  return {
    maturity,
    rank,
    direction,
    counterpartyAccountId: cp.accountId,
    evidence: cp.evidence,
    reclassified: impliedNow !== null && (input.flowType ?? null) !== impliedNow,
    reason: `${LEAF_REASON[maturity]} (destination account type: ${cp.accountType}; evidence: ${cp.evidence}${supported ? " + balance-gap support" : ""}).`,
    // Only a provider link or a uniquely matched leg is strong enough to write.
    persistable: cp.evidence === "PROVIDER_LINK" || cp.evidence === "MATCHED_LEG",
    unresolvedReason: isUnresolvedMaturity(maturity) ? "NO_COUNTERPART_EVIDENCE" : null,
  };
}

/**
 * The specific limitation behind an unresolved row — never a bare unknown.
 *
 * Returns null the moment the ladder HAS an answer, including every terminal
 * external leaf and cash. A caller that finds a non-null value here is holding a
 * named, renderable explanation; a caller that finds null must not print
 * "unresolved".
 */
function unresolvedReasonFor(
  m: TransferMaturity,
  e: DestinationEvidence,
): TransferUnresolvedReason | null {
  if (!isUnresolvedMaturity(m)) return null;
  if (m === "UNRESOLVED_LIABILITY_INFLOW") return "LIABILITY_INFLOW_UNATTESTED";
  // The evidence already named it where it could (cross-owner, span-types).
  return e.unresolvedReason ?? "NO_COUNTERPART_EVIDENCE";
}

/** Destination account type → the leaf it names. The ONLY discriminator. */
function leafForAccountType(t: string): TransferMaturity {
  switch (t) {
    case "savings":    return "SAVINGS_TRANSFER";
    case "checking":   return "CASH_TRANSFER";
    case "debt":       return "DEBT_PAYMENT";
    case "investment":
    case "crypto":     return "INVESTMENT_TRANSFER";
    // A known owned account whose type names no leaf: rank 1, not a guess at 2.
    default:           return "INTERNAL_TRANSFER";
  }
}

const EVIDENCE_REASON: Record<DestinationEvidenceLevel, (e: DestinationEvidence) => string> = {
  PROVIDER_LINKED: (e) =>
    `The institution stamped one reference on both sides of this movement, identifying the owned ${e.accountType} account on the other side.`,
  ACCOUNT_CERTAIN: (e) =>
    `Exactly one owned ${e.accountType} account qualifies as the destination and that leg is matched by this source alone, so the pairing closes in both directions.`,
  // ⚠️ Names the account and says plainly that the ROW on the other side is not
  // merely unknown but unknowable. No surface should imply a pending answer.
  ACCOUNT_CERTAIN_LEG_AMBIGUOUS: (e) =>
    `Every qualifying destination leg is in the same owned ${e.accountType} account, so the destination account is established. Identical movements between these accounts in this window cannot be told apart, so the specific transaction on the other side is not identified.`,
  TYPE_CERTAIN_ACCOUNT_AMBIGUOUS: (e) =>
    `Every qualifying destination is a ${e.accountType} account, so the movement is established; the specific account is not${e.mutualityRefusal ? ` — ${e.mutualityRefusal}` : ""}, so no counterparty is recorded.`,
  TYPE_AMBIGUOUS: (e) =>
    `Candidate destinations span ${e.candidateTypes.length} different account types (${e.candidateTypes.join(", ")}), so nothing beyond "a transfer occurred" is supported.`,
  NO_DESTINATION_EVIDENCE: (e) =>
    e.unresolvedReason === "CROSS_OWNER_BOUNDARY"
      ? `No qualifying opposite leg exists on an account owned by this user, though ${e.crossOwnerCandidateCount} matching leg(s) exist on another owner's accounts. Transfers are only matched within one owner, so this is a known limitation rather than an absence of evidence.`
      : "No qualifying opposite leg exists on any owned account, so there is no destination to establish.",
  CASH_NO_COUNTERPARTY: () =>
    "The provider attests this movement changed the money's FORM (cash), which has no destination account; an equal opposite leg nearby is a coincidence of amount and date, not a relation.",
};

const LEAF_REASON: Record<TransferMaturity, string> = {
  UNRESOLVED_TRANSFER: "Destination unknown",
  INTERNAL_TRANSFER:   "Matched an owned account whose type names no more specific movement",
  SAVINGS_TRANSFER:    "Matched an owned SAVINGS account, so this is a savings transfer, not a debt payment",
  CASH_TRANSFER:       "Matched an owned checking account, so this is an internal cash transfer",
  DEBT_PAYMENT:        "Matched an owned LIABILITY account, so this is a debt payment",
  INVESTMENT_TRANSFER: "Matched an owned investment account, so this is an investment transfer",
  CASH_MOVEMENT:       "The money changed form (cash), so there is no destination account to establish",
  ISSUER_CREDIT:       "The provider attests a non-payment family on a liability inflow, so this is an issuer-originated credit, not a payment",
  UNRESOLVED_LIABILITY_INFLOW: "No family evidence and no owned funding leg, so this cannot be asserted as a debt payment",
  EXTERNAL_PERSON_TRANSFER:     "Moved over a payment-app rail with no owned account on the other side, so the counterparty is a person",
  EXTERNAL_DEPOSITORY_TRANSFER: "Reached a bank account that is not one of yours",
  EXTERNAL_VENUE_TRANSFER:      "Reached a brokerage or exchange that is not connected here",
  EXTERNAL_UNKNOWN_TRANSFER:    "The provider attests a counterparty that cannot be one of your accounts",
};

/**
 * Presentation wording. One place.
 *
 * ⚠️ The external leaves read as COMPLETED FACTS, not as failures. "Sent to
 * someone else" is what happened; "Unresolved transfer" would be a false
 * statement about a movement whose destination is perfectly well understood.
 */
export const MATURITY_LABEL: Record<TransferMaturity, string> = {
  UNRESOLVED_TRANSFER: "Unresolved transfer",
  INTERNAL_TRANSFER:   "Internal transfer",
  SAVINGS_TRANSFER:    "Savings transfer",
  CASH_TRANSFER:       "Internal cash transfer",
  DEBT_PAYMENT:        "Debt payment",
  INVESTMENT_TRANSFER: "Investment transfer",
  CASH_MOVEMENT:       "Cash movement",
  ISSUER_CREDIT:       "Issuer credit",
  UNRESOLVED_LIABILITY_INFLOW: "Unconfirmed card credit",
  EXTERNAL_PERSON_TRANSFER:     "Sent to someone else",
  EXTERNAL_DEPOSITORY_TRANSFER: "External bank transfer",
  EXTERNAL_VENUE_TRANSFER:      "External investment transfer",
  EXTERNAL_UNKNOWN_TRANSFER:    "External transfer",
};

/** Presentation wording for a named limitation. One place. */
export const UNRESOLVED_REASON_LABEL: Record<TransferUnresolvedReason, string> = {
  CANDIDATES_SPAN_TYPES:       "Several possible destinations of different kinds",
  CROSS_OWNER_BOUNDARY:        "The matching account belongs to another member",
  NO_COUNTERPART_EVIDENCE:     "Nothing on the other side has been shared with us",
  LIABILITY_INFLOW_UNATTESTED: "Not confirmed as a card payment",
};

/**
 * ── Monotonicity governs MATURATION. Retraction is a different act. ─────────
 *
 * `adoptIfMonotonic` protects an established classification from being made
 * LESS certain as new evidence arrives. That is the right rule for maturation:
 * evidence arriving should never cost the product something it already knew.
 *
 * It is the wrong rule for a REPAIR. A repair asserts that a stored leaf was
 * never earned — that there is no established certainty to protect, only a claim
 * the evidence never supported. Applying monotonicity there would use a rule
 * designed to protect knowledge to protect a guess instead, and would freeze
 * exactly the mis-classifications a repair exists to remove.
 *
 * So the two are separate functions with separate names, and a caller must SAY
 * which one it is doing. `adoptRetraction` additionally requires an explicit
 * `priorWasUnearned` assertion, so a descent can never happen by accident or by
 * a caller reaching for whichever helper compiles.
 */
export function adoptRetraction(
  previous: TransferMaturity | null,
  next: MaturationResult,
  opts: {
    /**
     * The caller's explicit assertion that the PRIOR classification was not
     * supported by evidence. Required, and required to be true: without it this
     * is a maturation and must go through adoptIfMonotonic.
     */
    priorWasUnearned: boolean;
  },
): { adopt: boolean; reason: string } {
  if (!opts.priorWasUnearned) {
    return {
      adopt: false,
      reason: "Not a retraction: the prior classification was not asserted to be unearned, so monotonicity applies and this must go through adoptIfMonotonic.",
    };
  }
  if (previous === null) return { adopt: true, reason: "Nothing to retract; first assessment." };
  const prevRank = maturityRank(previous);
  if (next.rank > prevRank) {
    return { adopt: true, reason: "Not a descent — this raises specificity and needs no retraction." };
  }
  if (next.rank === prevRank && next.maturity === previous) {
    return { adopt: false, reason: "Unchanged; nothing to retract." };
  }
  return {
    adopt: true,
    reason: `Retracting ${previous} (rank ${prevRank}) to ${next.maturity} (rank ${next.rank}): the prior leaf was not supported by evidence, and an unearned claim is not knowledge worth preserving.`,
  };
}

/**
 * Guard for re-evaluation as evidence ARRIVES: a later assessment may only keep
 * or raise specificity. Returns the assessment to adopt.
 *
 * See `adoptRetraction` above for the deliberate exception — a repair that
 * withdraws a classification proven to have been unearned.
 */
export function adoptIfMonotonic(
  previous: TransferMaturity | null,
  next: MaturationResult,
): { adopt: boolean; reason: string } {
  if (previous === null) return { adopt: true, reason: "First assessment." };

  // v2.6-TRUTH-1 — CASH_MOVEMENT is terminal against LEG-DERIVED evidence.
  //
  // Without this, the "same rank, different leaf" rule below would let a later
  // coincidental amount/date match overwrite an established form change — which
  // is the very substitution the cash veto exists to prevent, arriving one step
  // later. A row does not stop having been a cash withdrawal because an equal
  // opposite leg showed up nearby.
  //
  // This is not absolute: if the provider's form attestation itself was wrong,
  // that is a claim the earlier assessment was UNEARNED, and the caller must say
  // so through `adoptRetraction`. The split is deliberate and mirrors the
  // maturation/retraction doctrine documented above.
  if (previous === "CASH_MOVEMENT" && next.maturity !== "CASH_MOVEMENT") {
    return {
      adopt: false,
      reason: "The movement is an established form change (cash), which has no destination account; a leg matched on amount and date cannot supersede that. If the form attestation itself was wrong, retract it explicitly.",
    };
  }

  const prevRank = maturityRank(previous);
  if (next.rank > prevRank) return { adopt: true, reason: "New evidence raised specificity." };
  if (next.rank === prevRank && next.maturity === previous) {
    return { adopt: true, reason: "Unchanged." };
  }
  if (next.rank === prevRank) {
    // Same rank, different leaf: the destination TYPE changed, which means the
    // earlier match was wrong. Adopt — this is a correction, not a descent.
    return { adopt: true, reason: "Same specificity, different destination type: the earlier match is superseded." };
  }
  return { adopt: false, reason: "Would reduce specificity; the earlier, better-evidenced assessment is kept." };
}
