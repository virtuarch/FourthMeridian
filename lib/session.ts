/**
 * lib/session.ts
 *
 * Lightweight server-only helpers for authenticating and authorising API route
 * handlers and Server Components.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every route that called `getServerSession(authOptions)` directly pulled in
 * the entire lib/auth.ts module graph — bcrypt, totp, recovery-code logic,
 * plaid encryption helpers — none of which are needed just to identify who
 * made a request.  Centralising session access here means:
 *
 *   1. Route files import ONE symbol from ONE file instead of two.
 *   2. If the session strategy changes, only this file needs updating.
 *   3. Turbopack's per-file module graph is narrower for every route.
 *
 * BEHAVIOUR PRESERVED
 * -------------------
 * All helpers call `getServerSession(authOptions)` internally, which runs the
 * full NextAuth `session()` callback — including the per-request DB revocation
 * check in lib/auth.ts.  There is no behaviour change vs. calling
 * `getServerSession(authOptions)` directly in each route.
 *
 * USAGE
 * -----
 * The helpers follow a Go-style tuple return so routes stay flat (no try/catch):
 *
 *   const [user, err] = await requireUser();
 *   if (err) return err;
 *   // user.id is guaranteed here
 *
 *   const [user, err] = await requireSystemAdmin();
 *   if (err) return err;
 *
 *   const [auth, err] = await requireSpaceRole(spaceId, "MEMBER");
 *   if (err) return err;
 *   const { user, membership } = auth;
 *
 * DO NOT IMPORT from lib/auth.ts in route handlers for session checks — import
 * from here instead.  lib/auth.ts should only be imported by:
 *   - app/api/auth/[...nextauth]/route.ts  (the NextAuth handler)
 *   - lib/space.ts                     (getSpaceContext needs full options)
 *   - lib/session.ts                       (this file — one central point)
 */

import "server-only";

import { getServerSession }      from "next-auth";
import { NextResponse }          from "next/server";
import { authOptions }           from "@/lib/auth";
import { db }                    from "@/lib/db";
import { setCachedRevocation }   from "@/lib/session-cache";
import { isRevocationIndeterminate } from "@/lib/auth/session-outcome";
import { captureSessionRevocationFailure } from "@/lib/monitoring/capture";
import { decideAdminApiAccess }  from "@/lib/admin-totp-enrollment";
import { env }                    from "@/lib/env";
import { UserRole,
         SpaceMemberRole }       from "@prisma/client";

// ── Exported types ────────────────────────────────────────────────────────────

/** Minimal user shape returned by all session helpers. */
export type SessionUser = {
  id:           string;
  role:         UserRole;
  username:     string | null;
  sessionToken: string | null;
  /**
   * True when the platform requires TOTP for this user's role but they have
   * not enrolled yet (SEC-FIX-1). Used by the guards below to deny API access
   * to a pending session — see totpSetupPending().
   */
  requireTotpSetup: boolean;
};

/**
 * SEC-FIX-1 — options accepted by the session guards to opt a route out of
 * the forced-TOTP-enrolment gate. Only the TOTP-enrolment endpoints
 * (/api/user/totp/{setup,verify,status}) set allowTotpSetupPending so a
 * pending user can still complete setup.
 */
export type SessionGuardOptions = {
  allowTotpSetupPending?: boolean;
};

/** Space membership row included with requireSpaceRole results. */
export type SpaceMembership = {
  spaceId: string;
  userId:      string;
  role:        SpaceMemberRole;
  status:      string;
};

// ── Standard error responses ──────────────────────────────────────────────────

export const unauthorized = (): NextResponse =>
  NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export const forbidden = (): NextResponse =>
  NextResponse.json({ error: "Forbidden" }, { status: 403 });

/**
 * PROD-POOLER-AUTH-INCIDENT-1 — the honest response when we could not determine
 * whether this session is still valid.
 *
 * 503, NOT 401. A 401 tells the client "you are signed out", which is how a
 * transient pool timeout used to cascade into users landing on /forgot-password
 * believing their credentials had broken. 503 + Retry-After says "ask again in a
 * moment" — which is true, because the session cookie is still intact and the
 * observed clusters self-healed in ~90 seconds.
 */
export const serviceUnavailable = (): NextResponse =>
  NextResponse.json(
    { error: "Service temporarily unavailable. Please try again." },
    { status: 503, headers: { "Retry-After": "5" } },
  );

// ── Internal resolver ─────────────────────────────────────────────────────────

/**
 * Three outcomes, deliberately distinct. Collapsing "indeterminate" into
 * "anonymous" is the masking defect this incident was made of.
 */
type SessionResolution =
  | { kind: "user"; user: SessionUser }
  | { kind: "anonymous" }
  | { kind: "indeterminate" };

