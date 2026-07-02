/**
 * POST /api/space/switch
 *
 * Switches the caller's active space.
 *
 * Body: { spaceId: string }
 *
 * Security:
 *  - Requires a valid NextAuth session.
 *  - Validates that the user is actually a member of the target space.
 *  - Non-members receive 403 — no information leak about space existence.
 *  - Sets the fintracker_space cookie so subsequent SSR calls use the
 *    new space context.
 *  - Logs SPACE_SWITCH to the audit log.
 */

import { NextRequest, NextResponse }  from "next/server";
import { db }                         from "@/lib/db";
import { SpaceMemberStatus }      from "@prisma/client";
import { ACTIVE_SPACE_COOKIE }    from "@/lib/space";
import { requireUser } from "@/lib/session";
import { withApiHandler, getClientIp } from "@/lib/api";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;

  const body = await req.json().catch(() => ({}));
  const { spaceId } = body as { spaceId?: string };

  if (!spaceId || typeof spaceId !== "string") {
    return NextResponse.json({ error: "spaceId is required" }, { status: 400 });
  }

  const userId = user.id;

  // Verify membership — never disclose whether a space exists to non-members
  const membership = await db.spaceMember.findUnique({
    where:   { spaceId_userId: { spaceId, userId } },
    include: { space: { select: { id: true, name: true, type: true, isPublic: true } } },
  });

  if (!membership || membership.status !== SpaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  await db.auditLog.create({
    data: {
      userId,
      spaceId:  membership.spaceId,
      action:       "SPACE_SWITCH",
      metadata:     {
        spaceName: membership.space.name,
        spaceType: membership.space.type,
        role:          membership.role,
      },
      ipAddress: getClientIp(req),
    },
  });

  // ── Build response with Set-Cookie ────────────────────────────────────────
  const res = NextResponse.json({
    space: {
      id:      membership.space.id,
      name:    membership.space.name,
      type:    membership.space.type,
      role:    membership.role,
      isPublic: membership.space.isPublic,
    },
  });

  // Cookie lifetime matches NextAuth session (30 days).
  // NOT httpOnly — the sidebar reads it client-side for the space switcher.
  // The value (a space ID) is not a secret; all authorization is re-validated
  // server-side on every request.
  const maxAge = 30 * 24 * 60 * 60;
  const secure = process.env.NODE_ENV === "production";

  res.cookies.set(ACTIVE_SPACE_COOKIE, spaceId, {
    path:     "/",
    maxAge,
    secure,
    sameSite: "lax",
    httpOnly: false,
  });

  return res;
}, "POST /api/space/switch");
