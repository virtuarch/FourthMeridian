/**
 * lib/platform-settings.ts
 *
 * Keys, descriptors and helpers for PlatformSetting.
 * All reads/writes go through these helpers to avoid typos — and, since
 * PLATFORM OPS POLICIES (Slice 1), every application WRITE is validated here
 * against the key's descriptor. A route cannot bypass validation by knowing the
 * key string: `setSetting` is the canonical setter and it refuses what the
 * descriptor refuses.
 *
 * ⚠️ THE DESCRIPTOR TABLE LIVES HERE, NOT IN A SEPARATE MODULE, because the
 * admission boundary (lib/platform/admission/admission-boundary.test.ts) pins
 * that the two control-plane keys appear only in this registry and the fact
 * adapter. The SHAPE and the validation engine are pure and live in
 * lib/platform/settings/descriptor.core.ts.
 */

import { db } from "@/lib/db";
import {
  DEFAULT_REFRESH_CADENCE, REFRESH_CADENCES, REFRESH_CADENCE_SETTING_KEY,
  type RefreshCadence, type RefreshSourceKind,
} from "@/lib/platform/refresh-policy.core";
import { cadenceIsHonourable } from "@/lib/platform/scheduler-capability";
import {
  PlatformSettingValidationError, descriptorsForSurface, validateSettingValue,
  type SettingDescriptor, type SettingValidation, type SettingWriteSurface,
} from "@/lib/platform/settings/descriptor.core";

export { PlatformSettingValidationError } from "@/lib/platform/settings/descriptor.core";
export type { SettingDescriptor, SettingValidation, SettingWriteSurface, PolicyClass } from "@/lib/platform/settings/descriptor.core";

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
  // PO-3C — the LAUNCH dimension, deliberately SEPARATE from registration_mode:
  // "how mature is the product" (development/beta/live) is a different axis from
  // "who may sign up" (open/invite_only/closed). Presentation/framing only — it
  // gates no behavior by itself; registration_mode remains the only signup gate.
  PRODUCT_STATUS:            "product_status",
  // OPS-2D-3 — the first CONTROL-PLANE facts: operator declarations about
  // whether operational work may begin, as opposed to every key above, which
  // configures how the product behaves for customers. Read only through
  // lib/platform/admission; no route reads them directly.
  //
  // Two keys, not one, because they answer different questions and an operator
  // needs to be able to say either without saying the other: "the platform is
  // under maintenance" is broader than "stop calling providers", and pausing
  // ingestion during a provider incident should not imply the product is down.
  //
  // Both ship absent, and absence means off — see policy-core.ts for why that
  // exception is bounded to never-configured and not extended to unreadable.
  MAINTENANCE_MODE:          "maintenance_mode",
  INGESTION_PAUSED:          "ingestion_paused",
  // Expected refresh cadence per source kind — policy that source health judges
  // "overdue" against. Read only through lib/platform/refresh-policy.ts; the
  // enum, grace and defaults live in refresh-policy.core.ts.
  REFRESH_CADENCE_BANK:      REFRESH_CADENCE_SETTING_KEY.BANK,
  REFRESH_CADENCE_WALLET:    REFRESH_CADENCE_SETTING_KEY.WALLET,
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

/**
 * Product maturity (product_status setting) — the LAUNCH axis, orthogonal to
 * registration_mode. It frames the platform ("we're in beta") without gating
 * signup ("who may register"). A team can be `beta` + `open` (public beta) or
 * `live` + `invite_only` (soft launch); the two never collapse into one control.
 */
export const PRODUCT_STATUSES = ["development", "beta", "live"] as const;
export type ProductStatus = typeof PRODUCT_STATUSES[number];

/** Defaults if the row doesn't exist yet (migration seeds these, but be safe). */
const DEFAULTS: Record<PlatformSettingKeyType, string> = {
  require_totp_system_admin: "false",
  require_totp_admins:       "false",
  require_totp_all_users:    "false",
  recovery_codes_enabled:    "true",
  min_password_length:       "8",
  // Ships `open` so nothing changes until an admin flips it (S3 ship checklist).
  registration_mode:         "open",
  // Ships `beta` — honest current maturity; changed only when the operator flips it.
  product_status:            "beta",
  // OPS-2D-3 — both ship OFF. Nothing about existing behaviour changes until an
  // operator declares otherwise. Note these defaults are documentation of the
  // contract, not the admission path's fallback: the admission resolver reads
  // the row itself so it can tell MISSING from INVALID, which getSetting()'s
  // `?? DEFAULTS[key]` deliberately collapses.
  maintenance_mode:          "false",
  ingestion_paused:          "false",
  refresh_cadence_bank:      DEFAULT_REFRESH_CADENCE.BANK,
  refresh_cadence_wallet:    DEFAULT_REFRESH_CADENCE.WALLET,
};

