/**
 * PATCH  /api/workspaces/[id]/goals/[goalId]  — update a goal (OWNER/ADMIN only)
 * DELETE /api/workspaces/[id]/goals/[goalId]  — soft-delete (move to trash) or permanently purge
 *
 * Deletion is two-phase:
 *   1. DELETE (no body)           → soft-delete: sets deletedAt = now  (move to trash)
 *   2. DELETE ?permanent=true     → hard-delete: physically removes the row
 *      (Only callable on already-soft-deleted goals, i.e. from the trash drawer)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceRole } from "@/lib/session";
import { WorkspaceMemberRole } from "@prisma/client";
import { db } from "@/lib/db";
import { withApiHandler, getClientIp } from "@/lib/api";

export const PATCH = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string; goalId: string }> }
) => {
  const { id: workspaceId, goalId } = await params;
  const [auth, err] = await requireWorkspaceRole(workspaceId, WorkspaceMemberRole.ADMIN);
  if (err) return err;
  const { user } = auth;

  const existing = await db.workspaceGoal.findUnique({
    where: { id: goalId },
  });
  if (!existing || existing.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const {
    name, description, category, status, targetAmount, currentAmount, targetDate,
    habitFrequency, spendingCategory, linkedAccountId,
    targetReductionAmount, targetReductionPct, snapshotBalance,
    archivedAt, deletedAt,
  } = body as {
    name?:                  string;
    description?:           string | null;
    category?:              string;
    status?:                string;
    targetAmount?:          number;
    currentAmount?:         number;
    targetDate?:            string | null;
    habitFrequency?:        string | null;
    spendingCategory?:      string | null;
    linkedAccountId?:       string | null;
    targetReductionAmount?: number | null;
    targetReductionPct?:    number | null;
    snapshotBalance?:       number | null;
    archivedAt?:            string | null;  // ISO string or null to unarchive
    deletedAt?:             string | null;  // ISO string to trash, null to restore
  };

  const updated = await db.workspaceGoal.update({
    where: { id: goalId },
    data: {
      ...(name                  !== undefined && { name: name.trim() }),
      ...(description           !== undefined && { description: description?.trim() || null }),
      ...(category              !== undefined && { category: category as never }),
      ...(status                !== undefined && { status: status as never }),
      ...(targetAmount          !== undefined && { targetAmount }),
      ...(currentAmount         !== undefined && { currentAmount }),
      ...(targetDate            !== undefined && { targetDate: targetDate ? new Date(targetDate) : null }),
      ...(habitFrequency        !== undefined && { habitFrequency }),
      ...(spendingCategory      !== undefined && { spendingCategory }),
      ...(linkedAccountId       !== undefined && { linkedAccountId }),
      ...(targetReductionAmount !== undefined && { targetReductionAmount }),
      ...(targetReductionPct    !== undefined && { targetReductionPct }),
      ...(snapshotBalance       !== undefined && { snapshotBalance }),
      // Mark completedAt when transitioning to COMPLETED
      ...(status === "COMPLETED" && !existing.completedAt && { completedAt: new Date() }),
      ...(status === "ACTIVE"    && { completedAt: null }),
      // Archive / unarchive
      ...(archivedAt !== undefined && { archivedAt: archivedAt ? new Date(archivedAt) : null }),
      // Trash / restore — when trashing, clear archivedAt for clean state
      ...(deletedAt  !== undefined && {
        deletedAt:  deletedAt ? new Date(deletedAt) : null,
        ...(deletedAt ? { archivedAt: null } : {}),
      }),
    },
  });

  await db.auditLog.create({
    data: {
      userId:      user.id,
      workspaceId,
      action:      "GOAL_UPDATE",
      metadata:    { goalId, name: updated.name, status: updated.status },
      ipAddress:   getClientIp(req),
    },
  });

  return NextResponse.json(updated);
}, "PATCH /api/workspaces/[id]/goals/[goalId]");

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string; goalId: string }> }
) => {
  const { id: workspaceId, goalId } = await params;
  const [auth, err] = await requireWorkspaceRole(workspaceId, WorkspaceMemberRole.ADMIN);
  if (err) return err;
  const { user } = auth;

  const permanent = new URL(req.url).searchParams.get("permanent") === "true";

  const existing = await db.workspaceGoal.findUnique({
    where: { id: goalId },
  });
  if (!existing || existing.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (permanent) {
    // Hard-delete: only allowed on already-trashed goals
    if (!existing.deletedAt) {
      return NextResponse.json(
        { error: "Move to trash before permanently deleting" },
        { status: 400 }
      );
    }
    await db.workspaceGoal.delete({ where: { id: goalId } });
  } else {
    // Soft-delete: move to trash
    await db.workspaceGoal.update({
      where: { id: goalId },
      data:  { deletedAt: new Date(), archivedAt: null },
    });
  }

  await db.auditLog.create({
    data: {
      userId:      user.id,
      workspaceId,
      action:      permanent ? "GOAL_PURGE" : "GOAL_DELETE",
      metadata:    { goalId, name: existing.name, permanent },
      ipAddress:   getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true });
}, "DELETE /api/workspaces/[id]/goals/[goalId]");
