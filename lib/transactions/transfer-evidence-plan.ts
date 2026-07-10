/**
 * lib/transactions/transfer-evidence-plan.ts
 *
 * The provider-aware WRITE-BOUNDARY planner for transfer evidence — decides, for a
 * stored transaction row, which adapter (if any) applies and whether the proposed
 * neutral fields may replace what is stored. Pure and Prisma-runtime-free (imports
 * only the Plaid adapter + the neutral write mapper), so it is unit-testable and
 * reusable by the sync path and the backfill without touching liquidity/Cash Flow.
 *
 * Gating doctrine:
 *  - Only Plaid-sourced rows (a plaidTransactionId) get the Plaid adapter. A
 *    non-Plaid row (CSV/manual) gets NO adapter and stays unclassified — never a
 *    Plaid-derived default.
 *  - Evidence is persisted ONLY when a descriptive axis (rail/form/venue) was
 *    recognized. A no-signal or unrecognized Plaid signal leaves the row
 *    unclassified (axes unset) and is reported, not written.
 */

import { plaidTransferEvidence } from "@/lib/transactions/plaid-transfer-evidence";
import {
  transferEvidenceWriteFields,
  reconcileTransferEvidence,
  NULL_TRANSFER_EVIDENCE_FIELDS,
  type TransferEvidenceFields,
  type ReconcileResult,
} from "@/lib/transactions/transfer-evidence-write";

/** How a row's provider evidence resolved. */
export type TransferEvidenceSignal =
  | "recognized"    // a Plaid detailed family mapped to a descriptive axis
  | "unrecognized"  // Plaid gave a detailed code we do not map
  | "no_signal"     // Plaid-sourced but no detailed code
  | "non_provider"; // not a Plaid row — no adapter applies

/** The stored-row inputs the planner reads (existing columns + current evidence). */
export interface StoredTransferRow {
  plaidTransactionId: string | null;
  pfcDetailed:        string | null;
  amount:             number;
  /** Raw merchant/descriptor — CF-P1: lets the adapter recognize a known
   *  payment-app rail Plaid filed as a generic account transfer. Optional. */
  name?:              string | null;
  /** The row's currently-stored transfer-evidence fields (all null if none). */
  stored:             TransferEvidenceFields;
}

export interface TransferEvidencePlan {
  signal:    TransferEvidenceSignal;
  /** The fields that WOULD be written (all null unless recognized). */
  proposed:  TransferEvidenceFields;
  reconcile: ReconcileResult;
}

const NO_WRITE: ReconcileResult = { write: false, reason: "unchanged" };

/**
 * Plan the transfer evidence for one stored row. Pure; deterministic. Applies the
 * Plaid adapter only to Plaid-sourced rows, persists only recognized axes, and
 * reconciles a recognized proposal against the stored value (preserving higher
 * authority, detecting version changes, and staying idempotent).
 */
export function planTransferEvidence(row: StoredTransferRow): TransferEvidencePlan {
  if (row.plaidTransactionId == null) {
    return { signal: "non_provider", proposed: NULL_TRANSFER_EVIDENCE_FIELDS, reconcile: NO_WRITE };
  }

  const ev = plaidTransferEvidence({ pfcDetailed: row.pfcDetailed, amount: row.amount, name: row.name ?? null });
  const recognized = Boolean(ev.railType || ev.movementForm || ev.venueClass);
  if (!recognized) {
    const signal: TransferEvidenceSignal = ev.reason === "plaid:no_signal" ? "no_signal" : "unrecognized";
    return { signal, proposed: NULL_TRANSFER_EVIDENCE_FIELDS, reconcile: NO_WRITE };
  }

  const proposed = transferEvidenceWriteFields(ev);
  return { signal: "recognized", proposed, reconcile: reconcileTransferEvidence(row.stored, proposed) };
}