// ── Descriptors — one per key; the shape is descriptor.core.ts ────────────────

type Descriptor = SettingDescriptor<PlatformSettingKeyType>;

const security = (
  key: PlatformSettingKeyType, label: string, description: string,
  over: Partial<Descriptor> = {},
): Descriptor => ({
  key, label, description,
  class: "SECURITY_SENSITIVE", valueType: "boolean", default: DEFAULTS[key],
  missingRow: "FALLBACK_TO_DEFAULT",
  writeSurfaces: ["ADMIN_SECURITY"], writeCapability: "SYSTEM_ADMIN",
  operatorConfigurable: false, resettable: false,
  ...over,
});

const refreshCadence = (sourceKind: RefreshSourceKind, label: string, description: string): Descriptor => ({
  key: REFRESH_CADENCE_SETTING_KEY[sourceKind], label, description,
  class: "OPERATOR_CONFIGURABLE", valueType: "enum", allowedValues: REFRESH_CADENCES,
  default: DEFAULT_REFRESH_CADENCE[sourceKind], missingRow: "FALLBACK_TO_DEFAULT",
  // Intended gate: control-plane-policy (lib/platform/capability-classification.ts).
  // No application writer exists until that capability is issuable.
  writeSurfaces: ["PLATFORM_OPS"], writeCapability: "CONTROL",
  operatorConfigurable: true, resettable: true,
  // The scheduler-honourability rule, from the ONE derived authority. A cadence
  // the deployed slots cannot deliver is refused at the setter, never stored and
  // degraded — see refresh-policy.core.ts assessCadence.
  constraint: (v) => {
    const a = cadenceIsHonourable(sourceKind, v as RefreshCadence);
    return a.honourable ? null : a.reason;
  },
});

const admissionFact = (key: PlatformSettingKeyType, label: string, description: string): Descriptor => ({
  key, label, description,
  class: "OPERATOR_CONFIGURABLE", valueType: "boolean", default: DEFAULTS[key],
  // Absence is OFF by contract (policy-core.ts); an explicit "false" row is
  // equivalent, and reset = delete returns to the never-configured state.
  missingRow: "ABSENT_MEANS_OFF",
  writeSurfaces: ["PLATFORM_OPS"], writeCapability: "CONTROL",
  operatorConfigurable: true, resettable: true,
});

/**
 * THE descriptor table. Exhaustive by type: a new key without a descriptor is a
 * compile error, so nothing can be written that was never described.
 */
