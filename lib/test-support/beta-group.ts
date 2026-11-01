/**
 * lib/test-support/beta-group.ts  (BETA_NOT_ACCEPTING — test-only)
 *
 * Seeds the authoritative Beta group (BETA_FULL_ACCESS_V1) into the fake with
 * an explicit lifecycle, and drops the cached catalogue so the next fresh read
 * sees it. Invitation issuance refuses unless this reads ACTIVE; tests that
 * exercise issuance itself seed ACTIVE. ⚠️ Imported by *.test.ts files only.
 */

import type { FakePrisma } from "./fake-prisma";
import { BETA_FULL_ACCESS_V1, DEFAULT_POLICY_GROUP } from "@/lib/entitlements/catalogue";
import type { PolicyGroupLifecycleState } from "@/lib/entitlements/lifecycle";

export async function seedBetaGroup(fake: FakePrisma, lifecycle: PolicyGroupLifecycleState = "ACTIVE"): Promise<void> {
  fake.seed("PolicyGroup", {
    key: DEFAULT_POLICY_GROUP, label: BETA_FULL_ACCESS_V1.label, description: "", isDefault: true, builtIn: true, currentVersion: 1,
    lifecycle, costFrozen: false, endedTransition: lifecycle === "ENDED" ? "READ_ONLY" : null,
  });
  fake.seed("PolicyGroupVersion", {
    groupKey: DEFAULT_POLICY_GROUP, version: 1, values: { ...BETA_FULL_ACCESS_V1.values }, label: BETA_FULL_ACCESS_V1.label,
    changeSummary: { kind: "SEEDED", changes: [] }, reasonCode: "POLICY_ROLLOUT",
  });
  const C = await import("@/lib/platform/policies/policy-group-catalogue");
  C.invalidatePolicyGroupCatalogue();
}
