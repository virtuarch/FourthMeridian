/**
 * lib/entitlements/policy-groups.test.ts  (POLICY EDITOR — the pure core, pinned)
 *
 *   1. validation — every dimension, kinds, [0, ceiling] counts, floors ≥ the
 *      ceiling (the MINIMUM) and ≤ 7 days, booleans ≤ ceiling, unknown dimension
 *      refused; key / label / description rules; code keys reserved;
 *   2. the catalogue — DB rows win over code, code groups kept when no row,
 *      stored values RE-VALIDATED (invalid ⇒ values null), archived, the
 *      single default (DB default wins even when invalid; else code default);
 *   3. resolution — precedence, clamp, invalid DB version ⇒ FAIL CLOSED (switch
 *      on AND off, never Beta, never unlimited), archived still resolves,
 *      table-absent back-compat (CODE_CATALOGUE ≡ no option, byte-identical),
 *      Founder overlay still applied on top of an EDITED Beta, the loader
 *      takes `catalogue` / `loadCatalogue`;
 *   4. preview + cost exposure — through the resolver and the one allowance
 *      precedence;
 *   5. categories — every dimension has one, the labels equal the Policies
 *      dashboard's.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/entitlements/policy-groups.test.ts
 */

import {
  BETA_FULL_ACCESS_V1, DEFAULT_POLICY_GROUP, DIMENSION_KEYS, ENTITLEMENT_CATEGORIES, ENTITLEMENT_DIMENSIONS, FAIL_CLOSED_VALUES,
  FOUNDER_INTERNAL_V1, type EntitlementValues,
} from "./catalogue";
import {
  CODE_CATALOGUE, FLOOR_MAX_MINUTES, assignableGroups, buildPolicyGroupCatalogue, codeFallbackCatalogue, dimensionBounds, diffEntitlementValues,
  isAssignableGroup, resolvableGroupKeys, validateEntitlementValues, validateGroupDescription, validateGroupLabel, validateNewGroupKey,
  type PolicyGroupRowFacts, type PolicyGroupVersionFacts,
} from "./policy-groups";
import { loadEffectiveEntitlements, resolveEffectiveEntitlements } from "./resolve";
import { estimateAllowanceCeiling, previewEffective } from "./policy-group-preview";
import { POLICY_CATEGORIES } from "@/components/platform/leads/policies-model";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const BETA = BETA_FULL_ACCESS_V1.values;
const NOW = new Date("2026-10-30T12:00:00.000Z");
const row = (o: Partial<PolicyGroupRowFacts> & { key: string }): PolicyGroupRowFacts => ({
  label: o.key, description: "", isDefault: false, builtIn: false, archivedAt: null, currentVersion: 1, ...o,
});
const ver = (groupKey: string, version: number, values: unknown): PolicyGroupVersionFacts => ({ groupKey, version, values, createdAt: new Date("2026-10-29T00:00:00Z") });
const facts = (policyGroup: string, overlay: string | null = null) => ({ policyGroup, overlay, assignedAt: NOW, assignedById: "op" });

