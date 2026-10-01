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
 *
 * ── RLS SLICE B ──────────────────────────────────────────────────────────────
 * The membership probe and the Space it names are TWO reads now, not one join,
 * and that split is deliberate. fm_app's `SpaceMember` policy carries a
 * `userId = current_fm_user_id()` arm, so a LEFT or REMOVED membership is still
 * visible to its owner — which the 403 below depends on — but `Space` requires
 * an ACTIVE one. Keeping the old `include: { space }` would have asked Prisma to
 * hydrate a REQUIRED relation that the policies correctly refuse, and Prisma
 * raises "Inconsistent query result: Field space is required" rather than
 * returning null: a LEFT member's clean 403 would have become a 500. So the
 * Space is read only AFTER the ACTIVE check has passed. Same statuses, same
 * codes, same body.
 */

import { NextRequest, NextResponse }  from "next/server";
import { withTenantDb }                from "@/lib/db/tenant-context";
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
  const membership = await withTenantDb(userId, (tx) => tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId } },
  }));

  if (!membership || membership.status !== SpaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // The membership is ACTIVE, so the Space is visible to fm_app — see the header
  // for why this is a second read rather than an include. Its audit row shares
  // the transaction, so a switch is never recorded against a Space this read
  // could not confirm.
  const space = await withTenantDb(userId, async (tx) => {
    const space = await tx.space.findUniqueOrThrow({
      where:  { id: spaceId },
      select: { id: true, name: true, type: true, isPublic: true },
    });

    // ── Audit log ───────────────────────────────────────────────────────────
    await tx.auditLog.create({
      data: {
        userId,
        spaceId:  membership.spaceId,
        action:       "SPACE_SWITCH",
        metadata:     {
          spaceName: space.name,
          spaceType: space.type,
          role:          membership.role,
        },
        ipAddress: getClientIp(req),
      },
    });
    return space;
  });

  // ── Build response with Set-Cookie ────────────────────────────────────────
  const res = NextResponse.json({
    space: {
      id:      space.id,
      name:    space.name,
      type:    space.type,
      role:    membership.role,
      isPublic: space.isPublic,
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
