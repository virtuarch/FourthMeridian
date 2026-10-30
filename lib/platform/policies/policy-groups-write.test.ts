/**
 * lib/platform/policies/policy-groups-write.test.ts  (POLICY EDITOR — the mutation service, pinned)
 *
 * Against the in-memory Prisma fake (the real schema; the migration's partial
 * unique "at most one default" mirrored with partialUnique):
 *   1. create / clone — version 1, validated, duplicate key ⇒ CONFLICT, code keys reserved, ONE audit row;
 *   2. update — a NEW version, optimistic token (stale ⇒ CONFLICT, nothing written), nothing-changed refused;
 *   3. rollback — a NEW version equal to the earlier one; history append-only;
 *   4. archive — refused while ANY assignment names the group, refused for the default, never a delete;
 *   5. default — exactly one default; stale token ⇒ CONFLICT; NEVER touches an assignment;
 *   6. audit rows — reason-required, POLICY_GROUP target, change summary + COUNTS, never a customer id;
 *   7. append-only + no assignment writes — source scan of every runtime file;
 *   8. the catalogue loader — cached, invalidated by writes, never throws (code fallback / last good).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/policies/policy-groups-write.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed JSON bodies / metadata */

import "@/lib/test-support/route-env";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { BETA_FULL_ACCESS_V1, DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1 } from "@/lib/entitlements/catalogue";
import { AuditAction, OPERATOR_ACTION_FEED_ACTIONS } from "@/lib/audit-actions";
import { REASON_REQUIRED_ACTIONS } from "@/lib/audit";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, e);
    if (["node_modules", ".next"].includes(e)) continue;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(e)) out.push(rel);
  }
  return out;
}

const fake = new FakePrisma();
const BETA = BETA_FULL_ACCESS_V1.values;
const REASON = { code: "POLICY_ROLLOUT" as const, note: "editor test" };
const ACTOR = { userId: "op_control_1", via: "PLATFORM_GRANT" as const, ipAddress: "203.0.113.9", userAgent: "test" };

function seedBeta() {
  // Exactly what migration 20261030120000_policy_group_editor seeds.
  fake.seed("PolicyGroup", { key: DEFAULT_POLICY_GROUP, label: BETA_FULL_ACCESS_V1.label, description: BETA_FULL_ACCESS_V1.description, isDefault: true, builtIn: true, currentVersion: 1, createdById: null });
  fake.seed("PolicyGroupVersion", { groupKey: DEFAULT_POLICY_GROUP, version: 1, values: { ...BETA }, label: BETA_FULL_ACCESS_V1.label, description: BETA_FULL_ACCESS_V1.description,
    changeSummary: { kind: "SEEDED", from: "CODE", changes: [] }, reasonCode: "POLICY_ROLLOUT", createdById: null });
}
const audits = (action?: string) => fake.rows("AuditLog", action ? { action } : {});
const versions = (key: string) => fake.rows("PolicyGroupVersion", { groupKey: key }).map((v) => v.version as number).sort((a, b) => a - b);

