/**
 * app/api/platform/platform-ops/policy-groups/lifecycle-routes.test.ts  (BETA LIFECYCLE L1)
 *
 * The REAL exported handlers of /policy-groups/[key]/lifecycle, real session
 * cookies, the in-memory Prisma fake (the real schema); authorization runs the
 * unmodified chain. Also the gate and Beta-lifecycle readers against the same
 * fake, through the real cached catalogue loader.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/platform/platform-ops/policy-groups/lifecycle-routes.test.ts
 *
 * Proves:
 *   1. auth — GET at PLATFORM_OPS READ; POST at FRESH PLATFORM_OPS CONTROL only
 *      (READ, WRITE, another area's CONTROL, a revoked grant, a customer and
 *      anonymous refused; nothing written);
 *   2. validation — action and reason required; refusals recorded without the note;
 *   3. the flow over HTTP — pause → (pause again refused) → freeze → resume →
 *      unfreeze → end → reopen without a note refused → reopen with a note;
 *      stale expectedVersion refused; archived group refused; one transition
 *      row + one audit row per success, none per refusal; no assignment touched;
 *   4. atomicity — an audit failure rolls back the group change AND the transition;
 *   5. propagation — after a write on this instance, the resolver and the gate
 *      see it on the very next call (cache invalidated); Founder / override
 *      never bypass;
 *   6. the gate I/O — single, Space-scoped (one owner / none / two), batch
 *      (ONE catalogue read + ONE assignment query), read failure ⇒ fail closed;
 *   7. freshness — the gate never uses the last-good copy; a cached read older
 *      than 30 s is re-read; a lifecycle read failure fails billable closed while
 *      entitlement values still resolve;
 *   8. getBetaLifecycleState — ACTIVE / PAUSED / ENDED / UNKNOWN (unreadable,
 *      no Beta row), cached and through a client;
 *   9. the GET read model — state, member counts, history newest first.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed JSON bodies / metadata */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { BETA_FULL_ACCESS_V1, DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1 } from "@/lib/entitlements/catalogue";
import { readFileSync } from "node:fs";
import path from "node:path";

const t = makeChecker("/api/platform/platform-ops/policy-groups/[key]/lifecycle + the billable gate");
const fake = new FakePrisma();
const BETA = BETA_FULL_ACCESS_V1.values;
const REASON = { code: "POLICY_ROLLOUT", note: "cost review window" };
type H = (req: never, ctx?: never) => Promise<Response>;

