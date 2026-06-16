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
 *   const [auth, err] = await requireWorkspaceRole(workspaceId, "MEMBER");
 *   if (err) return err;
 *   const { user, membership } = auth;
 *
 * DO NOT IMPORT from lib/auth.ts in route handlers for session checks — import
 * from here instead.  lib/auth.ts should only be imported by:
 *   - app/api/auth/[...nextauth]/route.ts  (the NextAuth handler)
 *   - lib/workspace.ts                     (getWorkspaceContext needs full options)
 *   - lib/session.ts                       (this file — one central point)
 */

import "server-only";

import { getServerSession }      from "next-auth";
import { NextResponse }          from "next/server";
import { authOptions }           from "@/lib/auth";
import { db }                    from "@/lib/db";
import { setCachedRevocation }   from "@/lib/session-cache";
import { UserRole,
         WorkspaceMemberRole }   from "@prisma/client";

// ── Exported types ────────────────────────────────────────────────────────────

/** Minimal user shape returned by all session helpers. */
export type SessionUser = {
  id:           string;
  role:         UserRole;
  username:     string | null;
  sessionToken: string | null;
};

/** Workspace membership row included with requireWorkspaceRole results. */
export type WorkspaceMembership = {
  workspaceId: string;
  userId:      string;
  role:        WorkspaceMemberRole;
  status:      string;
};

// ── Standard error responses ──────────────────────────────────────────────────

export const unauthorized = (): NextResponse =>
  NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export const forbidden = (): NextResponse =>
  NextResponse.json({ error: "Forbidden" }, { status: 403 });

// ── Internal resolver ─────────────────────────────────────────────────────────

async function resolveUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;
  return {
    id:           session.user.id,
    role:         session.user.role,
    username:     session.user.username ?? null,
    sessionToken: session.sessionToken  ?? null,
  };
}

// ── requireUser ───────────────────────────────────────────────────────────────

/**
 * Verifies the current session.
 *
 * Returns `[user, null]` when authenticated, `[null, 401]` otherwise.
 */
export async function requireUser(): Promise<
  [SessionUser, null] | [null, NextResponse]
> {
  const user = await resolveUser();
  if (!user) return [null, unauthorized()];
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
export async function requireFreshUser(): Promise<
  [SessionUser, null] | [null, NextResponse]
> {
  const user = await resolveUser();
  if (!user) return [null, unauthorized()];
  if (!user.sessionToken) return [null, unauthorized()];

  const t0 = Date.now();
  const dbSession = await db.userSession.findFirst({
    where:  { sessionToken: user.sessionToken, revokedAt: null },
    select: { id: true },
  });
  console.log(`[session] requireFreshUser live revocation check: ${Date.now() - t0}ms, valid=${!!dbSession}`);

  if (!dbSession) return [null, unauthorized()];

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
 */
export async function requireSystemAdmin(): Promise<
  [SessionUser, null] | [null, NextResponse]
> {
  const user = await resolveUser();
  if (!user) return [null, unauthorized()];
  if (user.role !== UserRole.SYSTEM_ADMIN) return [null, forbidden()];
  return [user, null];
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
  const user = await resolveUser();
  if (!user) return [null, unauthorized()];
  if (user.role !== UserRole.SYSTEM_ADMIN) return [null, forbidden()];
  if (!user.sessionToken) return [null, unauthorized()];

  const t0 = Date.now();
  const dbSession = await db.userSession.findFirst({
    where:  { sessionToken: user.sessionToken, revokedAt: null },
    select: { id: true },
  });
  console.log(`[session] requireFreshSystemAdmin live revocation check: ${Date.now() - t0}ms, valid=${!!dbSession}`);

  if (!dbSession) return [null, unauthorized()];

  setCachedRevocation(user.sessionToken, true);

  return [user, null];
}

// ── requireWorkspaceRole ──────────────────────────────────────────────────────

/** Role precedence for min-role comparisons. */
const ROLE_ORDER: WorkspaceMemberRole[] = [
  WorkspaceMemberRole.VIEWER,
  WorkspaceMemberRole.MEMBER,
  WorkspaceMemberRole.ADMIN,
  WorkspaceMemberRole.OWNER,
];

function meetsMinRole(
  actual: WorkspaceMemberRole,
  min:    WorkspaceMemberRole,
): boolean {
  return ROLE_ORDER.indexOf(actual) >= ROLE_ORDER.indexOf(min);
}

/**
 * Verifies the session and checks that the caller is an active member of
 * `workspaceId` with at least `minRole` (defaults to VIEWER).
 *
 * Returns `[{ user, membership }, null]` on success, an error response
 * otherwise.  Replaces the repeated local `getMembership()` helpers that
 * previously lived in individual route files.
 */
export async function requireWorkspaceRole(
  workspaceId: string,
  minRole:     WorkspaceMemberRole = WorkspaceMemberRole.VIEWER,
): Promise<
  [{ user: SessionUser; membership: WorkspaceMembership }, null] | [null, NextResponse]
> {
  const user = await resolveUser();
  if (!user) return [null, unauthorized()];

  const membership = await db.workspaceMember.findUnique({
    where:  { workspaceId_userId: { workspaceId, userId: user.id } },
    select: { workspaceId: true, userId: true, role: true, status: true },
  });

  if (!membership || membership.status !== "ACTIVE") return [null, forbidden()];
  if (!meetsMinRole(membership.role, minRole))        return [null, forbidden()];

  return [{ user, membership }, null];
}
