/**
 * PUT /api/platform/growth-revenue/registration-mode  (PO-3B · B1-A)
 *
 * The operator control for the beta switch: set registration_mode to
 * open | invite_only | closed. This is the SAME PlatformSetting the register
 * route reads — no second mode store; it moves the WRITE into the operating area
 * (Growth & Revenue) alongside the queue, gated by the platform axis.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE") — the
 * fresh (live-revocation-checked) variant every platform mutation uses. A READ
 * operator gets 403 here; a SYSTEM_ADMIN keeps its break-glass bypass.
 *
 * AUDIT: BETA_MODE_CHANGED with performedByAdminId + { previous, new } — so the
 * change appears in the Security Ops operator-action feed. A no-op change (new
 * === previous) still records honestly.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { AuditAction } from "@/lib/audit-actions";
import {
  getRegistrationMode,
  setSetting,
  PlatformSettingKey,
  REGISTRATION_MODES,
  type RegistrationMode,
} from "@/lib/platform-settings";

export const runtime = "nodejs";

function isRegistrationMode(v: unknown): v is RegistrationMode {
  return typeof v === "string" && (REGISTRATION_MODES as readonly string[]).includes(v);
}

export async function PUT(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;

  const body = await req.json().catch(() => ({}));
  const next = (body as { mode?: unknown }).mode;
  if (!isRegistrationMode(next)) {
    return NextResponse.json(
      { error: `mode must be one of: ${REGISTRATION_MODES.join(", ")}.` },
      { status: 400 },
    );
  }

  const previous = await getRegistrationMode();
  await setSetting(PlatformSettingKey.REGISTRATION_MODE, next, auth.user.id);

  await db.auditLog.create({
    data: {
      userId:             auth.user.id,
      performedByAdminId: auth.user.id,
      action:             AuditAction.BETA_MODE_CHANGED,
      metadata:           { previous, new: next },
    },
  });

  return NextResponse.json({ success: true, previous, mode: next });
}
