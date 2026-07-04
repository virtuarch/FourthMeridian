/**
 * POST /api/spaces/[id]/restore
 *
 * Restores a trashed Space — clears deletedAt. OWNER only.
 *
 * Does NOT recreate SpaceMember rows or WorkspaceAccountShare rows,
 * because trashing never removed them in the first place (see the DELETE
 * handler in app/api/spaces/[id]/route.ts) — they were left untouched
 * the whole time the space sat in trash. This route is a pure
 * deletedAt -> null flip, nothing more.
 *
 * Companion to the archive/unarchive toggle on PATCH
 * /api/spaces/[id] (`archivedAt`), which is a separate lifecycle state.
 * A space can only be restored from trash here if it is currently
 * trashed (deletedAt set); restoring from archive uses the PATCH endpoint
 * instead.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSpaceRole } from "@/lib/session";
import { SpaceMemberRole } from "@prisma/client";
import { db } from "@/lib/db";
import { withApiHandler, getClientIp } from "@/lib/api";
import { emitDomainEvent } from "@/lib/events/emit";

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  const [auth, err] = await requireSpaceRole(id, SpaceMemberRole.OWNER);
  if (err) return err;
  const { user } = auth;

  const space = await db.space.findUnique({ where: { id } });
  if (!space) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!space.deletedAt) {
    return NextResponse.json({ error: "Space is not in trash" }, { status: 400 });
  }

  await db.space.update({
    where: { id },
    data:  { deletedAt: null },
  });

  await emitDomainEvent({
    type:        "SpaceRestored",
    spaceId:     id,
    actorUserId: user.id,
    ipAddress:   getClientIp(req),
    payload:     { name: space.name },
  });

  return NextResponse.json({ ok: true });
}, "POST /api/spaces/[id]/restore");
