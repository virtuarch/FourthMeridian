/**
 * lib/transactions/transfer-evidence.ts
 *
 * Provider-neutral TRANSFER ontology — the canonical contract every evidence
 * source (Plaid, exchanges, brokerages, wallets, CSV import, manual entry, future
 * banks) normalizes INTO. Two stages; this file owns the canonical side:
 *
 *   Stage 1  (provider adapter, e.g. plaid-transfer-evidence.ts):
 *              provider-specific signal  →  TransferEvidence
 *   Stage 2  (THIS file, canonical):
 *              TransferEvidence + relationship context  →  TransferDisposition
 *
 * Doctrine:
 *  - EVIDENCE IS MULTI-AXIS AND ORTHOGONAL. A transfer signal answers at most one
 *    of several independent questions — the RAIL it used (a payment app), the
 *    FORM it took (physical cash), or the VENUE it reached (a bank / brokerage /
 *    exchange). These are not one "counterparty class"; a single provider signal
 *    illuminates one axis and leaves the others undefined. Do NOT collapse them.
 *  - OWNERSHIP IS NOT EVIDENCE. Whether the other side is a self-owned account is
 *    a CANONICAL RELATIONSHIP fact (from the owned-account transfer resolver), so
 *    it enters stage 2 as `TransferRelationshipContext`, never as an evidence axis
 *    and never emitted by a provider.
 *  - RAIL ≠ PURPOSE. A payment app is HOW money moved, not WHY. Payment-app
 *    evidence therefore derives an honest, ambiguous PAYMENT_APP_MOVEMENT — never
 *    P2P_PAYMENT / spending / income. Purpose is a later Party/Assertion concern.
 *  - PURE & self-contained: no imports, no DB/I-O, no provider names or strings.
 *    Runnable under tsx; importable anywhere. "Unknown over incorrect" — an
 *    unrecognized signal yields UNKNOWN_MOVEMENT, never a fabricated axis.
 *
 * Downstream (liquidity axis, Cash Flow Summary) consumes TransferDisposition and
 * never learns which provider produced the evidence. Adding a provider is a new
 * stage-1 adapter — this contract and everything below it are untouched.
 */

// ─── Stage-1 output / stage-2 input: provider-neutral, multi-axis evidence ─────

/** RAIL — the intermediary the movement travelled over. Smallest union the
 *  current evidence justifies; extend only when a provider distinctly attests a
 *  new rail. A rail says HOW, never WHY. */
export type TransferRail = "PAYMENT_APP";

/** FORM — the physical/monetary form the money took. Only CASH is currently
 *  attestable (an ATM withdrawal / branch deposit); "electronic/book" is the
 *  unmarked default (absence), not a value we fabricate. */
export type MovementForm = "CASH";

/** VENUE — the class of institution ASSOCIATED WITH the movement (a destination
 *  for an OUT, an origin for an IN — never assume "reached"). */
export type TransferVenue = "DEPOSITORY" | "BROKERAGE" | "EXCHANGE";

/** Net direction relative to the observed account (positive amount = IN). */
export type MovementDirection = "IN" | "OUT";

/**
 * What a provider adapter attests about one transfer-like movement. Every axis is
 * OPTIONAL and INDEPENDENT: a given signal typically sets exactly one of
 * {railType, movementForm, venueClass}. The provenance fields are always present.
 */
