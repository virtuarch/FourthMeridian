/**
 * lib/platform/policies/reconcile-beta.test.ts  (owner ruling, 2026-10-30 — BETA RECONCILIATION)
 *
 * The service against a hand-rolled transaction fake, plus the source rules
 * that keep its guarantees structural:
 *   1. the apply — CONFLICT writes nothing; createMany + skipDuplicates with the
 *      Beta-only row shape; ONE reason-required audit row with counts, no identity;
 *   2. create-only — no update / upsert / delete / raw SQL in the module or route;
 *   3. Beta only — the module names no group but DEFAULT_POLICY_GROUP;
 *   4. registration default — every new account is created with a Beta row;
 *   5. never automatic — nothing but the route imports the service;
 *   6. audit vocabulary — reason-required, listed in both operator feeds, labelled;
 *   7. the route is rate limited before it reads the body.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/policies/reconcile-beta.test.ts
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { AuditAction, OPERATOR_ACTION_FEED_ACTIONS } from "@/lib/audit-actions";
import { REASON_REQUIRED_ACTIONS } from "@/lib/audit";
import { DEFAULT_POLICY_GROUP, POLICY_GROUPS } from "@/lib/entitlements/catalogue";
import { CODE_CATALOGUE, buildPolicyGroupCatalogue } from "@/lib/entitlements/policy-groups";

/** Hermetic: the code catalogue (production uses the cached loader). */
const CODE = async () => CODE_CATALOGUE;
import { PLATFORM_OPS_FEED_RULES } from "@/lib/platform/activity/operator-feed-core";
import {
  ELIGIBLE_WHERE, applyBetaReconciliation, readBetaReconciliation,
  type BetaReconciliationClient, type BetaReconciliationReadClient, type BetaReconciliationTx,
} from "./reconcile-beta";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const ROOT = process.cwd();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (rel: string) => strip(readFileSync(path.join(ROOT, rel), "utf8"));
function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const e of readdirSync(abs)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const rel = path.join(dir, e);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e)) out.push(rel);
  }
  return out;
}

const MODULE = "lib/platform/policies/reconcile-beta.ts";
const ROUTE = "app/api/platform/platform-ops/policies/reconcile-beta/route.ts";

// ── A transaction fake that records every call ────────────────────────────────

function fakeClient(eligibleIds: string[], opts: { concurrentlyAssigned?: string[] } = {}) {
  const calls: { op: string; args: unknown }[] = [];
  const tx: BetaReconciliationTx = {
    user: { findMany: async (args) => { calls.push({ op: "user.findMany", args }); return eligibleIds.map((id) => ({ id })); } },
    customerPolicyAssignment: {
      createMany: async (args) => {
        calls.push({ op: "cpa.createMany", args });
        const skip = new Set(opts.concurrentlyAssigned ?? []);
        return { count: args.data.filter((d) => !skip.has(d.userId)).length };
      },
    },
    auditLog: { create: async (args) => { calls.push({ op: "auditLog.create", args }); return {}; } },
  };
  const client: BetaReconciliationClient = { $transaction: async (fn) => fn(tx) };
  return { client, calls };
}

const ACTOR = { userId: "op_000001", via: "PLATFORM_GRANT" as const, ipAddress: "203.0.113.1", userAgent: "test" };
const REASON = { code: "POLICY_ROLLOUT" as const, note: "beta default" };

