/**
 * POST /api/workspace/switch
 *
 * Switches the caller's active workspace.
 *
 * Body: { workspaceId: string }
 *
 * Security:
 *  - Requires a valid NextAuth session.
 *  - Validates that the user is actually a member of the target workspace.
 *  - Non-members receive 403 — no information leak about workspace existence.
 *  - Sets the fintracker_workspace cookie so subsequent SSR calls use the
 *    new workspace context.
 *  - Logs WORKSPACE_SWITCH to the audit log.
 */

import { NextRequest, NextResponse }  from "next/server";
import { db }                         from "@/lib/db";
import { WorkspaceMemberStatus }      from "@prisma/client";
import { ACTIVE_WORKSPACE_COOKIE }    from "@/lib/workspace";
import { requireUser } from "@/lib/session";
import { withApiHandler, getClientIp } from "@/lib/api";

export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;

  const body = await req.json().catch(() => ({}));
  const { workspaceId } = body as { workspaceId?: string };

  if (!workspaceId || typeof workspaceId !== "string") {
    return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  }

  const userId = user.id;

  // Verify membership — never disclose whether a workspace exists to non-members
  const membership = await db.workspaceMember.findUnique({
    where:   { workspaceId_userId: { workspaceId, userId } },
    include: { workspace: { select: { id: true, name: true, type: true, isPublic: true } } },
  });

  if (!membership || membership.status !== WorkspaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  await db.auditLog.create({
    data: {
      userId,
      workspaceId:  membership.workspaceId,
      action:       "WORKSPACE_SWITCH",
      metadata:     {
        workspaceName: membership.workspace.name,
        workspaceType: membership.workspace.type,
        role:          membership.role,
      },
      ipAddress: getClientIp(req),
    },
  });

  // ── Build response with Set-Cookie ────────────────────────────────────────
  const res = NextResponse.json({
    workspace: {
      id:      membership.workspace.id,
      name:    membership.workspace.name,
      type:    membership.workspace.type,
      role:    membership.role,
      isPublic: membership.workspace.isPublic,
    },
  });

  // Cookie lifetime matches NextAuth session (30 days).
  // NOT httpOnly — the sidebar reads it client-side for the workspace switcher.
  // The value (a workspace ID) is not a secret; all authorization is re-validated
  // server-side on every request.
  const maxAge = 30 * 24 * 60 * 60;
  const secure = process.env.NODE_ENV === "production";

  res.cookies.set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    path:     "/",
    maxAge,
    secure,
    sameSite: "lax",
    httpOnly: false,
  });

  return res;
}, "POST /api/workspace/switch");
