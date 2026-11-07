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
 *   5. the row's user is not DEACTIVATED and not SCHEDULED FOR DELETION
 *      (`deactivatedAt` / `deletionScheduledAt` null — see "ACCOUNT LOCKOUT");
 * and the role AND the TOTP-enrolment requirement the application acts on are
 * the user's CURRENT state from the store (factsFromRow), never the token's
 * claims. (P1b: `requireTotpSetup` in the token is client-updatable through
 * useSession().update and is a navigation hint for proxy.ts only.) Expiry is the JWT's own
 * `exp`, enforced by NextAuth's decode before any of this runs — AND, since
 * SEC-010, the session ROW's own lifetime (below).
 *
 * SESSION LIFETIME (SEC-010). The JWT is a 30-day ROLLING cookie: each use
 * re-issues it, so a stolen cookie used at least once a month lived forever.
 * factsFromRow now refuses a row that is
 *   · IDLE      — `lastActiveAt` older than SESSION_IDLE_TIMEOUT_MS (30 days), or
 *   · TOO OLD   — `createdAt` older than SESSION_ABSOLUTE_LIFETIME_MS (90 days),
 * whatever the token says. Both columns already exist (no schema change);
 * `lastActiveAt` is maintained by lib/auth/session-activity.ts at minute
 * granularity. A row missing either timestamp is malformed and refused. The
 * clock and both limits are injectable (`SessionLifetimePolicy`) so the rule is
 * provable with fixed clocks.
 *
 * ACCOUNT LOCKOUT. Deactivation (user, CS operator) and a deletion request set
 * `deactivatedAt` (deletion also `deletionScheduledAt`) and THEN revoke every
 * session as a separate, non-transactional step. A revoke that failed or was
 * partial left those sessions live indefinitely — the row was never revoked,
 * and the store proved them. The account state is now part of the proof:
 * factsFromRow refuses a row whose user carries either timestamp, exactly as
 * it refuses a revoked row (verdict "not-live"). It applies within the
 * revocation cache's existing TTL (lib/session-cache.ts) — the same window a
 * revoked row has, never a longer one. Reactivation / cancel-deletion clear the
 * timestamps in authorize() BEFORE the new session row is minted, so a fresh
 * login is proved live.
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
  userId:       true,
  revokedAt:    true,
  createdAt:    true,
  lastActiveAt: true,
  user:      { select: { id: true, role: true, totpEnabled: true, deactivatedAt: true, deletionScheduledAt: true } },
} as const;

/** SEC-010 — idle cut-off: no recorded activity for this long ⇒ the session is over. */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
/** SEC-010 — absolute cut-off: a session older than this is over, however active. */
export const SESSION_ABSOLUTE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export interface SessionLifetimePolicy {
  /** The current instant; defaults to Date.now(). */
  now?:           () => number;
  idleTimeoutMs?: number;
  absoluteMs?:    number;
}

export type SessionLifetimeVerdict = "LIVE" | "IDLE_EXPIRED" | "ABSOLUTE_EXPIRED" | "MALFORMED";

