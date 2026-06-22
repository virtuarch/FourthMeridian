/**
 * GET /api/spaces/[id]/sections
 *
 * Returns the ordered SpaceDashboardSection rows for a space.
 * Grouped by tab in the response for convenient client consumption.
 *
 * Security:
 *  - Requires authenticated session.
 *  - User must be an ACTIVE member of the space (any role).
 */

import { NextRequest, NextResponse }      from "next/server";
import { db }                             from "@/lib/db";
import { SpaceMemberStatus }          from "@prisma/client";
import { requireUser } from "@/lib/session";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const [user, err] = await requireUser();
  if (err) return err;

  const { id: spaceId } = await params;

  const membership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: user.id } },
    select: { role: true, status: true },
  });

  if (!membership || membership.status !== SpaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sections = await db.spaceDashboardSection.findMany({
    where: { spaceId },
    orderBy: [{ tab: "asc" }, { order: "asc" }],
  });

  return NextResponse.json(sections);
}
