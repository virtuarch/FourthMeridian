/**
 * app/api/platform/platform-ops/policy-groups/editor-routes.test.ts  (POLICY EDITOR)
 *
 * The REAL exported handlers of the five write routes and the group read, real
 * session cookies, the in-memory Prisma fake. Authorization runs through the
 * unmodified chain — session → require(Fresh)PlatformAccess → the PlatformGrant
 * row — never stubbed.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/platform/platform-ops/policy-groups/editor-routes.test.ts
 *
 * Proves:
 *   1. the auth matrix — GET [key] at PLATFORM_OPS READ; every write at fresh
 *      PLATFORM_OPS CONTROL (READ, WRITE, another area's CONTROL, a revoked grant,
 *      a customer and anonymous are all refused, and nothing is written);
 *   2. reason required; refusals past the grant are recorded
 *      (PLATFORM_CONTROL_REFUSED, control "policy-groups") WITHOUT the note;
 *   3. the flow over HTTP — create → read → stale edit 409 → edit → rollback →
 *      archive refused while assigned / for the default → make default;
 *   4. enforcement follows the edit on the next request (cache invalidated),
 *      the Founder overlay still applies on top, and nothing touched an assignment;
 *   5. Customer Success may ASSIGN a DB group and is refused an archived one.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed JSON bodies / metadata */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { BETA_FULL_ACCESS_V1, DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1 } from "@/lib/entitlements/catalogue";

const t = makeChecker("/api/platform/platform-ops/policy-groups/{create,[key],[key]/rollback,[key]/archive,[key]/default}");
const fake = new FakePrisma();
const BETA = BETA_FULL_ACCESS_V1.values;
const REASON = { code: "POLICY_ROLLOUT", note: "zebra crossing rationale" };

type H = (req: never, ctx?: never) => Promise<Response>;
let GET_KEY: H, PATCH_KEY: H, CREATE: H, ROLLBACK: H, ARCHIVE: H, DEFAULT: H, CS_POLICY: H;