// ── 1. Validation ────────────────────────────────────────────────────────────
console.log("1. Validation");
{
  check("Beta's code values validate", validateEntitlementValues(BETA).ok);
  check("FAIL_CLOSED_VALUES validate (they are within every bound)", validateEntitlementValues(FAIL_CLOSED_VALUES).ok);
  const missing = validateEntitlementValues({ ...BETA, exportsPerDay: undefined });
  check("a missing dimension is refused", !missing.ok && missing.errors.some((e) => /missing/.test(e)), missing);
  const unknown = validateEntitlementValues({ ...BETA, unlimitedEverything: true });
  check("an unknown dimension is refused (never ignored)", !unknown.ok && unknown.errors.some((e) => /Unknown entitlement "unlimitedEverything"/.test(e)));
  check("a count above its ceiling is refused (maxConnections 26 > 25)", !validateEntitlementValues({ ...BETA, maxConnections: 26 }).ok);
  check("a count at its ceiling is accepted (maxConnections 25)", validateEntitlementValues({ ...BETA, maxConnections: 25 }).ok);
  check("a negative count is refused", !validateEntitlementValues({ ...BETA, exportsPerDay: -1 }).ok);
  check("zero is a valid count (0 = none, never unlimited)", validateEntitlementValues({ ...BETA, aiDailyUsdAllowance: 0 }).ok);
  check("a non-integer count is refused", !validateEntitlementValues({ ...BETA, exportsPerDay: 2.5 }).ok);
  check("a numeric string is refused (kind)", !validateEntitlementValues({ ...BETA, exportsPerDay: "3" }).ok);
  check("a floor BELOW its ceiling (the minimum) is refused (cooldown 14 < 15)", !validateEntitlementValues({ ...BETA, manualBankRefreshCooldownMinutes: 14 }).ok);
  check("a floor AT its ceiling is accepted (15)", validateEntitlementValues({ ...BETA, manualBankRefreshCooldownMinutes: 15 }).ok);
  check("a floor above 7 days is refused", !validateEntitlementValues({ ...BETA, manualBankRefreshCooldownMinutes: FLOOR_MAX_MINUTES + 1 }).ok && FLOOR_MAX_MINUTES === 10_080);
  check("a boolean must be a boolean", !validateEntitlementValues({ ...BETA, conversations: "yes" }).ok && !validateEntitlementValues({ ...BETA, conversations: 1 }).ok);
  check("non-objects are refused", [null, [], "x", 3].every((v) => !validateEntitlementValues(v).ok));
  check("bounds: counts [0, ceiling]; floors [ceiling, 7 d]; booleans none",
    JSON.stringify(dimensionBounds("maxConnections")) === JSON.stringify({ min: 0, max: 25 })
      && JSON.stringify(dimensionBounds("manualBankRefreshCooldownMinutes")) === JSON.stringify({ min: 15, max: 10_080 })
      && dimensionBounds("conversations") === null);

  check("key: UPPER_SNAKE accepted", validateNewGroupKey("BETA_PLUS_V2").ok);
  check("key: lower case / spaces / leading digit / too short refused", ["beta_plus", "BETA PLUS", "2BETA", "AB", "A".repeat(49)].every((k) => !validateNewGroupKey(k).ok));
  check("key: code group, overlay, cohort and FAIL_CLOSED* are reserved",
    [DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1.key, "CLOSED_BETA_2026", "FAIL_CLOSED", "FAIL_CLOSED_V2"].every((k) => !validateNewGroupKey(k).ok));
  check("label: 1–60 chars (trimmed)", validateGroupLabel("  Pro  ").ok && !validateGroupLabel("   ").ok && !validateGroupLabel("x".repeat(61)).ok && validateGroupLabel("x".repeat(60)).ok);
  check("description: optional, ≤ 280", validateGroupDescription(undefined).ok && !validateGroupDescription("x".repeat(281)).ok);
}

