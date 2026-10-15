/**
 * lib/platform/ai/cost-controls-core.ts  (AI COST CONTROLS — the pure half)
 *
 * HOW A STORED ROW BECOMES A CONTROL VALUE, with no I/O. The loader
 * (cost-controls.ts) and the budget reader (ai-budget.ts) both resolve the
 * seven controls through these functions so the Policies panel, the Economics
 * budget and the enforcement paths can never disagree about what is in force.
 *
 * Origin follows the job-cadence idiom (spend-thresholds.ts):
 *   DEFAULT          no row — the code default is in force
 *                    (for the kill switch: ABSENT_MEANS_OFF ⇒ not paused)
 *   SETTING          a valid row — its value is in force
 *   INVALID_SETTING  a row the descriptor refuses — the SAFE value is in force:
 *                    the default for every FALLBACK_TO_DEFAULT key (enforced /
 *                    enabled / the default dollar figure) and PAUSED for the
 *                    kill switch, whose unreadable row denies (policy-core.ts).
 *
 * Validation is the registry's own (validateSetting), so a value the mutation
 * service would refuse is exactly a value this reader reports INVALID_SETTING.
 */

import { SETTING_DESCRIPTORS, isPlatformSettingKey, validateSetting, type PlatformSettingKeyType } from "@/lib/platform-settings";
import {
  AI_COST_CONTROL_DEFAULTS, AI_COST_CONTROL_KEYS, AI_COST_CONTROL_SETTING_KEYS,
  type AiCostControlKey, type AiCostControlValue, type ControlOrigin, type ControlValueView,
} from "./cost-controls.types";

export interface ControlRowFacts {
  value: string;
  updatedAt: Date;
  updatedById?: string | null;
}

/** The registered setting key behind a control (typed; the types file holds strings). */
export function settingKeyOf(control: AiCostControlKey): PlatformSettingKeyType {
  const key = AI_COST_CONTROL_SETTING_KEYS[control];
  if (!isPlatformSettingKey(key)) throw new Error(`[cost-controls] ${key} is not a registered PlatformSetting key`);
  return key;
}

export function isBooleanControl(control: AiCostControlKey): boolean {
  return typeof AI_COST_CONTROL_DEFAULTS[control] === "boolean";
}

/** The stored string a desired value becomes — booleans as "true"/"false", integers as digits. */
export function storedValueOf(control: AiCostControlKey, value: boolean | number): string {
  return isBooleanControl(control) ? String(Boolean(value)) : String(value);
}

/** The typed value a VALID stored string holds. */
function typedValue<K extends AiCostControlKey>(control: K, stored: string): AiCostControlValue<K> {
  return (isBooleanControl(control) ? stored === "true" : Number.parseInt(stored, 10)) as AiCostControlValue<K>;
}

/** The value in force when a row is INVALID: the default, except the kill switch, which denies. */
function safeValue<K extends AiCostControlKey>(control: K): AiCostControlValue<K> {
  if (control === "killSwitch.paused") return true as AiCostControlValue<K>;
  return AI_COST_CONTROL_DEFAULTS[control] as AiCostControlValue<K>;
}

/** PURE — one control's effective view from its stored row (null = no row) and the writer's display name. */
export function resolveControlValue<K extends AiCostControlKey>(
  control: K,
  row: ControlRowFacts | null,
  updatedByName: string | null = null,
): ControlValueView<AiCostControlValue<K>> {
  const key = settingKeyOf(control);
  const d = SETTING_DESCRIPTORS[key];
  const defaultValue = AI_COST_CONTROL_DEFAULTS[control] as AiCostControlValue<K>;
  const bounds = d.valueType === "integer" ? { min: d.min ?? 0, max: d.max ?? Number.MAX_SAFE_INTEGER } : null;
  const base = { control, settingKey: key, label: d.label, description: d.description, defaultValue, bounds };
  if (!row) return { ...base, value: defaultValue, origin: "DEFAULT" as ControlOrigin, updatedAt: null, updatedByName: null };
  const v = validateSetting(key, row.value);
  if (!v.ok) {
    return { ...base, value: safeValue(control), origin: "INVALID_SETTING", updatedAt: row.updatedAt.toISOString(), updatedByName };
  }
  return { ...base, value: typedValue(control, v.value), origin: "SETTING", updatedAt: row.updatedAt.toISOString(), updatedByName };
}

