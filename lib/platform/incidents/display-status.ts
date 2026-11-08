/**
 * lib/platform/incidents/display-status.ts  (Incident detail v1 — PURE, client-safe)
 *
 * The operator-facing STATUS of one incident, DERIVED at read time and NEVER
 * stored. The B9-rollback constraints (lifecycle.ts §"Operator transitions")
 * forbid any new non-NULL lifecycleState on an open row, so this is a pure
 * reading of facts the module already emits plus the connection's state.
 *
 * Precedence (first match wins):
 *   Resolved        the episode is closed (resolved or archived)
 *   Action needed   open, and the customer must act (NEEDS_REAUTH item, or an
 *                   update-mode-fixable / re-add code — explanations.ts remedyFor)
 *   Recovering      open, success proof recorded, confirmation pending
 *   Recurring       open, and an earlier episode of the same incident exists
 *                   (generation > 1 or previousIncidentId)
 *   Investigating   open and acknowledged by an operator. There is no separate
 *                   "investigating" field: the honest label is "Acknowledged".
 *   Active          any other open incident (incl. needs-verification: it is
 *                   shown as Active with `ongoing = false` — not broken now)
 */

import type { IncidentState } from "./intelligence/types";
import { customerActionRequiredFor } from "./explanations";

export type DisplayStatus = "action-needed" | "investigating" | "recovering" | "resolved" | "recurring" | "active";

export const DISPLAY_STATUS_WORD: Readonly<Record<DisplayStatus, string>> = {
  "action-needed": "Action needed",
  // Honest: the only fact is an operator acknowledgement.
  investigating: "Acknowledged · investigating",
  recovering: "Recovering",
  resolved: "Resolved",
  recurring: "Recurring",
  active: "Active",
};

export interface DisplayStatusInput {
  state: IncidentState;
  generation: number;
  previousIncidentId: string | null;
  /** PlaidItem.status of the subject connection (null when not item-scoped / unreadable). */
  itemStatus: string | null;
  /** The allowlisted provider error code (explanations.ts), or null. */
  providerErrorCode: string | null;
}

const CLOSED: ReadonlySet<IncidentState> = new Set(["resolved", "archived"]);

export function isOpenState(state: IncidentState): boolean {
  return !CLOSED.has(state);
}

export function deriveDisplayStatus(i: DisplayStatusInput): DisplayStatus {
  if (CLOSED.has(i.state)) return "resolved";
  if (customerActionRequiredFor(i.providerErrorCode, i.itemStatus)) return "action-needed";
  if (i.state === "recovering") return "recovering";
  if (i.generation > 1 || i.previousIncidentId !== null) return "recurring";
  if (i.state === "acknowledged") return "investigating";
  return "active";
}