// ── 2. The catalogue ─────────────────────────────────────────────────────────
console.log("2. The catalogue");
{
  check("CODE_CATALOGUE = the code groups, default Beta", CODE_CATALOGUE.defaultKey === DEFAULT_POLICY_GROUP
    && CODE_CATALOGUE.groups[DEFAULT_POLICY_GROUP].values === BETA && CODE_CATALOGUE.groups[DEFAULT_POLICY_GROUP].isDefault);
  const empty = buildPolicyGroupCatalogue([], [], NOW);
  check("no rows ⇒ the code groups (table empty ≡ code)", empty.defaultKey === DEFAULT_POLICY_GROUP && empty.groups[DEFAULT_POLICY_GROUP].source === "CODE"
    && JSON.stringify(empty.groups[DEFAULT_POLICY_GROUP].values) === JSON.stringify(BETA));

  const edited = { ...BETA, exportsPerDay: 5 };
  const cat = buildPolicyGroupCatalogue(
    [row({ key: DEFAULT_POLICY_GROUP, isDefault: true, builtIn: true, currentVersion: 2 }), row({ key: "PRO_V1" }), row({ key: "BROKEN_V1" }), row({ key: "OLD_V1", archivedAt: new Date("2026-10-01") })],
    [ver(DEFAULT_POLICY_GROUP, 1, BETA), ver(DEFAULT_POLICY_GROUP, 2, edited), ver("PRO_V1", 1, { ...BETA, maxConnections: 25 }), ver("BROKEN_V1", 1, { ...BETA, maxConnections: 999 }), ver("OLD_V1", 1, BETA)],
    NOW,
  );
  check("a DB row WINS over the code group of the same key (current version 2)", cat.groups[DEFAULT_POLICY_GROUP].source === "DB" && cat.groups[DEFAULT_POLICY_GROUP].values?.exportsPerDay === 5 && cat.groups[DEFAULT_POLICY_GROUP].version === 2);
  check("a DB-only group is defined", cat.groups.PRO_V1?.valid === true && cat.groups.PRO_V1.values?.maxConnections === 25);
  check("an out-of-range stored version ⇒ INVALID, values null (never a guessed value)", cat.groups.BROKEN_V1.valid === false && cat.groups.BROKEN_V1.values === null && cat.groups.BROKEN_V1.invalidReasons.length > 0);
  const noVersion = buildPolicyGroupCatalogue([row({ key: "GHOST_V1", currentVersion: 3 })], [ver("GHOST_V1", 1, BETA)], NOW);
  check("a row whose current version is missing ⇒ INVALID", noVersion.groups.GHOST_V1.valid === false);
  check("archived is reported, still valid (never strands a customer)", cat.groups.OLD_V1.archived && cat.groups.OLD_V1.valid);
  check("assignable = valid and not archived", isAssignableGroup(cat, "PRO_V1") && !isAssignableGroup(cat, "OLD_V1") && !isAssignableGroup(cat, "BROKEN_V1") && !isAssignableGroup(cat, "NOPE") && !isAssignableGroup(cat, 3));
  check("resolvable = valid (archived included)", JSON.stringify(resolvableGroupKeys(cat)) === JSON.stringify([DEFAULT_POLICY_GROUP, "OLD_V1", "PRO_V1"].sort()));
  check("assignableGroups lists the default first, never archived / invalid", assignableGroups(cat)[0].key === DEFAULT_POLICY_GROUP && assignableGroups(cat).every((g) => g.key !== "OLD_V1" && g.key !== "BROKEN_V1"));
  check("the DB default row is THE default (one isDefault)", cat.defaultKey === DEFAULT_POLICY_GROUP && Object.values(cat.groups).filter((g) => g.isDefault).length === 1);

  const moved = buildPolicyGroupCatalogue([row({ key: DEFAULT_POLICY_GROUP, builtIn: true }), row({ key: "PRO_V1", isDefault: true })], [ver(DEFAULT_POLICY_GROUP, 1, BETA), ver("PRO_V1", 1, BETA)], NOW);
  check("a moved default: PRO_V1 is the default, Beta is not", moved.defaultKey === "PRO_V1" && moved.groups.PRO_V1.isDefault && !moved.groups[DEFAULT_POLICY_GROUP].isDefault);
  const archivedDefault = buildPolicyGroupCatalogue([row({ key: "PRO_V1", isDefault: true, archivedAt: NOW })], [ver("PRO_V1", 1, BETA)], NOW);
  check("an archived default row is ignored ⇒ the code default", archivedDefault.defaultKey === DEFAULT_POLICY_GROUP);
  const invalidDefault = buildPolicyGroupCatalogue([row({ key: "PRO_V1", isDefault: true })], [ver("PRO_V1", 1, { conversations: true })], NOW);
  check("an INVALID DB default stays the default (its customers fail closed — never silently Beta)", invalidDefault.defaultKey === "PRO_V1" && !invalidDefault.groups.PRO_V1.valid);
  check("codeFallbackCatalogue is marked CODE_FALLBACK with the code groups", codeFallbackCatalogue().source === "CODE_FALLBACK" && codeFallbackCatalogue().defaultKey === DEFAULT_POLICY_GROUP);

  check("diff: changed dimensions only, registry order", JSON.stringify(diffEntitlementValues(BETA, edited).map((c) => [c.key, c.before, c.after])) === JSON.stringify([["exportsPerDay", 3, 5]]));
  check("diff from nothing lists every dimension", diffEntitlementValues(null, BETA).length === DIMENSION_KEYS.length);
}

