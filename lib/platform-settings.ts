/**
 * lib/platform-settings.ts
 *
 * Keys and helpers for PlatformSetting.
 * All reads/writes go through these helpers to avoid typos.
 */

import { db } from "@/lib/db";

export const PlatformSettingKey = {
  REQUIRE_TOTP_SYSTEM_ADMIN: "require_totp_system_admin",
  REQUIRE_TOTP_ADMINS:       "require_totp_admins",
  REQUIRE_TOTP_ALL_USERS:    "require_totp_all_users",
  RECOVERY_CODES_ENABLED:    "recovery_codes_enabled",
  MIN_PASSWORD_LENGTH:       "min_password_length",
  // Wave 1 S2 — platform-wide registration gate, read at the top of the register
  // route. One key, three values (below): two booleans would admit a
  // contradictory fourth state (closed-but-invite-required).
  REGISTRATION_MODE:         "registration_mode",
} as const;

export type PlatformSettingKeyType = typeof PlatformSettingKey[keyof typeof PlatformSettingKey];

/**
 * The three registration modes (registration_mode setting):
 *   open        — anyone may register (current behavior; the ship default).
 *   invite_only — registration requires a valid beta-access invite token (S3).
 *   closed      — registration is disabled entirely (403 before any validation).
 */
export const REGISTRATION_MODES = ["open", "invite_only", "closed"] as const;
export type RegistrationMode = typeof REGISTRATION_MODES[number];

/** Defaults if the row doesn't exist yet (migration seeds these, but be safe). */
const DEFAULTS: Record<PlatformSettingKeyType, string> = {
  require_totp_system_admin: "false",
  require_totp_admins:       "false",
  require_totp_all_users:    "false",
  recovery_codes_enabled:    "true",
  min_password_length:       "8",
  // Ships `open` so nothing changes until an admin flips it (S3 ship checklist).
  registration_mode:         "open",
};

/** Read all platform settings as a key→value map. */
export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await db.platformSetting.findMany();
  const map: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) map[row.key] = row.value;
  return map;
}

/** Read a single setting value (falls back to default). */
export async function getSetting(key: PlatformSettingKeyType): Promise<string> {
  const row = await db.platformSetting.findUnique({ where: { key } });
  return row?.value ?? DEFAULTS[key];
}

/**
 * The admin-configurable minimum password length, as an integer (SEC-4).
 *
 * Single source of truth for password-length enforcement: registration and
 * every password-set/change path read THIS instead of a hardcoded literal, so
 * the admin policy (min_password_length PlatformSetting) and actual enforcement
 * can never silently diverge. Floored at 8 (the historical minimum and the
 * admin UI's own lower bound) so a malformed/blank row can never weaken the
 * policy below the baseline. Defaults to 8 when unset or non-numeric.
 */
export async function getMinPasswordLength(): Promise<number> {
  const raw = await getSetting(PlatformSettingKey.MIN_PASSWORD_LENGTH);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(8, n) : 8;
}

/**
 * The current platform registration mode (Wave 1 S2). Falls back to `open` for
 * an unset row or any unrecognized value, so a malformed row can never silently
 * lock users out of registration — the same defensive-floor posture as
 * getMinPasswordLength above.
 */
export async function getRegistrationMode(): Promise<RegistrationMode> {
  const raw = await getSetting(PlatformSettingKey.REGISTRATION_MODE);
  return (REGISTRATION_MODES as readonly string[]).includes(raw)
    ? (raw as RegistrationMode)
    : "open";
}

/** Write a setting value. */
export async function setSetting(
  key: PlatformSettingKeyType,
  value: string,
  updatedById?: string,
): Promise<void> {
  await db.platformSetting.upsert({
    where:  { key },
    update: { value, updatedById: updatedById ?? null },
    create: { key, value, updatedById: updatedById ?? null },
  });
}
