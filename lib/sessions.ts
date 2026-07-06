/**
 * lib/sessions.ts  (OPS-2 S2)
 *
 * Shared server-side session-revocation helpers. Extracted so the same
 * revoke-all-except-current logic backs both "sign out everywhere"
 * (DELETE /api/user/sessions) and password-change hardening
 * (PATCH /api/user/password) — one implementation, no drift.
 *
 * Callers own their own AuditLog entry; this helper only mutates the
 * UserSession rows and clears the revocation cache.
 */

import "server-only";
import { db } from "@/lib/db";
import { clearAllSessions } from "@/lib/session-cache";

/**
 * Revoke all of a user's ACTIVE sessions except an optional one to keep.
 *
 * @param userId       The user whose sessions to revoke.
 * @param exceptToken  Session token to preserve (typically the caller's own
 *                     current session). Omit/null to revoke ALL sessions.
 * @returns            The number of sessions revoked.
 *
 * We don't have the individual revoked tokens in hand, so the whole
 * revocation cache is cleared rather than leaving stale "valid" entries for
 * the revoked sessions on this instance (same approach the inline
 * sign-out-everywhere path has always used).
 */
export async function revokeOtherUserSessions(
  userId: string,
  exceptToken?: string | null,
): Promise<number> {
  const { count } = await db.userSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptToken ? { sessionToken: { not: exceptToken } } : {}),
    },
    data: { revokedAt: new Date() },
  });

  clearAllSessions();

  return count;
}

/**
 * Revoke ALL of a user's active sessions (no exceptions).
 *
 * Thin, self-documenting wrapper over revokeOtherUserSessions with no token to
 * preserve — used by logged-out flows like password reset (OPS-2 S2b), where
 * there is no "current" session and a reset implies possible compromise, so
 * every existing session should die and the user re-authenticates.
 *
 * @param userId  The user whose sessions to revoke.
 * @returns       The number of sessions revoked.
 */
export async function revokeAllUserSessions(userId: string): Promise<number> {
  return revokeOtherUserSessions(userId);
}
