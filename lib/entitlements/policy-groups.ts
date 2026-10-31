/**
 * lib/entitlements/policy-groups.ts  (POLICY EDITOR — Phase 2, pure)
 *
 * WHICH POLICY GROUPS EXIST AND WHAT THEY GRANT, WHEN GROUP VALUES MAY LIVE AS
 * DATA. The dimension registry, the ceilings, FAIL_CLOSED_VALUES, OVERLAYS and
 * COHORTS stay code (catalogue.ts). A group's VALUES may come from a versioned
 * row (PolicyGroup + its current PolicyGroupVersion), written only by the
 * audited Platform Operations editor (lib/platform/policies/policy-groups-write.ts).
 *
 * PRECEDENCE OF A GROUP DEFINITION (buildPolicyGroupCatalogue):
 *   1. a PolicyGroup ROW (archived or not) with its current version — the row
 *      WINS over a code group of the same key (the migration seeds
 *      BETA_FULL_ACCESS_V1 with exactly the code values, so day one is unchanged);
 *   2. otherwise a CODE group (POLICY_GROUPS) — back-compat: an environment
 *      without the migration, or a read failure, resolves exactly as before;
 *   3. otherwise the key is UNKNOWN (the resolver's existing unknown path).
 *
 * STRICT AT WRITE, TOLERANT AT READ (review fix 1). Writes validate strictly
 * (validateEntitlementValues). A STORED version is NORMALISED at read
 * (normaliseStoredValues) so a change to the code registry — a new dimension,
 * a lowered ceiling — never fails closed the whole customer base:
 *   · a dimension MISSING from the stored version takes the CODE group's value
 *     for the same key when the group is a code group, else that dimension's
 *     FAIL_CLOSED value (per dimension, not the whole group);
 *   · an over-ceiling count is clamped to the ceiling, a floor below its
 *     minimum is raised to it, a boolean is AND-ed with its ceiling, a negative
 *     count becomes 0, a fractional one is floored;
 *   · unknown extra keys are ignored.
 * Only a STRUCTURALLY unusable version — not an object, or a known dimension
 * of the wrong type / NaN / non-finite, or a missing version row — makes its
 * GROUP INVALID: `values` is null and the resolver FAILS CLOSED for its
 * customers — never "unlimited", never silently Beta.
 *
 * THE DEFAULT GROUP (what registration assigns; what an unassigned customer
 * resolves to while the fail-closed switch is off) is the one non-archived,
 * valid row with isDefault, else the code DEFAULT_POLICY_GROUP.
 *
 * Pure: no I/O, no clock read (the loader stamps `loadedAt`), no database
 * import — reachable from the resolver, the editor UI and tests alike.
 */

import {
  COHORTS, DEFAULT_POLICY_GROUP, DIMENSION_KEYS, ENTITLEMENT_DIMENSIONS, FAIL_CLOSED_VALUES, OVERLAYS, POLICY_GROUPS,
  type EntitlementDimensionKey, type EntitlementValue, type EntitlementValues,
} from "./catalogue";
import type { PolicyGroupEndedTransitionKind, PolicyGroupLifecycleState } from "./lifecycle";

// ── Bounds ────────────────────────────────────────────────────────────────────

/**
 * The longest a "minutes-floor" dimension may be set to by the editor: 7 days —
 * the same value FAIL_CLOSED_VALUES uses as "no manual refresh". A floor's
 * catalogue `ceiling` is its MINIMUM (the fastest allowed); this is the editor's
 * maximum so a slider has an end. The resolver needs no maximum (a longer floor
 * is only ever more restrictive).
 */
export const FLOOR_MAX_MINUTES = 10_080;

/** The editable range of a numeric dimension: counts are [0, ceiling]; floors are [ceiling, FLOOR_MAX_MINUTES]. */
export function dimensionBounds(key: EntitlementDimensionKey): { min: number; max: number } | null {
  const d = ENTITLEMENT_DIMENSIONS[key];
  if (d.kind === "count") return { min: 0, max: d.ceiling as number };
  if (d.kind === "minutes-floor") return { min: d.ceiling as number, max: FLOOR_MAX_MINUTES };
  return null;
}

