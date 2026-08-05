/**
 * lib/transactions/transfer-admission.ts   (Financial Truth — Transfer Authority, Phase 1)
 *
 * WHO IS ALLOWED TO BE A TRANSFER LEG.
 *
 * Pure: no DB, no React, no clock, no provider strings beyond the two Plaid
 * FAMILY tokens the liability authority already relies on. Runnable under tsx.
 *
 * ── The defect this replaces ────────────────────────────────────────────────
 *
 * `isTransferCandidate` admitted `flowType ∈ {TRANSFER, DEBT_PAYMENT, UNKNOWN, null}`.
 * Measured over the live corpus that admitted 1,023 rows, of which:
 *
 *   352  had NO flowType at all — "never classified", not "might be a transfer".
 *        Among them: Payroll Direct Deposit ×41, Dining ×39, Subscriptions ×35,
 *        Groceries ×29, Utilities ×24, Buy/Sell ×36.
 *    65  were liability OUTFLOWS — a charge on a card, which is structurally
 *        incapable of being a transfer leg and which the flow classifier's own
 *        `debtPaymentUnlessLiabilityOutflow` veto already says is not one.
 *     8  were classified but carried no transfer evidence of any kind.
 *
 * Every one of those 425 rows was then counted, forever, as an UNRESOLVED
 * TRANSFER — a failure metric measuring rows that were never transfers.
 *
 * ── Why `null` is not a hypothesis ─────────────────────────────────────────
 *
 * A null `flowType` means no classifier has ruled. Admitting it makes the
 * transfer authority act on a hypothesis nobody formed — and, for a real user
 * with an import backlog, makes the transfer authority RACE the classifier. The
 * honest handling is to name it: `NOT_CLASSIFIED` is a reported backlog, never a
 * silent drop.
 *
 * ⚠️ The test is `flowType === null`, NOT `classifierVersion === null`.
 * `scripts/audit-flow-desync.ts` documents a third population — FOREIGN
 * AUTHORITY, where `classifierVersion` is null but `flowType` was written by a
 * different authority (today `lib/crypto/btc-sync.ts`). Those rows ARE
 * classified, just not by `classifyFlow`, and excluding them would silently drop
 * every on-chain transfer.
 *
 * ── Why admission is not merely a metric fix ───────────────────────────────
 *
 * Removing 65 liability charges removes 65 FALSE COMPETITORS from every other
 * leg's candidate set. A −$2,000 card charge and a −$2,000 checking debit both
 * qualify as sources for the same +$2,000 arrival, and the mutual-uniqueness
 * veto then correctly refuses both. Correct admission CAUSES correct resolution;
 * it is the first tier of the ladder, not a preamble to it.
 *
 * ── Seed / demo data is excluded BY PREDICATE, never by identity ────────────
 *
 * ⚠️ There is deliberately no owner allow-list, no institution deny-list and no
 * "Demo Bank" string anywhere in this file. All 352 seed rows in the live corpus
 * are excluded because they are UNCLASSIFIED — a rule that generalizes to a real
 * user's CSV backlog, to a newly-connected institution before the classifier
 * runs, and to a provider whose adapter has not shipped. A hard-coded exclusion
 * would generalize to nothing, and would silently start hiding real rows on the
 * day seed data gets classified.
 */

/** Why a row is, or is not, a member of the canonical transfer corpus. */
export type TransferAdmission =
  /** A legitimate transfer leg. Enters the evidence ladder. */
  | "ADMITTED"
  /** No classifier has ruled. A BACKLOG, not a transfer. Must be reported. */
  | "NOT_CLASSIFIED"
  /** Classified as something that is not a movement (spending, income, fee, …). */
  | "NOT_A_TRANSFER_FLOW"
  /**
   * Money LEAVING a liability account. That is a charge — the card lending you
   * money — and no ladder leaf describes it. The flow classifier already vetoes
   * it (`debtPaymentUnlessLiabilityOutflow`); this agrees with that authority
   * rather than admitting the row and failing to classify it later.
   */
  | "LIABILITY_CHARGE"
  /** Classified as transfer-ish but carrying no evidence that value moved. */
  | "NOT_TRANSFER_SHAPED"
  /** A zero amount has no direction, so it cannot be a leg of anything. */
  | "ZERO_AMOUNT"
  /** No owning account — nothing to be a side of. */
  | "NO_ACCOUNT";

export interface TransferAdmissionInput {
  /** The row's persisted flowType. `null` means NOT CLASSIFIED. */
  flowType: string | null | undefined;
  /** Signed amount in the row's own account. Negative is outflow. */
  amount: number;
  /** The row's OWN account type: checking | savings | investment | crypto | debt | other. */
  accountType: string | null | undefined;
  /** The owning FinancialAccount id, or null when the row is orphaned. */
  accountId: string | null | undefined;
  /** Fourth Meridian's own category (Transfer / Payment / …). Never a provider string. */
  category?: string | null;
  /** Plaid `personal_finance_category.primary` — a FAMILY token, never a merchant. */
  providerFamily?: string | null;
  /** Provider-attested movement form (CASH), when the adapter emitted one. */
  movementForm?: string | null;
  /** Provider-attested rail (PAYMENT_APP), when the adapter emitted one. */
  railType?: string | null;
  /** Provider-attested venue class (DEPOSITORY / BROKERAGE / EXCHANGE). */
  venueClass?: string | null;
}

