/**
 * lib/transactions/transfer-debt-payment-correction.ts
 *
 * v2.7-P1 — THE TRANSFER AUTHORITY'S WRITE RULE for depository legs the provider
 * filed as a loan payment. Pure, deterministic, no I/O, no Prisma runtime.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * Plaid tags an ACH pull initiated by a bank-and-card issuer ("ORIG CO
 * NAME:AMERICANEXPRESS CO ENTRY DESCR:TRANSFER") with PFC primary
 * `LOAN_PAYMENTS`. `mapPlaidCategory` maps that to `Payment`, and the classifier
 * — context-free, institution-blind BY DESIGN — persists `DEBT_PAYMENT`. Both
 * legs are depository accounts; the money went to the owner's own savings.
 *
 * The transfer authority (lib/transactions/transfer-maturation.ts, reached through
 * lib/transactions/transfer-resolution.ts) already pairs such a leg correctly and
 * matures it to SAVINGS_TRANSFER / CASH_TRANSFER. It computed `reclassified:true`
 * and threw it away: nothing ever wrote the verdict back. Money totals were right
 * (the debt-payment attestation refuses an unattested cash leg) but the persisted
 * flowType and category were not, so every consumer that reads the row instead of
 * the authority — filters, the category chip, the AI's transfer total, the Brief —
 * reported a savings transfer as a debt payment.
 *
 * ── Why the correction is HERE and not in the classifier ────────────────────
 *
 * The fix needs the OTHER leg. `classifyFlow` sees one row and must stay that
 * way: an institution- or descriptor-aware classifier is the error class this
 * codebase spent an arc removing. The transfer authority is the module that
 * already holds the cross-row evidence, so it is the one that writes — stamping
 * `flowAuthority = TRANSFER_AUTHORITY`, which the Plaid sync's ownership gate
 * (syncTransactions.ts `ownFlow`) then refuses to overwrite on re-sync.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * ELIGIBLE (all of):
 *   · the row's own account is DEPOSITORY (checking / savings);
 *   · the row is live and not a pending observation superseded by its posted twin;
 *   · its category is not a human's (categorySource ∉ {USER_OVERRIDE, USER_RULE});
 *   · EITHER (A) the classifier wrote DEBT_PAYMENT from provider evidence — PFC
 *     primary LOAN_PAYMENTS or the `Payment` category —
 *     OR (B) this rule previously wrote it TRANSFER at low confidence (its own
 *     signature, below) and later evidence now settles it.
 *
 * DECISION, from the transfer authority's evidence level and maturity:
 *
 *   PROVIDER_LINKED / ACCOUNT_CERTAIN / ACCOUNT_CERTAIN_LEG_AMBIGUOUS /
 *   TYPE_CERTAIN_ACCOUNT_AMBIGUOUS   (the mutuality guard already applied)
 *       maturity a transfer leaf  → TRANSFER · Transfer · ACCOUNT_TYPE_CONTEXT · 1.0
 *       maturity DEBT_PAYMENT     → (A) keep  ·  (B) restore DEBT_PAYMENT · Payment
 *   TYPE_AMBIGUOUS                → (A) TRANSFER · Transfer · AMBIGUOUS_UNKNOWN · 0.2
 *                                   (the R1 precedent; surfaces needsClassification)
 *   NO_DESTINATION_EVIDENCE (unpaired):
 *       cross-owner boundary      → unchanged (detection only, never a write)
 *       liability evidence        → keep DEBT_PAYMENT
 *       otherwise                 → (A) TRANSFER · Transfer · AMBIGUOUS_UNKNOWN · 0.2
 *   CASH_NO_COUNTERPARTY          → unchanged
 *
 * "Liability evidence" for an unpaired leg is a persisted LIABILITY counterparty
 * or a PFC DETAILED category that names a liability (credit card, mortgage, car,
 * student or personal loan). `LOAN_PAYMENTS_OTHER_PAYMENT` names none, and is the
 * tag the issuer-pull rows carry.
 *
 * Both written signatures are already REGISTERED transfer-authority signatures
 * (scripts/backfill-flow-authority.ts REPAIR_WRITE_SIGNATURES):
 *   TRANSFER|ACCOUNT_TYPE_CONTEXT|1 · TRANSFER|AMBIGUOUS_UNKNOWN|0.2 ·
 *   DEBT_PAYMENT|ACCOUNT_TYPE_CONTEXT|1
 *
 * ── What it never touches ───────────────────────────────────────────────────
 *
 * amount · date · flowDirection · counterpartyAccountId · pending · deletedAt ·
 * provider PFC columns · categorySource (the merchant-intelligence stack's
 * column; this rule only READS it, to let a human's category win) · any balance. No counterparty is persisted: the evidence
 * names a TYPE at some levels and an account only at others, and the read path
 * already projects the counterparty with its KD-15 gate. `flowDirection` is
 * preserved, so the liquidity axis resolves the row exactly as before — an
 * unattested DEBT_PAYMENT cash leg and a TRANSFER leg both go through
 * `classifyTransfer` (liquidity.ts), which is why every money total is unchanged.
 */

