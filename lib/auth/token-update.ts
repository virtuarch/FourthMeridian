/**
 * lib/auth/token-update.ts — SEC-001: what a client-initiated session update
 * may change on the JWT, and what it may only ASK to be re-derived.
 *
 * THE DEFECT THIS CLOSES. NextAuth's `useSession().update(data)` POSTs `data`
 * to /api/auth/session and the jwt callback runs with `trigger: "update"` and
 * `session: data`. lib/auth.ts used to copy `session.requireTotpSetup` onto the
 * token verbatim. proxy.ts reads that token field to decide whether a page
 * navigation is confined to the enrolment surface, and the server-rendered
 * layouts under /admin and /dashboard never re-checked the DB-derived flag — so
 * `POST /api/auth/session {data:{requireTotpSetup:false}}` with a valid CSRF
 * token turned a TOTP-pending (password-only) SYSTEM_ADMIN session into one that
 * could render the admin inventory (runtime-confirmed, 02-SECURITY-VERIFICATION).
 *
 * THE RULE. A client update payload is UNTRUSTED INPUT. Exactly one field is
 * accepted from it — `username`, which is presentation only and grants nothing
 * — and only when it is a string or null. Every other key, and in particular
 * every security-relevant claim (`requireTotpSetup`, `role`, `id`,
 * `sessionToken`, …), is ignored. An update is otherwise a REQUEST to re-derive
 * the navigation hint from the session store (lib/auth.ts does that I/O with
 * the same factsFromRow the session callback uses); the payload's own value is
 * never consulted for it.
 *
 * Pure: no imports, no I/O.
 */

/** The only token field a client update may set. */
export const CLIENT_UPDATABLE_TOKEN_FIELDS = ["username"] as const;

export interface ClientTokenPatch {
  /** Present only when the payload carried a well-formed username. */
  username?: string | null;
}

/**
 * The patch a client update payload is allowed to apply. Anything not listed
 * in CLIENT_UPDATABLE_TOKEN_FIELDS, and any listed field with an unexpected
 * shape, is dropped — never copied, never coerced.
 */
export function clientTokenPatch(payload: unknown): ClientTokenPatch {
  if (!payload || typeof payload !== "object") return {};
  const p = payload as Record<string, unknown>;
  const patch: ClientTokenPatch = {};
  if ("username" in p) {
    const u = p.username;
    if (u === null || typeof u === "string") patch.username = u;
  }
  return patch;
}
