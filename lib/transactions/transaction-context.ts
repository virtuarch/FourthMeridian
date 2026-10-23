/**
 * lib/transactions/transaction-context.ts
 *
 * CF-1 — per-row canonical projection facts for the Cash Flow Perspective context
 * section. Pure, deterministic, provider-neutral, Prisma-free. Derives (at read
 * time, from already-persisted canonical fields) the two facts the context needs:
 *   - transferDisposition — the canonical TransferDisposition (deriveTransferDisposition),
 *     only for TRANSFER rows; null otherwise.
 *   - needsClassification — the TE-2B semantic predicate.
 *
 * It changes NO calculation: it only exposes existing canonical knowledge. Provider
 * strings never enter here (inputs are Fourth Meridian's own enums/booleans).
 */

import {
  deriveTransferDisposition,
  dispositionForMaturity,
  type TransferDisposition,
  type TransferEvidence,
} from "@/lib/transactions/transfer-evidence";
import { shouldSurfaceAsNeedsClassification } from "@/lib/transactions/needs-classification";

/** Minimal canonical fields the projection reads off a stored row. */
export interface TransactionContextInput {
  flowType:                   string | null;
  classificationReason:       string | null;
  transferRail:               string | null;
  transferMovementForm:       string | null;
  transferVenueClass:         string | null;
  transferEvidenceConfidence: number | null;
  transferEvidenceReason:     string | null;
  transferEvidenceSource:     string | null;
  transferEvidenceVersion:    string | null;
  /** A Merchant identity was resolved (Transaction.merchantId set). */
  hasResolvedMerchant:        boolean;
  /** The movement resolved to an owned counterparty account (persisted or read-time). */
  isOwnedCounterparty:        boolean;
  /**
   * Phase 6 — the canonical maturity from the transfer authority, when the
   * caller ran it.
   *
   * ⚠️ When present it DECIDES, and the per-row evidence path below is not
   * consulted. That is the whole convergence: the ladder measured the corpus,
   * this module can only look at one row, and two authorities answering the same
   * question is how "unresolved" and "external bank transfer" came to describe
   * the same movement simultaneously.
   *
   * Null when the caller had no corpus (golden fixtures, exports built from a
   * bare row). The fallback is then honest rather than absent.
   */
  transferMaturity?:          string | null;
}

export interface TransactionContext {
  transferDisposition: TransferDisposition | null;
  needsClassification: boolean;
}

/**
 * Derive the context facts for one row. TransferDisposition is computed only for
 * TRANSFER rows (transfer-evidence axes are only meaningful there); non-transfer
 * rows get null. Ownership is a canonical relationship fact, supplied by the
 * caller — never inferred here.
 */
export function deriveTransactionContext(t: TransactionContextInput): TransactionContext {
  let transferDisposition: TransferDisposition | null = null;
  if (t.transferMaturity) {
    // The ladder has spoken. Project, never re-derive.
    transferDisposition = dispositionForMaturity(t.transferMaturity);
  } else if (t.flowType === "TRANSFER") {
    const evidence: TransferEvidence = {
      railType:           (t.transferRail ?? undefined) as TransferEvidence["railType"],
      movementForm:       (t.transferMovementForm ?? undefined) as TransferEvidence["movementForm"],
      venueClass:         (t.transferVenueClass ?? undefined) as TransferEvidence["venueClass"],
      evidenceConfidence: t.transferEvidenceConfidence ?? 0,
      reason:             t.transferEvidenceReason ?? "",
      source:             t.transferEvidenceSource ?? "",
      version:            t.transferEvidenceVersion ?? "",
    };
    transferDisposition = deriveTransferDisposition(evidence, { counterpartyIsOwned: t.isOwnedCounterparty });
  }

  const needs = shouldSurfaceAsNeedsClassification({
    flowType:                t.flowType,
    classificationReason:    t.classificationReason,
    transferRail:            t.transferRail,
    hasResolvedMerchant:     t.hasResolvedMerchant,
    hasResolvedCounterparty: t.isOwnedCounterparty,
  });

  return { transferDisposition, needsClassification: needs.needsClassification };
}
