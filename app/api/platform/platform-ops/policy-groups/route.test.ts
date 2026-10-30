/**
 * app/api/platform/platform-ops/policy-groups/route.test.ts  (PLATFORM OPS PHASE 1 UX)
 *
 * The REAL exported GET handlers of BOTH Policy Group catalogue routes, real
 * session cookies, the in-memory Prisma fake (lib/test-support/route-harness.ts).
 * Authorization runs through the unmodified chain — session →
 * requirePlatformAccess → the PlatformGrant row — never stubbed.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/platform/platform-ops/policy-groups/route.test.ts
 *
 * Proves: the new route is PLATFORM_OPS READ-gated (and only that); the Growth
 * route keeps its GROWTH_REVENUE READ gate; both answer the SAME shape — the
 * same body, bar the clock — from the ONE shared reader
 * (lib/platform/policy-groups-read.ts); neither exposes a mutating verb.
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { DEFAULT_POLICY_GROUP, DIMENSION_KEYS, POLICY_GROUPS } from "@/lib/entitlements/catalogue";

const t = makeChecker("/api/platform/{platform-ops,growth-revenue}/policy-groups");
const fake = new FakePrisma();
type Handler = (typeof import("./route"))["GET"];
let OPS_GET: Handler;
let GROWTH_GET: Handler;

const OPS_PATH = "/api/platform/platform-ops/policy-groups";
const GROWTH_PATH = "/api/platform/growth-revenue/policy-groups";

async function operator(name: string, grant: { area: string; level: string; status?: string } | null) {
  const u = fake.seed("User", { email: `${name}@example.test`, username: name, passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
  if (grant) fake.seed("PlatformGrant", { userId: u.id, area: grant.area, level: grant.level, status: grant.status ?? "ACTIVE" });
  return signIn(fake, u.id as string);
}

/** The counts the reader asks for — groupBy is configured (the fake never stubs it silently). */
function configureCounts() {
  const groupKey = Object.keys(POLICY_GROUPS)[0];
  fake.on("CustomerPolicyAssignment", "groupBy", (args) => {
    // POLICY EDITOR — the reader also groups by [policyGroup, overlay] (overlay counts per group); that one answers [].
    const by = (args.by as string[]).join();
    return by === "policyGroup"
      ? [{ policyGroup: groupKey, _count: { _all: 2 } }, { policyGroup: "RETIRED_GROUP", _count: { _all: 1 } }]
      : [];
  });
  fake.on("CustomerCohort", "groupBy", () => []);
}

