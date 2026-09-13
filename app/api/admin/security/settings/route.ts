/**
 * GET  /api/admin/security/settings  — read all platform settings
 * PATCH /api/admin/security/settings  — update one or more SECURITY settings
 *
 * Body for PATCH: { key: string, value: string }[]
 *
 * PLATFORM OPS POLICIES (Slice 1) — THE BOUNDARY. This route may write only the
 * keys whose descriptor names ADMIN_SECURITY as a write surface
 * (lib/platform-settings.ts SETTING_DESCRIPTORS). It used to accept every
 * registered key and validate two of them, which made a security console the
 * unvalidated writer of operational policy: a malformed `maintenance_mode`
 * written here would have denied all refresh work platform-wide, and a wallet
 * cadence below what the scheduler attempts would have declared every wallet
 * overdue. Operational policy belongs to Platform Ops and is written only
 * through the canonical validated setter, when a write path exists there.
 *
 * Every write here goes through `setSetting`, which validates against the
 * descriptor; the whole batch is validated BEFORE the first write so a rejected
 * entry never leaves a half-applied batch behind.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getAllSettings, setSetting, settingKeysForSurface, validateSetting,
  PlatformSettingKey, type PlatformSettingKeyType,
} from "@/lib/platform-settings";
import { db } from "@/lib/db";
import { requireSystemAdmin, requireFreshSystemAdmin } from "@/lib/session";

/** Derived from the descriptors — the security console never lists keys itself. */
const ALLOWED_KEYS = new Set<string>(settingKeysForSurface("ADMIN_SECURITY"));

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

  // Validate the whole batch first; write nothing until every entry passes.
  const changes: { key: PlatformSettingKeyType; value: string }[] = [];
  for (const { key, value } of body) {
    if (!ALLOWED_KEYS.has(key)) {
      return NextResponse.json({ error: `Setting "${key}" is not editable from the security console.` }, { status: 400 });
    }
    const typedKey = key as PlatformSettingKeyType;
    // require_totp_system_admin is permanently locked — cannot be disabled via API.
    // The descriptor refuses it too; this keeps the historical 403 shape.
    if (typedKey === PlatformSettingKey.REQUIRE_TOTP_SYSTEM_ADMIN && String(value) !== "true") {
      return NextResponse.json(
        { error: "require_totp_system_admin cannot be disabled. SYSTEM_ADMIN accounts must always use 2FA." },
        { status: 403 },
      );
    }
    const v = validateSetting(typedKey, String(value));
    if (!v.ok) return NextResponse.json({ error: `${key}: ${v.reason}` }, { status: 400 });
    changes.push({ key: typedKey, value: v.value });
  }

  const before = await getAllSettings();
  for (const { key, value } of changes) {
    await setSetting(key, value, admin.id);
  }

  // Audit log the settings change — with what each key held before, so the
  // row says what CHANGED and not only what was sent.
  await db.auditLog.create({
    data: {
      userId: admin.id,
      action: "PLATFORM_SETTINGS_UPDATED",
      metadata: { changes: changes.map((c) => ({ key: c.key, previous: before[c.key] ?? null, value: c.value })) },
    },
  });

  const settings = await getAllSettings();
  return NextResponse.json({ settings });
}
