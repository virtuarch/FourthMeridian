/**
 * lib/platform/settings/descriptor.core.ts  (PLATFORM OPS POLICIES — Slice 1)
 *
 * WHAT A PLATFORM SETTING IS — the typed description every read and write path
 * consumes, so no route, widget or script can invent whether a key is editable,
 * what it may hold, or what its absence means.
 *
 * THIS IS A DESCRIPTOR MODEL, NOT A CONFIGURATION FRAMEWORK. It describes the
 * eleven PlatformSetting keys that exist. The per-key table lives beside the key
 * registry in lib/platform-settings.ts (the admission boundary test requires the
 * control-plane keys to appear only there); this module owns the SHAPE and the
 * one validation engine over it. Pure: no Prisma, no I/O.
 *
 * CLASSIFICATION IS ON THE DESCRIPTOR. The taxonomy from the control-plane
 * investigation decides which keys can ever become Platform Ops controls:
 * SECURITY_SENSITIVE and FINANCIAL_SEMANTIC_NOT_EDITABLE keys carry no
 * PLATFORM_OPS write surface by construction, and a test pins that.
 *
 * RESET IS DELETE. `resettable` keys return to their default by REMOVING the
 * override row, never by writing the default value — so origin stays honest
 * (DEFAULT vs SETTING), a future default change propagates, and provenance is
 * not overwritten with a fact that was never configured.
 */

// ── Taxonomy ──────────────────────────────────────────────────────────────────

/** The policy classes from the investigation. Only some may appear on a PlatformSetting. */
export type PolicyClass =
  | "OPERATOR_CONFIGURABLE"
  | "OPERATOR_VISIBLE_CODE_CONTROLLED"
  | "DERIVED"
  | "PROVIDER_FACT"
  | "DEPLOYMENT_CAPABILITY"
  | "SECURITY_SENSITIVE"
  | "FINANCIAL_SEMANTIC_NOT_EDITABLE";

/** Where an application write for the key may originate. */
export type SettingWriteSurface = "ADMIN_SECURITY" | "GROWTH_REVENUE" | "PLATFORM_OPS";

/**
 * The authority a writer must hold. SYSTEM_ADMIN is the Emergency axis (a role),
 * WRITE and CONTROL are platform-grant levels. CONTROL is recorded here as the
 * INTENDED gate for operational policy; it is not yet issuable, so those keys
 * have no application writer today (lib/platform/policy.ts ISSUABLE_LEVELS).
 */
export type SettingWriteCapability = "SYSTEM_ADMIN" | "WRITE" | "CONTROL";

export type SettingValueType = "boolean" | "integer" | "enum";

/** What a missing row means for this key. */
export type MissingRowSemantics =
  /** Readers substitute `default`; an explicit row equal to the default is still a row. */
  | "FALLBACK_TO_DEFAULT"
  /** Absence is the OFF state by contract; readers must not substitute anything. */
  | "ABSENT_MEANS_OFF";

export interface SettingDescriptor<K extends string = string> {
  key: K;
  label: string;
  description: string;
  class: PolicyClass;
  valueType: SettingValueType;
  /** Closed value set for `enum` keys (already normalised). */
  allowedValues?: readonly string[];
  /** Lower bound for `integer` keys. */
  min?: number;
  /** The documented default, as stored. */
  default: string;
  missingRow: MissingRowSemantics;
  writeSurfaces: readonly SettingWriteSurface[];
  writeCapability: SettingWriteCapability;
  /** May a Platform Ops operator (with the right capability) change it? */
  operatorConfigurable: boolean;
  /** May the override row be deleted to return to the default? */
  resettable: boolean;
  /**
   * An extra rule over an already type-valid, normalised value — the place a
   * scheduler-honourability check or a security lock lives. Returns the reason
   * to refuse, or null to accept.
   */
  constraint?: (normalised: string) => string | null;
}

// ── Validation ────────────────────────────────────────────────────────────────

export type SettingValidation =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/** Thrown by the canonical setter when a value fails its descriptor. */
export class PlatformSettingValidationError extends Error {
  readonly key: string;
  readonly value: string;
  readonly reason: string;
  constructor(key: string, value: string, reason: string) {
    super(`${key}: ${reason}`);
    this.name = "PlatformSettingValidationError";
    this.key = key;
    this.value = value;
    this.reason = reason;
  }
}

/**
 * Validate a raw string against its descriptor and return the NORMALISED value
 * to store. Booleans are strictly "true" | "false" (the admission parser's
 * contract — "yes", "1", "" are invalid, and an invalid admission fact DENIES
 * work, which is exactly why this must refuse them before they are stored).
 */
export function validateSettingValue(descriptor: SettingDescriptor, raw: unknown): SettingValidation {
  if (typeof raw !== "string") return { ok: false, reason: "Value must be a string." };
  const trimmed = raw.trim();
  let value: string;
  switch (descriptor.valueType) {
    case "boolean": {
      const v = trimmed.toLowerCase();
      if (v !== "true" && v !== "false") return { ok: false, reason: 'Value must be "true" or "false".' };
      value = v;
      break;
    }
    case "integer": {
      if (!/^-?\d+$/.test(trimmed)) return { ok: false, reason: "Value must be a whole number." };
      const n = Number.parseInt(trimmed, 10);
      if (descriptor.min !== undefined && n < descriptor.min) {
        return { ok: false, reason: `Value must be at least ${descriptor.min}.` };
      }
      value = String(n);
      break;
    }
    case "enum": {
      const v = trimmed.toLowerCase();
      const allowed = descriptor.allowedValues ?? [];
      if (!allowed.includes(v)) return { ok: false, reason: `Value must be one of: ${allowed.join(", ")}.` };
      value = v;
      break;
    }
  }
  const refused = descriptor.constraint?.(value) ?? null;
  return refused ? { ok: false, reason: refused } : { ok: true, value };
}

/** Descriptors whose writes may originate from `surface`. */
export function descriptorsForSurface<K extends string>(
  descriptors: readonly SettingDescriptor<K>[],
  surface: SettingWriteSurface,
): SettingDescriptor<K>[] {
  return descriptors.filter((d) => d.writeSurfaces.includes(surface));
}
