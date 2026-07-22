/**
 * PATCH /api/admin/platform-grants/[grantId]  — revoke a platform grant.
 *
 * PO1.0 — revocation is a status flip (ACTIVE → REVOKED) with provenance
 * (revokedAt / revokedById), NEVER a row deletion — mirroring SpaceMember. The
 * row survives for audit; a later re-grant reinstates it (POST route).
 *
 * Same four-step guard stack as the create/level-change POST (07-07 risk #6):
 *   1. requireFreshSystemAdmin() — live revocation re-check.
 *   2. limitByUser(admin.id, "platform-grant", …) — rate limit.
 *   3. Target validation — grant exists and is currently ACTIVE.
 *   4. Status flip + AuditLog row (PLATFORM_GRANT_REVOKED) in ONE transaction,
 *      performedByAdminId set, area/level in metadata.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFreshSystemAdmin } from "@/lib/session";
import { limitByUser } from "@/lib/rate-limit";
import { AuditAction } from "@/lib/audit-actions";
import { getClientIp } from "@/lib/api";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ grantId: string }> },
) {
  // Step 1 — fresh auth.
  const [admin, err] = await requireFreshSystemAdmin();
  if (err) return err;

  // Step 2 — rate limit (same bucket as create/level-change).
  const limited = await limitByUser(admin.id, "platform-grant", { limit: 20, windowSec: 60 });
  if (limited) return limited;

  const { grantId } = await params;

  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (!body || body.action !== "revoke") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  }

  // Step 3 — target validation. Grant must exist and be ACTIVE (revoking an
  // already-revoked grant is a no-op we surface as 400, not a silent success).
  const grant = await db.platformGrant.findUnique({
    where:  { id: grantId },
    select: { id: true, userId: true, area: true, level: true, status: true },
  });
  if (!grant) {
    return NextResponse.json({ error: "Grant not found" }, { status: 404 });
  }
  if (grant.status !== "ACTIVE") {
    return NextResponse.json({ error: "Grant is not active" }, { status: 400 });
  }

  // Step 4 — status flip + audit row in ONE transaction.
  const [updated] = await db.$transaction([
    db.platformGrant.update({
      where: { id: grantId },
      data:  { status: "REVOKED", revokedAt: new Date(), revokedById: admin.id },
      select: {
        id:        true,
        area:      true,
        level:     true,
        status:    true,
        grantedAt: true,
        revokedAt: true,
        user:      { select: { id: true, name: true, username: true, email: true } },
        grantedBy: { select: { id: true, name: true, username: true } },
        revokedBy: { select: { id: true, name: true, username: true } },
      },
    }),
    db.auditLog.create({
      data: {
        userId:             grant.userId,
        action:             AuditAction.PLATFORM_GRANT_REVOKED,
        performedByAdminId: admin.id,
        metadata:           { area: grant.area, level: grant.level, previousStatus: "ACTIVE" },
        ipAddress:          getClientIp(req),
      },
    }),
  ]);

  return NextResponse.json({ grant: updated });
}
