/**
 * lib/entitlements/resolve.test.ts — the effective-entitlement resolver is
 * deterministic, explainable, and can never exceed a ceiling.
 * Run: npx tsx lib/entitlements/resolve.test.ts
 */
import {
  BETA_FULL_ACCESS_V1, DEFAULT_POLICY_GROUP, DIMENSION_KEYS, ENTITLEMENT_DIMENSIONS, FOUNDER_INTERNAL_V1,
  INVITE_COHORT, COHORTS, isPolicyGroupKey, isOverlayKey,
} from "./catalogue";
import { explainEntitlement, loadEffectiveEntitlements, resolveEffectiveEntitlements } from "./resolve";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const now = new Date("2026-10-08T00:00:00Z");

console.log("catalogue");
check("default policy group is a defined group", isPolicyGroupKey(DEFAULT_POLICY_GROUP));
check("the founder overlay is a defined overlay", isOverlayKey(FOUNDER_INTERNAL_V1.key));
check("the invite cohort is a defined cohort", INVITE_COHORT in COHORTS);
check("every policy value is within its ceiling",
  DIMENSION_KEYS.every((k) => {
    const d = ENTITLEMENT_DIMENSIONS[k]; const v = BETA_FULL_ACCESS_V1.values[k];
    return d.kind === "boolean" ? !(v && !d.ceiling) : d.kind === "count" ? Number(v) <= Number(d.ceiling) : Number(v) >= Number(d.ceiling);
  }));
check("the overlay changes only dimensions that exist", Object.keys(FOUNDER_INTERNAL_V1.values).every((k) => k in ENTITLEMENT_DIMENSIONS));

console.log("unassigned customer");
{
  const e = resolveEffectiveEntitlements(null);
  check("resolves to the default group", e.policyGroup === DEFAULT_POLICY_GROUP && !e.assigned && e.policyGroupKnown);
  check("every dimension reports POLICY_DEFAULT", Object.values(e.dimensions).every((d) => d.source === "POLICY_DEFAULT"));
  check("bank cooldown is the historical 60 minutes", e.dimensions.manualBankRefreshCooldownMinutes.value === 60);
  check("explanation names the default", explainEntitlement(e.dimensions.exportsPerDay).includes("default policy group"));
}

console.log("assigned, no overlay");
{
  const e = resolveEffectiveEntitlements({ policyGroup: "BETA_FULL_ACCESS_V1", overlay: null, assignedAt: now, assignedById: "op1" });
  check("sources are POLICY", Object.values(e.dimensions).every((d) => d.source === "POLICY"));
  check("assignment facts carried", e.assigned && e.assignedAt === now.toISOString() && e.assignedById === "op1");
}

console.log("founder overlay");
{
  const e = resolveEffectiveEntitlements({ policyGroup: "BETA_FULL_ACCESS_V1", overlay: "FOUNDER_INTERNAL_V1", assignedAt: now, assignedById: "op1" });
  check("overlaid dimensions report OVERLAY with the policy value kept beside", e.dimensions.exportsPerDay.source === "OVERLAY" && e.dimensions.exportsPerDay.value === 10 && e.dimensions.exportsPerDay.policyValue === 3);
  check("cooldown floor lowered to the ceiling floor, not below", e.dimensions.manualBankRefreshCooldownMinutes.value === 15);
  check("non-overlaid dimensions stay POLICY", e.dimensions.aiTurnsPerHour.source === "POLICY" && e.dimensions.aiTurnsPerHour.value === 60);
  check("the hourly Conversations ceiling is NOT exceeded by the overlay", Number(e.dimensions.aiTurnsPerHour.value) <= Number(ENTITLEMENT_DIMENSIONS.aiTurnsPerHour.ceiling));
  check("wallet syncs/hour unchanged at the ceiling", e.dimensions.manualWalletRefreshPerHour.value === 6);
}

console.log("ceilings win over anything asked");
{
  // A retired/unknown group and a bogus overlay cannot widen anything; an unknown group is reported, not hidden.
  const e = resolveEffectiveEntitlements({ policyGroup: "RETIRED_GROUP_V0", overlay: "NOT_AN_OVERLAY", assignedAt: now, assignedById: null });
  check("unknown group → default, reported", e.policyGroup === DEFAULT_POLICY_GROUP && !e.policyGroupKnown && e.unknownPolicyGroup === "RETIRED_GROUP_V0");
  check("unknown overlay → ignored, reported", e.overlay === null && !e.overlayKnown);
  check("every value within ceiling", DIMENSION_KEYS.every((k) => {
    const d = e.dimensions[k]; const c = ENTITLEMENT_DIMENSIONS[k];
    return c.kind === "boolean" ? !(d.value && !c.ceiling) : c.kind === "count" ? Number(d.value) <= Number(c.ceiling) : Number(d.value) >= Number(c.ceiling);
  }));
}

console.log("determinism");
{
  const a = JSON.stringify(resolveEffectiveEntitlements({ policyGroup: "BETA_FULL_ACCESS_V1", overlay: "FOUNDER_INTERNAL_V1", assignedAt: now, assignedById: "x" }));
  const b = JSON.stringify(resolveEffectiveEntitlements({ policyGroup: "BETA_FULL_ACCESS_V1", overlay: "FOUNDER_INTERNAL_V1", assignedAt: now, assignedById: "x" }));
  check("same facts ⇒ identical result", a === b);
}

console.log("loader");
{
  const fake = { customerPolicyAssignment: { findUnique: async ({ where }: { where: { userId: string } }) =>
    where.userId === "u1" ? { policyGroup: "BETA_FULL_ACCESS_V1", overlay: null, assignedAt: now, assignedById: null } : null } };
  loadEffectiveEntitlements(fake, "u1").then((e1) => loadEffectiveEntitlements(fake, "u2").then((e2) => {
    check("loader resolves an existing row as assigned", e1.assigned);
    check("loader resolves a missing row as the default", !e2.assigned && e2.policyGroup === DEFAULT_POLICY_GROUP);
    if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
    console.log("\nall checks passed");
  }));
}