async function main() {
  console.log("1. the apply");
  {
    const { client, calls } = fakeClient(["u_a", "u_b"]);
    const r = await applyBetaReconciliation({ expectedEligible: 3, reason: REASON, actor: ACTOR }, client, CODE);
    check("a changed population ⇒ CONFLICT with both counts", !r.ok && r.code === "CONFLICT" && r.eligible === 2 && r.expectedEligible === 3);
    check("…and only the read ran (no insert, no audit)", calls.map((c) => c.op).join() === "user.findMany");
    check("the read is the eligible population: active USER, no assignment row",
      JSON.stringify((calls[0].args as { where: unknown }).where) === JSON.stringify({ role: "USER", deactivatedAt: null, policyAssignment: { is: null } })
        && JSON.stringify(ELIGIBLE_WHERE) === JSON.stringify({ role: "USER", deactivatedAt: null, policyAssignment: { is: null } }));
  }
  {
    const { client, calls } = fakeClient([], {});
    const r = await applyBetaReconciliation({ expectedEligible: 0, reason: REASON, actor: ACTOR }, client, CODE);
    check("nobody eligible ⇒ NOTHING_TO_ASSIGN, nothing written", r.ok && r.outcome === "NOTHING_TO_ASSIGN" && calls.length === 1);
  }
  {
    const { client, calls } = fakeClient(["u_a", "u_b", "u_c"], { concurrentlyAssigned: ["u_c"] });
    const r = await applyBetaReconciliation({ expectedEligible: 3, reason: REASON, actor: ACTOR }, client, CODE);
    check("applied: eligible 3, created 2, skipped 1 (the concurrent assignment won)", r.ok && r.outcome === "ASSIGNED" && r.eligible === 3 && r.created === 2 && r.skipped === 1, r);
    check("order: read → createMany → ONE audit row, all inside the one transaction", calls.map((c) => c.op).join() === "user.findMany,cpa.createMany,auditLog.create");
    const cm = calls[1].args as { data: Record<string, unknown>[]; skipDuplicates: boolean };
    check("createMany skipDuplicates: true", cm.skipDuplicates === true);
    check("row shape: Beta, overlay null, allowance override null, assignedById the operator — nothing else",
      cm.data.every((d) => JSON.stringify(Object.keys(d).sort()) === JSON.stringify(["aiDailyUsdAllowanceOverride", "assignedById", "overlay", "policyGroup", "userId"])
        && d.policyGroup === DEFAULT_POLICY_GROUP && d.overlay === null && d.aiDailyUsdAllowanceOverride === null && d.assignedById === ACTOR.userId));
    const audit = (calls[2].args as { data: { action: string; userId?: string; spaceId?: string; performedByAdminId: string; metadata: Record<string, unknown> } }).data;
    check("audit: CUSTOMER_POLICY_RECONCILED by the operator, target POLICY_GROUP, no customer userId",
      audit.action === "CUSTOMER_POLICY_RECONCILED" && audit.performedByAdminId === ACTOR.userId && audit.userId === undefined
        && JSON.stringify(audit.metadata.target) === JSON.stringify({ kind: "POLICY_GROUP", id: DEFAULT_POLICY_GROUP }));
    check("audit: counts + reason; never an affected id", audit.metadata.eligible === 3 && audit.metadata.created === 2 && audit.metadata.skipped === 1
      && (audit.metadata.reason as { code: string }).code === "POLICY_ROLLOUT" && !/u_a|u_b|u_c/.test(JSON.stringify(audit)));
    let threw = false;
    try { await applyBetaReconciliation({ reason: undefined as never, actor: ACTOR }, fakeClient(["u_a"]).client, CODE); } catch { threw = true; }
    check("without a reason the audit chokepoint throws — the insert cannot commit un-audited", threw);
  }
  {
    const seen: string[] = [];
    const read: BetaReconciliationReadClient = {
      user: { count: async (a) => { seen.push(`user:${JSON.stringify(a.where)}`); return 1; } },
      customerPolicyAssignment: { count: async (a) => { seen.push(`cpa:${JSON.stringify(a.where)}`); return 1; } },
    };
    const d = await readBetaReconciliation(read, new Date("2026-10-30T12:00:00Z"), CODE);
    check("dry run: five counts, no findMany (counts only)", seen.length === 5 && d.checkedAt === "2026-10-30T12:00:00.000Z" && d.groupKey === DEFAULT_POLICY_GROUP);
    const known = JSON.stringify(Object.keys(POLICY_GROUPS));
    check("dry run buckets: eligible · deactivated · non-customer · known-group rows · unknown-group rows", [
      `user:${JSON.stringify(ELIGIBLE_WHERE)}`,
      `user:${JSON.stringify({ role: "USER", deactivatedAt: { not: null }, policyAssignment: { is: null } })}`,
      `user:${JSON.stringify({ role: { not: "USER" }, policyAssignment: { is: null } })}`,
      `cpa:{"policyGroup":{"in":${known}}}`,
      `cpa:{"policyGroup":{"notIn":${known}}}`,
    ].every((w, i) => seen[i] === w), seen);
  }

  console.log("\n2. create-only — no update / upsert / delete / raw SQL");
  for (const f of [MODULE, ROUTE]) {
    const src = code(f);
    check(`${f}: no update / updateMany / upsert / delete / deleteMany / raw SQL`,
      !/\.(update|updateMany|upsert|delete|deleteMany)\s*\(/.test(src) && !/\$(executeRaw|queryRaw|executeRawUnsafe|queryRawUnsafe)/.test(src));
  }
  check("the module inserts through createMany with skipDuplicates: true, exactly once",
    (code(MODULE).match(/\.createMany\(/g) ?? []).length === 1 && /skipDuplicates: true,/.test(code(MODULE)));
  check("the route touches no table itself (delegates to the service)", !/systemDb|customerPolicyAssignment|auditLog/.test(code(ROUTE)));

  console.log("\n3. Beta only");
  {
    const src = code(MODULE);
    const groupLiterals = Object.keys(POLICY_GROUPS).filter((k) => src.includes(`"${k}"`));
    // Ruling (review correction): the TARGET is the built-in Beta whatever the DB default is.
    check("the module names no group key literal — only DEFAULT_POLICY_GROUP", groupLiterals.length === 0 && /policyGroup: groupKey/.test(src) && /const groupKey = DEFAULT_POLICY_GROUP;/.test(src)
      && !/defaultKey/.test(src));
    check("no Free / Paid / Pro anywhere in the module", !/\b(FREE|PAID|PRO)(_|\b)/i.test(src));
    check("the default IS the beta group", DEFAULT_POLICY_GROUP === "BETA_FULL_ACCESS_V1");
  }

  console.log("\n3b. Beta archived / unusable ⇒ blocked, never another group");
  {
    const mk = (archivedAt: Date | null, values: unknown, defaultKey: string) => buildPolicyGroupCatalogue(
      [{ key: DEFAULT_POLICY_GROUP, label: "Beta", description: "", isDefault: defaultKey === DEFAULT_POLICY_GROUP, builtIn: true, archivedAt, currentVersion: 1 },
       { key: "PAID_V1", label: "Paid", description: "", isDefault: defaultKey === "PAID_V1", builtIn: false, archivedAt: null, currentVersion: 1 }],
      [{ groupKey: DEFAULT_POLICY_GROUP, version: 1, values, createdAt: new Date() }, { groupKey: "PAID_V1", version: 1, values: POLICY_GROUPS[DEFAULT_POLICY_GROUP].values, createdAt: new Date() }], new Date());
    const read: BetaReconciliationReadClient = { user: { count: async () => 2 }, customerPolicyAssignment: { count: async () => 0 } };
    const moved = mk(null, POLICY_GROUPS[DEFAULT_POLICY_GROUP].values, "PAID_V1");
    const d = await readBetaReconciliation(read, new Date(), async () => moved);
    check("the DB default moved to PAID_V1 ⇒ the target is STILL Beta, not blocked", d.groupKey === DEFAULT_POLICY_GROUP && d.blocked === null);
    const applied = fakeClient(["u_a"]);
    const r = await applyBetaReconciliation({ expectedEligible: 1, reason: REASON, actor: ACTOR }, applied.client, async () => moved);
    check("…and the apply assigns Beta (never the moved default)", r.ok && r.groupKey === DEFAULT_POLICY_GROUP);
    for (const [why, cat] of [["ARCHIVED", mk(new Date(), POLICY_GROUPS[DEFAULT_POLICY_GROUP].values, "PAID_V1")], ["INVALID", mk(null, "garbage", "PAID_V1")]] as const) {
      const dd = await readBetaReconciliation(read, new Date(), async () => cat);
      check(`Beta ${why}: the dry run reports eligible-but-blocked`, dd.eligible === 2 && dd.blocked === why && dd.groupKey === DEFAULT_POLICY_GROUP);
      const f = fakeClient(["u_a"]);
      const rr = await applyBetaReconciliation({ expectedEligible: 1, reason: REASON, actor: ACTOR }, f.client, async () => cat);
      check(`Beta ${why}: the apply REFUSES (BLOCKED) — no transaction, no row, no audit, never PAID_V1`,
        !rr.ok && rr.code === "BLOCKED" && rr.blocked === why && f.calls.length === 0);
    }
  }

  console.log("\n4. registration default — new accounts are born on Beta");
  {
    const reg = code("app/api/auth/register/route.ts");
    // POLICY EDITOR — the catalogue default (read before the transaction; Beta unless an operator moved it).
    check("register creates the assignment with the catalogue default inside its transaction",
      /const defaultPolicyGroup = \(await loadPolicyGroupCatalogue\(\)\)\.defaultKey;[\s\S]*db\.\$transaction\(async \(tx\) =>[\s\S]*tx\.customerPolicyAssignment\.create\(\{\s*data:\s*\{\s*userId:\s*newUser\.id,\s*policyGroup:\s*defaultPolicyGroup\s*\}/.test(reg));
    check("…with no overlay (Founder is never granted at birth)", !/FOUNDER/.test(reg));
  }

  console.log("\n5. never automatic — only the route imports the service");
  {
    const importers = [...walk("app"), ...walk("lib"), ...walk("components"), ...walk("jobs"), ...walk("scripts"), ...walk("prisma")]
      .filter((f) => !/\.test\.tsx?$/.test(f) && f !== MODULE)
      .filter((f) => /policies\/reconcile-beta(["/]|$)/m.test(readFileSync(path.join(ROOT, f), "utf8")) && /import/.test(readFileSync(path.join(ROOT, f), "utf8")));
    const servers = importers.filter((f) => /from "@\/lib\/platform\/policies\/reconcile-beta"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    check("the service's only importer is the route", servers.join() === ROUTE, servers);
    check("no job, cron, script or migration references it", importers.every((f) => !/^(jobs|scripts|prisma)\//.test(f)), importers);
    check("vercel cron config does not name it", !existsSync(path.join(ROOT, "vercel.json")) || !/reconcile-beta/.test(readFileSync(path.join(ROOT, "vercel.json"), "utf8")));
  }

  console.log("\n6. audit vocabulary");
  check("CUSTOMER_POLICY_RECONCILED exists and is reason-required", AuditAction.CUSTOMER_POLICY_RECONCILED === "CUSTOMER_POLICY_RECONCILED" && REASON_REQUIRED_ACTIONS.has(AuditAction.CUSTOMER_POLICY_RECONCILED));
  check("listed in the Security operator feed", OPERATOR_ACTION_FEED_ACTIONS.includes(AuditAction.CUSTOMER_POLICY_RECONCILED));
  check("admitted to the Platform Ops feed on a POLICY_GROUP target only, opening Policies",
    JSON.stringify(PLATFORM_OPS_FEED_RULES[AuditAction.CUSTOMER_POLICY_RECONCILED]?.kinds) === JSON.stringify(["POLICY_GROUP"])
      && PLATFORM_OPS_FEED_RULES[AuditAction.CUSTOMER_POLICY_RECONCILED]?.workspace === "platform-policies");
  check("the Security operator-actions widget labels it", /CUSTOMER_POLICY_RECONCILED:\s*"Assigned Beta to unassigned accounts"/.test(code("components/platform/widgets/SecOperatorActionsWidget.tsx")));

  console.log("\n7. route rate limit");
  {
    const r = code(ROUTE);
    check("POST is limited 5 / 60 s per operator, after the fresh grant and before the body is read",
      /requireFreshPlatformAccess\("PLATFORM_OPS", "CONTROL"\)[\s\S]*limitByUser\(auth\.user\.id, "platform-beta-reconcile", \{ limit: 5, windowSec: 60 \}\)[\s\S]*req\.json\(\)/.test(r));
    check("the confirmed count is echoed (expectedEligible) and a mismatch answers 409", /expectedEligible/.test(r) && /status: 409/.test(r));
  }

  if (failures > 0) { console.error(`\nreconcile-beta: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\nreconcile-beta: all checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