/**
 * The flow classifications capable of naming a movement.
 *
 * ⚠️ `null` is NOT here, and its absence is the whole of Phase 1. The previous
 * constant (`TRANSFER_CANDIDATE_FLOW_TYPES`) included it with the comment
 * "352 seed rows carry no flowType at all" — which was true, and was the reason
 * to exclude them rather than to admit them.
 */
export const ADMISSIBLE_FLOW_TYPES: readonly string[] = ["TRANSFER", "DEBT_PAYMENT", "UNKNOWN"];

/**
 * Provider families that attest a movement. Only the two the liability-inflow
 * authority already uses, plus the two transfer primaries — deliberately not a
 * growing list of provider vocabulary. A new provider adds an ADAPTER that emits
 * a rail/form/venue axis, which this predicate already accepts.
 */
const MOVEMENT_FAMILIES: ReadonlySet<string> = new Set([
  "TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS", "LOAN_DISBURSEMENTS",
]);

/** Fourth Meridian categories that assert a movement rather than a purchase. */
const MOVEMENT_CATEGORIES: ReadonlySet<string> = new Set(["Transfer", "Payment"]);

/**
 * Is there ANY evidence that value moved rather than being consumed or produced?
 *
 * Four independent sources, any one of which suffices. Provider-agnostic by
 * construction: an institution that supplies no PFC at all still passes on the
 * Fourth Meridian category, and a provider with no category still passes on an
 * attested axis. An institution supplying NONE of them yields
 * `NOT_TRANSFER_SHAPED`, which is honest rather than a guess in either direction.
 */
export function isTransferShaped(input: TransferAdmissionInput): boolean {
  if (input.providerFamily && MOVEMENT_FAMILIES.has(input.providerFamily)) return true;
  if (input.category && MOVEMENT_CATEGORIES.has(input.category)) return true;
  return Boolean(input.movementForm || input.railType || input.venueClass);
}

/**
 * The canonical admission decision. Total, deterministic, order-documented.
 *
 * Precedence matters and is asserted by test: structural impossibility
 * (`NO_ACCOUNT`, `ZERO_AMOUNT`) outranks classification state, which outranks
 * the liability-charge veto, which outranks shape. A row is reported under the
 * FIRST reason that applies, so the census never double-counts and every
 * excluded row carries exactly one explanation.
 */
export function admitTransferCandidate(input: TransferAdmissionInput): TransferAdmission {
  if (input.accountId == null) return "NO_ACCOUNT";
  if (Math.sign(input.amount) === 0) return "ZERO_AMOUNT";
  if (input.flowType == null) return "NOT_CLASSIFIED";
  if (!ADMISSIBLE_FLOW_TYPES.includes(input.flowType)) return "NOT_A_TRANSFER_FLOW";
  // The own-account veto, agreeing with the flow classifier rather than
  // duplicating its reasoning: money OUT of a liability is a charge.
  if (input.accountType === "debt" && input.amount < 0) return "LIABILITY_CHARGE";
  if (!isTransferShaped(input)) return "NOT_TRANSFER_SHAPED";
  return "ADMITTED";
}

/** Convenience for the many call sites that only need the boolean. */
export function isAdmittedTransferCandidate(input: TransferAdmissionInput): boolean {
  return admitTransferCandidate(input) === "ADMITTED";
}

/**
 * Presentation wording for the admission census. One place.
 *
 * `NOT_CLASSIFIED` reads as a BACKLOG and not as a rejection, because that is
 * what it is: those rows are waiting for a classifier, not failing a test.
 */
export const ADMISSION_LABEL: Record<TransferAdmission, string> = {
  ADMITTED:            "Transfer candidate",
  NOT_CLASSIFIED:      "Awaiting classification",
  NOT_A_TRANSFER_FLOW: "Not a movement",
  LIABILITY_CHARGE:    "Card charge, not a transfer leg",
  NOT_TRANSFER_SHAPED: "No evidence that value moved",
  ZERO_AMOUNT:         "Zero amount",
  NO_ACCOUNT:          "No owning account",
};

/**
 * Whether an exclusion is a BACKLOG (something we expect to admit later) or a
 * settled NO. The unresolved-transfer metric must never count either, but a
 * product surface treats them differently: a backlog is work in progress, a
 * settled no is finished.
 */
export function isAdmissionBacklog(a: TransferAdmission): boolean {
  return a === "NOT_CLASSIFIED";
}
