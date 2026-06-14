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
} as const;

export type PlatformSettingKeyType = typeof PlatformSettingKey[keyof typeof PlatformSettingKey];

/** Defaults if the row doesn't exist yet (migration seeds these, but be safe). */
const DEFAULTS: Record<PlatformSettingKeyType, string> = {
  require_totp_system_admin: "false",
  require_totp_admins:       "false",
  require_totp_all_users:    "false",
  recovery_codes_enabled:    "true",
  min_password_length:       "8",
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