function toMillis(v: unknown): number | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === "string" || typeof v === "number") {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** SEC-010 — the pure lifetime rule. Absolute is judged before idle. */
export function judgeSessionLifetime(
  row: { createdAt?: unknown; lastActiveAt?: unknown },
  policy: SessionLifetimePolicy = {},
): SessionLifetimeVerdict {
  const created    = toMillis(row.createdAt);
  const lastActive = toMillis(row.lastActiveAt);
  if (created === null || lastActive === null) return "MALFORMED";
  const now = (policy.now ?? Date.now)();
  if (now - created    > (policy.absoluteMs    ?? SESSION_ABSOLUTE_LIFETIME_MS)) return "ABSOLUTE_EXPIRED";
  if (now - lastActive > (policy.idleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS))      return "IDLE_EXPIRED";
  return "LIVE";
}

/**
 * LIVE SESSION — the ONE reporting definition of a "live" / "active" session,
 * built from the SAME constants and the SAME comparisons `judgeSessionLifetime`
 * and `factsFromRow` apply, so an operator count can never call a session live
 * that the auth path would refuse (S3 finding, 2026-11-03: five-plus surfaces
 * counted `revokedAt: null` alone, so idle / over-age rows read as live).
 *
 * A session is LIVE when ALL hold:
 *   · not revoked                                   (`revokedAt` null);
 *   · within the absolute lifetime                  (`now − createdAt    ≤ SESSION_ABSOLUTE_LIFETIME_MS`);
 *   · within the idle timeout                       (`now − lastActiveAt ≤ SESSION_IDLE_TIMEOUT_MS`);
 *   · the account is not locked out (ACCOUNT LOCKOUT, #291 — `deactivatedAt` and
 *     `deletionScheduledAt` both null).
 * The cut-offs are INCLUSIVE (`gte`) because judgeSessionLifetime expires only
 * on a strict `>`: a row exactly at the limit is live on both paths.
 *
 * Census pin: lib/auth/live-session.test.ts — no userSession read outside this
 * module may filter on a bare `revokedAt: null`.
 */
export function liveSessionCutoffs(now: Date, policy: Omit<SessionLifetimePolicy, "now"> = {}): { createdAfter: Date; activeAfter: Date } {
  const t = now.getTime();
  return {
    createdAfter: new Date(t - (policy.absoluteMs    ?? SESSION_ABSOLUTE_LIFETIME_MS)),
    activeAfter:  new Date(t - (policy.idleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS)),
  };
}

/**
 * The Prisma `where` (UserSessionWhereInput) for LIVE sessions, for counts,
 * groupBys, aggregates and lists. `userWhere` narrows the owning user further
 * (e.g. `{ role: "USER" }`) — it is merged with, never replaces, the lockout.
 * Typed structurally so this module stays free of a Prisma import.
 */
export function liveSessionWhere<U extends object = Record<never, never>>(
  now: Date,
  extra: { userId?: string | { in: string[] }; userWhere?: U } = {},
  policy: Omit<SessionLifetimePolicy, "now"> = {},
) {
  const { createdAfter, activeAfter } = liveSessionCutoffs(now, policy);
  return {
    ...(extra.userId !== undefined ? { userId: extra.userId } : {}),
    revokedAt:    null,
    createdAt:    { gte: createdAfter },
    lastActiveAt: { gte: activeAfter },
    // AUTH lockout (#291), deliberately both stamps — a session rule, NOT the Open-account population rule (lib/platform/customer/population.ts).
    user:         { is: { ...(extra.userWhere ?? ({} as U)), deactivatedAt: null, deletionScheduledAt: null } },
  };
}

/**
 * The pure predicate over an in-memory row — same rule as liveSessionWhere.
 * STRICT like factsFromRow: the owning user's lockout stamps must be present.
 */
export function isSessionLive(
  row: { revokedAt?: unknown; createdAt?: unknown; lastActiveAt?: unknown;
         user?: { deactivatedAt?: unknown; deletionScheduledAt?: unknown } | null },
  now: Date,
  policy: Omit<SessionLifetimePolicy, "now"> = {},
): boolean {
  if (!row || row.revokedAt !== null) return false;
  if (judgeSessionLifetime(row, { ...policy, now: () => now.getTime() }) !== "LIVE") return false;
  const user = row.user;
  if (!user || typeof user !== "object") return false;
  return user.deactivatedAt === null && user.deletionScheduledAt === null;
}

/**
 * For a SESSION LIST (a user's own devices, or an admin's view of one user's):
 * the row's own state, without the account lockout (that is a user-level fact
 * the list's owner shows elsewhere). An unrevoked row past its lifetime is
 * EXPIRED_NOT_REVOKED — it can no longer authenticate, and it is shown apart
 * from live sessions rather than hidden or miscounted.
 */
export type SessionDisplayState = "LIVE" | "EXPIRED_NOT_REVOKED" | "REVOKED";
export function sessionDisplayState(
  row: { revokedAt?: unknown; createdAt?: unknown; lastActiveAt?: unknown },
  now: Date,
): SessionDisplayState {
  if (row.revokedAt !== null && row.revokedAt !== undefined) return "REVOKED";
  return judgeSessionLifetime(row, { now: () => now.getTime() }) === "LIVE" ? "LIVE" : "EXPIRED_NOT_REVOKED";
}

export interface SessionRowLike {
  userId?:       unknown;
  revokedAt?:    unknown;
  createdAt?:    unknown;
  lastActiveAt?: unknown;
  user?:      { id?: unknown; role?: unknown; totpEnabled?: unknown; deactivatedAt?: unknown; deletionScheduledAt?: unknown } | null;
}

/**
 * The facts a live session row proves, or null when it proves nothing:
 * absent, revoked, ownerless, inconsistent, carrying an unknown role, past
 * its idle / absolute lifetime (SEC-010), or owned by a deactivated /
 * deletion-scheduled account (ACCOUNT LOCKOUT).
 * Never throws — a malformed row is a refusal, not an exception.
 */
export async function factsFromRow(
  row: SessionRowLike | null | undefined,
  readRequireTotpAllUsers: () => Promise<boolean>,
  lifetime: SessionLifetimePolicy = {},
): Promise<SessionFacts | null> {
  if (!row || typeof row !== "object") return null;
  if (row.revokedAt !== null) return null; // undefined (field missing) is malformed, not "not revoked"
  if (judgeSessionLifetime(row, lifetime) !== "LIVE") return null; // SEC-010
  if (typeof row.userId !== "string" || row.userId.length === 0) return null;
  const user = row.user;
  if (!user || typeof user !== "object") return null;
  if (user.id !== row.userId) return null;
  if (typeof user.role !== "string" || !KNOWN_ROLES.includes(user.role)) return null;
  if (typeof user.totpEnabled !== "boolean") return null;
  // ACCOUNT LOCKOUT — a deactivated or deletion-scheduled account proves no
  // session, revoked or not. STRICT, like every other fact here: both keys must
  // be PRESENT (SESSION_ROW_SELECT selects them) and each must be null or a Date.
  // A row without them is malformed and refused — the lockout is never the one
  // fact that fails open.
  if (!("deactivatedAt" in user) || !("deletionScheduledAt" in user)) return null;
  const isLockStamp = (v: unknown) => v === null || v instanceof Date;
  if (!isLockStamp(user.deactivatedAt) || !isLockStamp(user.deletionScheduledAt)) return null;
  if (user.deactivatedAt !== null || user.deletionScheduledAt !== null) return null;
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