import type { DestinationEvidenceLevel, TransferMaturity } from "@/lib/transactions/transfer-maturation";

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Own-account types that are depository. The rule never fires anywhere else. */
export const DEPOSITORY_ACCOUNT_TYPES: ReadonlySet<string> = new Set(["checking", "savings"]);

/** The maturities that name an OWNED, non-liability destination. */
export const TRANSFER_LEAF_MATURITIES: ReadonlySet<string> = new Set<TransferMaturity>([
  "SAVINGS_TRANSFER",
  "CASH_TRANSFER",
  "INVESTMENT_TRANSFER",
  "INTERNAL_TRANSFER",
]);

/** Evidence levels at which the destination TYPE is a fact (mutuality applied). */
export const TYPE_CERTAIN_EVIDENCE_LEVELS: ReadonlySet<string> = new Set<DestinationEvidenceLevel>([
  "PROVIDER_LINKED",
  "ACCOUNT_CERTAIN",
  "ACCOUNT_CERTAIN_LEG_AMBIGUOUS",
  "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS",
]);

/**
 * Provider DETAILED categories that name a liability. An unpaired leg carrying
 * one stays DEBT_PAYMENT: the provider positively named what kind of debt was
 * paid, which is evidence, not an institution guess. `LOAN_PAYMENTS_OTHER_PAYMENT`
 * is deliberately absent — it names nothing.
 */
export const LIABILITY_PAYMENT_DETAILS: ReadonlySet<string> = new Set([
  "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
  "LOAN_PAYMENTS_MORTGAGE_PAYMENT",
  "LOAN_PAYMENTS_CAR_PAYMENT",
  "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT",
  "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
]);

/** Category provenance a human authored. Always wins. */
export const USER_CATEGORY_SOURCES: ReadonlySet<string> = new Set(["USER_OVERRIDE", "USER_RULE"]);

/** The provider family the defect enters through. */
export const LOAN_PAYMENTS_FAMILY = "LOAN_PAYMENTS";

/** The written shapes. Each is a registered transfer-authority signature. */
export const CORRECTION_SHAPES = {
  TRANSFER_CERTAIN: {
    flowType: "TRANSFER", category: "Transfer",
    classificationReason: "ACCOUNT_TYPE_CONTEXT", classificationConfidence: 1,
  },
  TRANSFER_UNRESOLVED: {
    flowType: "TRANSFER", category: "Transfer",
    classificationReason: "AMBIGUOUS_UNKNOWN", classificationConfidence: 0.2,
  },
  DEBT_PAYMENT_RESTORED: {
    flowType: "DEBT_PAYMENT", category: "Payment",
    classificationReason: "ACCOUNT_TYPE_CONTEXT", classificationConfidence: 1,
  },
} as const;

export type CorrectionKind = keyof typeof CORRECTION_SHAPES;