// ── Validation ────────────────────────────────────────────────────────────────

export type ValuesValidation = { ok: true; values: EntitlementValues } | { ok: false; errors: string[] };

/**
 * A FULL set of entitlement values, or the reasons it is not one. Every
 * dimension present, the right kind, within its bounds (a boolean may not be
 * true where the ceiling is false); no unknown dimension. Used at WRITE (the
 * editor's input) and at READ (a stored version) — one rule.
 */
export function validateEntitlementValues(raw: unknown): ValuesValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: ["Values must be an object of every entitlement."] };
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(obj)) {
    if (!(k in ENTITLEMENT_DIMENSIONS)) errors.push(`Unknown entitlement "${k.slice(0, 64)}".`);
  }
  const out: Record<string, EntitlementValue> = {};
  for (const key of DIMENSION_KEYS) {
    const d = ENTITLEMENT_DIMENSIONS[key];
    const v = obj[key];
    if (v === undefined) { errors.push(`${d.label}: missing.`); continue; }
    if (d.kind === "boolean") {
      if (typeof v !== "boolean") { errors.push(`${d.label}: must be on or off.`); continue; }
      if (v && !(d.ceiling as boolean)) { errors.push(`${d.label}: the platform does not allow it on.`); continue; }
      out[key] = v;
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) { errors.push(`${d.label}: must be a whole number.`); continue; }
    const b = dimensionBounds(key)!;
    if (v < b.min || v > b.max) {
      errors.push(d.kind === "minutes-floor"
        ? `${d.label}: must be between ${b.min} (the platform's fastest) and ${b.max} minutes.`
        : `${d.label}: must be between 0 and the platform ceiling of ${b.max}.`);
      continue;
    }
    out[key] = v;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values: out as unknown as EntitlementValues };
}

export type StoredValuesNormalisation =
  | { ok: true; values: EntitlementValues; adjustments: string[] }
  | { ok: false; errors: string[] };

/**
 * READ-TIME normalisation of a stored version (see the header). `codeValues` is
 * the code group's values for the same key (null for a DB-only group). The
 * `adjustments` say, for an operator, what was filled or clamped.
 */
export function normaliseStoredValues(raw: unknown, codeValues: EntitlementValues | null): StoredValuesNormalisation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: ["The stored values are not an object."] };
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  const adjustments: string[] = [];
  const out: Record<string, EntitlementValue> = {};
  for (const key of DIMENSION_KEYS) {
    const d = ENTITLEMENT_DIMENSIONS[key];
    const v = obj[key];
    if (v === undefined) {
      const filled = codeValues ? codeValues[key] : FAIL_CLOSED_VALUES[key];
      out[key] = filled;
      adjustments.push(`${d.label}: not in the stored version — ${codeValues ? "the code group's value" : "the restricted (fail-closed) value"} ${String(filled)} applies.`);
      continue;
    }
    if (d.kind === "boolean") {
      if (typeof v !== "boolean") { errors.push(`${d.label}: stored value is not on/off.`); continue; }
      const b = v && (d.ceiling as boolean);
      if (b !== v) adjustments.push(`${d.label}: stored on, the platform allows off only.`);
      out[key] = b;
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) { errors.push(`${d.label}: stored value is not a number.`); continue; }
    const n = Math.max(0, Math.floor(v));
    const ceiling = d.ceiling as number;
    const c = d.kind === "minutes-floor" ? Math.max(n, ceiling) : Math.min(n, ceiling);
    if (c !== v) adjustments.push(`${d.label}: stored ${v}, ${d.kind === "minutes-floor" ? "raised to the platform minimum" : "clamped to the platform ceiling"} ${c}.`);
    out[key] = c;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values: out as unknown as EntitlementValues, adjustments };
}