async function main() {
  await installFakePrisma(fake);
  ({ GET: OPS_GET } = await import("./route"));
  ({ GET: GROWTH_GET } = await import("../../growth-revenue/policy-groups/route"));
  fake.reset();
  freshCache();
  configureCounts();
  const opsRead = await operator("ops-reader", { area: "PLATFORM_OPS", level: "READ" });
  const growthRead = await operator("growth-reader", { area: "GROWTH_REVENUE", level: "READ" });
  const csControl = await operator("cs", { area: "CUSTOMER_SUCCESS", level: "CONTROL" });
  const revoked = await operator("revoked", { area: "PLATFORM_OPS", level: "CONTROL", status: "REVOKED" });
  const customer = await operator("customer", null);

  const ops = (cookie?: string) => invoke(OPS_GET, request(OPS_PATH, { method: "GET", cookie }));
  const growth = (cookie?: string) => invoke(GROWTH_GET, request(GROWTH_PATH, { method: "GET", cookie }));

  t.section("1. the new route is PLATFORM_OPS READ-gated");
  t.check("anonymous → 401", (await ops()).status === 401);
  t.check("a customer with no grant → 403", (await ops(customer.cookie)).status === 403);
  t.check("GROWTH_REVENUE READ → 403 (another area's grant does not reach it)", (await ops(growthRead.cookie)).status === 403);
  t.check("CUSTOMER_SUCCESS CONTROL → 403", (await ops(csControl.cookie)).status === 403);
  t.check("a REVOKED PLATFORM_OPS grant → 403", (await ops(revoked.cookie)).status === 403);
  const opsOk = await ops(opsRead.cookie);
  t.check("PLATFORM_OPS READ → 200 (READ is enough: observation never needs more)", opsOk.status === 200, opsOk.body);

  t.section("2. the Growth route keeps its own gate");
  t.check("anonymous → 401", (await growth()).status === 401);
  t.check("PLATFORM_OPS READ → 403", (await growth(opsRead.cookie)).status === 403);
  const growthOk = await growth(growthRead.cookie);
  t.check("GROWTH_REVENUE READ → 200", growthOk.status === 200, growthOk.body);

  t.section("3. one reader, one shape");
  {
    type Body = Record<string, unknown> & { checkedAt?: string };
    const a = { ...(opsOk.body as Body) };
    const b = { ...(growthOk.body as Body) };
    t.check("both carry a checkedAt timestamp", typeof a.checkedAt === "string" && typeof b.checkedAt === "string");
    delete a.checkedAt; delete b.checkedAt;
    t.check("the two bodies are identical apart from the clock", JSON.stringify(a) === JSON.stringify(b), { a, b });
    t.check("the same top-level keys, in the same order",
      // + unassignedActiveCustomers: the active-only population the fail-closed Attention item counts.
      // + catalogueSource (POLICY EDITOR): where the group definitions came from (DB | CODE | CODE_FALLBACK).
      Object.keys(opsOk.body as Body).join() === "dimensions,policyGroups,overlays,cohorts,unassignedCustomers,unassignedActiveCustomers,unknownAssignments,defaultPolicyGroup,catalogueSource,checkedAt",
      Object.keys(opsOk.body as Body).join());
    const body = opsOk.body as {
      dimensions: { key: string }[]; policyGroups: { key: string; isDefault: boolean; customers: number }[];
      unassignedCustomers: number; unknownAssignments: number; defaultPolicyGroup: string;
    };
    t.check("every catalogue dimension and group is listed", body.dimensions.map((d) => d.key).join() === DIMENSION_KEYS.join()
      && body.policyGroups.map((g) => g.key).join() === Object.keys(POLICY_GROUPS).join());
    t.check("exactly one group is marked default, and it is the catalogue's", body.policyGroups.filter((g) => g.isDefault).map((g) => g.key).join() === DEFAULT_POLICY_GROUP
      && body.defaultPolicyGroup === DEFAULT_POLICY_GROUP);
    t.check("counts come from the configured groupBy: 2 on the first group, 1 unknown assignment",
      body.policyGroups[0].customers === 2 && body.unknownAssignments === 1, body);
    t.check("POLICY EDITOR: no PolicyGroup rows ⇒ the code catalogue, each group carries version/builtIn/archived/valid",
      (opsOk.body as { catalogueSource?: string }).catalogueSource === "DB"
        && (body.policyGroups as unknown as { valid: boolean; archived: boolean; builtIn: boolean; source: string }[]).every((g) => g.valid && !g.archived && g.builtIn && g.source === "CODE"));
    t.check("POLICY EDITOR: each dimension carries its editor category",
      (body.dimensions as unknown as { category?: string; categoryLabel?: string }[]).every((d) => typeof d.category === "string" && typeof d.categoryLabel === "string"));
    // Five seeded USER-role accounts; three assignment rows ⇒ two unassigned.
    t.check("unassigned = USER accounts minus assignment rows (never negative)", body.unassignedCustomers === 2, body.unassignedCustomers);
  }

  t.section("4. read-only");
  {
    const route = await import("./route");
    const growthRoute = await import("../../growth-revenue/policy-groups/route");
    const verbs = (m: Record<string, unknown>) => ["POST", "PUT", "PATCH", "DELETE"].filter((v) => v in m);
    // POLICY EDITOR — the list routes stay read-only; group WRITES live under
    // policy-groups/create and policy-groups/[key]/… at fresh CONTROL
    // (app/api/platform/platform-ops/policy-groups/editor-routes.test.ts).
    t.check("neither route exports a mutating verb", verbs(route).length === 0 && verbs(growthRoute).length === 0);
    t.check("the read wrote nothing", ["create", "update", "upsert", "delete", "createMany", "updateMany", "deleteMany"]
      .every((op) => fake.callsTo("CustomerPolicyAssignment", op).length === 0 && fake.callsTo("CustomerCohort", op).length === 0));
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
