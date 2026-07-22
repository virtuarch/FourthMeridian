/**
 * lib/space.ts
 *
 * Space context resolution. All server-side data queries go through here
 * to get the authenticated user + active Space for the current request.
 *
 * (Renamed from lib/workspace.ts — Fourth Meridian Phase 1 naming migration.
 * Naming only: no schema, auth, or business-logic changes.)
 *
 * getSpaceContext()  — production path: reads the live NextAuth session AND
 *                      the fintracker_space cookie to determine active
 *                      Space. Falls back to the user's Personal Space.
 *                      Use this in all API routes and Server Components.
 *
 * resolveSpaceContext(userId, activeSpaceId?) — shared implementation.
 *                      Verifies membership. Returns full context including
 *                      role and permissions. Falls back to Personal Space.
 */

import { cache }              from "react";
import { getServerSession }   from "next-auth";
import { cookies }            from "next/headers";
import { authOptions }        from "@/lib/auth";
import { db }                 from "@/lib/db";
import type { SpaceMemberRole } from "@prisma/client";

// ── Active Space cookie name ──────────────────────────────────────────────────
// Not httpOnly — the sidebar reads it client-side for the switcher UI.
// The value is just a Space ID; the server always re-validates membership,
// so no security information is exposed by making it readable.
export const ACTIVE_SPACE_COOKIE = "fintracker_space";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SpacePermissions {
  canInvite: boolean;  // OWNER or ADMIN
  canManage: boolean;  // OWNER or ADMIN
  canWrite:  boolean;  // OWNER, ADMIN, or MEMBER
  canRead:   boolean;  // all roles (always true for members)
  isOwner:   boolean;
}

export interface SpaceContext {
  userId:      string;
  spaceId:     string;
  role:        SpaceMemberRole;
  permissions: SpacePermissions;
  space: {
    id:          string;
    name:        string;
    type:        string;   // "PERSONAL" | "SHARED"
    category:    string;   // SpaceCategory
    isPublic:    boolean;
    /** MC1 Phase 3 Slice 6 — authoritative reporting currency (D-1); server pages use it to serialize conversion contexts for client surfaces. */
    reportingCurrency: string;
  };
}

// ── Permission helper ─────────────────────────────────────────────────────────

function derivePermissions(role: SpaceMemberRole): SpacePermissions {
  return {
    canInvite: role === "OWNER" || role === "ADMIN",
    canManage: role === "OWNER" || role === "ADMIN",
    canWrite:  role === "OWNER" || role === "ADMIN" || role === "MEMBER",
    canRead:   true,
    isOwner:   role === "OWNER",
  };
}

// ── Production path (session-aware) ──────────────────────────────────────────

/**
 * Resolves Space context from the active NextAuth session + active Space
 * cookie. Throws if unauthenticated. Falls back to Personal Space if the
 * cookie is missing, invalid, or the user is no longer a member.
 *
 * Use in all route handlers and Server Components.
 */
// ── Diagnostic instrumentation (temporary — perf audit) ──────────────────────
// getSpaceContext() is called many times per page render (every Server
// Component / API route that needs the active Space calls it
// independently). It is now wrapped in React's cache() below, so within a
// single request all calls after the first hit the in-memory cache instead
// of re-running getServerSession() + Prisma queries — but the counter + lap
// instrumentation is kept so the fan-out (and the cache savings) stay visible
// in the logs: grep for a single "[sctx]" id to see every query that one
// logical call triggered; grep for "[sctx] ENTER" alone and count the lines
// within one request's time window — after this fix there should be exactly
// ONE "ENTER" per request that actually calls getSpaceContext(), instead
// of 7.
let __sctxCallCounter = 0;

async function getSpaceContextUncached(): Promise<SpaceContext> {
  const callId = `${++__sctxCallCounter}-${Math.random().toString(36).slice(2, 6)}`;
  const t0 = Date.now();
  const lap = (label: string, from: number) => {
    console.log(`[sctx ${callId}] ${label}: ${Date.now() - from}ms`);
    return Date.now();
  };
  console.log(`[sctx ${callId}] ENTER getSpaceContext`);

  const session = await getServerSession(authOptions);
  let t = lap("getServerSession", t0);

  if (!session?.user?.id) {
    throw new Error("Not authenticated — no active session");
  }

  // Read the active Space preference from the cookie jar.
  // cookies() is a Next.js dynamic function — valid in Server Components and
  // Route Handlers, but not in static generation contexts.
  let requestedId: string | null = null;
  try {
    const jar = await cookies();
    requestedId = jar.get(ACTIVE_SPACE_COOKIE)?.value ?? null;
  } catch {
    // If called outside a request context (e.g., from a cron job that
    // accidentally calls this) — ignore and fall back to personal Space.
  }
  t = lap("cookies()", t);

  // When no active-Space cookie is set, honour the user's preferred
  // Space (set in profile settings). This makes it the effective default
  // landing Space after every login without requiring a client-side redirect.
  if (!requestedId) {
    // Honour the user's preferred Space if the migration has been applied.
    // Wrapped in try/catch so the app keeps working before the migration runs.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = await (db as any).user.findUnique({
        where:  { id: session.user.id },
        select: { preferredSpaceId: true },
      });
      requestedId = (user as { preferredSpaceId?: string | null } | null)?.preferredSpaceId ?? null;
    } catch {
      // Column not yet in DB (migration pending) — fall through to personal Space.
    }
    t = lap("user.findUnique [preferredSpaceId]", t);
  }

  const ctx = await resolveSpaceContext(session.user.id, requestedId, callId);
  lap("resolveSpaceContext (total)", t);
  console.log(`[sctx ${callId}] EXIT getSpaceContext: ${Date.now() - t0}ms total`);
  return ctx;
}

