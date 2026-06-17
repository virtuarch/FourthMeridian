/**
 * lib/workspace.ts
 *
 * Workspace context resolution. All server-side data queries go through here
 * to get the authenticated user + active workspace for the current request.
 *
 * getWorkspaceContext()  — production path: reads the live NextAuth session AND
 *                          the fintracker_workspace cookie to determine active
 *                          workspace. Falls back to the user's Personal workspace.
 *                          Use this in all API routes and Server Components.
 *
 * resolveWorkspaceContext(userId, activeWorkspaceId?) — shared implementation.
 *                          Verifies membership. Returns full context including
 *                          role and permissions. Falls back to Personal workspace.
 *
 * getDemoContext()       — dev/script path: resolves by looking up the demo
 *                          user's email directly. Kept for cron jobs and seed
 *                          scripts that run outside an HTTP request context.
 *                          Do not use this in routes or Server Components.
 */

import { cache }              from "react";
import { getServerSession }   from "next-auth";
import { cookies }            from "next/headers";
import { authOptions }        from "@/lib/auth";
import { db }                 from "@/lib/db";
import type { WorkspaceMemberRole } from "@prisma/client";

// ── Active workspace cookie name ──────────────────────────────────────────────
// Not httpOnly — the sidebar reads it client-side for the switcher UI.
// The value is just a workspace ID; the server always re-validates membership,
// so no security information is exposed by making it readable.
export const ACTIVE_WORKSPACE_COOKIE = "fintracker_workspace";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkspacePermissions {
  canInvite: boolean;  // OWNER or ADMIN
  canManage: boolean;  // OWNER or ADMIN
  canWrite:  boolean;  // OWNER, ADMIN, or MEMBER
  canRead:   boolean;  // all roles (always true for members)
  isOwner:   boolean;
}

export interface WorkspaceContext {
  userId:      string;
  workspaceId: string;
  role:        WorkspaceMemberRole;
  permissions: WorkspacePermissions;
  workspace: {
    id:          string;
    name:        string;
    type:        string;   // "PERSONAL" | "SHARED"
    category:    string;   // WorkspaceCategory
    isPublic:    boolean;
  };
}

// ── Permission helper ─────────────────────────────────────────────────────────

function derivePermissions(role: WorkspaceMemberRole): WorkspacePermissions {
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
 * Resolves workspace context from the active NextAuth session + active workspace
 * cookie. Throws if unauthenticated. Falls back to Personal workspace if the
 * cookie is missing, invalid, or the user is no longer a member.
 *
 * Use in all route handlers and Server Components.
 */
// ── Diagnostic instrumentation (temporary — perf audit) ──────────────────────
// getWorkspaceContext() is called many times per page render (every Server
// Component / API route that needs the active workspace calls it
// independently). It is now wrapped in React's cache() below, so within a
// single request all calls after the first hit the in-memory cache instead
// of re-running getServerSession() + Prisma queries — but the counter + lap
// instrumentation is kept so the fan-out (and the cache savings) stay visible
// in the logs: grep for a single "[wsctx]" id to see every query that one
// logical call triggered; grep for "[wsctx] ENTER" alone and count the lines
// within one request's time window — after this fix there should be exactly
// ONE "ENTER" per request that actually calls getWorkspaceContext(), instead
// of 7.
let __wsctxCallCounter = 0;

async function getWorkspaceContextUncached(): Promise<WorkspaceContext> {
  const callId = `${++__wsctxCallCounter}-${Math.random().toString(36).slice(2, 6)}`;
  const t0 = Date.now();
  const lap = (label: string, from: number) => {
    console.log(`[wsctx ${callId}] ${label}: ${Date.now() - from}ms`);
    return Date.now();
  };
  console.log(`[wsctx ${callId}] ENTER getWorkspaceContext`);

  const session = await getServerSession(authOptions);
  let t = lap("getServerSession", t0);

  if (!session?.user?.id) {
    throw new Error("Not authenticated — no active session");
  }

  // Read the active workspace preference from the cookie jar.
  // cookies() is a Next.js dynamic function — valid in Server Components and
  // Route Handlers, but not in static generation contexts.
  let requestedId: string | null = null;
  try {
    const jar = await cookies();
    requestedId = jar.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null;
  } catch {
    // If called outside a request context (e.g., from a cron job that
    // accidentally calls this) — ignore and fall back to personal workspace.
  }
  t = lap("cookies()", t);

  // When no active-workspace cookie is set, honour the user's preferred
  // workspace (set in profile settings). This makes it the effective default
  // landing workspace after every login without requiring a client-side redirect.
  if (!requestedId) {
    // Honour the user's preferred workspace if the migration has been applied.
    // Wrapped in try/catch so the app keeps working before the migration runs.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = await (db as any).user.findUnique({
        where:  { id: session.user.id },
        select: { preferredWorkspaceId: true },
      });
      requestedId = (user as { preferredWorkspaceId?: string | null } | null)?.preferredWorkspaceId ?? null;
    } catch {
      // Column not yet in DB (migration pending) — fall through to personal workspace.
    }
    t = lap("user.findUnique [preferredWorkspaceId]", t);
  }

  const ctx = await resolveWorkspaceContext(session.user.id, requestedId, callId);
  lap("resolveWorkspaceContext (total)", t);
  console.log(`[wsctx ${callId}] EXIT getWorkspaceContext: ${Date.now() - t0}ms total`);
  return ctx;
}