export type ResolvedControls = { [K in AiCostControlKey]: ControlValueView<AiCostControlValue<K>> };

/** PURE — every control from a key → row map (the loader's one findMany). */
export function resolveControls(
  rows: ReadonlyMap<string, ControlRowFacts>,
  names: ReadonlyMap<string, string | null> = new Map(),
): ResolvedControls {
  const out = {} as ResolvedControls;
  for (const control of AI_COST_CONTROL_KEYS) {
    const row = rows.get(AI_COST_CONTROL_SETTING_KEYS[control]) ?? null;
    const name = row?.updatedById ? names.get(row.updatedById) ?? null : null;
    (out as Record<AiCostControlKey, unknown>)[control] = resolveControlValue(control, row, name);
  }
  return out;
}

/** The setting keys the loader reads — derived from the contract, never listed twice. */
export const AI_COST_CONTROL_SETTING_KEY_LIST: readonly string[] = AI_COST_CONTROL_KEYS.map((c) => AI_COST_CONTROL_SETTING_KEYS[c]);

// ── Change validation (pure) ─────────────────────────────────────────────────

export type ValidatedChange =
  | { control: AiCostControlKey; key: PlatformSettingKeyType; kind: "SET"; stored: string; expectedUpdatedAt: string | null }
  | { control: AiCostControlKey; key: PlatformSettingKeyType; kind: "RESET"; expectedUpdatedAt: string | null };

export type ChangeValidation =
  | { ok: true; changes: ValidatedChange[] }
  | { ok: false; reason: string; control?: AiCostControlKey };

/**
 * PURE — validate the whole batch BEFORE any transaction: known controls, no
 * duplicates, the value's TYPE matches the control (a boolean control takes a
 * boolean, an integer control a whole number — a string "5" is refused, so a
 * client cannot smuggle text past the descriptor), then the descriptor's own
 * rule. `null` is a reset.
 */
export function validateControlChanges(raw: unknown): ChangeValidation {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: "changes must be a non-empty array." };
  if (raw.length > AI_COST_CONTROL_KEYS.length) return { ok: false, reason: `At most ${AI_COST_CONTROL_KEYS.length} changes per request (one per control).` };
  const seen = new Set<string>();
  const out: ValidatedChange[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return { ok: false, reason: "Each change must be an object { control, value, expectedUpdatedAt }." };
    const { control, value, expectedUpdatedAt } = item as { control?: unknown; value?: unknown; expectedUpdatedAt?: unknown };
    if (typeof control !== "string" || !(AI_COST_CONTROL_KEYS as readonly string[]).includes(control)) {
      return { ok: false, reason: `Unknown control ${JSON.stringify(control)}.` };
    }
    const c = control as AiCostControlKey;
    if (seen.has(c)) return { ok: false, reason: `Control ${c} appears more than once.`, control: c };
    seen.add(c);
    if (expectedUpdatedAt !== null && typeof expectedUpdatedAt !== "string") {
      return { ok: false, reason: "expectedUpdatedAt must be the observed row version (ISO) or null.", control: c };
    }
    if (typeof expectedUpdatedAt === "string" && !Number.isFinite(Date.parse(expectedUpdatedAt))) {
      return { ok: false, reason: "expectedUpdatedAt is not a valid instant.", control: c };
    }
    const key = settingKeyOf(c);
    if (value === null) { out.push({ control: c, key, kind: "RESET", expectedUpdatedAt }); continue; }
    if (isBooleanControl(c)) {
      if (typeof value !== "boolean") return { ok: false, reason: `${c} takes true or false.`, control: c };
    } else if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
      return { ok: false, reason: `${c} takes a whole number of dollars.`, control: c };
    }
    const v = validateSetting(key, storedValueOf(c, value as boolean | number));
    if (!v.ok) return { ok: false, reason: `${c}: ${v.reason}`, control: c };
    out.push({ control: c, key, kind: "SET", stored: v.value, expectedUpdatedAt });
  }
  return { ok: true, changes: out };
}
