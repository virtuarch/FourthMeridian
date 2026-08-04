/**
 * lib/transactions/transfer-maturation.ts   (V27-L4C/D)
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
   * V27-TRUTH-1 — money changed FORM (cash out of / into an account). A terminal
   * fact, not an unknown: there is no destination ACCOUNT to find, so this is
   * maximally specific while carrying no counterparty. See CASH_NO_COUNTERPARTY.
   */
  | "CASH_MOVEMENT";

export function maturityRank(m: TransferMaturity): 0 | 1 | 2 {
  switch (m) {
    case "UNRESOLVED_TRANSFER": return 0;
    case "INTERNAL_TRANSFER":   return 1;
    // CASH_MOVEMENT is rank 2: "this was a form change" is a complete answer, not
    // a partial one. Ranking it 0 would let a later coincidental leg match
    // "raise" specificity and overwrite it — the exact defect this veto exists to
    // prevent.
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

/** Flow classifications eligible to ENTER transfer resolution.
 *
 *  DEBT_PAYMENT is in the set, and that is the point: the mis-filed leg above
 *  was excluded from its own repair because the resolver required TRANSFER.
 *  `null` is included because 352 seed rows carry no flowType at all. */
export const TRANSFER_CANDIDATE_FLOW_TYPES: readonly (string | null)[] = [
  "TRANSFER", "DEBT_PAYMENT", "UNKNOWN", null,
];

export function isTransferCandidate(flowType: string | null | undefined): boolean {
  return TRANSFER_CANDIDATE_FLOW_TYPES.includes(flowType ?? null);
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

// ── Destination evidence (V27-L4-AUDIT) ─────────────────────────────────────

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
  /** Exactly one destination LEG qualifies, and that leg sees exactly one
   *  qualifying source — a MUTUAL pairing. Account AND type are known, and
   *  `counterpartyAccountId` may be persisted. See the mutual-uniqueness note. */
  | "ACCOUNT_CERTAIN"
  /** Several accounts qualify but they all share ONE type — or a single account
   *  qualifies whose pairing is NOT mutual. The type names the movement; the
   *  account does NOT, so no counterparty may be persisted. */
  | "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS"
  /** Candidates span more than one destination type. Nothing above "a transfer
   *  happened" is supported. */
  | "TYPE_AMBIGUOUS"
  /** No qualifying opposite leg exists at all. Distinct from TYPE_AMBIGUOUS:
   *  there is nothing to be ambiguous BETWEEN, and inventing one would be
   *  fabrication rather than a guess. */
  | "NO_DESTINATION_EVIDENCE"
  /**
   * V27-TRUTH-1 — the money changed FORM. Cash has no destination account to
   * find, so leg matching is not merely inconclusive here, it is inapplicable.
   * Structurally terminal: `accountId` is null and `persistableCounterparty` is
   * false at this level and cannot be otherwise.
   */
  | "CASH_NO_COUNTERPARTY";

/**
 * One candidate destination — a SPECIFIC opposite leg on an owned account.
 *
 * ⚠️ This is a LEG, not an account. The distinction is the whole of V27-TRUTH-1.
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
}

export interface DestinationEvidence {
  level: DestinationEvidenceLevel;
  /** Set ONLY at ACCOUNT_CERTAIN. Null at every other level, by construction. */
  accountId: string | null;
  /** Set at ACCOUNT_CERTAIN and TYPE_CERTAIN_ACCOUNT_AMBIGUOUS. */
  accountType: string | null;
  /** Set ONLY at ACCOUNT_CERTAIN — the specific mutually-paired leg. */
  legId: string | null;
  candidateAccountIds: string[];
  candidateTypes: string[];
  /** True ONLY at ACCOUNT_CERTAIN — the one level where an account id is a fact. */
  persistableCounterparty: boolean;
  /**
   * Why a pairing that LOOKED unique was refused. Present only when the demotion
   * happened, so a repair can report the reason instead of silently proposing
   * less. Never used to justify a write.
   */
  mutualityRefusal?: string;
}

/**
 * Resolve the destination evidence level from the candidate LEG set.
 *
 * ── Two structural vetoes (V27-TRUTH-1) ─────────────────────────────────────
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
export function resolveDestinationEvidence(
  candidates: readonly DestinationCandidate[],
  opts: {
    /** The SOURCE row's movement form, when the provider attests one. */
    movementForm?: TransferMovementForm | null;
  } = {},
): DestinationEvidence {
  // ── Veto 1 — cash. Before any candidate is even considered. ───────────────
  if (opts.movementForm === "CASH") {
    return {
      level: "CASH_NO_COUNTERPARTY",
      accountId: null, accountType: null, legId: null,
      candidateAccountIds: [], candidateTypes: [],
      persistableCounterparty: false,
    };
  }

  // Supersession is enforced here, not by the caller.
  const live = candidates.filter((c) => !c.superseded);

  const accountIds = [...new Set(live.map((c) => c.accountId))].sort();
  const types = [...new Set(live.map((c) => c.accountType))].sort();

  if (accountIds.length === 0) {
    return {
      level: "NO_DESTINATION_EVIDENCE",
      accountId: null, accountType: null, legId: null,
      candidateAccountIds: [], candidateTypes: [],
      persistableCounterparty: false,
    };
  }

  // ── Veto 2 — mutual uniqueness. ──────────────────────────────────────────
  if (live.length === 1 && live[0].competingSourceCount === 1) {
    return {
      level: "ACCOUNT_CERTAIN",
      accountId: live[0].accountId, accountType: live[0].accountType,
      legId: live[0].legId,
      candidateAccountIds: accountIds, candidateTypes: types,
      persistableCounterparty: true,
    };
  }

  // Not mutual. Say WHY, then fall to the strongest honest level below.
  const refusal =
    live.length > 1
      ? `${live.length} qualifying destination legs across ${accountIds.length} account(s); the forward direction is not unique.`
      : `The single qualifying leg (${live[0].legId}) is itself matched by ${live[0].competingSourceCount} source events, so the pairing does not close in both directions.`;

  if (types.length === 1) {
    return {
      level: "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS",
      // The account is genuinely unknown — never guess one from the set.
      accountId: null, accountType: types[0], legId: null,
      candidateAccountIds: accountIds, candidateTypes: types,
      persistableCounterparty: false,
      mutualityRefusal: refusal,
    };
  }
  return {
    level: "TYPE_AMBIGUOUS",
    accountId: null, accountType: null, legId: null,
    candidateAccountIds: accountIds, candidateTypes: types,
    persistableCounterparty: false,
    mutualityRefusal: refusal,
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
  const days = Math.abs(a.dateMs - b.dateMs) / 86_400_000;
  return days <= TRANSFER_MATCH_WINDOW_DAYS;
}

/**
 * Resolve destination evidence for `source` against the whole corpus, computing
 * BOTH directions with `legsQualify`.
 *
 * This is the entry point a consumer should use. The set-level
 * `resolveDestinationEvidence` remains available for callers that already hold a
 * candidate set, but only this one guarantees the reverse count was actually
 * computed rather than assumed.
 */
export function resolveDestinationEvidenceFor(
  source: TransferLeg,
  corpus: readonly TransferLeg[],
): DestinationEvidence {
  if (source.movementForm === "CASH") {
    return resolveDestinationEvidence([], { movementForm: "CASH" });
  }
  const forward = corpus.filter((c) => legsQualify(source, c));
  const candidates: DestinationCandidate[] = forward.map((leg) => ({
    legId: leg.id,
    accountId: leg.accountId,
    accountType: leg.accountType,
    // The reverse direction, with the same predicate. Includes `source` itself.
    competingSourceCount: corpus.filter((c) => legsQualify(leg, c)).length,
    superseded: leg.superseded,
  }));
  return resolveDestinationEvidence(candidates, { movementForm: source.movementForm ?? null });
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
 * ── Where the CASH veto sits in that precedence (V27-TRUTH-1) ───────────────
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
  // 1. The row's own account settles a liability inflow outright — no
  //    counterparty consulted, so the cash veto has nothing to act on here.
  if (own && own.accountType === "debt") {
    if (own.amount > 0) return "DEBT_PAYMENT";
    // A liability OUTFLOW is a charge. The ladder has no leaf for that and must
    // not invent one, so it stays at the least-specific honest answer.
    return "UNRESOLVED_TRANSFER";
  }
  // 2. Otherwise the destination type decides, where it is known.
  switch (e.level) {
    // The form IS the answer. Never falls through to a leg-derived leaf.
    case "CASH_NO_COUNTERPARTY":
      return "CASH_MOVEMENT";
    case "ACCOUNT_CERTAIN":
    case "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS":
      return leafForAccountType(e.accountType as string);
    case "TYPE_AMBIGUOUS":
    case "NO_DESTINATION_EVIDENCE":
      return "UNRESOLVED_TRANSFER";
  }
}

/** The row's OWN side — its account type and signed amount. */
export interface OwnSideContext {
  /** checking | savings | investment | crypto | debt | other. */
  accountType: string;
  /** Signed amount in the row's own account. Negative is outflow. */
  amount: number;
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
   * V27-L4-AUDIT — the FULL candidate set's evidence level. When supplied it
   * takes precedence over `counterparty`, because it can express certainty about
   * a destination TYPE without certainty about the account.
   */
  destination?: DestinationEvidence;
  /**
   * V27-L4-AUDIT — the ROW'S OWN account type. Supplying it lets the ladder
   * settle a liability inflow from the row itself, which the destination type
   * cannot do (see maturityForEvidence). Strongly recommended.
   */
  ownAccountType?: string;
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
}

/** The FlowType a matured classification implies, for comparison against the
 *  stored column. Kept separate from the ladder so the ladder can be finer.
 *
 *  CASH_MOVEMENT implies TRANSFER: a withdrawal is still a transfer out of the
 *  account, it simply has no counterparty. The stored vocabulary has no cash
 *  member, and inventing one would be a schema change. */
export function impliedFlowType(m: TransferMaturity): "TRANSFER" | "DEBT_PAYMENT" {
  return m === "DEBT_PAYMENT" ? "DEBT_PAYMENT" : "TRANSFER";
}

/**
 * Resolve the current best classification from the evidence available NOW.
 * Re-runnable: given more evidence it returns a higher rank, given the same
 * evidence it returns the same answer, and it never descends.
 */
export function matureClassification(input: MaturationInput): MaturationResult {
  const direction = input.amount < 0 ? "OUTFLOW" : "INFLOW";

  // V27-L4-AUDIT — the evidence-level path. When the caller supplies the whole
  // candidate SET, TYPE_CERTAIN_ACCOUNT_AMBIGUOUS becomes expressible: a rank-2
  // classification with NO persistable counterparty, which the single-counterparty
  // path below cannot represent.
  if (input.destination) {
    const e = input.destination;
    const maturity = maturityForEvidence(
      e,
      input.ownAccountType ? { accountType: input.ownAccountType, amount: input.amount } : undefined,
    );
    const impliedNow = impliedFlowType(maturity);
    return {
      maturity,
      rank: maturityRank(maturity),
      direction,
      counterpartyAccountId: e.accountId,
      // A leg only counts as evidence where a leg was actually admitted. Neither
      // "nothing qualified" nor "cash, so nothing may qualify" is a matched leg.
      evidence: e.level === "NO_DESTINATION_EVIDENCE" || e.level === "CASH_NO_COUNTERPARTY"
        ? "NONE" : "MATCHED_LEG",
      reclassified: (input.flowType ?? null) !== impliedNow,
      reason: input.ownAccountType === "debt"
        ? (input.amount > 0
            ? "Money arriving at a liability account is a debt payment; this account's own type settles it without needing the counterparty."
            : "Money leaving a liability account is a charge, never a debt payment, and the transfer ladder has no leaf for it.")
        : EVIDENCE_REASON[e.level](e),
      persistable: e.persistableCounterparty,
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
    reclassified: (input.flowType ?? null) !== impliedNow,
    reason: `${LEAF_REASON[maturity]} (destination account type: ${cp.accountType}; evidence: ${cp.evidence}${supported ? " + balance-gap support" : ""}).`,
    // Only a provider link or a uniquely matched leg is strong enough to write.
    persistable: cp.evidence === "PROVIDER_LINK" || cp.evidence === "MATCHED_LEG",
  };
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
  ACCOUNT_CERTAIN: (e) =>
    `Exactly one owned ${e.accountType} account qualifies as the destination and that leg is matched by this source alone, so the pairing closes in both directions.`,
  TYPE_CERTAIN_ACCOUNT_AMBIGUOUS: (e) =>
    `Every qualifying destination is a ${e.accountType} account, so the movement is established; the specific account is not${e.mutualityRefusal ? ` — ${e.mutualityRefusal}` : ""}, so no counterparty is recorded.`,
  TYPE_AMBIGUOUS: (e) =>
    `Candidate destinations span ${e.candidateTypes.length} different account types (${e.candidateTypes.join(", ")}), so nothing beyond "a transfer occurred" is supported.`,
  NO_DESTINATION_EVIDENCE: () =>
    "No qualifying opposite leg exists on any owned account, so there is no destination to establish.",
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
};

/** Presentation wording. One place. */
export const MATURITY_LABEL: Record<TransferMaturity, string> = {
  UNRESOLVED_TRANSFER: "Unresolved transfer",
  INTERNAL_TRANSFER:   "Internal transfer",
  SAVINGS_TRANSFER:    "Savings transfer",
  CASH_TRANSFER:       "Internal cash transfer",
  DEBT_PAYMENT:        "Debt payment",
  INVESTMENT_TRANSFER: "Investment transfer",
  CASH_MOVEMENT:       "Cash movement",
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

  // V27-TRUTH-1 — CASH_MOVEMENT is terminal against LEG-DERIVED evidence.
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
