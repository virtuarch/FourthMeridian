/**
 * lib/auth/session-proof.ts — P1: a validly signed NextAuth token is NOT
 * authentication. A session exists only when the authoritative session store
 * proves it.
 *
 * THE DEFECT THIS CLOSES. The session callback in lib/auth.ts ran its
 * revocation lookup only `if (sessionToken)`, took `id` and `role` straight
 * from the token, and looked the row up by sessionToken alone. So anyone able
 * to sign a token with NEXTAUTH_SECRET — and that secret is shared with Preview
 * — could present `{ id: <anyone>, role: "SYSTEM_ADMIN" }` with no sessionToken
 * and be served as that user, with that role, with no row, no revocation and
 * no TOTP. Or attach their OWN live sessionToken to someone else's id.
 *
 * THE INVARIANT. A request is authenticated only when ALL hold:
 *   1. the token carries a well-formed `id` and `sessionToken` (readSessionClaims);
 *   2. a UserSession row with that sessionToken exists and is not revoked;
 *   3. that row's userId EQUALS the token's id (ownership, not mere existence);
 *   4. the row's user exists, and its role is a known role;
 * and the role AND the TOTP-enrolment requirement the application acts on are
 * the user's CURRENT state from the store (factsFromRow), never the token's
 * claims. (P1b: `requireTotpSetup` in the token is client-updatable through
 * useSession().update and is a navigation hint for proxy.ts only.) Expiry is the JWT's own
 * `exp`, enforced by NextAuth's decode before any of this runs.
 *
 * FAILURE IS NOT TRUST. When the store cannot answer, the verdict is
 * INDETERMINATE (deny this request, keep the cookie — PROD-POOLER-AUTH-
 * INCIDENT-1) or, within lib/session-cache.ts's bounded stale window, a
 * previously VERIFIED set of facts — which is still judged against this
 * request's own token. There is no path on which "could not verify" becomes
 * "trust the JWT".
 *
 * Pure: no Prisma, no I/O. lib/auth.ts and lib/session.ts own the queries.
 */

import type { RevocationOutcome, SessionFacts } from "@/lib/session-cache";

/** The platform setting key authorize() reads (PlatformSettingKey.REQUIRE_TOTP_ALL_USERS). */
export const REQUIRE_TOTP_ALL_USERS_KEY = "require_totp_all_users";

/** The roles a session may carry. Pinned equal to Prisma's UserRole by test. */
export const KNOWN_ROLES: readonly string[] = ["USER", "SYSTEM_ADMIN"];

/**
 * Shape of a sessionToken: authorize() mints `crypto.randomUUID()`. Accept a
 * conservative opaque-id alphabet rather than exactly a UUID, so a legitimate
 * older format is never locked out — but nothing that is not a short opaque
 * string ever reaches the database.
 */
export const SESSION_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const USER_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

export interface SessionClaims {
  readonly userId:       string;
  readonly sessionToken: string;
}

/** The token's identity claims, or null when either is absent or malformed. */
export function readSessionClaims(token: { id?: unknown; sessionToken?: unknown } | null | undefined): SessionClaims | null {
  if (!token) return null;
  const { id, sessionToken } = token;
  if (typeof id !== "string" || !USER_ID_SHAPE.test(id)) return null;
  if (typeof sessionToken !== "string" || !SESSION_TOKEN_SHAPE.test(sessionToken)) return null;
  return { userId: id, sessionToken };
}

/** The select every session-proof lookup uses — one shape, both callers. */
export const SESSION_ROW_SELECT = {
  userId:    true,
  revokedAt: true,
  user:      { select: { id: true, role: true, totpEnabled: true } },
} as const;

export interface SessionRowLike {
  userId?:    unknown;
  revokedAt?: unknown;
  user?:      { id?: unknown; role?: unknown; totpEnabled?: unknown } | null;
}

/**
 * The facts a live session row proves, or null when it proves nothing:
 * absent, revoked, ownerless, inconsistent, or carrying an unknown role.
 * Never throws — a malformed row is a refusal, not an exception.
 */
export async function factsFromRow(
  row: SessionRowLike | null | undefined,
  readRequireTotpAllUsers: () => Promise<boolean>,
): Promise<SessionFacts | null> {
  if (!row || typeof row !== "object") return null;
  if (row.revokedAt !== null) return null; // undefined (field missing) is malformed, not "not revoked"
  if (typeof row.userId !== "string" || row.userId.length === 0) return null;
  const user = row.user;
  if (!user || typeof user !== "object") return null;
  if (user.id !== row.userId) return null;
  if (typeof user.role !== "string" || !KNOWN_ROLES.includes(user.role)) return null;
  if (typeof user.totpEnabled !== "boolean") return null;
  return {
    userId:           row.userId,
    role:             user.role,
    requireTotpSetup: await currentTotpRequirement(user.role, user.totpEnabled, readRequireTotpAllUsers),
  };
}

/**
 * P1b — the enrolment requirement from CURRENT state, by the same rule
 * authorize() applies at sign-in (lib/auth-totp-policy.ts): never once
 * enrolled; always for SYSTEM_ADMIN; otherwise the require_totp_all_users
 * setting. The setting is read only when it can matter (an un-enrolled USER),
 * as authorize() does. A failed read THROWS — the caller's degradation path
 * turns that into INDETERMINATE, never into "not required".
 */
async function currentTotpRequirement(
  role: string,
  totpEnabled: boolean,
  readRequireTotpAllUsers: () => Promise<boolean>,
): Promise<boolean> {
  if (totpEnabled) return false;
  if (role === "SYSTEM_ADMIN") return true;
  return (await readRequireTotpAllUsers()) === true;
}

export type SessionVerdict =
  | { readonly kind: "authenticated"; readonly userId: string; readonly role: string; readonly requireTotpSetup: boolean }
  | { readonly kind: "refused"; readonly reason: "not-live" | "owner-mismatch" | "malformed-facts" }
  | { readonly kind: "indeterminate" };

/**
 * Judge a revocation outcome against THIS request's claimed identity. The
 * ownership comparison happens here, per request — never inside the cache.
 */
export function judgeSession(claims: SessionClaims, outcome: RevocationOutcome): SessionVerdict {
  if (outcome.valid === null) return { kind: "indeterminate" };
  if (outcome.valid !== true || !outcome.facts) return { kind: "refused", reason: "not-live" };
  const { userId, role, requireTotpSetup } = outcome.facts;
  if (typeof userId !== "string" || typeof role !== "string" || !KNOWN_ROLES.includes(role) ||
      typeof requireTotpSetup !== "boolean") {
    return { kind: "refused", reason: "malformed-facts" };
  }
  if (userId !== claims.userId) return { kind: "refused", reason: "owner-mismatch" };
  return { kind: "authenticated", userId, role, requireTotpSetup };
}
