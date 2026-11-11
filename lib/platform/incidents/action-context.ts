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

/**
 * S2 R2 — the incident id is recorded ONLY when it is VERIFIED server-side: the
 * incident exists and its subject is THIS route's connection (`belongs`, one
 * indexed read — intelligence/index.ts incidentBelongsToItem). Anything else —
 * absent, malformed, unknown, another connection's incident, a failed read —
 * is dropped silently: the action is still audited, without an incidentId.
 */
export async function verifiedIncidentId(
  candidate: string | null,
  plaidItemId: string,
  belongs: (incidentId: string, plaidItemId: string) => Promise<boolean>,
): Promise<string | null> {
  if (!candidate) return null;
  try {
    return (await belongs(candidate, plaidItemId)) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Incident drawer PR-B (S2 09gg b) — a "Run job" posted from an incident drawer
 * to the Manual operations route carries `?incidentId=`. It is recorded ONLY
 * when VERIFIED server-side: the incident exists AND its OWN evidence (the
 * newest occurrence's job, through job-commands.ts) maps to THIS command
 * (`commandOf`, intelligence/index.ts incidentJobCommandId). Anything else —
 * absent, malformed, unknown, an incident whose job maps elsewhere or nowhere,
 * a failed read — is dropped silently: the run is still audited, without an
 * incidentId. It grants nothing: every route guard runs regardless.
 */
export async function verifiedJobIncidentId(
  candidate: string | null,
  commandId: string,
  commandOf: (incidentId: string) => Promise<string | null>,
): Promise<string | null> {
  if (!candidate) return null;
  try {
    return (await commandOf(candidate)) === commandId ? candidate : null;
  } catch {
    return null;
  }
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