/** Why a row was left exactly as it is. Every untouched candidate carries one. */
export type CorrectionSkipCode =
  | "DELETED"
  | "NOT_DEPOSITORY"
  | "NOT_ELIGIBLE_FLOW"          // neither (A) nor (B)
  | "NO_PROVIDER_PROVENANCE"     // DEBT_PAYMENT, but not from LOAN_PAYMENTS / Payment
  | "USER_CATEGORY"              // USER_OVERRIDE / USER_RULE — the human wins
  | "PENDING_SUPERSEDED"         // a pending observation whose posted twin is live: it retires
  | "PERSISTED_COUNTERPARTY"     // a persisted non-liability link the read path owns
  | "NOT_ASSESSED"               // the transfer authority returned no verdict
  | "LIABILITY_COUNTERPARTY"     // KEEP — the destination is a liability
  | "LIABILITY_EVIDENCE"         // KEEP — unpaired, but the provider named a liability
  | "CROSS_OWNER_BOUNDARY"       // detection only, never a write
  | "NO_TRANSFER_LEAF"           // cash movement / any maturity outside the leaf set
  | "NOT_YET_SETTLED";           // (B) still ambiguous — nothing new to say

export interface CorrectionInput {
  /** The row's own account type (checking | savings | investment | crypto | debt | other). */
  ownAccountType: string | null;
  flowType: string | null;
  flowAuthority: string | null;
  /** The row's Transaction.categorySource — read to respect a human's category, never written. */
  rowCategorySource: string | null;
  category: string | null;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
  classificationReason: string | null;
  classificationConfidence: number | null;
  deleted: boolean;
  /** A pending row whose posted twin (pendingTransactionRef) is live. */
  supersededByPosted: boolean;
  /**
   * The persisted counterparty's account type — `null` when the row carries no
   * persisted counterparty, `"unknown"` when it carries one we could not type.
   */
  persistedCounterpartyAccountType: string | null;
  /** The transfer authority's verdict for this row, or null when it gave none. */
  assessment: {
    evidenceLevel: string;
    maturity: string;
    unresolvedReason?: string | null;
  } | null;
}

export type CorrectionDecision =
  | {
      action: "WRITE";
      kind: CorrectionKind;
      /** Which eligibility arm admitted the row. */
      arm: "A" | "B";
      evidenceLevel: string;
      maturity: string;
      write: (typeof CORRECTION_SHAPES)[CorrectionKind];
    }
  | { action: "KEEP" | "SKIP"; code: CorrectionSkipCode };

const skip = (code: CorrectionSkipCode): CorrectionDecision => ({ action: "SKIP", code });
const keep = (code: CorrectionSkipCode): CorrectionDecision => ({ action: "KEEP", code });

/** (A) — the classifier wrote DEBT_PAYMENT from provider evidence. */
function isArmA(i: CorrectionInput): boolean {
  return i.flowType === "DEBT_PAYMENT" && i.flowAuthority === "CLASSIFIER";
}

/**
 * (B) — this rule's OWN low-confidence write, recognisable by its full shape.
 * The category is part of the shape on purpose: the L4-REPAIR-3 R1 rows share
 * the flow signature but kept category `Payment`, so they are NOT re-opened here.
 */
export function isOwnUnresolvedWrite(i: Pick<CorrectionInput,
  "flowType" | "flowAuthority" | "classificationReason" | "classificationConfidence" | "category" | "pfcPrimary">): boolean {
  const s = CORRECTION_SHAPES.TRANSFER_UNRESOLVED;
  return i.flowType === s.flowType
    && i.flowAuthority === "TRANSFER_AUTHORITY"
    && i.classificationReason === s.classificationReason
    && i.classificationConfidence === s.classificationConfidence
    && i.category === s.category
    && i.pfcPrimary === LOAN_PAYMENTS_FAMILY;
}

function hasProviderDebtProvenance(i: CorrectionInput): boolean {
  return i.pfcPrimary === LOAN_PAYMENTS_FAMILY || i.category === "Payment";
}

function write(kind: CorrectionKind, arm: "A" | "B", i: CorrectionInput): CorrectionDecision {
  return {
    action: "WRITE", kind, arm,
    evidenceLevel: i.assessment!.evidenceLevel,
    maturity: i.assessment!.maturity,
    write: CORRECTION_SHAPES[kind],
  };
}

/**
 * Decide one row. Pure and total: same input, same answer; never throws.
 *
 * ⚠️ Reads NO descriptor, merchant or institution. Every input is either a
 * provider category code, an account TYPE, ownership metadata, or the transfer
 * authority's own verdict.
 */
