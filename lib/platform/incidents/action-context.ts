/**
 * lib/platform/incidents/action-context.ts  (Incident detail v1 — PURE)
 *
 * An operator recovery action (resync / request-reauth) taken FROM an incident
 * drawer carries the incident id as `?incidentId=`, so the audit row says which
 * incident it was taken for. The id is an opaque incident reference (never a
 * customer id); anything not id-shaped is dropped, never recorded.
 * It is context only: it grants nothing and changes no authorization.
 */

const INCIDENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The validated incident id from a request URL's `incidentId` param, or null. */
export function incidentIdFromSearch(search: URLSearchParams): string | null {
  const v = search.get("incidentId");
  return v && INCIDENT_ID.test(v) ? v : null;
}

/** Spread into an operator-action audit `detail`: `{ incidentId }` when present, else nothing. */
export function incidentAuditDetail(incidentId: string | null): { incidentId?: string } {
  return incidentId ? { incidentId } : {};
}

/**
 * The honest outcome of a request-reauth call (the route's response body):
 *   created               a new reconnect notice was sent to the customer
 *   suppressed_duplicate  an open reconnect notice already exists — nothing new was sent
 *   marked_not_notified   the connection was marked as needing reauthorization, but no notice was sent
 *   no_change             nothing changed: already marked, and no notice was sent
 */
export type ReauthRequestOutcome = "created" | "suppressed_duplicate" | "marked_not_notified" | "no_change";

export function reauthRequestOutcome(statusChanged: boolean, notice: string): ReauthRequestOutcome {
  if (notice === "created") return "created";
  if (notice === "suppressed") return "suppressed_duplicate";
  return statusChanged ? "marked_not_notified" : "no_change";
}
