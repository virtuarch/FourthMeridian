/**
 * lib/workspace.ts
 *
 * Workspace context resolution. All server-side data queries go through here
 * to get the (userId, workspaceId) pair for the current request.
 *
 * getWorkspaceContext()  — production path: reads the live NextAuth session.
 *                          Use this in all API routes and Server Components.
 *
 * getDemoContext()       — dev/script path: resolves by looking up the demo
 *                          user's email directly. Kept for cron jobs and seed
 *                          scripts that run outside an HTTP request context.
 *                          Do not use this in routes or Server Components.
 *
 * resolveWorkspaceContext(userId) — shared implementation; finds the user's
 *                          PERSONAL workspace. Also useful after M2 auth for
 *                          future shared-workspace switching.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export interface WorkspaceContext {
  userId:      string;
  workspaceId: string;
}

// ── Production path (session-aware) ──────────────────────────────────────────

/**
 * Resolves workspace context from the active NextAuth session.
 * Throws if unauthenticated. Use in all route handlers and Server Components.
 */
export async function getWorkspaceContext(): Promise<WorkspaceContext> {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    throw new Error("Not authenticated — no active session");
  }

  return resolveWorkspaceContext(session.user.id);
}

// ── Shared resolver ───────────────────────────────────────────────────────────

/**
 * Returns { userId, workspaceId } for a given user's PERSONAL workspace.
 * Used by both getWorkspaceContext() and getDemoContext().
 */
export async function resolveWorkspaceContext(userId: string): Promise<WorkspaceContext> {
  // Prefer the user's PERSONAL workspace; fall back to any membership if none exists.
  const membership = await db.workspaceMember.findFirst({
    where: {
      userId,
      workspace: { type: "PERSONAL" },
    },
    select: { userId: true, workspaceId: true },
  }) ?? await db.workspaceMember.findFirstOrThrow({
    where:   { userId },
    orderBy: { joinedAt: "asc" },
    select:  { userId: true, workspaceId: true },
  });

  return { userId: membership.userId, workspaceId: membership.workspaceId };
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