async function resolveSession(): Promise<SessionResolution> {
  const session = await getServerSession(authOptions);
  // Checked BEFORE the user check: the degraded session deliberately carries no
  // user, so an ordering mistake here would silently downgrade 503 back to 401.
  if (isRevocationIndeterminate(session)) return { kind: "indeterminate" };
  if (!session?.user?.id)                 return { kind: "anonymous" };
  return {
    kind: "user",
    user: {
      id:               session.user.id,
      role:             session.user.role,
      username:         session.user.username ?? null,
      sessionToken:     session.sessionToken  ?? null,
      requireTotpSetup: session.requireTotpSetup ?? false,
    },
  };
}

/**
 * The live revocation re-check used by the two `requireFresh*` guards.
 *
 * Fresh guards deliberately bypass the cache, so they own the same failure mode
 * the cached path just had fixed: an uncaught P2024 here surfaced as a 500. It
 * must fail CLOSED (a sensitive action must never proceed on an unverified
 * session) but HONESTLY (503, not 401, and never a destroyed cookie).
 */
async function recheckSessionLive(
  sessionToken: string,
): Promise<"valid" | "revoked" | "unavailable"> {
  try {
    const dbSession = await db.userSession.findFirst({
      where:  { sessionToken, revokedAt: null },
      select: { id: true },
    });
    return dbSession ? "valid" : "revoked";
  } catch (error) {
    captureSessionRevocationFailure({ error, disposition: "INDETERMINATE" });
    return "unavailable";
  }
}

// ── Forced-TOTP-enrolment gate (SEC-FIX-1) ────────────────────────────────────

/**
 * Returns true when this session must be denied because the platform requires
 * TOTP enrolment it has not completed.
 *
 * WHY HERE: the browser proxy (proxy.ts — Next.js 16's replacement for
 * middleware.ts) redirects page navigations to the enrolment screen, but its
 * matcher is ONLY ["/dashboard/:path*", "/admin/:path*"] — it never runs on
 * /api/*, so it cannot protect a single API route. Without this check a pending
 * session (authenticated by password but not yet enrolled) could call
 * data/admin APIs directly. Enforcing at this shared authorization layer closes
 * that gap for every route that uses the guards below. The enrolment endpoints
 * themselves pass { allowTotpSetupPending: true } so setup can still be
 * completed.
 *
 * PO-1A — the two are a PAIR, and the pairing is load-bearing: the proxy picks
 * the enrolment SURFACE and this gate denies everything else. When a surface
 * composed gated data (the old /admin/security did), the proxy sent the pending
 * admin to a page whose own fetches this gate then 403'd — a deadlock. Surfaces
 * reachable while pending must therefore compose ONLY /api/user/totp/* data;
 * see lib/admin-totp-enrollment.ts.
 */
function totpSetupPending(
  user: SessionUser,
  opts?: SessionGuardOptions,
): boolean {
  return user.requireTotpSetup && !opts?.allowTotpSetupPending;
}

// ── requireUser ───────────────────────────────────────────────────────────────

/**
 * Verifies the current session.
 *
 * Returns `[user, null]` when authenticated, `[null, 401]` otherwise.
 */
export async function requireUser(
  opts?: SessionGuardOptions,
): Promise<
  [SessionUser, null] | [null, NextResponse]
> {
  const resolution = await resolveSession();
  if (resolution.kind === "indeterminate") return [null, serviceUnavailable()];
  if (resolution.kind === "anonymous")     return [null, unauthorized()];
  const user = resolution.user;
  if (totpSetupPending(user, opts)) return [null, forbidden()];
  return [user, null];
}

// ── requireFreshUser ──────────────────────────────────────────────────────────

/**
 * Like requireUser(), but never trusts the short-TTL revocation cache
 * (lib/session-cache.ts) — it always re-checks UserSession against the DB
 * directly, no matter how recently this session was last verified.
 *
 * Use this for sensitive, state-changing actions where a cached "still
 * valid" answer up to SESSION_CACHE_TTL_MS (30s) stale is not an acceptable
 * risk: changing the password, disabling 2FA, regenerating recovery codes,
 * revoking sessions, anything destructive or security-relevant. Ordinary
 * page loads and read-only requests should keep using requireUser().
 */
export async function requireFreshUser(
  opts?: SessionGuardOptions,
): Promise<
  [SessionUser, null] | [null, NextResponse]
> {
  const resolution = await resolveSession();
  if (resolution.kind === "indeterminate") return [null, serviceUnavailable()];
  if (resolution.kind === "anonymous")     return [null, unauthorized()];
  const user = resolution.user;
  if (totpSetupPending(user, opts)) return [null, forbidden()];
  if (!user.sessionToken) return [null, unauthorized()];

  const t0 = Date.now();
  const verdict = await recheckSessionLive(user.sessionToken);
  if (process.env.NODE_ENV !== "production") {
    console.log(`[session] requireFreshUser live revocation check: ${Date.now() - t0}ms, verdict=${verdict}`);
  }

  if (verdict === "unavailable") return [null, serviceUnavailable()];
  if (verdict === "revoked")     return [null, unauthorized()];

  // Refresh the cache with this authoritative result so any cached reads
  // within the TTL window right after this reflect it too.
  setCachedRevocation(user.sessionToken, true);

  return [user, null];
}