// React's cache() memoizes per-request (per render pass of the RSC tree) for
// the exact same arguments — getSpaceContext() takes none, so every call
// within one request now resolves to a single shared in-flight/resolved
// promise instead of re-running session lookup + Prisma queries. This does
// NOT cache across requests/users — cache() scope is reset for each new
// request, so there is no cross-user leakage risk.
export const getSpaceContext = cache(getSpaceContextUncached);

// ── Shared resolver ───────────────────────────────────────────────────────────

/**
 * Resolves the Space context for a user, optionally for a specific Space.
 *
 * Security guarantees:
 *  1. Never allows access to a Space the user is not a member of.
 *  2. Falls back to the user's PERSONAL Space if the requested Space
 *     is unavailable (missing, deleted, or user not a member).
 *  3. SYSTEM_ADMIN does NOT get special bypass here — admin routes should never
 *     call this function. An admin with no Space memberships will throw.
 */
export async function resolveSpaceContext(
  userId:         string,
  activeSpaceId?: string | null,
  callId?:        string,
): Promise<SpaceContext> {
  const id = callId ?? `direct-${Math.random().toString(36).slice(2, 6)}`;
  const t0 = Date.now();
  const lap = (label: string, from: number) => {
    console.log(`[sctx ${id}] ${label}: ${Date.now() - from}ms`);
    return Date.now();
  };

  // ── Try the requested Space first ────────────────────────────────────────
  if (activeSpaceId) {
    const membership = await db.spaceMember.findUnique({
      where:   { spaceId_userId: { spaceId: activeSpaceId, userId } },
      include: { space: { select: { id: true, name: true, type: true, category: true, isPublic: true, reportingCurrency: true, archivedAt: true, deletedAt: true } } },
    });
    lap("spaceMember.findUnique [requested]", t0);

    // Only treat the membership as valid if the user is still ACTIVE, and
    // the Space itself is neither archived nor trashed — an archived/
    // trashed Space must never silently become the "active" context;
    // fall through to the personal Space fallback instead.
    if (membership && membership.status === "ACTIVE" && !membership.space.archivedAt && !membership.space.deletedAt) {
      return {
        userId,
        spaceId:     membership.spaceId,
        role:        membership.role,
        permissions: derivePermissions(membership.role),
        space:       membership.space,
      };
    }
    // Not a member (or no longer active) — fall through to personal Space fallback.
  }

  // ── Fall back to PERSONAL Space ──────────────────────────────────────────
  // PERSONAL Spaces can never be archived/trashed (enforced in the API
  // layer), but the filter is kept here too as defense in depth.
  // role: OWNER — defense in depth: PERSONAL Spaces are enforced single-owner
  // at every mutation entry point (see personal-single-user.test.ts), so no
  // ACTIVE non-owner membership on a PERSONAL Space should exist. Filtering
  // here anyway means this resolver can never return a stranger's personal
  // Space even if that invariant were ever violated by a bug or bad data.
  let t = Date.now();
  const personal = await db.spaceMember.findFirst({
    where:   { userId, status: "ACTIVE", role: "OWNER", space: { type: "PERSONAL", archivedAt: null, deletedAt: null } },
    include: { space: { select: { id: true, name: true, type: true, category: true, isPublic: true, reportingCurrency: true } } },
  });
  lap("spaceMember.findFirst [personal fallback]", t);

  if (personal) {
    return {
      userId,
      spaceId:     personal.spaceId,
      role:        personal.role,
      permissions: derivePermissions(personal.role),
      space:       personal.space,
    };
  }

  // ── Last resort: any ACTIVE membership ───────────────────────────────────
  // Handles edge cases (e.g., personal Space was somehow deleted).
  // Still prefers a non-archived/non-trashed Space where one exists;
  // only falls through to an archived/trashed one if that's truly all the
  // user has left, so the app never hard-fails with no context at all.
  t = Date.now();
  const any = await db.spaceMember.findFirst({
    where:   { userId, status: "ACTIVE", space: { archivedAt: null, deletedAt: null } },
    orderBy: { joinedAt: "asc" },
    include: { space: { select: { id: true, name: true, type: true, category: true, isPublic: true, reportingCurrency: true } } },
  }) ?? await db.spaceMember.findFirstOrThrow({
    where:   { userId, status: "ACTIVE" },
    orderBy: { joinedAt: "asc" },
    include: { space: { select: { id: true, name: true, type: true, category: true, isPublic: true, reportingCurrency: true } } },
  });
  lap("spaceMember.findFirstOrThrow [any membership]", t);

  return {
    userId,
    spaceId:     any.spaceId,
    role:        any.role,
    permissions: derivePermissions(any.role),
    space:       any.space,
  };
}
