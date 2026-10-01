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
import { withTenantDb } from "@/lib/db/tenant-context";
import { withApiHandler, getClientIp } from "@/lib/api";
import { emitDomainEvent, dispatchDomainEvent } from "@/lib/events/emit";
import type { DomainEvent } from "@/lib/events/types";

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  const [auth, err] = await requireSpaceRole(id, SpaceMemberRole.OWNER);
  if (err) return err;
  const { user } = auth;

  // RLS slice B — requireSpaceRole has established an ACTIVE OWNER membership,
  // so the trashed Space is visible to fm_app (trashing never touched
  // SpaceMember, which is what keeps it reachable at all).
  const space = await withTenantDb(user.id, (tx) => tx.space.findUnique({ where: { id } }));
  if (!space) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!space.deletedAt) {
    return NextResponse.json({ error: "Space is not in trash" }, { status: 400 });
  }

  const event: DomainEvent = {
    type:        "SpaceRestored",
    spaceId:     id,
    actorUserId: user.id,
    ipAddress:   getClientIp(req),
    payload:     { name: space.name },
  };

  // ⚠️ PERSIST INSIDE THE BOUNDARY, DISPATCH OUTSIDE IT. The flip and its
  // canonical AuditLog row now share the one transaction that carries the
  // identity (they were two statements before — nothing atomic was split). The
  // handler phase must NOT be inside it: a handler can regenerate snapshots and
  // write notifications, and withTenantDb is a security boundary around the
  // shortest coherent database operation, never around arbitrary follow-on work.
  // SpaceRestored has no registered handler today, so this is a no-op call — made
  // anyway, because the shape must be right before one is registered.
  await withTenantDb(user.id, async (tx) => {
    await tx.space.update({
      where: { id },
      data:  { deletedAt: null },
    });
    await emitDomainEvent(tx, event);
  });
  await dispatchDomainEvent(event);

  return NextResponse.json({ ok: true });
}, "POST /api/spaces/[id]/restore");