// ── requireSystemAdmin ────────────────────────────────────────────────────────

/**
 * Verifies the session and requires SYSTEM_ADMIN role.
 *
 * Returns `[user, null]` on success, an error response otherwise.
 *
 * PO-1A — the decision itself lives in decideAdminApiAccess() so it is provable
 * without a session or a DB. Semantics are unchanged: role first, then the
 * forced-enrolment gate, both 403. There is deliberately no options parameter —
 * no admin route may ever opt out of the enrolment gate.
 */
export async function requireSystemAdmin(): Promise<
  [SessionUser, null] | [null, NextResponse]
> {
  const resolution = await resolveSession();
  if (resolution.kind === "indeterminate") return [null, serviceUnavailable()];
  if (resolution.kind === "anonymous")     return [null, unauthorized()];
  const user = resolution.user;
  if (adminApiAccess(user) !== "ALLOW") return [null, forbidden()];
  return [user, null];
}

/**
 * V25-FINAL-2 — the single runtime call into the admin-access authority. Reads
 * the DISABLE_SYSTEM_ADMIN kill switch HERE (env.isSystemAdminDisabled) and
 * feeds it to the pure rule, so both guards enforce it identically and no route
 * reads the env flag itself. The rule owns the decision; this owns the read.
 */
function adminApiAccess(user: SessionUser) {
  return decideAdminApiAccess({
    role:                user.role,
    requireTotpSetup:    user.requireTotpSetup,
    systemAdminDisabled: env.isSystemAdminDisabled,
  });
}

// ── requireFreshSystemAdmin ───────────────────────────────────────────────────

/**
 * Like requireSystemAdmin(), but bypasses the revocation cache the same way
 * requireFreshUser() does. Use for admin security actions (e.g. revoking a
 * user's sessions) where a stale cached "still valid" result is not
 * acceptable.
 */
export async function requireFreshSystemAdmin(): Promise<
  [SessionUser, null] | [null, NextResponse]
> {
  const resolution = await resolveSession();
  if (resolution.kind === "indeterminate") return [null, serviceUnavailable()];
  if (resolution.kind === "anonymous")     return [null, unauthorized()];
  const user = resolution.user;
  if (adminApiAccess(user) !== "ALLOW") return [null, forbidden()];
  if (!user.sessionToken) return [null, unauthorized()];

  const t0 = Date.now();
  const verdict = await recheckSessionLive(user.sessionToken);
  if (process.env.NODE_ENV !== "production") {
    console.log(`[session] requireFreshSystemAdmin live revocation check: ${Date.now() - t0}ms, verdict=${verdict}`);
  }

  if (verdict === "unavailable") return [null, serviceUnavailable()];
  if (verdict === "revoked")     return [null, unauthorized()];

  setCachedRevocation(user.sessionToken, true);

  return [user, null];
}

// ── requireSpaceRole ──────────────────────────────────────────────────────

/** Role precedence for min-role comparisons. */
const ROLE_ORDER: SpaceMemberRole[] = [
  SpaceMemberRole.VIEWER,
  SpaceMemberRole.MEMBER,
  SpaceMemberRole.ADMIN,
  SpaceMemberRole.OWNER,
];

function meetsMinRole(
  actual: SpaceMemberRole,
  min:    SpaceMemberRole,
): boolean {
  return ROLE_ORDER.indexOf(actual) >= ROLE_ORDER.indexOf(min);
}

/**
 * Verifies the session and checks that the caller is an active member of
 * `spaceId` with at least `minRole` (defaults to VIEWER).
 *
 * Returns `[{ user, membership }, null]` on success, an error response
 * otherwise.  Replaces the repeated local `getMembership()` helpers that
 * previously lived in individual route files.
 */
export async function requireSpaceRole(
  spaceId: string,
  minRole:     SpaceMemberRole = SpaceMemberRole.VIEWER,
): Promise<
  [{ user: SessionUser; membership: SpaceMembership }, null] | [null, NextResponse]
> {
  const resolution = await resolveSession();
  if (resolution.kind === "indeterminate") return [null, serviceUnavailable()];
  if (resolution.kind === "anonymous")     return [null, unauthorized()];
  const user = resolution.user;
  if (totpSetupPending(user)) return [null, forbidden()];

  const membership = await db.spaceMember.findUnique({
    where:  { spaceId_userId: { spaceId, userId: user.id } },
    select: { spaceId: true, userId: true, role: true, status: true },
  });

  if (!membership || membership.status !== "ACTIVE") return [null, forbidden()];
  if (!meetsMinRole(membership.role, minRole))        return [null, forbidden()];

  return [{ user, membership }, null];
}