/** UPPER_SNAKE, starts with a letter, 3–48 chars. */
export const POLICY_GROUP_KEY_PATTERN = /^[A-Z][A-Z0-9_]{2,47}$/;
export const POLICY_GROUP_LABEL_MAX = 60;
export const POLICY_GROUP_DESCRIPTION_MAX = 280;

/** A new group key, or the reason it is refused. Never a code group, overlay, cohort or the restricted set. */
export function validateNewGroupKey(raw: unknown): { ok: true; key: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !POLICY_GROUP_KEY_PATTERN.test(raw)) {
    return { ok: false, error: "The key must be UPPER_SNAKE_CASE: a letter, then letters, digits or underscores (3–48 characters)." };
  }
  if (raw in POLICY_GROUPS || raw in OVERLAYS || raw in COHORTS || raw.startsWith("FAIL_CLOSED")) {
    return { ok: false, error: `"${raw}" is reserved by the code catalogue.` };
  }
  return { ok: true, key: raw };
}

export function validateGroupLabel(raw: unknown): { ok: true; label: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "A label is required." };
  const label = raw.trim();
  if (label.length < 1 || label.length > POLICY_GROUP_LABEL_MAX) return { ok: false, error: `The label must be 1–${POLICY_GROUP_LABEL_MAX} characters.` };
  return { ok: true, label };
}

export function validateGroupDescription(raw: unknown): { ok: true; description: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, description: "" };
  if (typeof raw !== "string") return { ok: false, error: "The description must be text." };
  const description = raw.trim();
  if (description.length > POLICY_GROUP_DESCRIPTION_MAX) return { ok: false, error: `The description must be at most ${POLICY_GROUP_DESCRIPTION_MAX} characters.` };
  return { ok: true, description };
}

// ── The catalogue ─────────────────────────────────────────────────────────────

export interface CatalogueGroup {
  key: string;
  label: string;
  description: string;
  /** The full values, or null when the stored definition is INVALID (⇒ fail closed). */
  values: EntitlementValues | null;
  valid: boolean;
  /** Why the stored definition is invalid (operator-facing; never customer data). */
  invalidReasons: readonly string[];
  /** What read-time normalisation filled or clamped in a valid stored version (operator-facing). */
  readAdjustments?: readonly string[];
  archived: boolean;
  archivedAt: string | null;
  isDefault: boolean;
  builtIn: boolean;
  /** The current version (null for a code-only group). */
  version: number | null;
  /** DB = a PolicyGroup row; CODE = the code catalogue (no row). */
  source: "DB" | "CODE";
  /** ISO day the current definition took effect. */
  effectiveFrom: string;
  /**
   * BETA LIFECYCLE (L1) — the group's lifecycle state and cost freeze. Absent ⇒
   * ACTIVE and not frozen (a code group, or a catalogue built without lifecycle
   * facts). The billable gate never trusts an absent value: it requires the
   * catalogue's `lifecycleSource` to be "DB" (lib/entitlements/billable-gate-core.ts).
   */
  lifecycle?: PolicyGroupLifecycleState;
  costFrozen?: boolean;
  endedTransition?: PolicyGroupEndedTransitionKind | null;
  /** The lifecycle optimistic token (bumped by every transition). */
  lifecycleVersion?: number;
}