async function main() {
  await installFakePrisma(fake);
  fake.partialUnique("PolicyGroup", ["isDefault"], { isDefault: true }, "PolicyGroup_single_default");
  const W = await import("./policy-groups-write");
  const C = await import("./policy-group-catalogue");
  fake.reset();
  C.invalidatePolicyGroupCatalogue();
  // Review fix 3 — the row locks are parameterised $queryRaw; answer them from the fake's PolicyGroup rows.
  const order: string[] = [];
  const answerLocks = () => {
    fake.queryRaw = (sql, values) => {
      if (!/FROM "PolicyGroup" WHERE "key" = \? FOR (UPDATE|SHARE)$/.test(sql.trim())) throw new Error(`unexpected raw SQL: ${sql}`);
      order.push(sql.includes("FOR UPDATE") ? "lock:update" : "lock:share");
      return fake.rows("PolicyGroup", { key: values[0] as string }).map((r) => ({ key: r.key, archivedAt: r.archivedAt ?? null }));
    };
  };
  answerLocks();
  seedBeta();
  // Customers: 3 on Beta (one with Founder), none elsewhere yet.
  for (const [i, overlay] of [[1, null], [2, null], [3, FOUNDER_INTERNAL_V1.key]] as const) {
    const u = fake.seed("User", { email: `c${i}@example.test`, username: `cust${i}`, passwordHash: "x", role: "USER" });
    fake.seed("CustomerPolicyAssignment", { userId: u.id, policyGroup: DEFAULT_POLICY_GROUP, overlay });
  }
  const customerIds = fake.rows("User").map((u) => u.id as string);
  const assignmentsSnapshot = () => JSON.stringify(fake.rows("CustomerPolicyAssignment").map((r) => [r.userId, r.policyGroup, r.overlay, String(r.assignedAt)]));
  const assignmentsBefore = assignmentsSnapshot();

  console.log("1. create / clone");
  {
    const bad = await W.createPolicyGroup({ key: "pro", label: "Pro", from: "DEFAULT", reason: REASON, actor: ACTOR });
    check("a lower-case key ⇒ VALIDATION", !bad.ok && bad.code === "VALIDATION");
    const reserved = await W.createPolicyGroup({ key: DEFAULT_POLICY_GROUP, label: "x", from: "DEFAULT", reason: REASON, actor: ACTOR });
    check("a code group key is reserved ⇒ VALIDATION", !reserved.ok && reserved.code === "VALIDATION");
    const over = await W.createPolicyGroup({ key: "PRO_V1", label: "Pro", from: "DEFAULT", values: { ...BETA, maxConnections: 26 }, reason: REASON, actor: ACTOR });
    check("values above a ceiling ⇒ VALIDATION with the reasons", !over.ok && over.code === "VALIDATION" && (over.errors ?? []).some((e) => /Maximum connections/.test(e)));
    const unknownDim = await W.createPolicyGroup({ key: "PRO_V1", label: "Pro", from: "DEFAULT", values: { ...BETA, superUser: true }, reason: REASON, actor: ACTOR });
    check("an unknown dimension ⇒ VALIDATION", !unknownDim.ok && (unknownDim.errors ?? []).some((e) => /Unknown entitlement "superUser"/.test(e)));
    const missingSrc = await W.createPolicyGroup({ key: "PRO_V1", label: "Pro", from: "NOPE_V1", reason: REASON, actor: ACTOR });
    check("cloning a group that does not exist ⇒ NOT_FOUND", !missingSrc.ok && missingSrc.code === "NOT_FOUND");
    check("…no refusal wrote a group, a version or an audit row", fake.rows("PolicyGroup").length === 1 && fake.rows("PolicyGroupVersion").length === 1 && audits().length === 0);

    const blank = await W.createPolicyGroup({ key: "PRO_V1", label: "Pro", description: "Paid tier draft", from: "DEFAULT", values: { ...BETA, maxConnections: 25, aiDailyUsdAllowance: 12 }, reason: REASON, actor: ACTOR });
    check("create from the default with edited values ⇒ version 1, 2 changes", blank.ok && blank.value.version === 1 && blank.value.changes.length === 2, blank);
    const g = fake.one("PolicyGroup", { key: "PRO_V1" })!;
    check("…the row: not default, not built-in, version 1, created by the operator", g.isDefault === false && g.builtIn === false && g.currentVersion === 1 && g.createdById === ACTOR.userId);
    const v1 = fake.one("PolicyGroupVersion", { groupKey: "PRO_V1", version: 1 })!;
    check("…version 1 holds the FULL values, reason code + note, change summary (from the default)",
      (v1.values as Record<string, unknown>).maxConnections === 25 && Object.keys(v1.values as object).length === 9 && v1.reasonCode === "POLICY_ROLLOUT" && v1.reasonNote === "editor test"
        && (v1.changeSummary as { kind: string; from: string }).kind === "CREATED" && (v1.changeSummary as { from: string }).from === DEFAULT_POLICY_GROUP);
    const clone = await W.createPolicyGroup({ key: "PRO_V1_COPY", label: "Pro copy", from: "PRO_V1", reason: REASON, actor: ACTOR });
    check("CLONE of an existing group's current version ⇒ same values, 0 changes", clone.ok && clone.value.changes.length === 0
      && JSON.stringify(fake.one("PolicyGroupVersion", { groupKey: "PRO_V1_COPY" })!.values) === JSON.stringify(v1.values));
    const dup = await W.createPolicyGroup({ key: "PRO_V1", label: "Again", from: "DEFAULT", reason: REASON, actor: ACTOR });
    check("a duplicate key ⇒ CONFLICT, nothing written", !dup.ok && dup.code === "CONFLICT" && fake.rows("PolicyGroup").length === 3);
    check("ONE POLICY_GROUP_CREATED row per create", audits(AuditAction.POLICY_GROUP_CREATED).length === 2);
  }

  console.log("2. update — a new version; the optimistic token");
  {
    const edited = { ...BETA, exportsPerDay: 5 };
    const noToken = await W.updatePolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedVersion: 0, values: edited, reason: REASON, actor: ACTOR });
    check("no expectedVersion ⇒ VALIDATION", !noToken.ok && noToken.code === "VALIDATION");
    const stale = await W.updatePolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedVersion: 7, values: edited, reason: REASON, actor: ACTOR });
    check("a stale expectedVersion ⇒ CONFLICT (409), nothing written", !stale.ok && stale.code === "CONFLICT" && versions(DEFAULT_POLICY_GROUP).join() === "1" && audits(AuditAction.POLICY_GROUP_UPDATED).length === 0);
    const same = await W.updatePolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedVersion: 1, values: { ...BETA }, reason: REASON, actor: ACTOR });
    check("nothing changed ⇒ VALIDATION (no empty version)", !same.ok && same.code === "VALIDATION" && versions(DEFAULT_POLICY_GROUP).join() === "1");
    const floor = await W.updatePolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedVersion: 1, values: { ...BETA, manualBankRefreshCooldownMinutes: 5 }, reason: REASON, actor: ACTOR });
    check("a floor below its ceiling ⇒ VALIDATION", !floor.ok && floor.code === "VALIDATION");
    const ok = await W.updatePolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedVersion: 1, values: edited, reason: REASON, actor: ACTOR });
    check("Beta edited ⇒ version 2, 1 change, 3 customers affected", ok.ok && ok.value.version === 2 && ok.value.changes.length === 1 && ok.value.customersAffected === 3, ok);
    check("…version 1 still exists, unchanged (append-only)", versions(DEFAULT_POLICY_GROUP).join() === "1,2"
      && (fake.one("PolicyGroupVersion", { groupKey: DEFAULT_POLICY_GROUP, version: 1 })!.values as Record<string, unknown>).exportsPerDay === 3);
    check("…the pointer moved to 2", fake.one("PolicyGroup", { key: DEFAULT_POLICY_GROUP })!.currentVersion === 2);
    const again = await W.updatePolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedVersion: 1, values: { ...edited, exportsPerDay: 6 }, reason: REASON, actor: ACTOR });
    check("a second editor holding version 1 ⇒ CONFLICT (409)", !again.ok && again.code === "CONFLICT" && versions(DEFAULT_POLICY_GROUP).join() === "1,2");
    const renamed = await W.updatePolicyGroup({ key: "PRO_V1", expectedVersion: 1, values: fake.one("PolicyGroupVersion", { groupKey: "PRO_V1", version: 1 })!.values, label: "Pro (draft)", reason: REASON, actor: ACTOR });
    check("a label-only change is a new version too", renamed.ok && renamed.value.version === 2 && fake.one("PolicyGroup", { key: "PRO_V1" })!.label === "Pro (draft)");
    check("ONE POLICY_GROUP_UPDATED row per edit", audits(AuditAction.POLICY_GROUP_UPDATED).length === 2);
  }

  console.log("3. rollback — a new version from an earlier one");
  {
    const notEarlier = await W.rollbackPolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedVersion: 2, toVersion: 2, reason: REASON, actor: ACTOR });
    check("restoring the current (or a later) version ⇒ VALIDATION", !notEarlier.ok && notEarlier.code === "VALIDATION");
    const missing = await W.rollbackPolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedVersion: 9, toVersion: 8, reason: REASON, actor: ACTOR });
    check("a version that does not exist ⇒ NOT_FOUND", !missing.ok && missing.code === "NOT_FOUND");
    const rb = await W.rollbackPolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedVersion: 2, toVersion: 1, reason: REASON, actor: ACTOR });
    check("rollback to v1 ⇒ a NEW version 3 equal to v1's values", rb.ok && rb.value.version === 3 && versions(DEFAULT_POLICY_GROUP).join() === "1,2,3"
      && JSON.stringify(fake.one("PolicyGroupVersion", { groupKey: DEFAULT_POLICY_GROUP, version: 3 })!.values) === JSON.stringify(fake.one("PolicyGroupVersion", { groupKey: DEFAULT_POLICY_GROUP, version: 1 })!.values));
    check("…its summary says ROLLED_BACK from 2, restored 1", (() => { const sm = fake.one("PolicyGroupVersion", { groupKey: DEFAULT_POLICY_GROUP, version: 3 })!.changeSummary as Record<string, unknown>; return sm.kind === "ROLLED_BACK" && sm.restoredVersion === 1 && sm.fromVersion === 2; })());
    check("…v2 is kept (history is append-only)", fake.one("PolicyGroupVersion", { groupKey: DEFAULT_POLICY_GROUP, version: 2 }) !== undefined);
    check("ONE POLICY_GROUP_ROLLED_BACK row", audits(AuditAction.POLICY_GROUP_ROLLED_BACK).length === 1);
  }

  console.log("4. archive");
  {
    const def = await W.archivePolicyGroup({ key: DEFAULT_POLICY_GROUP, reason: REASON, actor: ACTOR });
    check("the default group ⇒ NOT_EDITABLE (409), not archived", !def.ok && def.code === "NOT_EDITABLE" && fake.one("PolicyGroup", { key: DEFAULT_POLICY_GROUP })!.archivedAt == null);
    const u = fake.seed("User", { email: "pro@example.test", username: "pro1", passwordHash: "x", role: "USER", deactivatedAt: new Date() });
    fake.seed("CustomerPolicyAssignment", { userId: u.id, policyGroup: "PRO_V1" });
    const assigned = await W.archivePolicyGroup({ key: "PRO_V1", reason: REASON, actor: ACTOR });
    check("ANY assignment naming the group (even a deactivated customer's) ⇒ CONFLICT, not archived",
      !assigned.ok && assigned.code === "CONFLICT" && /1 customer is assigned/.test(assigned.error) && fake.one("PolicyGroup", { key: "PRO_V1" })!.archivedAt == null);
    const ok = await W.archivePolicyGroup({ key: "PRO_V1_COPY", reason: REASON, actor: ACTOR });
    check("an unassigned, non-default group ⇒ archived (row kept)", ok.ok && fake.one("PolicyGroup", { key: "PRO_V1_COPY" })!.archivedAt instanceof Date);
    const twice = await W.archivePolicyGroup({ key: "PRO_V1_COPY", reason: REASON, actor: ACTOR });
    check("archiving twice ⇒ VALIDATION", !twice.ok && twice.code === "VALIDATION");
    const lockSql = fake.raw.filter((r) => /FOR UPDATE/.test(r.sql));
    check("review fix 3: archive takes a FOR UPDATE row lock, parameterised (the key is a bound value, never in the SQL text)",
      lockSql.length >= 1 && lockSql.every((r) => r.values[0] !== undefined && !r.sql.includes(String(r.values[0]))));
    order.length = 0;
    fake.on("CustomerPolicyAssignment", "count", () => { order.push("count"); return undefined; });
    const u2 = fake.seed("User", { email: "trial@example.test", username: "trial1", passwordHash: "x", role: "USER" });
    void u2;
    await W.createPolicyGroup({ key: "LOCK_ORDER_V1", label: "Lock order", from: "DEFAULT", reason: REASON, actor: ACTOR });
    await W.archivePolicyGroup({ key: "LOCK_ORDER_V1", reason: REASON, actor: ACTOR });
    check("review fix 3: the lock is taken BEFORE the assignments are counted", order[0] === "lock:update" && order.indexOf("count") > 0, order);
    fake.clearHooks();
    const builtIn = await W.setDefaultPolicyGroup({ key: "PRO_V1", expectedDefaultKey: DEFAULT_POLICY_GROUP, reason: REASON, actor: ACTOR });
    const archBeta = await W.archivePolicyGroup({ key: DEFAULT_POLICY_GROUP, reason: REASON, actor: ACTOR });
    check("review fix 6: a BUILT-IN group (Beta, not the default) ⇒ NOT_EDITABLE 'Built-in groups cannot be archived'",
      builtIn.ok && !archBeta.ok && archBeta.code === "NOT_EDITABLE" && /Built-in groups cannot be archived/.test(archBeta.error) && fake.one("PolicyGroup", { key: DEFAULT_POLICY_GROUP })!.archivedAt == null);
    await W.setDefaultPolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedDefaultKey: "PRO_V1", reason: REASON, actor: ACTOR });
    const cloneArchived = await W.createPolicyGroup({ key: "FROM_ARCHIVED_V1", label: "x", from: "PRO_V1_COPY", reason: REASON, actor: ACTOR });
    check("review fix 7: cloning FROM an archived group ⇒ NOT_EDITABLE, nothing written", !cloneArchived.ok && cloneArchived.code === "NOT_EDITABLE" && !fake.one("PolicyGroup", { key: "FROM_ARCHIVED_V1" }));
    const editArchived = await W.updatePolicyGroup({ key: "PRO_V1_COPY", expectedVersion: 1, values: { ...BETA, exportsPerDay: 9 }, reason: REASON, actor: ACTOR });
    check("an archived group cannot be edited ⇒ NOT_EDITABLE", !editArchived.ok && editArchived.code === "NOT_EDITABLE");
    check("no PolicyGroup or version row was ever deleted", fake.callsTo("PolicyGroup", "delete").length + fake.callsTo("PolicyGroup", "deleteMany").length + fake.callsTo("PolicyGroupVersion", "delete").length + fake.callsTo("PolicyGroupVersion", "deleteMany").length === 0);
  }

  console.log("5. default");
  {
    const archived = await W.setDefaultPolicyGroup({ key: "PRO_V1_COPY", expectedDefaultKey: DEFAULT_POLICY_GROUP, reason: REASON, actor: ACTOR });
    check("an archived group cannot be the default ⇒ NOT_EDITABLE", !archived.ok && archived.code === "NOT_EDITABLE");
    const stale = await W.setDefaultPolicyGroup({ key: "PRO_V1", expectedDefaultKey: "SOMETHING_ELSE", reason: REASON, actor: ACTOR });
    check("a stale expectedDefaultKey ⇒ CONFLICT", !stale.ok && stale.code === "CONFLICT");
    const already = await W.setDefaultPolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedDefaultKey: DEFAULT_POLICY_GROUP, reason: REASON, actor: ACTOR });
    check("already the default ⇒ VALIDATION", !already.ok && already.code === "VALIDATION");
    const before = assignmentsSnapshot();
    const moved = await W.setDefaultPolicyGroup({ key: "PRO_V1", expectedDefaultKey: DEFAULT_POLICY_GROUP, reason: REASON, actor: ACTOR });
    check("moved: PRO_V1 is the default, Beta is not — exactly one default row", moved.ok && fake.rows("PolicyGroup", { isDefault: true }).map((r) => r.key).join() === "PRO_V1");
    check("…NO assignment was read-modified, created or deleted (new registrations only)", assignmentsSnapshot() === before
      && ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"].every((op) => fake.callsTo("CustomerPolicyAssignment", op).length === 0));
    let threw = "";
    try { fake.seed("PolicyGroup", { key: "SECOND_DEFAULT", label: "x", isDefault: true, currentVersion: 1 }); } catch (e) { threw = (e as { code?: string }).code ?? String(e); }
    check("the partial unique index refuses a second default (P2002)", threw === "P2002");
    const back = await W.setDefaultPolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedDefaultKey: "PRO_V1", reason: REASON, actor: ACTOR });
    check("moved back to Beta", back.ok && fake.rows("PolicyGroup", { isDefault: true }).map((r) => r.key).join() === DEFAULT_POLICY_GROUP);
    check("ONE POLICY_GROUP_DEFAULT_CHANGED row per move", audits(AuditAction.POLICY_GROUP_DEFAULT_CHANGED).length === 4);
    // Review fix 4 — a concurrent archive lands between the unset and the set.
    const auditsBefore = audits().length;
    fake.on("PolicyGroup", "updateMany", (args) => {
      if ((args.data as { isDefault?: boolean }).isDefault === true) { const r = fake.one("PolicyGroup", { key: "PRO_V1" })!; r.archivedAt = new Date(); }
      return undefined;
    });
    const raced = await W.setDefaultPolicyGroup({ key: "PRO_V1", expectedDefaultKey: DEFAULT_POLICY_GROUP, reason: REASON, actor: ACTOR });
    fake.clearHooks();
    check("review fix 4: set-default on a row archived meanwhile ⇒ CONFLICT (409)", !raced.ok && raced.code === "CONFLICT", raced);
    check("…the unset ROLLED BACK: Beta is still the one default, no audit row", fake.rows("PolicyGroup", { isDefault: true }).map((r) => r.key).join() === DEFAULT_POLICY_GROUP && audits().length === auditsBefore);
    fake.one("PolicyGroup", { key: "PRO_V1" })!.archivedAt = null;
  }

  console.log("6. audit rows");
  {
    const rows = fake.rows("AuditLog").filter((r) => String(r.action).startsWith("POLICY_GROUP_"));
    check("every policy-group action is reason-required and listed in the Security operator feed",
      [AuditAction.POLICY_GROUP_CREATED, AuditAction.POLICY_GROUP_UPDATED, AuditAction.POLICY_GROUP_ROLLED_BACK, AuditAction.POLICY_GROUP_ARCHIVED, AuditAction.POLICY_GROUP_DEFAULT_CHANGED]
        .every((a) => REASON_REQUIRED_ACTIONS.has(a) && OPERATOR_ACTION_FEED_ACTIONS.includes(a)));
    check("all 12 rows (3 created, 2 edited, 1 restored, 2 archived, 4 default moves; refusals write none): by the operator, target POLICY_GROUP, area PLATFORM_OPS, reason code + note, SUCCESS, no userId column",
      rows.length === 12 && rows.every((r) => {
        const m = r.metadata as Record<string, any>;
        return r.performedByAdminId === ACTOR.userId && r.userId == null && m.target.kind === "POLICY_GROUP" && m.actor.area === "PLATFORM_OPS"
          && m.reason.code === "POLICY_ROLLOUT" && m.reason.note === "editor test" && m.result === "SUCCESS";
      }), rows.length);
    const upd = rows.find((r) => r.action === AuditAction.POLICY_GROUP_UPDATED)!.metadata as Record<string, any>;
    check("the UPDATED row carries the change summary (dimension, before, after) and COUNTS",
      JSON.stringify(upd.changes) === JSON.stringify([{ key: "exportsPerDay", before: 3, after: 5 }]) && upd.customersAffected === 3 && upd.customersWithOverlay === 1
        && upd.change.before.version === 1 && upd.change.after.version === 2);
    const all = JSON.stringify(fake.rows("AuditLog")) + JSON.stringify(fake.rows("PolicyGroupVersion"));
    check("NO customer id, email or username appears in any audit row or version", !customerIds.some((id) => all.includes(id)) && !/cust\d|@example\.test/.test(all));
    let threw = false;
    try { await W.updatePolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedVersion: 3, values: { ...BETA, exportsPerDay: 4 }, reason: undefined as never, actor: ACTOR }); } catch { threw = true; }
    check("without a reason the audit chokepoint throws and the version rolls back", threw && versions(DEFAULT_POLICY_GROUP).join() === "1,2,3" && fake.one("PolicyGroup", { key: DEFAULT_POLICY_GROUP })!.currentVersion === 3);
    check("the customers' assignments are exactly as seeded (only the test's own PRO_V1 fixture was added)",
      JSON.stringify(JSON.parse(assignmentsSnapshot()).slice(0, 3)) === assignmentsBefore);
  }

  console.log("7. append-only + no assignment writes (source)");
  {
    const runtime = [...walk("lib"), ...walk("app"), ...walk("components"), ...walk("jobs")].filter((f) => !/\.test\.tsx?$/.test(f));
    const mutatesVersions = runtime.filter((f) => /policyGroupVersion\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\s*\(/.test(code(f)));
    check("no runtime file updates, upserts or deletes a PolicyGroupVersion", mutatesVersions.length === 0, mutatesVersions);
    const deletesGroups = runtime.filter((f) => /policyGroup\s*\.\s*(delete|deleteMany)\s*\(/.test(code(f)));
    check("no runtime file deletes a PolicyGroup", deletesGroups.length === 0, deletesGroups);
    const w = code("lib/platform/policies/policy-groups-write.ts");
    check("the write service never writes CustomerPolicyAssignment (counts only)", !/customerPolicyAssignment\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(w) && /customerPolicyAssignment\.count\(/.test(w));
    check("the write service never touches a ceiling, an overlay or the fail-closed set", !/ENTITLEMENT_DIMENSIONS|OVERLAYS|FAIL_CLOSED_VALUES|FOUNDER/.test(w));
    check("every operation runs in ONE transaction and invalidates the cache after commit", (w.match(/return run\(client,/g) ?? []).length === 5 && /if \(r\.ok\) invalidatePolicyGroupCatalogue\(\);/.test(w));
    // Review fix 3 — the ONLY raw SQL is the row lock: one parameterised (tagged-template) SELECT … FOR UPDATE in
    // archive and one SELECT … FOR SHARE in the CS assignment; no Unsafe variant, no executeRaw, nothing else.
    const w2 = code("lib/platform/policies/policy-groups-write.ts");
    check("raw SQL in the write service = exactly one tagged-template FOR UPDATE lock",
      (w2.match(/\$queryRaw/g) ?? []).length === 1 && /\$queryRaw`SELECT "key" FROM "PolicyGroup" WHERE "key" = \$\{input\.key\} FOR UPDATE`/.test(w2) && !/Unsafe|\$executeRaw/.test(w2));
    const a2 = code("lib/platform/customer/assign.ts");
    check("raw SQL in the CS assignment = exactly one tagged-template FOR SHARE re-check",
      (a2.match(/\$queryRaw/g) ?? []).length === 2 /* type + call */ && /\$queryRaw<\{ archivedAt: Date \| null \}\[\]>`SELECT "archivedAt" FROM "PolicyGroup" WHERE "key" = \$\{input\.policyGroup\} FOR SHARE`/.test(a2) && !/Unsafe|\$executeRaw/.test(a2));
    check("no raw SQL in the catalogue loader or the detail read", ["lib/platform/policies/policy-group-catalogue.ts", "lib/platform/policies/policy-group-detail.ts"].every((f) => !/\$(executeRaw|queryRaw)/.test(code(f))));
  }

  console.log("8. the catalogue loader");
  {
    C.invalidatePolicyGroupCatalogue();
    const a = await C.loadPolicyGroupCatalogue();
    check("reads the DB (Beta at v3 = the restored v1 values)", a.source === "DB" && a.groups[DEFAULT_POLICY_GROUP].version === 3 && a.groups[DEFAULT_POLICY_GROUP].values?.exportsPerDay === 3);
    const calls = fake.callsTo("PolicyGroup", "findMany").length;
    await C.loadPolicyGroupCatalogue();
    check("a second load within the TTL is served from cache (no read)", fake.callsTo("PolicyGroup", "findMany").length === calls && C.CATALOGUE_TTL_MS <= 30_000);
    await W.updatePolicyGroup({ key: DEFAULT_POLICY_GROUP, expectedVersion: 3, values: { ...BETA, exportsPerDay: 4 }, reason: REASON, actor: ACTOR });
    const b = await C.loadPolicyGroupCatalogue();
    check("a write invalidates the cache: the next load sees version 4", b.groups[DEFAULT_POLICY_GROUP].version === 4 && b.groups[DEFAULT_POLICY_GROUP].values?.exportsPerDay === 4);
    C.invalidatePolicyGroupCatalogue();
    fake.on("PolicyGroup", "findMany", () => { throw Object.assign(new Error('relation "PolicyGroup" does not exist'), { code: "P2021" }); });
    const c = await C.loadPolicyGroupCatalogue();
    check("a failed read serves the LAST GOOD catalogue (never throws)", c.groups[DEFAULT_POLICY_GROUP].version === 4 && c.source === "DB");
    // Review fix 2 — the last good read has a maximum age; past it, the strict code fallback.
    C.invalidatePolicyGroupCatalogue();
    C.ageLastGoodPolicyGroupCatalogueForTests(C.LAST_GOOD_MAX_AGE_MS + 1_000);
    const old = await C.loadPolicyGroupCatalogue();
    check("a failed read with a last good OLDER than 5 min ⇒ the CODE_FALLBACK (strict), not the stale DB catalogue",
      C.LAST_GOOD_MAX_AGE_MS === 300_000 && old.source === "CODE_FALLBACK" && old.groups.PRO_V1 === undefined);
    fake.clearHooks();
    const r = await C.readPolicyGroupCatalogue({});
    check("a client without the delegates (an old generated client) ⇒ the code catalogue", r.source === "CODE" && r.defaultKey === DEFAULT_POLICY_GROUP);
    let threw = false;
    try { await C.readPolicyGroupCatalogue({ policyGroup: { findMany: async () => { throw new Error("relation does not exist"); } }, policyGroupVersion: { findMany: async () => [] } }); } catch { threw = true; }
    check("the UNCACHED read throws (only the cached loader swallows)", threw);
  }

  if (failures > 0) { console.error(`\npolicy-groups-write: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\npolicy-groups-write: all checks passed.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
