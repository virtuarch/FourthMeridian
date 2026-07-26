/**
 * lib/auth/session-outcome.ts  (PROD-POOLER-AUTH-INCIDENT-1)
 *
 * The one shared name for "the session-revocation check could not be answered".
 *
 * WHY A FLAG ON THE SESSION, AND NOT A THROW
 * ------------------------------------------
 * The NextAuth `session()` callback has exactly one way to report failure that
 * does NOT destroy the user's credential: return a value. A throw is caught by
 * NextAuth itself (node_modules/next-auth/core/routes/session.js) which responds
 * with `sessionStore.clean()` — `Set-Cookie: …=; Max-Age=0`, i.e. it DELETES the
 * session cookie. That is how a 10-second Postgres pool timeout became a real
 * logout in production on 2026-07-25 and 2026-07-26.
 *
 * So the callback returns a session that carries this flag instead. Returning a
 * body also makes NextAuth re-issue the session cookie on its normal path, which
 * means the credential is actively PRESERVED rather than merely not-deleted.
 *
 * WHY THIS IS NOT "user: undefined" ALONE
 * --------------------------------------
 * `user: undefined` already means something: unauthenticated → 401. An
 * indeterminate revocation check is a different fact with a different correct
 * response (503 + Retry-After, "try again", session intact). Collapsing the two
 * is exactly the masking defect PS-4A removed from the LOGIN path, where a pool
 * timeout used to surface as "invalid password". This keeps the resume path
 * honest in the same way.
 *
 * CLIENT-SAFE. A plain string constant with no imports, so both the server
 * guards (lib/session.ts) and any future client-side handling can share one
 * spelling. Mirrors lib/auth/login-outcome.ts.
 */

/**
 * Property set on the returned session when revocation could not be determined.
 *
 * Consumers must treat its presence as "unknown", never as "valid" or "revoked".
 */
export const SESSION_INDETERMINATE_FLAG = "revocationIndeterminate" as const;

/** Shape of the degraded session object the `session()` callback returns. */
export type IndeterminateSession = {
  [SESSION_INDETERMINATE_FLAG]: true;
};

/** True when a resolved session reported an indeterminate revocation check. */
export function isRevocationIndeterminate(session: unknown): boolean {
  return (
    !!session &&
    typeof session === "object" &&
    (session as Record<string, unknown>)[SESSION_INDETERMINATE_FLAG] === true
  );
}
