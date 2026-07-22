/**
 * GET  /api/admin/security/settings  — read all platform settings
 * PATCH /api/admin/security/settings  — update one or more settings
 *
 * Body for PATCH: { key: string, value: string }[]
 */

import { NextRequest, NextResponse } from "next/server";
import { getAllSettings, setSetting, PlatformSettingKey, REGISTRATION_MODES } from "@/lib/platform-settings";
import { db } from "@/lib/db";
import { requireSystemAdmin, requireFreshSystemAdmin } from "@/lib/session";

const ALLOWED_KEYS = new Set(Object.values(PlatformSettingKey));

export async function GET() {
  const [, err] = await requireSystemAdmin();
  if (err) return err;

  const settings = await getAllSettings();
  return NextResponse.json({ settings });
}

export async function PATCH(req: NextRequest) {
  // SEC-2 — mutates PLATFORM-WIDE security posture (TOTP requirements, the
  // min-password-length policy). Always a live revocation check, never the
  // cache; the GET above stays on the cached variant (read-only).
  const [admin, err] = await requireFreshSystemAdmin();
  if (err) return err;

  const body = await req.json() as { key: string; value: string }[];
  if (!Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be an array of {key, value}" }, { status: 400 });
  }

  for (const { key, value } of body) {
    if (!ALLOWED_KEYS.has(key as never)) {
      return NextResponse.json({ error: `Unknown setting key: ${key}` }, { status: 400 });
    }
    // require_totp_system_admin is permanently locked — cannot be disabled via API
    if (key === "require_totp_system_admin" && value !== "true") {
      return NextResponse.json(
        { error: "require_totp_system_admin cannot be disabled. SYSTEM_ADMIN accounts must always use 2FA." },
        { status: 403 },
      );
    }
    // registration_mode is a closed enum — reject anything outside it so a typo
    // can't write a value the register route won't recognize (it would fall back
    // to `open`, but rejecting here keeps the stored state honest).
    if (key === PlatformSettingKey.REGISTRATION_MODE && !(REGISTRATION_MODES as readonly string[]).includes(String(value))) {
      return NextResponse.json(
        { error: `registration_mode must be one of: ${REGISTRATION_MODES.join(", ")}.` },
        { status: 400 },
      );
    }
    await setSetting(key as never, String(value), admin.id);
  }

  // Audit log the settings change
  await db.auditLog.create({
    data: {
      userId: admin.id,
      action: "PLATFORM_SETTINGS_UPDATED",
      metadata: { changes: body },
    },
  });

  const settings = await getAllSettings();
  return NextResponse.json({ settings });
}
