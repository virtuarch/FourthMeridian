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
  | "INVESTMENT_TRANSFER";

export function maturityRank(m: TransferMaturity): 0 | 1 | 2 {
  switch (m) {
    case "UNRESOLVED_TRANSFER": return 0;
    case "INTERNAL_TRANSFER":   return 1;
    default:                    return 2;
  }
}

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
  /** Exactly one destination account qualifies. Account AND type are known, and
   *  `counterpartyAccountId` may be persisted. */
  | "ACCOUNT_CERTAIN"
  /** Several accounts qualify but they all share ONE type. The type names the
   *  movement; the account does NOT, so no counterparty may be persisted. */
  | "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS"
  /** Candidates span more than one destination type. Nothing above "a transfer
   *  happened" is supported. */
  | "TYPE_AMBIGUOUS"
  /** No qualifying opposite leg exists at all. Distinct from TYPE_AMBIGUOUS:
   *  there is nothing to be ambiguous BETWEEN, and inventing one would be
   *  fabrication rather than a guess. */
  | "NO_DESTINATION_EVIDENCE";

/** One candidate destination — an owned account an opposite leg sits in. */
export interface DestinationCandidate {
  accountId: string;
  /** checking | savings | investment | crypto | debt | other. */
  accountType: string;
}

export interface DestinationEvidence {
  level: DestinationEvidenceLevel;
  /** Set ONLY at ACCOUNT_CERTAIN. Null at every other level, by construction. */
  accountId: string | null;
  /** Set at ACCOUNT_CERTAIN and TYPE_CERTAIN_ACCOUNT_AMBIGUOUS. */
  accountType: string | null;
  candidateAccountIds: string[];
  candidateTypes: string[];
  /** True ONLY at ACCOUNT_CERTAIN — the one level where an account id is a fact. */
  persistableCounterparty: boolean;
}

/**
 * Resolve the destination evidence level from the candidate set. Pure; the
 * caller owns finding the candidates (amount, sign, currency, window, ownership).
 */
export function resolveDestinationEvidence(
  candidates: readonly DestinationCandidate[],
): DestinationEvidence {
  const accountIds = [...new Set(candidates.map((c) => c.accountId))].sort();
  const types = [...new Set(candidates.map((c) => c.accountType))].sort();

  if (accountIds.length === 0) {
    return {
      level: "NO_DESTINATION_EVIDENCE",
      accountId: null, accountType: null,
      candidateAccountIds: [], candidateTypes: [],
      persistableCounterparty: false,
    };
  }
  if (accountIds.length === 1) {
    return {
      level: "ACCOUNT_CERTAIN",
      accountId: accountIds[0], accountType: types[0],
      candidateAccountIds: accountIds, candidateTypes: types,
      persistableCounterparty: true,
    };
  }
  if (types.length === 1) {
    return {
      level: "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS",
      // The account is genuinely unknown — never guess one from the set.
      accountId: null, accountType: types[0],
      candidateAccountIds: accountIds, candidateTypes: types,
      persistableCounterparty: false,
    };
  }
  return {
    level: "TYPE_AMBIGUOUS",
    accountId: null, accountType: null,
    candidateAccountIds: accountIds, candidateTypes: types,
    persistableCounterparty: false,
  };
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
 */
export function maturityForEvidence(
  e: DestinationEvidence,
  own?: OwnSideContext,
): TransferMaturity {
  // 1. The row's own account settles a liability inflow outright.
  if (own && own.accountType === "debt") {
    if (own.amount > 0) return "DEBT_PAYMENT";
    // A liability OUTFLOW is a charge. The ladder has no leaf for that and must
    // not invent one, so it stays at the least-specific honest answer.
    return "UNRESOLVED_TRANSFER";
  }
  // 2. Otherwise the destination type decides, where it is known.
  switch (e.level) {
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
 *  stored column. Kept separate from the ladder so the ladder can be finer. */
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
      evidence: e.level === "NO_DESTINATION_EVIDENCE" ? "NONE" : "MATCHED_LEG",
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
    `Exactly one owned ${e.accountType} account qualifies as the destination, so both the account and the movement are established.`,
  TYPE_CERTAIN_ACCOUNT_AMBIGUOUS: (e) =>
    `${e.candidateAccountIds.length} owned accounts qualify and every one is a ${e.accountType} account: the movement is established, the specific account is not, so no counterparty is recorded.`,
  TYPE_AMBIGUOUS: (e) =>
    `Candidate destinations span ${e.candidateTypes.length} different account types (${e.candidateTypes.join(", ")}), so nothing beyond "a transfer occurred" is supported.`,
  NO_DESTINATION_EVIDENCE: () =>
    "No qualifying opposite leg exists on any owned account, so there is no destination to establish.",
};

const LEAF_REASON: Record<TransferMaturity, string> = {
  UNRESOLVED_TRANSFER: "Destination unknown",
  INTERNAL_TRANSFER:   "Matched an owned account whose type names no more specific movement",
  SAVINGS_TRANSFER:    "Matched an owned SAVINGS account, so this is a savings transfer, not a debt payment",
  CASH_TRANSFER:       "Matched an owned checking account, so this is an internal cash transfer",
  DEBT_PAYMENT:        "Matched an owned LIABILITY account, so this is a debt payment",
  INVESTMENT_TRANSFER: "Matched an owned investment account, so this is an investment transfer",
};

/** Presentation wording. One place. */
export const MATURITY_LABEL: Record<TransferMaturity, string> = {
  UNRESOLVED_TRANSFER: "Unresolved transfer",
  INTERNAL_TRANSFER:   "Internal transfer",
  SAVINGS_TRANSFER:    "Savings transfer",
  CASH_TRANSFER:       "Internal cash transfer",
  DEBT_PAYMENT:        "Debt payment",
  INVESTMENT_TRANSFER: "Investment transfer",
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