export function decideTransferDebtPaymentCorrection(i: CorrectionInput): CorrectionDecision {
  if (i.deleted) return skip("DELETED");
  if (!i.ownAccountType || !DEPOSITORY_ACCOUNT_TYPES.has(i.ownAccountType)) return skip("NOT_DEPOSITORY");
  if (i.rowCategorySource && USER_CATEGORY_SOURCES.has(i.rowCategorySource)) return skip("USER_CATEGORY");

  const armA = isArmA(i);
  const armB = !armA && isOwnUnresolvedWrite(i);
  if (!armA && !armB) return skip("NOT_ELIGIBLE_FLOW");
  if (armA && !hasProviderDebtProvenance(i)) return skip("NO_PROVIDER_PROVENANCE");
  if (i.supersededByPosted) return skip("PENDING_SUPERSEDED");

  // A persisted counterparty is stronger than any read-time match, and the
  // resolver does not re-assess such a row. A liability one settles it.
  if (i.persistedCounterpartyAccountType != null) {
    return i.persistedCounterpartyAccountType === "debt"
      ? keep("LIABILITY_COUNTERPARTY")
      : skip("PERSISTED_COUNTERPARTY");
  }

  const a = i.assessment;
  if (!a) return skip("NOT_ASSESSED");

  if (TYPE_CERTAIN_EVIDENCE_LEVELS.has(a.evidenceLevel)) {
    if (TRANSFER_LEAF_MATURITIES.has(a.maturity)) return write("TRANSFER_CERTAIN", armA ? "A" : "B", i);
    if (a.maturity === "DEBT_PAYMENT") {
      return armA ? keep("LIABILITY_COUNTERPARTY") : write("DEBT_PAYMENT_RESTORED", "B", i);
    }
    return skip("NO_TRANSFER_LEAF");
  }

  // Below this line nothing is certain, so (B) has nothing new to say.
  if (armB) return skip("NOT_YET_SETTLED");

  if (a.evidenceLevel === "TYPE_AMBIGUOUS") return write("TRANSFER_UNRESOLVED", "A", i);

  if (a.evidenceLevel === "NO_DESTINATION_EVIDENCE") {
    if (a.unresolvedReason === "CROSS_OWNER_BOUNDARY") return skip("CROSS_OWNER_BOUNDARY");
    if (i.pfcDetailed && LIABILITY_PAYMENT_DETAILS.has(i.pfcDetailed)) return keep("LIABILITY_EVIDENCE");
    return write("TRANSFER_UNRESOLVED", "A", i);
  }

  // CASH_NO_COUNTERPARTY, or a level this rule does not know.
  return skip("NO_TRANSFER_LEAF");
}

// ── Read-time resolved nature (for rows not yet corrected) ───────────────────

/** True when the transfer authority named an owned, non-liability destination. */
export function isTransferLeafMaturity(m: string | null | undefined): boolean {
  return m != null && TRANSFER_LEAF_MATURITIES.has(m);
}

/**
 * The row's flow NATURE as the transfer authority resolves it, for consumers that
 * read a row rather than the authority. A DEBT_PAYMENT whose destination the
 * authority matured to an owned non-liability account is a TRANSFER; everything
 * else is its persisted flowType. Once a row is corrected at write time the two
 * agree and this is the identity.
 */
export function resolvedFlowType<T extends string | null | undefined>(
  flowType: T,
  transferMaturity: string | null | undefined,
): T | "TRANSFER" {
  return flowType === "DEBT_PAYMENT" && isTransferLeafMaturity(transferMaturity) ? "TRANSFER" : flowType;
}

/**
 * The category that goes with `resolvedFlowType`: the provider's `Payment` label
 * on a row the authority resolved to a transfer reads `Transfer`. Any other
 * category — including every human choice — is returned unchanged.
 */
export function resolvedCategory<C extends string | null | undefined>(
  category: C,
  flowType: string | null | undefined,
  transferMaturity: string | null | undefined,
): C | "Transfer" {
  return category === "Payment" && resolvedFlowType(flowType, transferMaturity) === "TRANSFER" && flowType === "DEBT_PAYMENT"
    ? "Transfer"
    : category;
}
