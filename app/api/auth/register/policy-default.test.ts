/**
 * app/api/auth/register/policy-default.test.ts  (POLICY EDITOR — the registration default)
 *
 * The REAL POST /api/auth/register against the in-memory Prisma fake. New
 * registrations are placed on THE DEFAULT GROUP:
 *   1. no PolicyGroup rows                  ⇒ the code default (Beta);
 *   2. the migration's seeded Beta default  ⇒ Beta (day one: unchanged);
 *   3. an operator moved the default        ⇒ that group (the DB default row);
 *   0. the table is absent / the read fails (first read of the process) ⇒
 *      Beta, and registration still succeeds (the read is outside the
 *      transaction and never throws; later failures serve the last good read);
 *   5. never an overlay (Founder is never granted at birth), never a write to
 *      PolicyGroup / PolicyGroupVersion.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/auth/register/policy-default.test.ts
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker } from "@/lib/test-support/route-harness";
import { clearCapturedEmails } from "@/lib/email/providers/capture";
import { BETA_FULL_ACCESS_V1, DEFAULT_POLICY_GROUP } from "@/lib/entitlements/catalogue";

const t = makeChecker("POST /api/auth/register — the default policy group (POLICY EDITOR)");
let POST: typeof import("./route").POST;
const fake = new FakePrisma();

let n = 0;
const form = () => {
  n++;
  return { email: `person${n}@example.test`, username: `person_${n}`, password: "correct horse battery", firstName: "New", lastName: "Person", acceptedTerms: true };
};
const register = () => invoke(POST, request("/api/auth/register", { body: form(), ip: `198.51.100.${n + 1}` }));

function world(): void {
  fake.reset();
  clearCapturedEmails();
  fake.seed("PlatformSetting", { key: "registration_mode", value: "open" });
}
function seedGroup(key: string, isDefault: boolean, values: Record<string, unknown> = { ...BETA_FULL_ACCESS_V1.values }) {
  fake.seed("PolicyGroup", { key, label: key, isDefault, builtIn: key === DEFAULT_POLICY_GROUP, currentVersion: 1 });
  fake.seed("PolicyGroupVersion", { groupKey: key, version: 1, values, label: key, changeSummary: { kind: "SEEDED", changes: [] }, reasonCode: "POLICY_ROLLOUT" });
}
const assignmentOf = () => {
  const u = fake.rows("User").at(-1)!;
  return fake.one("CustomerPolicyAssignment", { userId: u.id });
};

async function main() {
  await installFakePrisma(fake);
  ({ POST } = await import("./route"));
  const { invalidatePolicyGroupCatalogue } = await import("@/lib/platform/policies/policy-group-catalogue");

  t.section("0. table absent / read failure (fresh process, no last good) ⇒ Beta, registration still succeeds");
  {
    world(); invalidatePolicyGroupCatalogue();
    fake.on("PolicyGroup", "findMany", () => { throw Object.assign(new Error('relation "PolicyGroup" does not exist'), { code: "P2021" }); });
    const r = await register();
    t.check("201 (the failed read is outside the registration transaction)", r.status === 201, r.body);
    t.check("assigned the code default, Beta", assignmentOf()?.policyGroup === DEFAULT_POLICY_GROUP);
    fake.clearHooks();
  }


  t.section("1. no PolicyGroup rows ⇒ the code default (Beta)");
  {
    world(); invalidatePolicyGroupCatalogue();
    const r = await register();
    t.check("201", r.status === 201, r.body);
    t.check("assigned Beta, no overlay", assignmentOf()?.policyGroup === DEFAULT_POLICY_GROUP && assignmentOf()?.overlay == null);
  }

  t.section("2. the seeded Beta default ⇒ Beta (day one unchanged)");
  {
    world(); invalidatePolicyGroupCatalogue();
    seedGroup(DEFAULT_POLICY_GROUP, true);
    seedGroup("PRO_V1", false);
    const r = await register();
    t.check("201 on Beta", r.status === 201 && assignmentOf()?.policyGroup === DEFAULT_POLICY_GROUP);
  }

  t.section("3. an operator moved the default ⇒ new registrations get it");
  {
    world(); invalidatePolicyGroupCatalogue();
    seedGroup(DEFAULT_POLICY_GROUP, false);
    seedGroup("PRO_V1", true);
    const r = await register();
    t.check("201 on the DB default (PRO_V1)", r.status === 201 && assignmentOf()?.policyGroup === "PRO_V1", assignmentOf());
    t.check("…no overlay at birth", assignmentOf()?.overlay == null);
  }

  t.section("5. registration never writes a group definition");
  t.check("no create / update / delete on PolicyGroup or PolicyGroupVersion",
    ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"].every((op) =>
      fake.callsTo("PolicyGroup", op).length === 0 && fake.callsTo("PolicyGroupVersion", op).length === 0));

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