async function operator(name: string, grant: { area: string; level: string; status?: string } | null) {
  const u = fake.seed("User", { email: `${name}@example.test`, username: name, passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
  if (grant) fake.seed("PlatformGrant", { userId: u.id, area: grant.area, level: grant.level, status: grant.status ?? "ACTIVE" });
  return signIn(fake, u.id as string);
}
function customer(name: string, policyGroup: string | null, overlay: string | null = null, override: number | null = null) {
  const u = fake.seed("User", { email: `${name}@example.test`, username: name, passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
  if (policyGroup) fake.seed("CustomerPolicyAssignment", { userId: u.id, policyGroup, overlay, aiDailyUsdAllowanceOverride: override });
  return u.id as string;
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function main() {
  await installFakePrisma(fake);
  fake.partialUnique("PolicyGroup", ["isDefault"], { isDefault: true }, "PolicyGroup_single_default");
  const { GET, POST } = await import("./[key]/lifecycle/route") as unknown as { GET: H; POST: H };
  const C = await import("@/lib/platform/policies/policy-group-catalogue");
  const { entitlementsForUser } = await import("@/lib/entitlements/consume");
  const G = await import("@/lib/entitlements/billable-gate");
  const { getBetaLifecycleState } = await import("@/lib/entitlements/beta-lifecycle");
  fake.reset();
  freshCache();
  C.invalidatePolicyGroupCatalogue();
  const locks: string[] = [];
  fake.queryRaw = (sql, values) => {
    if (!/FROM "PolicyGroup" WHERE "key" = \? FOR (UPDATE|SHARE)$/.test(sql.trim())) throw new Error(`unexpected raw SQL: ${sql}`);
    locks.push(String(values[0]));
    return fake.rows("PolicyGroup", { key: values[0] as string }).map((r) => ({ key: r.key }));
  };

  // The editor migration's seed (the lifecycle migration's column defaults apply: ACTIVE, not frozen, version 0).
  fake.seed("PolicyGroup", { key: DEFAULT_POLICY_GROUP, label: BETA_FULL_ACCESS_V1.label, description: BETA_FULL_ACCESS_V1.description, isDefault: true, builtIn: true, currentVersion: 1 });
  fake.seed("PolicyGroupVersion", { groupKey: DEFAULT_POLICY_GROUP, version: 1, values: { ...BETA }, label: BETA_FULL_ACCESS_V1.label, changeSummary: { kind: "SEEDED", changes: [] }, reasonCode: "POLICY_ROLLOUT" });
  fake.seed("PolicyGroup", { key: "PRO_V1", label: "Pro", description: "", isDefault: false, builtIn: false, currentVersion: 1 });
  fake.seed("PolicyGroupVersion", { groupKey: "PRO_V1", version: 1, values: { ...BETA }, label: "Pro", changeSummary: { kind: "CREATED", changes: [] }, reasonCode: "POLICY_ROLLOUT" });
  fake.seed("PolicyGroup", { key: "OLD_V1", label: "Old", description: "", isDefault: false, builtIn: false, currentVersion: 1, archivedAt: new Date() });
  fake.seed("PolicyGroupVersion", { groupKey: "OLD_V1", version: 1, values: { ...BETA }, label: "Old", changeSummary: { kind: "CREATED", changes: [] }, reasonCode: "POLICY_ROLLOUT" });

  const anon = undefined;
  const cust = await operator("plaincustomer", null);
  const read = await operator("opsread", { area: "PLATFORM_OPS", level: "READ" });
  const write = await operator("opswrite", { area: "PLATFORM_OPS", level: "WRITE" });
  const otherArea = await operator("cscontrol", { area: "CUSTOMER_SUCCESS", level: "CONTROL" });
  const revoked = await operator("revoked", { area: "PLATFORM_OPS", level: "CONTROL", status: "REVOKED" });
  const control = await operator("opscontrol", { area: "PLATFORM_OPS", level: "CONTROL" });
  const betaA = customer("betaa", DEFAULT_POLICY_GROUP);
  const founder = customer("foundercust", DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1.key, 20);
  const pro = customer("procust", "PRO_V1");
  const coOwner = customer("coowner", DEFAULT_POLICY_GROUP);
  const assignmentSnapshot = () => JSON.stringify(fake.rows("CustomerPolicyAssignment").map((r) => [r.userId, r.policyGroup, r.overlay, r.aiDailyUsdAllowanceOverride, String(r.assignedAt)]).sort());
  const assignmentsBefore = assignmentSnapshot();

  const P = (k: string) => `/api/platform/platform-ops/policy-groups/${k}/lifecycle`;
  const get = (cookie: string | undefined, key: string) => invoke<Record<string, any>>(GET, request(P(key), { method: "GET", cookie }), { key });
  const post = (cookie: string | undefined, key: string, body: unknown) => invoke<Record<string, any>>(POST, request(P(key), { method: "POST", cookie, body }), { key });
  const transitions = (key = DEFAULT_POLICY_GROUP) => fake.rows("PolicyGroupTransition", { groupKey: key });
  const lifecycleAudits = () => fake.rows("AuditLog").filter((r) => /^POLICY_GROUP_(PAUSED|RESUMED|ENDED|COST_FROZEN|COST_UNFROZEN)$/.test(String(r.action)));
  const beta = () => fake.rows("PolicyGroup", { key: DEFAULT_POLICY_GROUP })[0];

  t.section("1. auth");
  t.check("GET: anonymous → 401", (await get(anon, DEFAULT_POLICY_GROUP)).status === 401);
  t.check("GET: a customer → 403", (await get(cust.cookie, DEFAULT_POLICY_GROUP)).status === 403);
  t.check("GET: another area's CONTROL → 403", (await get(otherArea.cookie, DEFAULT_POLICY_GROUP)).status === 403);
  t.check("GET: PLATFORM_OPS READ → 200", (await get(read.cookie, DEFAULT_POLICY_GROUP)).status === 200);
  t.check("GET: unknown key → 404", (await get(read.cookie, "NOPE_V1")).status === 404);
  for (const [who, s, status] of [["anonymous", undefined, 401], ["a customer", cust, 403], ["PLATFORM_OPS READ", read, 403], ["PLATFORM_OPS WRITE", write, 403],
    ["another area's CONTROL", otherArea, 403], ["a REVOKED CONTROL grant", revoked, 403]] as const) {
    const codes = [];
    for (const action of ["pause", "resume", "end", "freeze", "unfreeze"]) codes.push((await post(s?.cookie, DEFAULT_POLICY_GROUP, { action, reason: REASON })).status);
    t.check(`POST by ${who} → ${status} for every action`, codes.every((c) => c === status), codes);
  }
  t.check("…and nothing was written (no transition, no lifecycle audit, Beta untouched)",
    transitions().length === 0 && lifecycleAudits().length === 0 && beta().lifecycle === "ACTIVE" && beta().costFrozen === false && beta().lifecycleVersion === 0);

  t.section("2. validation");
  {
    const before = fake.rows("AuditLog", { action: "PLATFORM_CONTROL_REFUSED" }).length;
    t.check("no action → 400", (await post(control.cookie, DEFAULT_POLICY_GROUP, { reason: REASON })).status === 400);
    t.check("an unknown action → 400", (await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "delete", reason: REASON })).status === 400);
    t.check("no reason → 400", (await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "pause" })).status === 400);
    t.check("a bad expectedVersion → 400", (await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "pause", reason: REASON, expectedVersion: -1 })).status === 400);
    const refused = fake.rows("AuditLog", { action: "PLATFORM_CONTROL_REFUSED" }).slice(before);
    t.check("each refusal past the grant is recorded (control policy-groups) without the note",
      refused.length === 4 && refused.every((r) => (r.metadata as any).control === "policy-groups" && !JSON.stringify(r.metadata).includes(REASON.note)), refused.map((r) => r.metadata));
    t.check("a refusal of a known action is recorded under its verb", (refused[2].metadata as any).verb === "pause" && (refused[0].metadata as any).verb === "change");
    t.check("nothing changed", transitions().length === 0 && beta().lifecycleVersion === 0);
  }

  t.section("3. the flow over HTTP");
  {
    const p = await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "pause", reason: REASON, expectedVersion: 0 });
    t.check("pause → 200: ACTIVE → PAUSED, version 1, member count, default flagged",
      p.status === 200 && p.body.kind === "PAUSE" && p.body.from.lifecycle === "ACTIVE" && p.body.to.lifecycle === "PAUSED" && p.body.lifecycleVersion === 1
        && p.body.membersAffected === 3 && p.body.isDefault === true, p.body);
    t.check("the row lock was taken on the group", locks.includes(DEFAULT_POLICY_GROUP));
    t.check("ONE transition row: PAUSE, ACTIVE → PAUSED, reason + operator",
      transitions().length === 1 && transitions()[0].kind === "PAUSE" && transitions()[0].fromLifecycle === "ACTIVE" && transitions()[0].toLifecycle === "PAUSED"
        && transitions()[0].reasonCode === "POLICY_ROLLOUT" && transitions()[0].reasonNote === REASON.note && transitions()[0].operatorId === control.userId);
    const a = lifecycleAudits();
    t.check("ONE POLICY_GROUP_PAUSED audit row: POLICY_GROUP target, reason, before/after, counts — never a customer id",
      a.length === 1 && a[0].action === "POLICY_GROUP_PAUSED" && (a[0].metadata as any).target.kind === "POLICY_GROUP" && (a[0].metadata as any).reason.code === "POLICY_ROLLOUT"
        && (a[0].metadata as any).change.after.lifecycle === "PAUSED" && (a[0].metadata as any).membersAffected === 3
        && ![betaA, founder, coOwner].some((id) => JSON.stringify(a[0]).includes(id)), a[0]?.metadata);
    t.check("pause again → 409 (invalid transition), nothing written",
      (await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "pause", reason: REASON })).status === 409 && transitions().length === 1);
    t.check("a stale expectedVersion → 409", (await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "freeze", reason: REASON, expectedVersion: 0 })).status === 409 && transitions().length === 1);
    const f = await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "freeze", reason: REASON, expectedVersion: 1 });
    t.check("freeze on PAUSED → 200: lifecycle unchanged, frozen", f.status === 200 && f.body.to.lifecycle === "PAUSED" && f.body.to.costFrozen === true && beta().costFrozen === true);
    t.check("freeze again → 409", (await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "freeze", reason: REASON })).status === 409);
    const r = await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "resume", reason: { code: "POLICY_ROLLOUT" } });
    t.check("resume from PAUSED (no note needed) → ACTIVE, still frozen", r.status === 200 && beta().lifecycle === "ACTIVE" && beta().costFrozen === true);
    t.check("resume again → 409", (await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "resume", reason: REASON })).status === 409);
    t.check("unfreeze → 200", (await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "unfreeze", reason: REASON })).status === 200 && beta().costFrozen === false);
    t.check("unfreeze again → 409", (await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "unfreeze", reason: REASON })).status === 409);
    const e = await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "end", reason: REASON });
    t.check("end → 200: ENDED with endedTransition READ_ONLY", e.status === 200 && beta().lifecycle === "ENDED" && beta().endedTransition === "READ_ONLY");
    t.check("end again → 409; pause an ended group → 409",
      (await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "end", reason: REASON })).status === 409
        && (await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "pause", reason: REASON })).status === 409);
    const noNote = await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "resume", reason: { code: "POLICY_ROLLOUT" } });
    t.check("reopen (resume from ENDED) WITHOUT a note → 400, still ENDED", noNote.status === 400 && beta().lifecycle === "ENDED", noNote.body);
    const reopen = await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "resume", reason: { code: "POLICY_ROLLOUT", note: "owner reopened the beta" } });
    t.check("reopen WITH a note → 200: ACTIVE, endedTransition cleared, audited as reopened",
      reopen.status === 200 && beta().lifecycle === "ACTIVE" && beta().endedTransition === null
        && (lifecycleAudits().at(-1)!.metadata as any).reopened === true);
    t.check("history: 6 transitions, kinds in order, version 6",
      transitions().map((x) => x.kind).join() === "PAUSE,FREEZE,RESUME,UNFREEZE,END,RESUME" && beta().lifecycleVersion === 6, transitions().map((x) => x.kind));
    t.check("one audit row per successful transition (6)", lifecycleAudits().length === 6);
    t.check("an archived group → 409 NOT_EDITABLE", (await post(control.cookie, "OLD_V1", { action: "pause", reason: REASON })).body.code === "NOT_EDITABLE");
    t.check("an unknown group → 404", (await post(control.cookie, "NOPE_V1", { action: "pause", reason: REASON })).status === 404);
    t.check("NO assignment was created, changed or deleted", assignmentSnapshot() === assignmentsBefore);
  }

  t.section("4. atomicity — audit failure rolls everything back");
  {
    const tBefore = transitions().length, vBefore = beta().lifecycleVersion;
    fake.on("AuditLog", "create", () => { throw new Error("audit store down"); }, { once: true });
    let status: number | "threw";
    try { status = (await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "freeze", reason: REASON })).status; } catch { status = "threw"; }
    t.check("the write did not succeed (the error propagates — never a 200)", status === "threw" || status === 500, status);
    t.check("the group is unchanged (not frozen, same version) and NO transition row survived",
      beta().costFrozen === false && beta().lifecycleVersion === vBefore && transitions().length === tBefore, { frozen: beta().costFrozen, v: beta().lifecycleVersion, n: transitions().length });
    fake.clearHooks();
  }

  t.section("5. propagation — the next call on this instance sees the write");
  {
    C.invalidatePolicyGroupCatalogue();
    const before = await entitlementsForUser(founder);
    const gateBefore = await G.assertBillableAllowed({ userId: founder, operation: "ai_chat" });
    t.check("ACTIVE: the Founder customer has $20 and ai_chat is allowed", before.dimensions.aiDailyUsdAllowance.value === 20 && gateBefore.allowed, gateBefore);
    await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "freeze", reason: REASON });
    const after = await entitlementsForUser(founder);
    const gateAfter = await G.assertBillableAllowed({ userId: founder, operation: "ai_chat" });
    t.check("after FREEZE (no TTL wait): allowance $0 (LIFECYCLE) despite the overlay and the $20 override",
      after.dimensions.aiDailyUsdAllowance.value === 0 && after.dimensions.aiDailyUsdAllowance.source === "LIFECYCLE" && after.lifecycleRestriction === "COST_FREEZE");
    t.check("…and the gate says COST_FREEZE", !gateAfter.allowed && gateAfter.reason === "COST_FREEZE", gateAfter);
    const proGate = await G.assertBillableAllowed({ userId: pro, operation: "plaid_sync" });
    t.check("a PRO_V1 member is unaffected", proGate.allowed);
    t.check("export (a read) is still allowed for the frozen member", (await G.assertBillableAllowed({ userId: founder, operation: "export" })).allowed);
    await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "unfreeze", reason: REASON });
    t.check("UNFREEZE restores on the next call (reversible, membership untouched)",
      (await G.assertBillableAllowed({ userId: founder, operation: "ai_chat" })).allowed && (await entitlementsForUser(founder)).dimensions.aiDailyUsdAllowance.value === 20
        && assignmentSnapshot() === assignmentsBefore);
  }

  t.section("6. the gate I/O");
  {
    await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "pause", reason: REASON });
    const personal = fake.seed("Space", { name: "Personal", type: "PERSONAL" });
    fake.seed("SpaceMember", { spaceId: personal.id, userId: betaA, role: "OWNER", status: "ACTIVE" });
    fake.seed("SpaceMember", { spaceId: personal.id, userId: pro, role: "MEMBER", status: "ACTIVE" });
    const proSpace = fake.seed("Space", { name: "Pro", type: "SHARED" });
    fake.seed("SpaceMember", { spaceId: proSpace.id, userId: pro, role: "OWNER", status: "ACTIVE" });
    fake.seed("SpaceMember", { spaceId: proSpace.id, userId: betaA, role: "OWNER", status: "LEFT" });
    const shared = fake.seed("Space", { name: "Shared", type: "SHARED" });
    fake.seed("SpaceMember", { spaceId: shared.id, userId: betaA, role: "OWNER", status: "ACTIVE" });
    fake.seed("SpaceMember", { spaceId: shared.id, userId: coOwner, role: "OWNER", status: "ACTIVE" });
    const empty = fake.seed("Space", { name: "Platform", type: "SHARED" });
    const r = async (i: Parameters<typeof G.assertBillableAllowed>[0]) => { const d = await G.assertBillableAllowed(i); return d.allowed ? "ALLOWED" : d.reason; };
    t.check("Space with one ACTIVE OWNER (Beta, paused) → BETA_PAUSED", await r({ spaceId: personal.id as string, operation: "plaid_sync" }) === "BETA_PAUSED");
    t.check("Space whose ACTIVE OWNER is on Pro → allowed (a LEFT owner does not count)", await r({ spaceId: proSpace.id as string, operation: "wallet_sync" }) === "ALLOWED");
    t.check("Space with TWO active owners → NO_OWNER", await r({ spaceId: shared.id as string, operation: "wallet_sync" }) === "NO_OWNER");
    t.check("Space with no owner → NO_OWNER", await r({ spaceId: empty.id as string, operation: "crypto_backfill" }) === "NO_OWNER");
    t.check("userId wins over spaceId (the actor is billed)", await r({ userId: pro, spaceId: shared.id as string, operation: "ai_chat" }) === "ALLOWED");
    t.check("neither user nor Space → NO_OWNER", await r({ operation: "price_history" }) === "NO_OWNER");

    const unassigned = customer("noassign", null);
    await C.loadFreshPolicyGroupCatalogue(); // warm
    const groupReads = fake.callsTo("PolicyGroup", "findMany").length;
    const assignmentReads = fake.callsTo("CustomerPolicyAssignment").length;
    C.invalidatePolicyGroupCatalogue();
    const m = await G.billableAllowedForUsers([betaA, founder, pro, unassigned, pro], "plaid_sync");
    const groupReadsUsed = fake.callsTo("PolicyGroup", "findMany").length - groupReads;
    const assignmentQueries = fake.callsTo("CustomerPolicyAssignment").length - assignmentReads;
    t.check("batch: one entry per distinct user", m.size === 4);
    t.check("batch: Beta members (incl. Founder) BETA_PAUSED, Pro allowed, unassigned follows the default (switch off)",
      (m.get(betaA) as any).reason === "BETA_PAUSED" && (m.get(founder) as any).reason === "BETA_PAUSED" && m.get(pro)!.allowed && (m.get(unassigned) as any).reason === "BETA_PAUSED");
    t.check("batch: ONE catalogue read (values + lifecycle = the loader's 2 PolicyGroup queries) and ONE assignment query",
      groupReadsUsed === 2 && assignmentQueries === 1, { groupReadsUsed, assignmentQueries });
    t.check("batch: the rollout switch fails the unassigned customer closed (NOT_ENTITLED)",
      ((await G.billableAllowedForUsers([unassigned], "plaid_sync", undefined, { failClosed: true })).get(unassigned) as any).reason === "NOT_ENTITLED");
    t.check("batch of none → empty map", (await G.billableAllowedForUsers([], "plaid_sync")).size === 0);

    fake.on("CustomerPolicyAssignment", "findUnique", () => { throw new Error("connection reset"); });
    fake.on("CustomerPolicyAssignment", "findMany", () => { throw new Error("connection reset"); });
    t.check("assignment read failure → POLICY_UNAVAILABLE for metered (never throws)", await r({ userId: pro, operation: "ai_chat" }) === "POLICY_UNAVAILABLE");
    t.check("…and export stays allowed", await r({ userId: pro, operation: "export" }) === "ALLOWED");
    const bm = await G.billableAllowedForUsers([pro, betaA], "wallet_sync");
    t.check("batch read failure → every user POLICY_UNAVAILABLE", [...bm.values()].every((d) => !d.allowed && d.reason === "POLICY_UNAVAILABLE"));
    fake.clearHooks();
    await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "resume", reason: REASON });
  }

  t.section("7. freshness — never the last-good copy, never older than 30 s");
  {
    C.invalidatePolicyGroupCatalogue();
    t.check("a fresh read is usable", (await C.loadFreshPolicyGroupCatalogue()) !== null);
    const reads = fake.callsTo("PolicyGroup", "findMany").length;
    C.ageCachedPolicyGroupCatalogueForTests(31_000);
    const reread = await C.loadFreshPolicyGroupCatalogue();
    t.check("a cached read aged past 30 s is RE-READ (not served) for billable",
      reread !== null && fake.callsTo("PolicyGroup", "findMany").length > reads && Date.now() - Date.parse(reread.loadedAt!) <= 30_000);

    C.invalidatePolicyGroupCatalogue();
    fake.on("PolicyGroup", "findMany", () => { throw new Error("connection refused"); });
    const values = await C.loadPolicyGroupCatalogue();
    t.check("on a read failure the ordinary loader serves the LAST GOOD copy for values (marked)", values.source === "DB" && values.servedFromLastGood === true);
    t.check("…but the billable loader returns null (fail closed)", (await C.loadFreshPolicyGroupCatalogue()) === null);
    t.check("…and the gate says POLICY_UNAVAILABLE while sign-in reads still resolve values",
      ((await G.assertBillableAllowed({ userId: pro, operation: "plaid_exchange" })) as any).reason === "POLICY_UNAVAILABLE"
        && (await entitlementsForUser(pro)).dimensions.exportsPerDay.value === BETA.exportsPerDay);
    t.check("getBetaLifecycleState → UNKNOWN while unreadable", (await getBetaLifecycleState()) === "UNKNOWN");
    {
      const e = await entitlementsForUser(pro);
      t.check("review fix 3 — under the LAST-GOOD copy the resolver itself reports POLICY_UNAVAILABLE: billable dimensions READ_ONLY, reads kept",
        e.lifecycleRestriction === "POLICY_UNAVAILABLE" && e.dimensions.aiDailyUsdAllowance.value === 0 && e.dimensions.maxConnections.value === 0
          && e.dimensions.dailyBrief.value === true && e.dimensions.exportsPerDay.value === BETA.exportsPerDay, e.lifecycleRestriction);
    }
    fake.clearHooks();

    // Lifecycle columns unreadable (e.g. code deployed before the migration): values resolve, billable fails closed.
    C.invalidatePolicyGroupCatalogue();
    fake.on("PolicyGroup", "findMany", (args) => {
      if ((args.select as Record<string, unknown> | undefined)?.lifecycle) throw new Error('column "lifecycle" does not exist');
      return undefined;
    });
    const noLife = await C.loadPolicyGroupCatalogue();
    t.check("a lifecycle read failure still yields a DB catalogue for values (lifecycleSource UNAVAILABLE)", noLife.source === "DB" && noLife.lifecycleSource === "UNAVAILABLE" && noLife.groups.PRO_V1?.valid === true);
    t.check("…billable fails closed", (await C.loadFreshPolicyGroupCatalogue()) === null
      && ((await G.assertBillableAllowed({ userId: pro, operation: "plaid_sync" })) as any).reason === "POLICY_UNAVAILABLE");
    {
      const e = await entitlementsForUser(pro);
      t.check("…and a DB-only group's member still resolves their plan (not fail closed), billable dimensions POLICY_UNAVAILABLE (review fix 3)",
        !e.failClosed && e.lifecycleRestriction === "POLICY_UNAVAILABLE" && e.dimensions.conversations.value === false && e.dimensions.exportsPerDay.value === BETA.exportsPerDay);
    }
    fake.clearHooks();
    C.invalidatePolicyGroupCatalogue();
  }

  t.section("8. getBetaLifecycleState");
  {
    t.check("ACTIVE", (await getBetaLifecycleState()) === "ACTIVE");
    await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "pause", reason: REASON });
    t.check("PAUSED (immediately after the write)", (await getBetaLifecycleState()) === "PAUSED");
    await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "end", reason: REASON });
    t.check("ENDED", (await getBetaLifecycleState()) === "ENDED");
    const { db } = await import("@/lib/db");
    t.check("through a client (uncached read): ENDED", (await getBetaLifecycleState(db as never)) === "ENDED");
    t.check("through a client whose read fails: UNKNOWN",
      (await getBetaLifecycleState({ policyGroup: { findMany: async () => { throw new Error("down"); } }, policyGroupVersion: { findMany: async () => [] } } as never)) === "UNKNOWN");
    t.check("through a client without the delegates (no table): UNKNOWN", (await getBetaLifecycleState({} as never)) === "UNKNOWN");
    t.check("no Beta ROW (only the code group): UNKNOWN", (await getBetaLifecycleState({
      policyGroup: { findMany: async () => [] }, policyGroupVersion: { findMany: async () => [] },
    } as never)) === "UNKNOWN");
    await post(control.cookie, DEFAULT_POLICY_GROUP, { action: "resume", reason: { code: "POLICY_ROLLOUT", note: "reopen for the next test" } });
  }

  t.section("9. the GET read model");
  {
    const g = await get(read.cookie, DEFAULT_POLICY_GROUP);
    t.check("state: ACTIVE, not frozen, version, no restriction, default + built-in",
      g.body.lifecycle === "ACTIVE" && g.body.costFrozen === false && g.body.lifecycleVersion === beta().lifecycleVersion && g.body.restriction === null
        && g.body.isDefault === true && g.body.builtIn === true, g.body);
    t.check("members: counts only (3 assigned, 1 with an overlay)", g.body.members.customers === 3 && g.body.members.withOverlay === 1);
    t.check("history newest first, with kinds, reason code, has-note flag and an operator label (never an email)",
      g.body.transitions[0].kind === "RESUME" && g.body.transitions.length === transitions().length
        && g.body.transitions.every((x: any) => typeof x.hasNote === "boolean" && !String(x.operator).includes("@") && !("reasonNote" in x)));
    t.check("billablePolicyReadable is reported", g.body.billablePolicyReadable === true);
    t.check("no customer identity in the body", ![betaA, founder, coOwner, pro].some((id) => JSON.stringify(g.body).includes(id)));
  }

  t.section("10. source guarantees");
  {
    const w = code("lib/platform/policies/policy-group-lifecycle-write.ts");
    t.check("transitions are append-only: no runtime update/delete of PolicyGroupTransition",
      ["lib/platform/policies/policy-group-lifecycle-write.ts", "lib/platform/policies/policy-group-lifecycle-read.ts", "app/api/platform/platform-ops/policy-groups/[key]/lifecycle/route.ts"]
        .every((f) => !/policyGroupTransition\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\s*\(/.test(code(f))));
    t.check("the lifecycle write never writes an assignment and only counts members",
      !/customerPolicyAssignment\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(w) && /customerPolicyAssignment\.count\(/.test(w));
    t.check("raw SQL = exactly one tagged-template FOR UPDATE lock", (w.match(/\$queryRaw/g) ?? []).length === 1 && /\$queryRaw`SELECT "key" FROM "PolicyGroup" WHERE "key" = \$\{input\.key\} FOR UPDATE`/.test(w) && !/Unsafe|\$executeRaw/.test(w));
    t.check("the cache is invalidated after a successful commit", /if \(result\.ok\) invalidatePolicyGroupCatalogue\(\);/.test(w));
    const mig = readFileSync(path.join(process.cwd(), "prisma/migrations/20261031120000_policy_group_lifecycle/migration.sql"), "utf8");
    t.check("migration: fm_system SELECT+INSERT only on transitions, fm_backup SELECT, nothing to fm_app/fm_auth, RLS forced",
      /GRANT SELECT, INSERT ON TABLE public\."PolicyGroupTransition" TO fm_system;/.test(mig) && /GRANT SELECT ON TABLE public\."PolicyGroupTransition" TO fm_backup;/.test(mig)
        && !/GRANT[^;]*PolicyGroupTransition[^;]*TO fm_(app|auth)/.test(mig) && /FORCE ROW LEVEL SECURITY/.test(mig)
        && !/GRANT[^;]*(UPDATE|DELETE)[^;]*PolicyGroupTransition/.test(mig));
    t.check("migration: additive (no DROP, no UPDATE of rows), defaults reproduce today",
      !/\bDROP\b/i.test(mig.replace(/--.*$/gm, "")) && !/^\s*UPDATE\b/im.test(mig) && /DEFAULT 'ACTIVE'/.test(mig) && /"costFrozen" BOOLEAN NOT NULL DEFAULT false/.test(mig));
    t.check("migration: FK RESTRICT to PolicyGroup", /REFERENCES "PolicyGroup"\("key"\) ON DELETE RESTRICT ON UPDATE RESTRICT/.test(mig));
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