export const SETTING_DESCRIPTORS: Readonly<Record<PlatformSettingKeyType, Descriptor>> = {
  require_totp_system_admin: security(
    "require_totp_system_admin", "Require 2FA for system administrators",
    "Locked on. A SYSTEM_ADMIN session always requires TOTP.",
    { constraint: (v) => (v === "true" ? null : "require_totp_system_admin cannot be disabled. SYSTEM_ADMIN accounts must always use 2FA.") },
  ),
  require_totp_admins: security(
    "require_totp_admins", "Require 2FA for Space admins", "Any ADMIN Space role must have 2FA enabled.",
  ),
  require_totp_all_users: security(
    "require_totp_all_users", "Require 2FA for all users", "All users must set up 2FA before accessing the dashboard.",
  ),
  recovery_codes_enabled: security(
    "recovery_codes_enabled", "Recovery codes enabled", "Users can generate one-time backup codes as a 2FA fallback.",
  ),
  min_password_length: security(
    "min_password_length", "Minimum password length", "Enforced at registration and every password change. Never below 8.",
    { valueType: "integer", min: 8 },
  ),
  registration_mode: security(
    "registration_mode", "Registration mode", "Who may sign up: open, invite_only or closed.",
    { valueType: "enum", allowedValues: REGISTRATION_MODES, writeSurfaces: ["ADMIN_SECURITY", "GROWTH_REVENUE"], writeCapability: "WRITE" },
  ),
  product_status: {
    key: "product_status", label: "Product status", description: "Launch maturity shown to customers: development, beta or live. Gates nothing.",
    class: "OPERATOR_CONFIGURABLE", valueType: "enum", allowedValues: PRODUCT_STATUSES,
    default: DEFAULTS.product_status, missingRow: "FALLBACK_TO_DEFAULT",
    writeSurfaces: ["GROWTH_REVENUE"], writeCapability: "WRITE",
    operatorConfigurable: true, resettable: false,
  },
  maintenance_mode: admissionFact(
    "maintenance_mode", "Maintenance mode",
    "While on, no refresh execution and no new connection may begin. An unreadable value also denies work.",
  ),
  ingestion_paused: admissionFact(
    "ingestion_paused", "Ingestion paused",
    "While on, no refresh execution may begin; connections may still be established.",
  ),
  refresh_cadence_bank: refreshCadence(
    "BANK", "Bank refresh cadence",
    "How often every bank connection is expected to refresh. Source health judges a bank overdue past this cadence plus grace.",
  ),
  refresh_cadence_wallet: refreshCadence(
    "WALLET", "Wallet refresh cadence",
    "How often every wallet is expected to refresh. The scheduled sweep attempts a wallet once it is due under this cadence.",
  ),
};

export function listSettingDescriptors(): Descriptor[] {
  return Object.values(SETTING_DESCRIPTORS);
}

export function getSettingDescriptor(key: PlatformSettingKeyType): Descriptor {
  return SETTING_DESCRIPTORS[key];
}

/** The keys a given surface may write — derived from the descriptors, never listed twice. */
export function settingKeysForSurface(surface: SettingWriteSurface): PlatformSettingKeyType[] {
  return descriptorsForSurface(listSettingDescriptors(), surface).map((d) => d.key);
}

/** True for a registered key (the typed API requires registration). */
export function isPlatformSettingKey(key: unknown): key is PlatformSettingKeyType {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(SETTING_DESCRIPTORS, key);
}

/** Validate without writing — the same rule the setter applies. */
export function validateSetting(key: PlatformSettingKeyType, raw: unknown): SettingValidation {
  return validateSettingValue(SETTING_DESCRIPTORS[key], raw);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

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

/** The current product maturity (PO-3C). Falls back to `beta` for an unset or
 *  unrecognized value — the honest current stage, never a silent "live". */
export async function getProductStatus(): Promise<ProductStatus> {
  const raw = await getSetting(PlatformSettingKey.PRODUCT_STATUS);
  return (PRODUCT_STATUSES as readonly string[]).includes(raw)
    ? (raw as ProductStatus)
    : "beta";
}

// ── Writes — the canonical, validated seam ────────────────────────────────────

/**
 * Write a setting value. THE ONLY application write path for PlatformSetting.
 * Validates against the key's descriptor first and throws
 * PlatformSettingValidationError on refusal — before any database call — so a
 * malformed admission flag or an unhonourable cadence can never be stored by a
 * route that merely knows the key string. The stored value is the NORMALISED
 * form ("true", "12h"), never the caller's raw text.
 */
export async function setSetting(
  key: PlatformSettingKeyType,
  value: string,
  updatedById?: string,
): Promise<void> {
  const v = validateSetting(key, value);
  if (!v.ok) throw new PlatformSettingValidationError(key, value, v.reason);
  await db.platformSetting.upsert({
    where:  { key },
    update: { value: v.value, updatedById: updatedById ?? null },
    create: { key, value: v.value, updatedById: updatedById ?? null },
  });
}

/**
 * Reset a setting to its default by DELETING the override row — never by
 * writing the default value, so `origin` stays DEFAULT and a later change to
 * the code default propagates. Only `resettable` descriptors allow it. Returns
 * true when a row was removed. No route calls this yet: it is the seam the
 * future policy editor's reset lands on.
 */
export async function deleteSetting(key: PlatformSettingKeyType): Promise<boolean> {
  const d = SETTING_DESCRIPTORS[key];
  if (!d.resettable) throw new PlatformSettingValidationError(key, "", `${key} has no default to reset to; it must be set explicitly.`);
  const { count } = await db.platformSetting.deleteMany({ where: { key } });
  return count > 0;
}