export interface PolicyGroupCatalogue {
  /** DB = read from the tables; CODE = the code catalogue by construction; CODE_FALLBACK = the read failed. */
  source: "DB" | "CODE" | "CODE_FALLBACK";
  groups: Readonly<Record<string, CatalogueGroup>>;
  /** The DEFAULT group key (registration, reconciliation, the unassigned fallback). */
  defaultKey: string;
  loadedAt: string | null;
  /**
   * BETA LIFECYCLE (L1) — where the per-group lifecycle / cost-freeze facts came
   * from: DB = read with this catalogue; CODE = the code catalogue by
   * construction (every group ACTIVE); UNAVAILABLE = the lifecycle read failed
   * (values still resolve; the billable gate FAILS CLOSED). Absent ⇒ CODE.
   */
  lifecycleSource?: "DB" | "CODE" | "UNAVAILABLE";
  /**
   * True when the cached loader served this catalogue as the LAST GOOD read
   * after a failed read. Entitlement VALUES may use it (≤ 5 min); billable
   * decisions never do (lib/entitlements/billable-gate-core.ts).
   */
  servedFromLastGood?: boolean;
  /** L2 — true when the GLOBAL cost freeze (platform_cost_frozen) was folded in (or its read failed). */
  globalCostFrozen?: boolean;
}

function codeGroup(key: string, isDefault: boolean): CatalogueGroup {
  const g = POLICY_GROUPS[key];
  return {
    key: g.key, label: g.label, description: g.description, values: g.values, valid: true, invalidReasons: [],
    archived: false, archivedAt: null, isDefault, builtIn: true, version: null, source: "CODE", effectiveFrom: g.effectiveFrom,
  };
}

/** The code catalogue as a PolicyGroupCatalogue — exactly today's resolution. */
export const CODE_CATALOGUE: PolicyGroupCatalogue = Object.freeze({
  source: "CODE" as const,
  groups: Object.freeze(Object.fromEntries(Object.keys(POLICY_GROUPS).map((k) => [k, codeGroup(k, k === DEFAULT_POLICY_GROUP)]))),
  defaultKey: DEFAULT_POLICY_GROUP,
  loadedAt: null,
  lifecycleSource: "CODE" as const,
});

/** The code catalogue, marked as a fallback (the DB read failed or the table is absent). */
export function codeFallbackCatalogue(): PolicyGroupCatalogue {
  // BETA LIFECYCLE — the lifecycle facts are unknown when the read failed: billable fails closed.
  return { ...CODE_CATALOGUE, source: "CODE_FALLBACK", lifecycleSource: "UNAVAILABLE" };
}

/** One PolicyGroup row as the loader selects it. */
export interface PolicyGroupRowFacts {
  key: string;
  label: string;
  description: string;
  isDefault: boolean;
  builtIn: boolean;
  archivedAt: Date | null;
  currentVersion: number;
}

/** BETA LIFECYCLE — one PolicyGroup row's lifecycle columns (a SEPARATE read, so a database
 *  without the lifecycle migration still resolves values; only billable decisions fail closed). */
export interface PolicyGroupLifecycleFacts {
  key: string;
  lifecycle: PolicyGroupLifecycleState;
  costFrozen: boolean;
  endedTransition: PolicyGroupEndedTransitionKind | null;
  lifecycleVersion: number;
}

/** One PolicyGroupVersion row as the loader selects it (only current versions are needed). */
export interface PolicyGroupVersionFacts {
  groupKey: string;
  version: number;
  values: unknown;
  createdAt: Date;
}

/**
 * PURE — the catalogue from the rows (rows win over code; code groups without a row are kept).
 *
 * BETA LIFECYCLE — `lifecycle` is the separate lifecycle read: an array ⇒
 * lifecycleSource DB (a DB row missing from it reads ACTIVE — it cannot happen
 * within one read, and ACTIVE is what the column default says); null ⇒ the read
 * FAILED ⇒ UNAVAILABLE (every group ACTIVE for VALUES; billable fails closed);
 * undefined ⇒ not asked (CODE — tests and pre-lifecycle callers).
 */
