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

/**
 * The row lock issuance takes before re-reading the suspected-abuse verdict on a
 * DENIED approve (`SELECT "id" FROM "BetaAccessRequest" WHERE "id" = $1 FOR UPDATE`).
 * The fake has no locks; this answers that one statement with the row's id and
 * refuses any other raw query, so nothing else silently passes.
 */
export function allowRequestRowLock(fake: FakePrisma): void {
  fake.queryRaw = (sql: string, values: unknown[]) => {
    if (/FROM "BetaAccessRequest" WHERE "id" = [\s\S]*FOR UPDATE/.test(sql)) {
      return fake.rows("BetaAccessRequest", { id: values[0] as string }).map((r) => ({ id: r.id }));
    }
    throw new Error(`unexpected $queryRaw in this test: ${sql}`);
  };
}