// React's cache() memoizes per-request (per render pass of the RSC tree) for
// the exact same arguments — getWorkspaceContext() takes none, so every call
// within one request now resolves to a single shared in-flight/resolved
// promise instead of re-running session lookup + Prisma queries. This does
// NOT cache across requests/users — cache() scope is reset for each new
// request, so there is no cross-user leakage risk.
export const getWorkspaceContext = cache(getWorkspaceContextUncached);

// ── Shared resolver ───────────────────────────────────────────────────────────

/**
 * Resolves the workspace context for a user, optionally for a specific workspace.
 *
 * Security guarantees:
 *  1. Never allows access to a workspace the user is not a member of.
 *  2. Falls back to the user's PERSONAL workspace if the requested workspace
 *     is unavailable (missing, deleted, or user not a member).
 *  3. SYSTEM_ADMIN does NOT get special bypass here — admin routes should never
 *     call this function. An admin with no workspace memberships will throw.
 */
export async function resolveWorkspaceContext(
  userId:              string,
  activeWorkspaceId?:  string | null,
  callId?:             string,
): Promise<WorkspaceContext> {
  const id = callId ?? `direct-${Math.random().toString(36).slice(2, 6)}`;
  const t0 = Date.now();
  const lap = (label: string, from: number) => {
    console.log(`[wsctx ${id}] ${label}: ${Date.now() - from}ms`);
    return Date.now();
  };

  // ── Try the requested workspace first ────────────────────────────────────
  if (activeWorkspaceId) {
    const membership = await db.workspaceMember.findUnique({
      where:   { workspaceId_userId: { workspaceId: activeWorkspaceId, userId } },
      include: { workspace: { select: { id: true, name: true, type: true, category: true, isPublic: true, archivedAt: true, deletedAt: true } } },
    });
    lap("workspaceMember.findUnique [requested]", t0);

    // Only treat the membership as valid if the user is still ACTIVE, and
    // the workspace itself is neither archived nor trashed — an archived/
    // trashed workspace must never silently become the "active" context;
    // fall through to the personal workspace fallback instead.
    if (membership && membership.status === "ACTIVE" && !membership.workspace.archivedAt && !membership.workspace.deletedAt) {
      return {
        userId,
        workspaceId:  membership.workspaceId,
        role:         membership.role,
        permissions:  derivePermissions(membership.role),
        workspace:    membership.workspace,
      };
    }
    // Not a member (or no longer active) — fall through to personal workspace fallback.
  }

  // ── Fall back to PERSONAL workspace ──────────────────────────────────────
  // PERSONAL workspaces can never be archived/trashed (enforced in the API
  // layer), but the filter is kept here too as defense in depth.
  let t = Date.now();
  const personal = await db.workspaceMember.findFirst({
    where:   { userId, status: "ACTIVE", workspace: { type: "PERSONAL", archivedAt: null, deletedAt: null } },
    include: { workspace: { select: { id: true, name: true, type: true, category: true, isPublic: true } } },
  });
  lap("workspaceMember.findFirst [personal fallback]", t);

  if (personal) {
    return {
      userId,
      workspaceId:  personal.workspaceId,
      role:         personal.role,
      permissions:  derivePermissions(personal.role),
      workspace:    personal.workspace,
    };
  }

  // ── Last resort: any ACTIVE membership ───────────────────────────────────
  // Handles edge cases (e.g., personal workspace was somehow deleted).
  // Still prefers a non-archived/non-trashed workspace where one exists;
  // only falls through to an archived/trashed one if that's truly all the
  // user has left, so the app never hard-fails with no context at all.
  t = Date.now();
  const any = await db.workspaceMember.findFirst({
    where:   { userId, status: "ACTIVE", workspace: { archivedAt: null, deletedAt: null } },
    orderBy: { joinedAt: "asc" },
    include: { workspace: { select: { id: true, name: true, type: true, category: true, isPublic: true } } },
  }) ?? await db.workspaceMember.findFirstOrThrow({
    where:   { userId, status: "ACTIVE" },
    orderBy: { joinedAt: "asc" },
    include: { workspace: { select: { id: true, name: true, type: true, category: true, isPublic: true } } },
  });
  lap("workspaceMember.findFirstOrThrow [any membership]", t);

  return {
    userId,
    workspaceId:  any.workspaceId,
    role:         any.role,
    permissions:  derivePermissions(any.role),
    workspace:    any.workspace,
  };
}

// ── Dev / script path (no HTTP context) ──────────────────────────────────────

const DEMO_USER_EMAIL = "jane@example.com";

/**
 * @deprecated — for cron jobs and scripts only.
 * Use getWorkspaceContext() in all Next.js routes and Server Components.
 */
export async function getDemoContext(): Promise<WorkspaceContext> {
  const user = await db.user.findUniqueOrThrow({
    where:  { email: DEMO_USER_EMAIL },
    select: { id: true },
  });
  return resolveWorkspaceContext(user.id);
}
