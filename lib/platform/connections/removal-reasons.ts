/**
 * lib/platform/connections/removal-reasons.ts  (PB-5)
 *
 * The operator "Remove connection" reason: a FIXED enum (owner-approved) plus an
 * optional, length-capped note. Pure and client-safe — the confirm dialog
 * renders the same list the route parses, so the two cannot drift.
 */

import { OPERATOR_NOTE_MAX, assertOperatorNoteSafe, OperatorActionValidationError, type OperatorReasonCode } from "@/lib/audit";

export const REMOVAL_REASONS = ["customer_request", "abuse", "cost", "account_closure", "other"] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

export const REMOVAL_REASON_LABEL: Record<RemovalReason, string> = {
  customer_request: "Customer request",
  abuse:            "Abuse",
  cost:             "Cost",
  account_closure:  "Account closure",
  other:            "Other",
};

/**
 * The operator-action envelope's own reason vocabulary (lib/audit.ts) is shared
 * by every operator surface and is not widened for one action; the PB-5 reason
 * maps onto it, and rides verbatim in `detail.removalReason`, which is what
 * the Removed connections list shows.
 */
export const REMOVAL_REASON_ENVELOPE_CODE: Record<RemovalReason, OperatorReasonCode> = {
  customer_request: "SUPPORT_REQUEST",
  abuse:            "ABUSE",
  cost:             "OTHER",
  account_closure:  "SUPPORT_REQUEST",
  other:            "OTHER",
};

/** The note cap — the envelope's own (assertOperatorNoteSafe enforces it, plus no email / digits / secrets). */
export const REMOVAL_NOTE_MAX = OPERATOR_NOTE_MAX;

export interface RemovalRequest { reason: RemovalReason; note: string | null }

/** Parse the untrusted body. Returns the request or the reason it is malformed (400). */
export function parseRemovalRequest(raw: unknown): { request: RemovalRequest } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "A reason is required." };
  const { reason, note } = raw as { reason?: unknown; note?: unknown };
  if (typeof reason !== "string" || !(REMOVAL_REASONS as readonly string[]).includes(reason)) {
    return { error: `reason must be one of ${REMOVAL_REASONS.join(", ")}.` };
  }
  if (note !== undefined && note !== null && typeof note !== "string") return { error: "note must be a string." };
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (trimmed === "") return { request: { reason: reason as RemovalReason, note: null } };
  try {
    return { request: { reason: reason as RemovalReason, note: assertOperatorNoteSafe(trimmed) } };
  } catch (e) {
    return { error: e instanceof OperatorActionValidationError ? e.message : "note is invalid." };
  }
}

