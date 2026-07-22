/**
 * lib/transactions/transfer-evidence-write.ts
 *
 * Persistence mapping + authority/replay rules for provider-neutral transfer
 * evidence (TE1). Turns a canonical TransferEvidence (lib/transactions/
 * transfer-evidence.ts) into the exact Transaction columns to write, and decides
 * whether a proposed write may replace what is already stored.
 *
 * Pure & Prisma-runtime-free (type-only Prisma imports, same convention as
 * plaid-flow-input.ts) so it is unit-testable under tsx. It writes ONLY the seven
 * additive transfer-evidence columns and never touches any other field.
 *
 * Authority doctrine (mirrors categorySource USER_* preservation): a lower-
 * authority source must never overwrite a higher-authority one. A provider adapter
 * ("plaid", future exchanges/brokerages/wallets) is a single provider tier; a
 * future manual/user correction outranks all providers. Same-tier re-writes are
 * allowed so a provider can refresh its own evidence and a mapping-version bump can
 * be replayed. Idempotent: identical evidence at the same version is a no-op.
 */

import type {
  TransferRail as PrismaTransferRail,
  TransferMovementForm as PrismaTransferMovementForm,
  TransferVenueClass as PrismaTransferVenueClass,
} from "@prisma/client";
import type {
  TransferEvidence,
  TransferRail,
  MovementForm,
  TransferVenue,
} from "@/lib/transactions/transfer-evidence";

// Compile-guarded maps: the key set forces every canonical value to be mapped and
// each value must be assignable to the Prisma enum — drift either way is a tsc error.
const RAIL_TO_PRISMA: Record<TransferRail, PrismaTransferRail> = { PAYMENT_APP: "PAYMENT_APP" };
const FORM_TO_PRISMA: Record<MovementForm, PrismaTransferMovementForm> = { CASH: "CASH" };
const VENUE_TO_PRISMA: Record<TransferVenue, PrismaTransferVenueClass> = {
  DEPOSITORY: "DEPOSITORY",
  BROKERAGE:  "BROKERAGE",
  EXCHANGE:   "EXCHANGE",
};

/** The exact subset of Transaction columns this slice writes. All nullable. */
export interface TransferEvidenceFields {
  transferRail:               PrismaTransferRail | null;
  transferMovementForm:       PrismaTransferMovementForm | null;
  transferVenueClass:         PrismaTransferVenueClass | null;
  transferEvidenceConfidence: number | null;
  transferEvidenceReason:     string | null;
  transferEvidenceSource:     string | null;
  transferEvidenceVersion:    string | null;
}

/** Fully-unset evidence — for non-transfer or non-adapter rows (no fabrication). */
export const NULL_TRANSFER_EVIDENCE_FIELDS: TransferEvidenceFields = {
  transferRail:               null,
  transferMovementForm:       null,
  transferVenueClass:         null,
  transferEvidenceConfidence: null,
  transferEvidenceReason:     null,
  transferEvidenceSource:     null,
  transferEvidenceVersion:    null,
};

/**
 * Map provider-neutral evidence to write columns. Axes persist only when attested
 * (never fabricated); provenance (confidence/reason/source/version) always persists
 * so an adapter run — including an honest no-signal/unrecognized run — is durable
 * and replay-detectable. Provider category strings are never mapped in.
 */
export function transferEvidenceWriteFields(ev: TransferEvidence): TransferEvidenceFields {
  return {
    transferRail:               ev.railType ? RAIL_TO_PRISMA[ev.railType] : null,
    transferMovementForm:       ev.movementForm ? FORM_TO_PRISMA[ev.movementForm] : null,
    transferVenueClass:         ev.venueClass ? VENUE_TO_PRISMA[ev.venueClass] : null,
    transferEvidenceConfidence: ev.evidenceConfidence,
    transferEvidenceReason:     ev.reason,
    transferEvidenceSource:     ev.source,
    transferEvidenceVersion:    ev.version,
  };
}

// ─── Authority + replay ───────────────────────────────────────────────────────

/** Source authority tiers. Manual/user corrections outrank any provider adapter. */
export function sourceAuthority(source: string | null | undefined): number {
  if (!source) return 0;
  if (source === "manual" || source === "user") return 100;
  return 10; // any provider adapter (plaid, future exchange/brokerage/wallet)
}

export type ReconcileReason =
  | "new"                          // nothing stored → write
  | "version_change"               // same source, mapping version differs → replay
  | "changed"                      // same authority, fields differ → refresh
  | "unchanged"                    // identical at same version → no-op (idempotent)
  | "preserved_higher_authority";  // stored outranks incoming → keep stored

export interface ReconcileResult {
  write:  boolean;
  reason: ReconcileReason;
}

function fieldsEqual(a: TransferEvidenceFields, b: TransferEvidenceFields): boolean {
  return (
    a.transferRail === b.transferRail &&
    a.transferMovementForm === b.transferMovementForm &&
    a.transferVenueClass === b.transferVenueClass &&
    a.transferEvidenceConfidence === b.transferEvidenceConfidence &&
    a.transferEvidenceReason === b.transferEvidenceReason &&
    a.transferEvidenceSource === b.transferEvidenceSource &&
    a.transferEvidenceVersion === b.transferEvidenceVersion
  );
}

/**
 * Decide whether `incoming` evidence may replace `stored`. Pure; used by the
 * backfill (and available to any write path that must preserve higher authority).
 * Never downgrades: a higher-authority stored value is always preserved.
 */
export function reconcileTransferEvidence(
  stored: TransferEvidenceFields,
  incoming: TransferEvidenceFields,
): ReconcileResult {
  const storedAuth = sourceAuthority(stored.transferEvidenceSource);
  const incomingAuth = sourceAuthority(incoming.transferEvidenceSource);

  if (storedAuth > incomingAuth) return { write: false, reason: "preserved_higher_authority" };
  if (stored.transferEvidenceSource == null) return { write: true, reason: "new" };
  if (stored.transferEvidenceVersion !== incoming.transferEvidenceVersion) {
    return { write: true, reason: "version_change" };
  }
  if (!fieldsEqual(stored, incoming)) return { write: true, reason: "changed" };
  return { write: false, reason: "unchanged" };
}