// ── 3. Resolution ────────────────────────────────────────────────────────────
console.log("3. Resolution");
(async () => {
  const edited: EntitlementValues = { ...BETA, exportsPerDay: 5, aiTurnsPerMinute: 12 };
  const cat = buildPolicyGroupCatalogue(
    [row({ key: DEFAULT_POLICY_GROUP, isDefault: true, builtIn: true, currentVersion: 2 }), row({ key: "PRO_V1" }), row({ key: "BROKEN_V1" }), row({ key: "OLD_V1", archivedAt: NOW })],
    [ver(DEFAULT_POLICY_GROUP, 2, edited), ver("PRO_V1", 1, { ...BETA, maxConnections: 25, aiDailyUsdAllowance: 12 }), ver("BROKEN_V1", 1, { ...BETA, exportsPerDay: "lots" }), ver("OLD_V1", 1, { ...BETA, exportsPerDay: 2 })],
    NOW,
  );

  // Back-compat: the code catalogue (table absent / read failed) ≡ no option.
  for (const [name, f] of [["unassigned", null], ["Beta", facts(DEFAULT_POLICY_GROUP)], ["Beta+Founder", facts(DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1.key)], ["unknown", facts("RETIRED_V0")]] as const) {
    for (const failClosed of [false, true]) {
      const a = JSON.stringify(resolveEffectiveEntitlements(f, undefined, { failClosed }));
      const b = JSON.stringify(resolveEffectiveEntitlements(f, undefined, { failClosed, catalogue: CODE_CATALOGUE }));
      const c = JSON.stringify(resolveEffectiveEntitlements(f, undefined, { failClosed, catalogue: codeFallbackCatalogue() }));
      check(`back-compat ${name} (switch ${failClosed ? "on" : "off"}): code catalogue ≡ no option ≡ fallback (byte-identical)`, a === b && b === c);
    }
  }
  const seededDay1 = buildPolicyGroupCatalogue([row({ key: DEFAULT_POLICY_GROUP, isDefault: true, builtIn: true })], [ver(DEFAULT_POLICY_GROUP, 1, BETA)], NOW);
  check("day one: the seeded Beta row resolves EXACTLY like the code catalogue",
    JSON.stringify(resolveEffectiveEntitlements(facts(DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1.key), { aiDailyUsdAllowanceUsd: 7 }, { catalogue: seededDay1 }))
      === JSON.stringify(resolveEffectiveEntitlements(facts(DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1.key), { aiDailyUsdAllowanceUsd: 7 })));

  const beta = resolveEffectiveEntitlements(facts(DEFAULT_POLICY_GROUP), undefined, { catalogue: cat });
  check("an edited Beta's DB values are in force (exports 5, turns/min 12), source POLICY", beta.dimensions.exportsPerDay.value === 5 && beta.dimensions.aiTurnsPerMinute.value === 12 && beta.dimensions.exportsPerDay.source === "POLICY");
  const founder = resolveEffectiveEntitlements(facts(DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1.key), undefined, { catalogue: cat });
  check("Founder overlay still applied ON TOP of the edited Beta (exports 10, turns/min 30, allowance $20, connections 25, cooldown 15)",
    founder.dimensions.exportsPerDay.value === 10 && founder.dimensions.aiTurnsPerMinute.value === 30 && founder.dimensions.aiDailyUsdAllowance.value === 20
      && founder.dimensions.maxConnections.value === 25 && founder.dimensions.manualBankRefreshCooldownMinutes.value === 15 && founder.dimensions.exportsPerDay.source === "OVERLAY");
  check("…and a dimension the overlay does not name keeps the edited Beta value (turns/hour 60, wallet 6)", founder.dimensions.aiTurnsPerHour.value === 60 && founder.dimensions.manualWalletRefreshPerHour.value === 6);
  const pro = resolveEffectiveEntitlements(facts("PRO_V1"), { aiDailyUsdAllowanceUsd: null }, { catalogue: cat });
  check("a DB-only group resolves (POLICY, connections 25, allowance 12)", pro.policyGroupKnown && pro.dimensions.maxConnections.value === 25 && pro.dimensions.aiDailyUsdAllowance.value === 12 && !pro.failClosed);
  check("ceiling still clamps LAST: a forged catalogue value above the ceiling is cut (source CEILING)", (() => {
    const forged = { ...cat, groups: { ...cat.groups, PRO_V1: { ...cat.groups.PRO_V1, values: { ...BETA, maxConnections: 500 } as EntitlementValues } } };
    const e = resolveEffectiveEntitlements(facts("PRO_V1"), undefined, { catalogue: forged });
    return e.dimensions.maxConnections.value === 25 && e.dimensions.maxConnections.source === "CEILING";
  })());
  const archived = resolveEffectiveEntitlements(facts("OLD_V1"), undefined, { catalogue: cat, failClosed: true });
  check("an ARCHIVED group with an assignment still resolves to its plan (race guard, not stranded)", !archived.failClosed && archived.dimensions.exportsPerDay.value === 2);

  for (const failClosed of [false, true]) {
    const broken = resolveEffectiveEntitlements(facts("BROKEN_V1", FOUNDER_INTERNAL_V1.key), { aiDailyUsdAllowanceUsd: 9 }, { catalogue: cat, failClosed });
    check(`invalid DB version (switch ${failClosed ? "on" : "off"}) ⇒ FAIL CLOSED, reason INVALID_POLICY_GROUP`, broken.failClosed && broken.failClosedReason === "INVALID_POLICY_GROUP");
    check(`…every value is FAIL_CLOSED_VALUES (never Beta, never unlimited), Founder + platform setting ignored`,
      DIMENSION_KEYS.every((k) => broken.dimensions[k].value === FAIL_CLOSED_VALUES[k]) && broken.dimensions.aiDailyUsdAllowance.value === 0);
    check("…the group key is still reported (known, not 'unknown')", broken.policyGroup === "BROKEN_V1" && broken.policyGroupKnown && broken.unknownPolicyGroup === null);
  }
  const invalidDefault = buildPolicyGroupCatalogue([row({ key: "PRO_V1", isDefault: true })], [ver("PRO_V1", 1, { conversations: true })], NOW);
  const unassignedOff = resolveEffectiveEntitlements(null, undefined, { catalogue: invalidDefault });
  check("unassigned with an INVALID default, switch off ⇒ fail closed (INVALID_POLICY_GROUP), not Beta", unassignedOff.failClosed && unassignedOff.failClosedReason === "INVALID_POLICY_GROUP");
  const unassignedOn = resolveEffectiveEntitlements(null, undefined, { catalogue: cat, failClosed: true });
  check("unassigned, switch on ⇒ UNASSIGNED (existing behaviour)", unassignedOn.failClosed && unassignedOn.failClosedReason === "UNASSIGNED");
  const unknownOff = resolveEffectiveEntitlements(facts("RETIRED_V0"), undefined, { catalogue: cat });
  check("unknown key, switch off ⇒ the (DB) default group, POLICY_DEFAULT (existing behaviour)", !unknownOff.failClosed && unknownOff.policyGroup === DEFAULT_POLICY_GROUP && unknownOff.dimensions.exportsPerDay.value === 5 && unknownOff.dimensions.exportsPerDay.source === "POLICY_DEFAULT");
  const unknownOn = resolveEffectiveEntitlements(facts("RETIRED_V0"), undefined, { catalogue: cat, failClosed: true });
  check("unknown key, switch on ⇒ UNKNOWN_POLICY_GROUP (existing behaviour)", unknownOn.failClosed && unknownOn.failClosedReason === "UNKNOWN_POLICY_GROUP" && unknownOn.unknownPolicyGroup === "RETIRED_V0");

  const client = { customerPolicyAssignment: { findUnique: async () => ({ policyGroup: "PRO_V1", overlay: null, assignedAt: NOW, assignedById: null }) } };
  check("loader: `catalogue` is used", (await loadEffectiveEntitlements(client, "u", { catalogue: cat })).dimensions.maxConnections.value === 25);
  let loads = 0;
  check("loader: `loadCatalogue` is called when no catalogue is given", (await loadEffectiveEntitlements(client, "u", { loadCatalogue: async () => { loads++; return cat; } })).dimensions.maxConnections.value === 25 && loads === 1);
  check("loader: neither ⇒ the code catalogue (PRO_V1 unknown ⇒ default)", (await loadEffectiveEntitlements(client, "u")).policyGroupKnown === false);

  // ── 4. Preview + exposure ────────────────────────────────────────────────
  console.log("4. Preview + cost exposure");
  const pv = previewEffective(edited, null);
  check("preview (plain) = the resolver's values", pv.exportsPerDay.value === 5 && pv.exportsPerDay.source === "POLICY");
  const pf = previewEffective(edited, FOUNDER_INTERNAL_V1.key);
  check("preview with Founder = overlay ∘ group, clamped", pf.exportsPerDay.value === 10 && pf.aiDailyUsdAllowance.value === 20 && pf.aiTurnsPerHour.value === 60);
  const buckets = [
    { overlay: null, overrideUsd: null, count: 10 },
    { overlay: FOUNDER_INTERNAL_V1.key, overrideUsd: null, count: 2 },
    { overlay: null, overrideUsd: 3, count: 1 },
  ];
  const x = estimateAllowanceCeiling(buckets, 5, null);
  check("exposure = Σ customers × allowance by the one precedence (10×$5 + 2×$20 + 1×$3 = $93)", x.ceilingUsdPerDay === 93 && x.customers === 13 && x.notFollowingGroup === 3, x);
  const y = estimateAllowanceCeiling(buckets, 8, 6);
  check("a platform setting outranks the group (10×$6 + 2×$20 + 1×$3 = $103; 13 not following the group)", y.ceilingUsdPerDay === 103 && y.notFollowingGroup === 13, y);
  check("exposure never exceeds customers × the ceiling", estimateAllowanceCeiling([{ overlay: null, overrideUsd: 500, count: 4 }], 5, null).ceilingUsdPerDay === 4 * ENTITLEMENT_DIMENSIONS.aiDailyUsdAllowance.ceiling);

  // ── 5. Categories ────────────────────────────────────────────────────────
  console.log("5. Categories");
  check("every dimension names a known category", DIMENSION_KEYS.every((k) => ENTITLEMENT_DIMENSIONS[k].category in ENTITLEMENT_CATEGORIES));
  check("each catalogue category label is the Policies dashboard's label for the same dimensions",
    DIMENSION_KEYS.every((k) => POLICY_CATEGORIES.find((c) => c.dimensions.includes(k))?.label === ENTITLEMENT_CATEGORIES[ENTITLEMENT_DIMENSIONS[k].category]));

  if (failures > 0) { console.error(`\npolicy-groups: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\npolicy-groups: all checks passed.");
})().catch((e) => { console.error(e); process.exit(1); });
