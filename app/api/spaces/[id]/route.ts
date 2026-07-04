/**
 * GET    /api/spaces/[id]  — get space details (must be a member, or public)
 * PATCH  /api/spaces/[id]  — update name/description/isPublic/category
 *                                (OWNER/ADMIN only), or archive/unarchive via
 *                                `archivedAt` (OWNER only — see below)
 * DELETE /api/spaces/[id]  — move space to trash (soft-delete, sets
 *                                deletedAt). OWNER only, SHARED only. This no
 *                                longer performs a real delete — see
 *                                app/api/spaces/[id]/permanent/route.ts
 *                                for the only endpoint that does.
 *
 * Lifecycle: active -> archived (this PATCH) -> trashed (this DELETE) ->
 * restored (app/api/spaces/[id]/restore/route.ts) or permanently deleted
 * (app/api/spaces/[id]/permanent/route.ts). Archiving and trashing never
 * touch WorkspaceAccountShare or SpaceSnapshot rows — those are only
 * affected by permanent delete.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser, requireSpaceRole } from "@/lib/session";
import { SpaceMemberRole } from "@prisma/client";
import { db } from "@/lib/db";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";

export const GET = withApiHandler(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const [user, err] = await requireUser();
  if (err) return err;

  const space = await db.space.findUnique({
    where: { id },
    include: {
      members: {
        where: { status: "ACTIVE" },
        include: { user: { select: { id: true, name: true, username: true, email: true } } },
        orderBy: { joinedAt: "asc" },
      },
    },
  });

  if (!space) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ── SP-2b Batch 3 — DOCUMENTED public-read exception (intentionally inline) ──
  // This GET door is NOT a role/lifecycle gate, so it deliberately does NOT use
  // requireSpaceAction. It is a read-VISIBILITY gate with three properties that
  // requireSpaceAction cannot model, and must be preserved here:
  //   1. Existence first — a missing Space returns 404 (above) BEFORE any auth
  //      check; requireSpaceAction never emits 404 (it would 403 a missing
  //      Space, collapsing the 404/403 distinction).
  //   2. Public OR member — a PUBLIC Space is readable by anyone authenticated,
  //      including non-members; requireSpaceAction 403s every non-member and has
  //      no `isPublic` awareness, so it would break public-Space reads.
  //   3. myRole derivation — the response carries the caller's role (or null for
  //      a public non-member); requireSpaceAction returns no row for a public
  //      non-member (it 403s first).
  // See docs/initiatives/sp2/SP-2B_BATCH3_INVESTIGATION.md. Do NOT swap this for
  // requireSpaceAction("space:read").
  const membership = await db.spaceMember.findUnique({ where: { spaceId_userId: { spaceId: id, userId: user.id } } });
  const isActiveMember = membership?.status === "ACTIVE";
  if (!space.isPublic && !isActiveMember) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ ...space, myRole: isActiveMember ? membership!.role : null });
}, "GET /api/spaces/[id]");

export const PATCH = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  // Base gate: ADMIN+ for ordinary field edits. Archiving/unarchiving is
  // additionally restricted to OWNER below — ADMINs cannot archive a
  // space they don't own.
  const [patchAuth, patchErr] = await requireSpaceRole(id, SpaceMemberRole.ADMIN);
  if (patchErr) return patchErr;
  const { user, membership } = patchAuth;

  const body = await req.json();
  const { name, description, isPublic, category, archivedAt } = body as {
    name?:        string;
    description?: string;
    isPublic?:    boolean;
    category?:    string;
    archivedAt?:  string | null; // ISO string to archive, null to unarchive
  };

  const existing = await db.space.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ── Archive / unarchive ────────────────────────────────────────────────
  if (archivedAt !== undefined) {
    if (membership.role !== SpaceMemberRole.OWNER) {
      return NextResponse.json(
        { error: "Only the Space owner can archive or unarchive this Space" },
        { status: 403 }
      );
    }
    if (existing.type === "PERSONAL") {
      return NextResponse.json({ error: "Cannot archive your Personal Space" }, { status: 400 });
    }
    if (existing.deletedAt) {
      return NextResponse.json(
        { error: "Space is in trash — restore it before archiving" },
        { status: 400 }
      );
    }
  }

  const space = await db.space.update({
    where: { id },
    data: {
      ...(name        !== undefined && { name: name.trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
      ...(isPublic    !== undefined && { isPublic }),
      ...(category    !== undefined && { category: category as never }),
      ...(archivedAt  !== undefined && { archivedAt: archivedAt ? new Date(archivedAt) : null }),
    },
  });

  await db.auditLog.create({
    data: {
      userId:      user.id,
      spaceId: id,
      action:      archivedAt !== undefined
        ? (archivedAt ? AuditAction.SPACE_ARCHIVED : AuditAction.SPACE_UNARCHIVED)
        : AuditAction.SPACE_UPDATE,
      metadata:    { name: space.name, isPublic: space.isPublic, category },
      ipAddress:   getClientIp(req),
    },
  });

  return NextResponse.json(space);
}, "PATCH /api/spaces/[id]");

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  // requireSpaceRole enforces both ACTIVE status and OWNER role —
  // a LEFT or REMOVED owner cannot delete.
  const [auth, err] = await requireSpaceRole(id, SpaceMemberRole.OWNER);
  if (err) return err;
  const { user } = auth;

  const space = await db.space.findUnique({ where: { id } });
  if (!space) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (space.type === "PERSONAL") {
    return NextResponse.json({ error: "Cannot delete your Personal Space" }, { status: 400 });
  }
  if (space.deletedAt) {
    return NextResponse.json({ error: "Space is already in trash" }, { status: 400 });
  }

  // Soft-delete only: move to trash. Does NOT cascade-delete members,
  // shares, snapshots, goals, or anything else — those rows are untouched
  // until (and unless) the space is permanently deleted from the trash
  // via app/api/spaces/[id]/permanent/route.ts. Clears archivedAt so a
  // space is never simultaneously "archived" and "trashed".
  await db.space.update({
    where: { id },
    data:  { deletedAt: new Date(), archivedAt: null },
  });

  await db.auditLog.create({
    data: {
      userId:    user.id,
      spaceId: id,
      action:    AuditAction.SPACE_TRASHED,
      metadata:  { name: space.name },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true });
}, "DELETE /api/spaces/[id]");