export interface TransferEvidence {
  /** The rail used, when attested (e.g. a payment app). Orthogonal to venue/form. */
  railType?:     TransferRail;
  /** The money's form, when attested (CASH). Orthogonal to rail/venue. */
  movementForm?: MovementForm;
  /** The venue class associated with the movement, when attested. Orthogonal. */
  venueClass?:   TransferVenue;
  /** Direction from the source's signed amount; undefined for a zero amount. */
  direction?:    MovementDirection;
  /**
   * 0..1 — confidence in the PROVIDER→NEUTRAL MAPPING itself (how sure the adapter
   * is that it translated the provider signal correctly), NOT confidence in the
   * transaction's purpose or final economic meaning. An exact deterministic family
   * match is 1.0 ("fully confident in this adapter translation"); no-signal and
   * unrecognized inputs are 0. A payment-app mapping being 1.0 says nothing about
   * whether the movement was a gift, reimbursement, income, spending, or P2P.
   */
  evidenceConfidence: number;
  /** Deterministic machine reason for THIS mapping (provenance; never parsed). */
  reason:        string;
  /** Emitting adapter id (e.g. "plaid"). Audit only — must not influence stage 2. */
  source:        string;
  /** Adapter/mapping version, so a re-map is detectable and replayable. */
  version:       string;
}

// ─── Canonical relationship context (NOT evidence, NOT provider-supplied) ──────

/**
 * Canonical relationship facts Fourth Meridian owns, supplied to stage 2
 * separately from provider evidence. Ownership is the ONLY signal that upgrades an
 * ambiguous depository movement to INTERNAL — and it comes from the owned-account
 * resolver / account tiers, never from a provider.
 */
export interface TransferRelationshipContext {
  /** True when the counterparty is a confirmed self-owned account. Undefined = not
   *  established. */
  counterpartyIsOwned?: boolean;
}

// ─── Stage-2 output: derived canonical disposition (NOT the evidence contract) ─

/**
 * The DERIVED movement disposition — what economically happened, computed from
 * evidence + relationship context. Deliberately NOT a FlowType and NOT the
 * evidence itself: it is the projection the Cash Flow Summary groups by. Honest
 * about ambiguity: a payment-app rail yields PAYMENT_APP_MOVEMENT (purpose
 * unresolved), never a claimed P2P payment.
 */
export type TransferDisposition =
  | "INTERNAL_TRANSFER"      // confirmed between your own accounts (wealth-neutral)
  | "EXTERNAL_BANK_TRANSFER" // to/from a depository not known to be owned
  | "ASSET_VENUE_TRANSFER"   // funding/withdrawing a brokerage/exchange (deploy/liquidate)
  | "CASH_MOVEMENT"          // to/from physical cash — a form change, no counterparty
  | "PAYMENT_APP_MOVEMENT"   // moved over a payment-app rail; purpose UNRESOLVED
  | "UNKNOWN_MOVEMENT";      // honest residue — nothing attestable

/**
 * Derive the canonical disposition from provider-neutral evidence plus canonical
 * relationship context. Pure, total, deterministic; never throws. Precedence is
 * fixed and documented so overlapping axes cannot be resolved ambiguously.
 */
export function deriveTransferDisposition(
  evidence: TransferEvidence,
  ctx: TransferRelationshipContext = {},
): TransferDisposition {
  // 1. Physical cash is a form change with no counterparty — it dominates.
  if (evidence.movementForm === "CASH") return "CASH_MOVEMENT";
  // 2. An asset venue is capital deployment/liquidation whether or not owned
  //    (the liquidity axis derives the tier crossing); venue dominates ownership.
  if (evidence.venueClass === "EXCHANGE" || evidence.venueClass === "BROKERAGE") {
    return "ASSET_VENUE_TRANSFER";
  }
  // 3. Confirmed ownership makes it internal regardless of rail/depository venue.
  if (ctx.counterpartyIsOwned === true) return "INTERNAL_TRANSFER";
  // 4. A depository not known to be owned is honestly external until a leg match.
  if (evidence.venueClass === "DEPOSITORY") return "EXTERNAL_BANK_TRANSFER";
  // 5. A payment-app rail tells us HOW, not WHY — ambiguous, never P2P/spending.
  if (evidence.railType === "PAYMENT_APP") return "PAYMENT_APP_MOVEMENT";
  // 6. Nothing attestable.
  return "UNKNOWN_MOVEMENT";
}
