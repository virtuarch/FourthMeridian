/**
 * GET  /api/admin/platform-grants  — list every platform grant (any status)
 *                                     with holder + grantor + revoker identity.
 * POST /api/admin/platform-grants  — create · reinstate · level-change a grant
 *                                     for (userId, area). Which of the three it
 *                                     was determines the canon audit action.
 *
 * PO1.0 — the extra-guarded grant-administration surface (07-07 risk #6, "the
 * big one"). Mutation is SYSTEM_ADMIN-only, full stop: no platform capability
 * can mint platform capabilities, so the grant-yourself-access escalation class
 * does not exist in PO1.0. Every mutation carries the four-step guard stack:
 *   1. requireFreshSystemAdmin() — live revocation re-check, deliberately
 *      stronger than the cached guard most admin routes use.
 *   2. limitByUser(admin.id, "platform-grant", …) — rate limit.
 *   3. Target validation — user exists, role === USER, area/level are enum members.
 *   4. Grant write + AuditLog row in ONE transaction, canon action, with
 *      performedByAdminId set and area/level (+ previous state) in metadata.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  UserRole,
  PlatformArea,
  PlatformAccessLevel,
  type Prisma,
} from "@prisma/client";
import { requireSystemAdmin, requireFreshSystemAdmin } from "@/lib/session";
import { limitByUser } from "@/lib/rate-limit";
import { AuditAction } from "@/lib/audit-actions";
import { getClientIp } from "@/lib/api";

export const runtime = "nodejs";

// Identity shape included for holder / grantor / revoker on every listed grant.
const identitySelect = { id: true, name: true, username: true } as const;

// ── GET — list all grants ─────────────────────────────────────────────────────

export async function GET() {
  const [, err] = await requireSystemAdmin();
  if (err) return err;

  const grants = await db.platformGrant.findMany({
    orderBy: [{ user: { username: "asc" } }, { area: "asc" }],
    select: {
      id:        true,
      area:      true,
      level:     true,
      status:    true,
      grantedAt: true,
      revokedAt: true,
      user:      { select: { ...identitySelect, email: true } },
      grantedBy: { select: identitySelect },
      revokedBy: { select: identitySelect },
    },
  });

  return NextResponse.json({ grants });
}

// ── POST — create / reinstate / change-level ──────────────────────────────────

export async function POST(req: NextRequest) {
  // Step 1 — fresh auth (live revocation check; stronger than cached).
  const [admin, err] = await requireFreshSystemAdmin();
  if (err) return err;

  // Step 2 — rate limit.
  const limited = await limitByUser(admin.id, "platform-grant", { limit: 20, windowSec: 60 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as
    | { userId?: unknown; area?: unknown; level?: unknown }
    | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const { userId, area, level } = body;

  // Step 3 — target validation.
  if (typeof userId !== "string" || !userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }
  if (typeof area !== "string" || !(Object.values(PlatformArea) as string[]).includes(area)) {
    return NextResponse.json({ error: "Invalid area" }, { status: 400 });
  }
  if (typeof level !== "string" || !(Object.values(PlatformAccessLevel) as string[]).includes(level)) {
    return NextResponse.json({ error: "Invalid level" }, { status: 400 });
  }
  const areaVal  = area  as PlatformArea;
  const levelVal = level as PlatformAccessLevel;

  const target = await db.user.findUnique({
    where:  { id: userId },
    select: { id: true, role: true },
  });
  if (!target) {
    return NextResponse.json({ error: "Target user not found" }, { status: 400 });
  }
  // SYSTEM_ADMIN needs no grants — the break-glass bypass already covers them;
  // issuing one would only mislead audits. Restrict grants to role === USER.
  if (target.role !== UserRole.USER) {
    return NextResponse.json(
      { error: "Grants may only be issued to USER-role accounts" },
      { status: 400 },
    );
  }

  // Classify the mutation from the existing row's state.
  const existing = await db.platformGrant.findUnique({
    where:  { userId_area: { userId, area: areaVal } },
    select: { level: true, status: true },
  });

  let action: string;
  let metadata: Prisma.InputJsonValue;

  if (!existing) {
    action   = AuditAction.PLATFORM_GRANT_CREATED;
    metadata = { area: areaVal, level: levelVal };
  } else if (existing.status === "REVOKED") {
    action   = AuditAction.PLATFORM_GRANT_REINSTATED;
    metadata = { area: areaVal, level: levelVal, previousStatus: "REVOKED", previousLevel: existing.level };
  } else if (existing.level !== levelVal) {
    action   = AuditAction.PLATFORM_GRANT_LEVEL_CHANGED;
    metadata = { area: areaVal, level: levelVal, previousLevel: existing.level };
  } else {
    // ACTIVE at the same level — idempotent no-op; no mutation, no audit row.
    const grant = await db.platformGrant.findUnique({
      where:  { userId_area: { userId, area: areaVal } },
      select: grantSelect,
    });
    return NextResponse.json({ grant, changed: false });
  }

  // Step 4 — grant write + audit row in ONE transaction. Re-grant semantics:
  // a revoked row is REINSTATED (status→ACTIVE, level set, grantedBy/At
  // refreshed, revoked* cleared) rather than re-created — one row per (user,
  // area), forever, fully attributable.
  const [grant] = await db.$transaction([
    db.platformGrant.upsert({
      where:  { userId_area: { userId, area: areaVal } },
      create: {
        userId,
        area:        areaVal,
        level:       levelVal,
        status:      "ACTIVE",
        grantedById: admin.id,
      },
      update: {
        level:       levelVal,
        status:      "ACTIVE",
        grantedById: admin.id,
        grantedAt:   new Date(),
        revokedAt:   null,
        revokedById: null,
      },
      select: grantSelect,
    }),
    db.auditLog.create({
      data: {
        userId,
        action,
        performedByAdminId: admin.id,
        metadata,
        ipAddress: getClientIp(req),
      },
    }),
  ]);

  return NextResponse.json({ grant, changed: true }, { status: 200 });
}

// Grant shape returned to the admin UI after a mutation.
const grantSelect = {
  id:        true,
  area:      true,
  level:     true,
  status:    true,
  grantedAt: true,
  revokedAt: true,
  user:      { select: { ...identitySelect, email: true } },
  grantedBy: { select: identitySelect },
  revokedBy: { select: identitySelect },
} satisfies Prisma.PlatformGrantSelect;