async function operator(name: string, grant: { area: string; level: string; status?: string } | null) {
  const u = fake.seed("User", { email: `${name}@example.test`, username: name, passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
  if (grant) fake.seed("PlatformGrant", { userId: u.id, area: grant.area, level: grant.level, status: grant.status ?? "ACTIVE" });
  return signIn(fake, u.id as string);
}
function customer(name: string, policyGroup: string | null, overlay: string | null = null) {
  const u = fake.seed("User", { email: `${name}@example.test`, username: name, passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
  if (policyGroup) fake.seed("CustomerPolicyAssignment", { userId: u.id, policyGroup, overlay });
  return u.id as string;
}

async function main() {
  await installFakePrisma(fake);
  fake.partialUnique("PolicyGroup", ["isDefault"], { isDefault: true }, "PolicyGroup_single_default");
  ({ GET: GET_KEY, PATCH: PATCH_KEY } = await import("./[key]/route") as never);
  ({ POST: CREATE } = await import("./create/route") as never);
  ({ POST: ROLLBACK } = await import("./[key]/rollback/route") as never);
  ({ POST: ARCHIVE } = await import("./[key]/archive/route") as never);
  ({ POST: DEFAULT } = await import("./[key]/default/route") as never);
  ({ POST: CS_POLICY } = await import("../../customer-success/customers/[userId]/policy/route") as never);
  const { invalidatePolicyGroupCatalogue } = await import("@/lib/platform/policies/policy-group-catalogue");
  const { entitlementsForUser } = await import("@/lib/entitlements/consume");
  fake.reset();
  freshCache();
  invalidatePolicyGroupCatalogue();
  // Review fix 3 — the row locks (archive FOR UPDATE, CS assign FOR SHARE) answered from the fake's rows.
  fake.queryRaw = (sql, values) => {
    if (!/FROM "PolicyGroup" WHERE "key" = \? FOR (UPDATE|SHARE)$/.test(sql.trim())) throw new Error(`unexpected raw SQL: ${sql}`);
    return fake.rows("PolicyGroup", { key: values[0] as string }).map((r) => ({ key: r.key, archivedAt: r.archivedAt ?? null }));
  };
  // groupBy is computed from the fake's rows (the fake never stubs it silently).
  fake.on("CustomerPolicyAssignment", "groupBy", (args) => {
    const by = args.by as string[];
    const groups = new Map<string, Record<string, unknown>>();
    for (const r of fake.rows("CustomerPolicyAssignment", (args.where ?? {}) as Record<string, unknown>)) {
      const k = JSON.stringify(by.map((f) => r[f] ?? null));
      const g = groups.get(k) ?? { ...Object.fromEntries(by.map((f) => [f, r[f] ?? null])), _count: { _all: 0 } };
      (g._count as { _all: number })._all++;
      groups.set(k, g);
    }
    return [...groups.values()];
  });

  // The migration's seed.
  fake.seed("PolicyGroup", { key: DEFAULT_POLICY_GROUP, label: BETA_FULL_ACCESS_V1.label, description: BETA_FULL_ACCESS_V1.description, isDefault: true, builtIn: true, currentVersion: 1 });
  fake.seed("PolicyGroupVersion", { groupKey: DEFAULT_POLICY_GROUP, version: 1, values: { ...BETA }, label: BETA_FULL_ACCESS_V1.label, changeSummary: { kind: "SEEDED", changes: [] }, reasonCode: "POLICY_ROLLOUT" });

  const anon = undefined;
  const cust = await operator("plaincustomer", null);
  const read = await operator("opsread", { area: "PLATFORM_OPS", level: "READ" });
  const write = await operator("opswrite", { area: "PLATFORM_OPS", level: "WRITE" });
  const otherArea = await operator("cscontrol", { area: "CUSTOMER_SUCCESS", level: "CONTROL" });
  const revoked = await operator("revoked", { area: "PLATFORM_OPS", level: "CONTROL", status: "REVOKED" });
  const control = await operator("opscontrol", { area: "PLATFORM_OPS", level: "CONTROL" });
  const csWrite = await operator("cswrite", { area: "CUSTOMER_SUCCESS", level: "WRITE" });
  const betaA = customer("betaa", DEFAULT_POLICY_GROUP);
  const founder = customer("foundercust", DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1.key);
  const unassigned = customer("unassigned", null);
  const assignmentSnapshot = () => JSON.stringify(fake.rows("CustomerPolicyAssignment").map((r) => [r.userId, r.policyGroup, r.overlay, String(r.assignedAt)]).sort());
  const before = assignmentSnapshot();

  const P = (k: string, tail = "") => `/api/platform/platform-ops/policy-groups/${k}${tail}`;
  const call = (h: H, path: string, method: string, cookie: string | undefined, body?: unknown, params: Record<string, unknown> = {}) =>
    invoke<Record<string, any>>(h, request(path, { method, cookie, ...(body !== undefined ? { body } : {}) }), params);
  const getKey = (cookie: string | undefined, key: string) => call(GET_KEY, P(key), "GET", cookie, undefined, { key });
  const create = (cookie: string | undefined, body: unknown) => call(CREATE, P("create"), "POST", cookie, body);
  const patch = (cookie: string | undefined, key: string, body: unknown) => call(PATCH_KEY, P(key), "PATCH", cookie, body, { key });
  const rollback = (cookie: string | undefined, key: string, body: unknown) => call(ROLLBACK, P(key, "/rollback"), "POST", cookie, body, { key });
  const archive = (cookie: string | undefined, key: string, body: unknown) => call(ARCHIVE, P(key, "/archive"), "POST", cookie, body, { key });
  const makeDefault = (cookie: string | undefined, key: string, body: unknown) => call(DEFAULT, P(key, "/default"), "POST", cookie, body, { key });
  const groupWrites = () => fake.rows("PolicyGroup").length + fake.rows("PolicyGroupVersion").length;

  t.section("1. auth matrix");
  t.check("GET [key]: anonymous → 401", (await getKey(anon, DEFAULT_POLICY_GROUP)).status === 401);
  t.check("GET [key]: a customer → 403", (await getKey(cust.cookie, DEFAULT_POLICY_GROUP)).status === 403);
  t.check("GET [key]: another area's CONTROL → 403", (await getKey(otherArea.cookie, DEFAULT_POLICY_GROUP)).status === 403);
  const g = await getKey(read.cookie, DEFAULT_POLICY_GROUP);
  t.check("GET [key]: PLATFORM_OPS READ → 200 (observation never needs more)", g.status === 200, g.body);
  t.check("GET [key]: an unknown key → 404", (await getKey(read.cookie, "NOPE_V1")).status === 404);
  {
    const writesBefore = groupWrites();
    const valid = { create: { key: "PRO_V1", label: "Pro", from: "DEFAULT", reason: REASON }, patch: { expectedVersion: 1, values: { ...BETA, exportsPerDay: 5 }, reason: REASON } };
    for (const [who, s, code] of [["anonymous", undefined, 401], ["a customer", cust, 403], ["PLATFORM_OPS READ", read, 403], ["PLATFORM_OPS WRITE (CONTROL is a rank above)", write, 403],
      ["another area's CONTROL", otherArea, 403], ["a REVOKED CONTROL grant", revoked, 403]] as const) {
      const c = s?.cookie;
      const codes = [
        (await create(c, valid.create)).status, (await patch(c, DEFAULT_POLICY_GROUP, valid.patch)).status,
        (await rollback(c, DEFAULT_POLICY_GROUP, { expectedVersion: 1, toVersion: 1, reason: REASON })).status,
        (await archive(c, DEFAULT_POLICY_GROUP, { reason: REASON })).status,
        (await makeDefault(c, DEFAULT_POLICY_GROUP, { expectedDefaultKey: DEFAULT_POLICY_GROUP, reason: REASON })).status,
      ];
      t.check(`${who} → ${code} on create, edit, rollback, archive and default`, codes.every((x) => x === code), codes);
    }
    t.check("…and none of them wrote a group, a version or an audit row of the editor",
      groupWrites() === writesBefore && fake.rows("AuditLog").filter((r) => String(r.action).startsWith("POLICY_GROUP_")).length === 0);
  }

  t.section("2. reason required; refusals recorded without the note");
  {
    const refusalsBefore = fake.rows("AuditLog", { action: "PLATFORM_CONTROL_REFUSED" }).length;
    t.check("no reason → 400", (await create(control.cookie, { key: "PRO_V1", label: "Pro", from: "DEFAULT" })).status === 400);
    t.check("a bad reason code → 400", (await patch(control.cookie, DEFAULT_POLICY_GROUP, { expectedVersion: 1, values: BETA, reason: { code: "BECAUSE" } })).status === 400);
    t.check("an unsafe note (long digit run) → 400", (await archive(control.cookie, DEFAULT_POLICY_GROUP, { reason: { code: "OTHER", note: "card 4111111111111111" } })).status === 400);
    const bad = await patch(control.cookie, DEFAULT_POLICY_GROUP, { expectedVersion: 1, values: { ...BETA, maxConnections: 999 }, reason: REASON });
    t.check("values above a ceiling → 400 VALIDATION naming the dimension", bad.status === 400 && bad.body.code === "VALIDATION" && (bad.body.errors as string[]).some((e) => /Maximum connections/.test(e)), bad.body);
    t.check("missing expectedVersion → 400", (await patch(control.cookie, DEFAULT_POLICY_GROUP, { values: BETA, reason: REASON })).status === 400);
    t.check("create with no `from` → 400", (await create(control.cookie, { key: "PRO_V1", label: "Pro", reason: REASON })).status === 400);
    const refusals = fake.rows("AuditLog", { action: "PLATFORM_CONTROL_REFUSED" }).slice(refusalsBefore);
    t.check("each refusal past the grant is ONE PLATFORM_CONTROL_REFUSED row, control policy-groups, with the verb and code",
      refusals.length === 6 && refusals.every((r) => (r.metadata as any).control === "policy-groups" && (r.metadata as any).result === "REFUSED")
        && refusals.map((r) => (r.metadata as any).verb).join() === "create,change,archive,change,change,create", refusals.map((r) => (r.metadata as any).verb));
    t.check("…targeting the group key (closed vocabulary) and never the note, the values or the digits",
      (refusals[1].metadata as any).target.id === `policy-group:${DEFAULT_POLICY_GROUP}`
        && !JSON.stringify(refusals).includes("4111111111111111") && !JSON.stringify(refusals).includes("zebra") && !JSON.stringify(refusals).includes("999"));
    t.check("…the reason CODE is kept when it parsed", (refusals[3].metadata as any).reason?.code === "POLICY_ROLLOUT" && (refusals[3].metadata as any).reason?.note === undefined);
  }

  t.section("3. the flow");
  {
    const c = await create(control.cookie, { key: "PRO_V1", label: "Pro", description: "Draft paid tier", from: "DEFAULT", values: { ...BETA, maxConnections: 25 }, reason: REASON });
    t.check("create → 201 version 1", c.status === 201 && c.body.version === 1 && c.body.key === "PRO_V1", c.body);
    t.check("a duplicate key → 409 CONFLICT", (await create(control.cookie, { key: "PRO_V1", label: "Pro", from: "DEFAULT", reason: REASON })).status === 409);
    const clone = await create(control.cookie, { key: "PRO_V1_TRIAL", label: "Pro trial", from: "PRO_V1", reason: REASON });
    t.check("clone → 201 with the source's values", clone.status === 201 && (fake.one("PolicyGroupVersion", { groupKey: "PRO_V1_TRIAL" })!.values as any).maxConnections === 25);

    const d = (await getKey(read.cookie, DEFAULT_POLICY_GROUP)).body;
    t.check("GET [key]: current version, history, counts by (overlay, override), no customer identity",
      d.group.version === 1 && d.versions.length === 1 && d.versions[0].createdBy === "Seeded from code" && d.assignments.customers === 2 && d.assignments.withFounder === 1
        && !JSON.stringify(d).includes(betaA) && !JSON.stringify(d).includes(founder) && !/@example\.test|betaa|foundercust/.test(JSON.stringify(d)));
    t.check("GET [key]: the default group counts the unassigned ACTIVE customers resolving to it (switch off)", d.assignments.unassignedResolvingHere >= 1);
    t.check("GET [key]: effective preview plain + with Founder (resolver values)", d.effective.plain.exportsPerDay.value === 3 && d.effective.founder.exportsPerDay.value === 10);
    t.check("GET [key]: cost exposure is an estimated ceiling; measured spend 'not yet available' (never invented)",
      typeof d.cost.current.ceilingUsdPerDay === "number" && d.cost.measured30dUsd === null && /not yet available/.test(d.cost.measuredNote));

    const stale = await patch(control.cookie, DEFAULT_POLICY_GROUP, { expectedVersion: 4, values: { ...BETA, exportsPerDay: 5 }, reason: REASON });
    t.check("edit with a stale expectedVersion → 409 CONFLICT, nothing written", stale.status === 409 && stale.body.code === "CONFLICT" && fake.rows("PolicyGroupVersion", { groupKey: DEFAULT_POLICY_GROUP }).length === 1);
    const e = await patch(control.cookie, DEFAULT_POLICY_GROUP, { expectedVersion: 1, values: { ...BETA, exportsPerDay: 5 }, reason: REASON });
    t.check("edit → 200 version 2 (1 change, 2 customers affected)", e.status === 200 && e.body.version === 2 && e.body.changes.length === 1 && e.body.customersAffected === 2, e.body);

    t.section("4. enforcement follows on the next request; Founder still on top; assignments untouched");
    const ea = await entitlementsForUser(betaA);
    t.check("a Beta customer now has exports 5 (the new version), source POLICY", ea.dimensions.exportsPerDay.value === 5 && ea.dimensions.exportsPerDay.source === "POLICY");
    const ef = await entitlementsForUser(founder);
    t.check("the Founder customer: overlay still applied on top of the edited Beta (exports 10, OVERLAY)", ef.dimensions.exportsPerDay.value === 10 && ef.dimensions.exportsPerDay.source === "OVERLAY" && ef.overlay === FOUNDER_INTERNAL_V1.key);
    const eu = await entitlementsForUser(unassigned);
    t.check("an unassigned customer (switch off) resolves to the edited default, reported POLICY_DEFAULT", eu.dimensions.exportsPerDay.value === 5 && eu.dimensions.exportsPerDay.source === "POLICY_DEFAULT");

    const rb = await rollback(control.cookie, DEFAULT_POLICY_GROUP, { expectedVersion: 2, toVersion: 1, reason: REASON });
    t.check("rollback → 200 version 3 (values of v1)", rb.status === 200 && rb.body.version === 3);
    t.check("…enforcement is back to exports 3", (await entitlementsForUser(betaA)).dimensions.exportsPerDay.value === 3);

    const archDefault = await archive(control.cookie, DEFAULT_POLICY_GROUP, { reason: REASON });
    t.check("archive the default → 409 NOT_EDITABLE", archDefault.status === 409 && archDefault.body.code === "NOT_EDITABLE");
    const archBuiltIn = await archive(control.cookie, DEFAULT_POLICY_GROUP, { reason: REASON });
    t.check("archive a BUILT-IN group → 409 NOT_EDITABLE", archBuiltIn.status === 409 && archBuiltIn.body.code === "NOT_EDITABLE");
    const proCustomer = customer("procust", "PRO_V1");
    const archAssigned = await archive(control.cookie, "PRO_V1", { reason: REASON });
    t.check("archive a group with an assignment → 409 CONFLICT (reassign first)", archAssigned.status === 409 && archAssigned.body.code === "CONFLICT" && /assigned/.test(archAssigned.body.error));
    const arch = await archive(control.cookie, "PRO_V1_TRIAL", { reason: REASON });
    t.check("archive an unassigned group → 200", arch.status === 200 && typeof arch.body.archivedAt === "string");

    const staleDefault = await makeDefault(control.cookie, "PRO_V1", { expectedDefaultKey: "PRO_V1", reason: REASON });
    t.check("make default with a stale expectedDefaultKey → 409", staleDefault.status === 409);
    const md = await makeDefault(control.cookie, "PRO_V1", { expectedDefaultKey: DEFAULT_POLICY_GROUP, reason: REASON });
    t.check("make default → 200 (previous Beta)", md.status === 200 && md.body.previousDefault === DEFAULT_POLICY_GROUP);
    const archBetaNotDefault = await archive(control.cookie, DEFAULT_POLICY_GROUP, { reason: REASON });
    t.check("…Beta, no longer the default, is STILL not archivable (built-in) → 409 'Built-in groups cannot be archived'",
      archBetaNotDefault.status === 409 && /Built-in groups cannot be archived/.test(String(archBetaNotDefault.body.error)));
    const cloneArchived = await create(control.cookie, { key: "FROM_TRIAL_V1", label: "x", from: "PRO_V1_TRIAL", reason: REASON });
    t.check("clone FROM an archived group → 409 NOT_EDITABLE", cloneArchived.status === 409 && cloneArchived.body.code === "NOT_EDITABLE");
    t.check("…exactly one default row", fake.rows("PolicyGroup", { isDefault: true }).map((r) => r.key).join() === "PRO_V1");
    const back = await makeDefault(control.cookie, DEFAULT_POLICY_GROUP, { expectedDefaultKey: "PRO_V1", reason: REASON });
    t.check("…and back to Beta (owner ruling: Beta is the default)", back.status === 200);

    t.check("no editor operation created, changed or deleted any existing customer's assignment",
      JSON.stringify(JSON.parse(assignmentSnapshot()).filter((r: unknown[]) => r[0] !== proCustomer)) === before);
    const editorAudits = fake.rows("AuditLog").filter((r) => String(r.action).startsWith("POLICY_GROUP_"));
    t.check("one audit row per successful operation (2 create, 1 edit, 1 rollback, 1 archive, 2 default)",
      editorAudits.map((r) => r.action).join() === "POLICY_GROUP_CREATED,POLICY_GROUP_CREATED,POLICY_GROUP_UPDATED,POLICY_GROUP_ROLLED_BACK,POLICY_GROUP_ARCHIVED,POLICY_GROUP_DEFAULT_CHANGED,POLICY_GROUP_DEFAULT_CHANGED", editorAudits.map((r) => r.action));
    t.check("…none names a customer", ![betaA, founder, unassigned, proCustomer].some((id) => JSON.stringify(editorAudits).includes(id)));
  }

  t.section("5. Customer Success assigns DB groups, never archived ones");
  {
    const assign = (userId: string, body: unknown) => invoke<Record<string, any>>(CS_POLICY, request(`/api/platform/customer-success/customers/${userId}/policy`, { method: "POST", cookie: csWrite.cookie, body }), { userId });
    const ok = await assign(betaA, { policyGroup: "PRO_V1", reason: { code: "SUPPORT_REQUEST" } });
    t.check("CS WRITE assigns a non-archived DB group → 200, labelled from the catalogue", ok.status === 200 && ok.body.policy.policyGroup === "PRO_V1" && ok.body.policy.policyGroupLabel === "Pro", ok.body);
    const archived = await assign(betaA, { policyGroup: "PRO_V1_TRIAL", reason: { code: "SUPPORT_REQUEST" } });
    t.check("an ARCHIVED group → 400, nothing changed", archived.status === 400 && /archived/.test(archived.body.error) && fake.one("CustomerPolicyAssignment", { userId: betaA })!.policyGroup === "PRO_V1");
    const unknown = await assign(betaA, { policyGroup: "NOPE_V1", reason: { code: "SUPPORT_REQUEST" } });
    t.check("an unknown group → 400", unknown.status === 400 && /Unknown policy group/.test(unknown.body.error));
    const fc = await assign(betaA, { policyGroup: "FAIL_CLOSED", reason: { code: "SUPPORT_REQUEST" } });
    t.check("the restricted set is never assignable → 400", fc.status === 400);
    const back = await assign(betaA, { policyGroup: DEFAULT_POLICY_GROUP, reason: { code: "SUPPORT_REQUEST" } });
    t.check("…and a code / seeded group still is (Beta) → 200", back.status === 200 && back.body.policy.policyGroup === DEFAULT_POLICY_GROUP);
    t.check("CS cannot reach any editor write (CUSTOMER_SUCCESS WRITE → 403)", (await create(csWrite.cookie, { key: "CS_GROUP", label: "x", from: "DEFAULT", reason: REASON })).status === 403);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