export function buildPolicyGroupCatalogue(
  rows: readonly PolicyGroupRowFacts[],
  versions: readonly PolicyGroupVersionFacts[],
  loadedAt: Date,
  lifecycle?: readonly PolicyGroupLifecycleFacts[] | null,
): PolicyGroupCatalogue {
  const current = new Map(versions.map((v) => [`${v.groupKey}#${v.version}`, v] as const));
  const life = new Map((lifecycle ?? []).map((l) => [l.key, l] as const));
  const groups: Record<string, CatalogueGroup> = {};
  for (const r of rows) {
    const v = current.get(`${r.key}#${r.currentVersion}`);
    const codeValues = r.key in POLICY_GROUPS ? POLICY_GROUPS[r.key].values : null;
    const check = v ? normaliseStoredValues(v.values, codeValues) : { ok: false as const, errors: [`Version ${r.currentVersion} is missing.`] };
    groups[r.key] = {
      key: r.key, label: r.label, description: r.description,
      values: check.ok ? check.values : null, valid: check.ok, invalidReasons: check.ok ? [] : check.errors,
      readAdjustments: check.ok ? check.adjustments : [],
      archived: r.archivedAt !== null, archivedAt: r.archivedAt?.toISOString() ?? null,
      isDefault: false, builtIn: r.builtIn, version: r.currentVersion, source: "DB",
      effectiveFrom: (v?.createdAt ?? loadedAt).toISOString().slice(0, 10),
      lifecycle: life.get(r.key)?.lifecycle ?? "ACTIVE",
      costFrozen: life.get(r.key)?.costFrozen ?? false,
      endedTransition: life.get(r.key)?.endedTransition ?? null,
      lifecycleVersion: life.get(r.key)?.lifecycleVersion ?? 0,
    };
  }
  for (const k of Object.keys(POLICY_GROUPS)) if (!(k in groups)) groups[k] = codeGroup(k, false);

  // The DB default wins even when its stored definition is invalid: its
  // customers then FAIL CLOSED (the resolver) rather than silently getting Beta.
  const dbDefault = rows.find((r) => r.isDefault && r.archivedAt === null);
  const defaultKey = dbDefault?.key ?? DEFAULT_POLICY_GROUP;
  groups[defaultKey] = { ...groups[defaultKey], isDefault: true };
  const lifecycleSource = lifecycle === undefined ? "CODE" : lifecycle === null ? "UNAVAILABLE" : "DB";
  return { source: "DB", groups, defaultKey, loadedAt: loadedAt.toISOString(), lifecycleSource };
}

// ── Lookups ───────────────────────────────────────────────────────────────────

/** A group a customer may be ASSIGNED to now: defined, valid, not archived. */
export function isAssignableGroup(catalogue: PolicyGroupCatalogue, key: unknown): key is string {
  if (typeof key !== "string") return false;
  const g = catalogue.groups[key];
  return g !== undefined && g.valid && !g.archived;
}

/** Keys that resolve to a plan (valid; archived included — an archived group never strands a customer). */
export function resolvableGroupKeys(catalogue: PolicyGroupCatalogue): string[] {
  return Object.values(catalogue.groups).filter((g) => g.valid).map((g) => g.key).sort();
}

/** The groups Customer Success may offer, in a stable order (default first). */
export function assignableGroups(catalogue: PolicyGroupCatalogue): { key: string; label: string; isDefault: boolean }[] {
  return Object.values(catalogue.groups)
    .filter((g) => g.valid && !g.archived)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label))
    .map((g) => ({ key: g.key, label: g.label, isDefault: g.isDefault }));
}

export function groupLabel(catalogue: PolicyGroupCatalogue, key: string): string {
  return catalogue.groups[key]?.label ?? key;
}

// ── Change summary ────────────────────────────────────────────────────────────

export interface DimensionChange {
  key: EntitlementDimensionKey;
  label: string;
  before: EntitlementValue | null;
  after: EntitlementValue;
}

/** PURE — the dimensions whose value differs (registry order). `before` null ⇒ every dimension is listed. */
export function diffEntitlementValues(before: EntitlementValues | null, after: EntitlementValues): DimensionChange[] {
  return DIMENSION_KEYS
    .filter((k) => before === null || before[k] !== after[k])
    .map((k) => ({ key: k, label: ENTITLEMENT_DIMENSIONS[k].label, before: before ? before[k] : null, after: after[k] }));
}
