/**
 * lib/entitlements/fail-closed.test.ts — owner ruling (2026-10-30): missing or
 * invalid customer policy-group assignments FAIL CLOSED.
 *
 *   1. resolver — both modes; each reason; overlay / override / platform setting
 *      ignored ONLY in fail-closed; ceilings still clamp; switch-off ⇒ identical
 *      to the pre-ruling resolution for missing / unknown / known assignments
 *   2. recovery — a corrected assignment resolves normally on the next request
 *   3. FAIL_CLOSED_VALUES is not a policy group: not in POLICY_GROUPS / OVERLAYS,
 *      not readable by the policy-groups read, not assignable
 *   4. consume — refusals say "plan needs attention" (same 403), countLimit 0
 *   5. env getter — exact match on "enforce"
 *   6. enforcement owners still call the resolver with the switch
 *   7. the assignment-health read + attention item + alert rule — shape, opaque
 *      identity, bounded, and no write / delete anywhere in the new paths
 *
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/entitlements/fail-closed.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_POLICY_GROUP, DIMENSION_KEYS, ENTITLEMENT_DIMENSIONS, FAIL_CLOSED_VALUES, OVERLAYS, POLICY_GROUPS,
  isOverlayKey, isPolicyGroupKey,
} from "./catalogue";
import { explainEntitlement, loadEffectiveEntitlements, resolveEffectiveEntitlements, type AssignmentFacts } from "./resolve";
import { countLimit, refuseIfDisabled, refuseIfFailClosed, PLAN_NEEDS_ATTENTION_CODE } from "./consume";
import { buildPolicyAssignmentHealth, customerRef, describePolicyAssignmentIssue, POLICY_ASSIGNMENT_ISSUE_CAP } from "./assignment-health-core";
import { loadPolicyAssignmentHealth, type PolicyAssignmentReadClient } from "./assignment-health";
import { buildAttention, ATTENTION_AUTHORITIES } from "@/lib/platform/ops/attention-core";
import { ALERT_RULES } from "@/lib/alerts/rules";
import { evaluateAlertRules, evaluatePolicyAssignmentInvalid } from "@/lib/alerts/evaluate";
import { opaqueUserRef } from "@/lib/platform/ai/spend-health";
import { isKnownRefusalSentence, planNeedsAttentionSentence, CONVERSATIONS_LABEL } from "@/lib/ai/conversation/refusal-sentences";
import { connectionCapForUser, connectionLimitResponse } from "@/lib/connections/connection-cap";
import { isManualRefreshEntitled } from "@/lib/refresh/refresh-all";
import { opaqueRefTail } from "@/lib/platform/customer/customers";
import { projectPolicy, FAIL_CLOSED_POLICY_LABEL } from "@/lib/platform/customer/customer-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const strip = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const now = new Date("2026-10-30T00:00:00Z");

const KNOWN: AssignmentFacts = { policyGroup: "BETA_FULL_ACCESS_V1", overlay: null, assignedAt: now, assignedById: "op" };
const KNOWN_FOUNDER: AssignmentFacts = { ...KNOWN, overlay: "FOUNDER_INTERNAL_V1", aiDailyUsdAllowanceOverride: 15 };
const UNKNOWN: AssignmentFacts = { policyGroup: "RETIRED_GROUP_V0", overlay: "FOUNDER_INTERNAL_V1", assignedAt: now, assignedById: "op", aiDailyUsdAllowanceOverride: 20 };
const PLATFORM = { aiDailyUsdAllowanceUsd: 9 };

async function main(): Promise<void> {
  console.log("1. resolver — switch OFF is the pre-ruling resolution");
  for (const [name, facts] of [["missing", null], ["unknown", UNKNOWN], ["known", KNOWN], ["known + founder + override", KNOWN_FOUNDER]] as const) {
    const off = resolveEffectiveEntitlements(facts, PLATFORM);
    const offExplicit = resolveEffectiveEntitlements(facts, PLATFORM, { failClosed: false });
    check(`${name}: { failClosed: false } ≡ no option (byte-identical)`, JSON.stringify(off) === JSON.stringify(offExplicit));
    check(`${name}: switch off never fails closed`, off.failClosed === false && off.failClosedReason === null);
    check(`${name}: no dimension reports FAIL_CLOSED when off`, Object.values(off.dimensions).every((d) => d.source !== "FAIL_CLOSED"));
  }
  {
    const missing = resolveEffectiveEntitlements(null);
    check("missing, off: still POLICY_DEFAULT on the Beta default (today's behaviour)", missing.policyGroup === DEFAULT_POLICY_GROUP
      && Object.values(missing.dimensions).every((d) => d.source === "POLICY_DEFAULT") && missing.dimensions.conversations.value === true);
    const unknown = resolveEffectiveEntitlements(UNKNOWN);
    check("unknown, off: still the default with the overlay applied (today's behaviour)", unknown.unknownPolicyGroup === "RETIRED_GROUP_V0"
      && unknown.dimensions.aiTurnsPerMinute.value === 30 && unknown.dimensions.aiTurnsPerMinute.source === "OVERLAY");
  }

  console.log("1b. resolver — switch ON, a VALID assignment is untouched");
  for (const [name, facts] of [["known", KNOWN], ["known + founder + override", KNOWN_FOUNDER]] as const) {
    const off = resolveEffectiveEntitlements(facts, PLATFORM);
    const on = resolveEffectiveEntitlements(facts, PLATFORM, { failClosed: true });
    check(`${name}: identical with the switch on`, JSON.stringify(on) === JSON.stringify(off));
  }
  {
    const founder = resolveEffectiveEntitlements(KNOWN_FOUNDER, PLATFORM, { failClosed: true });
    check("valid + overlay + override: the overlay and override still apply when on", founder.dimensions.aiTurnsPerMinute.value === 30
      && founder.dimensions.aiDailyUsdAllowance.value === 15 && founder.dimensions.aiDailyUsdAllowance.source === "USER_OVERRIDE");
  }

  console.log("1c. resolver — switch ON, missing / unknown FAIL CLOSED");
  {
    const missing = resolveEffectiveEntitlements(null, PLATFORM, { failClosed: true });
    check("missing ⇒ failClosed, reason UNASSIGNED", missing.failClosed && missing.failClosedReason === "UNASSIGNED" && !missing.assigned);
    check("missing ⇒ every dimension is FAIL_CLOSED_VALUES with source FAIL_CLOSED",
      DIMENSION_KEYS.every((k) => missing.dimensions[k].value === FAIL_CLOSED_VALUES[k] && missing.dimensions[k].source === "FAIL_CLOSED"),
      JSON.stringify(missing.dimensions));
    check("missing ⇒ the platform allowance setting is NOT a candidate ($0, not $9)", missing.dimensions.aiDailyUsdAllowance.value === 0
      && missing.dimensions.aiDailyUsdAllowance.platformValue === null);

    const unknown = resolveEffectiveEntitlements(UNKNOWN, PLATFORM, { failClosed: true });
    check("unknown ⇒ failClosed, reason UNKNOWN_POLICY_GROUP, key reported", unknown.failClosed && unknown.failClosedReason === "UNKNOWN_POLICY_GROUP"
      && unknown.unknownPolicyGroup === "RETIRED_GROUP_V0" && !unknown.policyGroupKnown);
    check("unknown ⇒ the founder OVERLAY is ignored (no paid access resurrected)",
      Object.values(unknown.dimensions).every((d) => d.overlayValue === null) && unknown.dimensions.aiTurnsPerMinute.value === 0
      && unknown.dimensions.maxConnections.value === 0);
    check("unknown ⇒ the per-customer AI override ($20) is ignored", unknown.dimensions.aiDailyUsdAllowance.value === 0
      && unknown.dimensions.aiDailyUsdAllowance.overrideValue === null && unknown.dimensions.aiDailyUsdAllowance.source === "FAIL_CLOSED");
    check("unknown ⇒ the stored override is still REPORTED (nothing hidden, nothing rewritten)", unknown.aiDailyUsdAllowanceOverride === 20 && unknown.overlay === "FOUNDER_INTERNAL_V1");
    check("fail-closed: reading the Brief stays on, conversations off", unknown.dimensions.dailyBrief.value === true && unknown.dimensions.conversations.value === false);
    check("fail-closed: one export a day (safe read of own data)", unknown.dimensions.exportsPerDay.value === 1);
    check("fail-closed: bank cooldown is the 7-day floor", unknown.dimensions.manualBankRefreshCooldownMinutes.value === 10_080);
    check("explanation names the restriction and where it is fixed", /restricted \(fail closed\)/.test(explainEntitlement(unknown.dimensions.conversations))
      && /Customer Success/.test(explainEntitlement(unknown.dimensions.conversations)));
  }

  console.log("1d. ceilings still clamp in fail-closed");
  {
    const dims = ENTITLEMENT_DIMENSIONS as unknown as Record<string, { ceiling: unknown }>;
    const saved = dims.manualBankRefreshCooldownMinutes.ceiling;
    const savedExports = dims.exportsPerDay.ceiling;
    dims.manualBankRefreshCooldownMinutes.ceiling = 20_000; // a floor above the restricted value
    dims.exportsPerDay.ceiling = 0;                          // a count ceiling below it
    try {
      const e = resolveEffectiveEntitlements(null, PLATFORM, { failClosed: true });
      check("a minutes-floor ceiling raises the restricted value (source CEILING)", e.dimensions.manualBankRefreshCooldownMinutes.value === 20_000 && e.dimensions.manualBankRefreshCooldownMinutes.source === "CEILING");
      check("a count ceiling caps the restricted value (source CEILING)", e.dimensions.exportsPerDay.value === 0 && e.dimensions.exportsPerDay.source === "CEILING");
    } finally {
      dims.manualBankRefreshCooldownMinutes.ceiling = saved;
      dims.exportsPerDay.ceiling = savedExports;
    }
    check("every FAIL_CLOSED value is within today's ceilings (never above the platform bound)",
      DIMENSION_KEYS.every((k) => {
        const d = ENTITLEMENT_DIMENSIONS[k]; const v = FAIL_CLOSED_VALUES[k];
        return d.kind === "boolean" ? !(v && !d.ceiling) : d.kind === "count" ? Number(v) <= Number(d.ceiling) : Number(v) >= Number(d.ceiling);
      }));
  }

  console.log("2. recovery is automatic — per-request resolution");
  {
    const rows = new Map<string, { policyGroup: string; overlay: string | null; assignedAt: Date; assignedById: string | null } | null>([["u1", null]]);
    const fake = { customerPolicyAssignment: { findUnique: async ({ where }: { where: { userId: string } }) => rows.get(where.userId) ?? null } };
    const before = await loadEffectiveEntitlements(fake, "u1", { failClosed: true });
    check("before: unassigned ⇒ fail closed", before.failClosed && before.dimensions.conversations.value === false);
    rows.set("u1", { policyGroup: "RETIRED_GROUP_V0", overlay: null, assignedAt: now, assignedById: "op" });
    const unknown = await loadEffectiveEntitlements(fake, "u1", { failClosed: true });
    check("still unknown ⇒ still fail closed", unknown.failClosedReason === "UNKNOWN_POLICY_GROUP");
    rows.set("u1", { policyGroup: "BETA_FULL_ACCESS_V1", overlay: null, assignedAt: now, assignedById: "op" });
    const after = await loadEffectiveEntitlements(fake, "u1", { failClosed: true });
    check("after the CS fix: the next resolution is the plan (no flag, no cache)", !after.failClosed && after.dimensions.conversations.value === true
      && after.dimensions.aiDailyUsdAllowance.value === POLICY_GROUPS.BETA_FULL_ACCESS_V1.values.aiDailyUsdAllowance && after.dimensions.conversations.source === "POLICY");
    check("loader without options is the pre-ruling resolution", (await loadEffectiveEntitlements({ customerPolicyAssignment: { findUnique: async () => null } }, "u2")).failClosed === false);
  }

  console.log("3. FAIL_CLOSED_VALUES is not a policy group");
  {
    const asKey = (v: unknown) => Object.entries(POLICY_GROUPS).some(([, g]) => g.values === v) || Object.values(OVERLAYS).some((o) => o.values === v);
    check("not the values of any policy group or overlay", !asKey(FAIL_CLOSED_VALUES));
    check("no key named like it is a group, an overlay, or assignable", !isPolicyGroupKey("FAIL_CLOSED") && !isOverlayKey("FAIL_CLOSED")
      && !isPolicyGroupKey("FAIL_CLOSED_VALUES") && !Object.keys(POLICY_GROUPS).some((k) => /FAIL/i.test(k)));
    check("frozen (cannot be mutated at runtime)", Object.isFrozen(FAIL_CLOSED_VALUES));
    const readSrc = strip("lib/platform/policy-groups-read.ts");
    check("the policy-groups read never names it (lists POLICY_GROUPS / OVERLAYS only)", !/FAIL_CLOSED/.test(readSrc));
    const assign = strip("lib/platform/customer/assign.ts");
    check("the assignment write validates through isPolicyGroupKey (FAIL_CLOSED is refused as unknown)", /isPolicyGroupKey\(input\.policyGroup\)/.test(assign) && !/FAIL_CLOSED/.test(assign));
    const widget = strip("components/platform/widgets/CsCustomersWidget.tsx");
    check("the CS editor offers POLICY_GROUPS only (never the restricted set)", !/FAIL_CLOSED_VALUES/.test(widget) && /POLICY_GROUPS/.test(widget));
  }

  console.log("4. consume — honest refusals, same status codes");
  {
    const fc = resolveEffectiveEntitlements(null, undefined, { failClosed: true });
    const plain = resolveEffectiveEntitlements(null);
    const r = refuseIfDisabled(fc, "conversations", CONVERSATIONS_LABEL)!;
    const body = await r.json() as { error: string; code: string; entitlement: string };
    check("conversations off in fail-closed ⇒ 403 with the plan-needs-attention sentence", r.status === 403 && body.code === PLAN_NEEDS_ATTENTION_CODE
      && body.error === planNeedsAttentionSentence(CONVERSATIONS_LABEL) && /Your data is safe/.test(body.error) && body.entitlement === "conversations");
    check("the sentence is a known refusal (never fed back to the model as an answer)", isKnownRefusalSentence(body.error));
    check("refuseIfDisabled does not refuse the Brief read in fail-closed (dailyBrief stays on)", refuseIfDisabled(fc, "dailyBrief", "The Daily Brief") === null);
    const g = refuseIfFailClosed(fc, "Manual refresh")!;
    check("refuseIfFailClosed ⇒ 403 PLAN_NEEDS_ATTENTION", g.status === 403 && ((await g.json()) as { code: string }).code === PLAN_NEEDS_ATTENTION_CODE);
    check("refuseIfFailClosed is null for a resolved plan", refuseIfFailClosed(plain, "Manual refresh") === null);
    check("countLimit: the deliberate 0 survives in fail-closed (maxConnections)", countLimit(fc, "maxConnections") === 0);
    check("countLimit: exports stay at 1 in fail-closed", countLimit(fc, "exportsPerDay") === 1);
    check("countLimit: never below 1 outside fail-closed (unchanged)", countLimit(plain, "exportsPerDay") === 3);
    check("refresh-all: fail-closed is NOT entitled to a manual refresh; a plan is", !isManualRefreshEntitled(fc) && isManualRefreshEntitled(plain));

    const cap = await connectionCapForUser("u1", { counts: async () => ({ nonRevokedPlaidItems: 2, walletConnections: 1 }), entitlements: async () => fc });
    check("connection cap: fail-closed refuses a NEW connection (limit 0) and is marked", !cap.allowed && cap.limit === 0 && cap.failClosed === true && cap.current === 3);
    const capRes = connectionLimitResponse(cap);
    const capBody = await capRes.json() as { error: string; code: string };
    check("connection cap: same 403, plan sentence", capRes.status === 403 && capBody.code === PLAN_NEEDS_ATTENTION_CODE && /plan needs attention/.test(capBody.error));
    const ok = await connectionCapForUser("u1", { counts: async () => ({ nonRevokedPlaidItems: 2, walletConnections: 1 }), entitlements: async () => plain });
    check("connection cap: a resolved plan is unchanged (no failClosed mark)", ok.allowed && ok.failClosed === undefined);
    const cc = strip("lib/connections/connection-cap.ts");
    check("connection cap only COUNTS existing connections — no update / delete / disconnect", !/\.(update|updateMany|delete|deleteMany|create|upsert)\(/.test(cc));

    const view = projectPolicy(fc);
    check("CS policy view: honest label, reason, and FAIL_CLOSED sources", view.failClosed && view.failClosedReason === "UNASSIGNED"
      && view.policyGroupLabel === FAIL_CLOSED_POLICY_LABEL && view.dimensions.every((d) => d.source === "FAIL_CLOSED"));
    check("CS policy view: a plan shows its label and failClosed false", !projectPolicy(plain).failClosed && projectPolicy(plain).policyGroupLabel === POLICY_GROUPS[DEFAULT_POLICY_GROUP].label);
  }

  console.log("5. env getter — exact match");
  {
    const envSrc = read("lib/env.ts");
    check("snapshot reads POLICY_ASSIGNMENT_FAIL_CLOSED", /POLICY_ASSIGNMENT_FAIL_CLOSED:\s*process\.env\.POLICY_ASSIGNMENT_FAIL_CLOSED/.test(envSrc));
    check("getter is true ONLY for exactly \"enforce\"", /get isPolicyAssignmentFailClosed\(\) \{ return _e\.POLICY_ASSIGNMENT_FAIL_CLOSED === "enforce"; \}/.test(envSrc));
    check(".env.example documents it, unset by default, Production only with separate approval",
      /^POLICY_ASSIGNMENT_FAIL_CLOSED=$/m.test(read(".env.example")) && /Production ONLY with separate owner approval/.test(read(".env.example")));
    const { env } = await import("@/lib/env");
    check("unset in this test process ⇒ false (ships dormant)", process.env.POLICY_ASSIGNMENT_FAIL_CLOSED === undefined ? env.isPolicyAssignmentFailClosed === false : true);
  }

  console.log("6. enforcement owners still resolve through the authority, with the switch");
  {
    const consume = strip("lib/entitlements/consume.ts");
    check("consume: the ONE switch reader is entitlementLoadOptions (env.isPolicyAssignmentFailClosed)", /failClosed:\s*env\.isPolicyAssignmentFailClosed/.test(consume));
    check("consume: the default tenant loader passes it", /loadEffectiveEntitlements\(tx,\s*userId,\s*entitlementLoadOptions\(\)\)/.test(consume));
    const direct: [string, RegExp][] = [
      ["app/api/plaid/refresh/route.ts", /loadEffectiveEntitlements\(tx,\s*user\.id,\s*entitlementLoadOptions\(\)\)/],
      ["app/api/accounts/[id]/sync/route.ts", /loadEffectiveEntitlements\(tx,\s*user\.id,\s*entitlementLoadOptions\(\)\)/],
      ["app/api/refresh/all/route.ts", /loadEffectiveEntitlements\(tx,\s*user\.id,\s*entitlementLoadOptions\(\)\)/],
      ["app/api/platform/customer-success/customers/[userId]/refresh/route.ts", /loadEffectiveEntitlements\(systemDb,\s*userId,\s*entitlementLoadOptions\(\)\)/],
      ["lib/platform/customer/customer-detail.ts", /loadEffectiveEntitlements\(client,\s*userId,\s*entitlementLoadOptions\(\)\)/],
    ];
    for (const [f, re] of direct) check(`${f}: loads with the switch`, re.test(strip(f)));
    for (const f of ["app/api/ai/chat/route.ts", "app/api/brief/route.ts", "app/api/brief/generate/route.ts", "app/api/user/export/route.ts", "lib/connections/connection-cap.ts"]) {
      check(`${f}: still resolves through entitlementsForUser (the switch-aware loader)`, /entitlementsForUser\(/.test(strip(f)));
    }
    const gen = strip("app/api/brief/generate/route.ts");
    check("brief generate: fail-closed refusal before pacing, the allowance and any model call",
      /refuseIfFailClosed\(entitlements,\s*'The Daily Brief'\)/.test(gen) && gen.indexOf("refuseIfFailClosed(") < gen.indexOf("paceAiRequest(")
      && gen.indexOf("refuseIfFailClosed(") < gen.indexOf("dailyAiAllowanceFor(") && gen.indexOf("refuseIfFailClosed(") < gen.indexOf("generateBriefResponse("));
    const get = strip("app/api/brief/route.ts");
    check("brief GET (reading) has NO fail-closed refusal — existing Briefs stay readable", !/refuseIfFailClosed/.test(get));
    const exp = strip("app/api/user/export/route.ts");
    check("export has NO fail-closed refusal — a read of the customer's own data stays (1/day)", !/refuseIfFailClosed/.test(exp));
    const plaid = strip("app/api/plaid/refresh/route.ts");
    check("plaid refresh: fail-closed refusal before any Plaid call", /refuseIfFailClosed\(entitlements,\s*"Manual refresh"\)/.test(plaid)
      && plaid.indexOf("refuseIfFailClosed(") < plaid.indexOf("checkManualRefreshCooldown("));
    const sync = strip("app/api/accounts/[id]/sync/route.ts");
    check("wallet sync: fail-closed refusal before the cooldown, limiter and claim", /refuseIfFailClosed\(entitlements,\s*"Manual refresh"\)/.test(sync)
      && sync.indexOf("refuseIfFailClosed(") < sync.indexOf("checkManualRefreshCooldown(") && sync.indexOf("refuseIfFailClosed(") < sync.indexOf("limitByUser("));
    const chat = strip("app/api/ai/chat/route.ts");
    check("chat: conversations gate (refuseIfDisabled) still precedes any model call", /refuseIfDisabled\(entitlements,\s*'conversations'/.test(chat));
  }

  console.log("7. assignment-health read, attention item, alert rule");
  {
    check("customerRef is the SAME opaque format as opaqueUserRef", customerRef("cmabcdef123456") === opaqueUserRef("cmabcdef123456") && customerRef("cmabcdef123456") === "user …123456");
    const fake: PolicyAssignmentReadClient & { calls: string[] } = {
      calls: [],
      user: {
        count: async () => { fake.calls.push("user.count"); return 30; },
        findMany: async (a) => { fake.calls.push(`user.findMany:${a.take}:${JSON.stringify(a.select)}`); return Array.from({ length: a.take }, (_, i) => ({ id: `cuser${String(i).padStart(6, "0")}`, createdAt: new Date(now.getTime() - (i + 1) * 3_600_000) })); },
      },
      customerPolicyAssignment: {
        count: async () => { fake.calls.push("cpa.count"); return 2; },
        findMany: async (a) => { fake.calls.push(`cpa.findMany:${a.take}:${JSON.stringify(a.where)}`); return [{ userId: "cuserzzzz01", policyGroup: "RETIRED_GROUP_V0", assignedAt: new Date("2026-01-01T00:00:00Z") }, { userId: "cuserzzzz02", policyGroup: "X".repeat(200), assignedAt: new Date("2026-01-02T00:00:00Z") }]; },
      },
    };
    const h = await loadPolicyAssignmentHealth({ client: fake, enforced: true, now });
    check("reads: two counts + two finds, bounded by the cap", fake.calls.length === 4 && fake.calls.filter((c) => c.includes(`:${POLICY_ASSIGNMENT_ISSUE_CAP}:`)).length === 2);
    check("reads: the user find selects id + createdAt only (no email, name, username)", fake.calls.some((c) => c === `user.findMany:${POLICY_ASSIGNMENT_ISSUE_CAP}:{"id":true,"createdAt":true}`));
    check("reads: unknown = policyGroup NOT IN the catalogue keys", fake.calls.some((c) => c.includes(`"notIn":${JSON.stringify(Object.keys(POLICY_GROUPS))}`)));
    check("health: exact counts, capped list, truncated", h.total === 32 && h.unassigned === 30 && h.unknown === 2 && h.items.length === POLICY_ASSIGNMENT_ISSUE_CAP && h.truncated && h.enforced);
    check("health: oldest first — the two unknown keys lead", h.items[0].reason === "UNKNOWN_POLICY_GROUP" && h.items[0].unknownKey === "RETIRED_GROUP_V0" && h.items[0].ref === "user …zzzz01");
    check("health: an over-long unknown key is cut to 64 chars", h.items[1].unknownKey?.length === 64);
    check("health: every ref is opaque (`user …` + 6)", h.items.every((i) => /^user …[A-Za-z0-9_-]{6}$/.test(i.ref)));

    // Attention
    const base = { connections: null, jobs: null, providers: null, resources: null, alerts: null, incidents: null };
    const on = buildAttention({ ...base, policyAssignments: h }, now);
    const rows = on.items.filter((i) => i.entity.kind === "customer");
    check("attention: policy-assignments is a named authority", ATTENTION_AUTHORITIES.includes("policy-assignments") && on.authorities.checked.includes("policy-assignments"));
    check("attention: one row per listed customer, severity error when enforced", rows.length === POLICY_ASSIGNMENT_ISSUE_CAP && rows.every((r) => r.severity === "error"));
    const first = rows.find((r) => r.entity.label === "user …zzzz01")!;
    check("attention: row names the opaque ref, the reason and the unknown key, and the CS fix",
      !!first && /"RETIRED_GROUP_V0" is not in the catalogue/.test(first.problem) && /Customer Success › Customers, search "user …zzzz01"/.test(first.problem) && /fail closed/.test(first.problem));
    check("attention: row has no ref field (never a customer id) and a Policies doorway",
      first.entity.ref === undefined && first.actions.some((a) => a.kind === "open-workspace" && a.workspace === "platform-policies:groups") && first.evidence.workspace === "platform-policies:groups");
    check("attention: floor caption states the exact total beyond the cap", on.floors.some((f) => /Policy assignments: 25 of 32 affected customers shown/.test(f)), on.floors.join(" | "));
    const blob = JSON.stringify(rows);
    check("attention: no email / name / whole id in any row", !/@|cuser000000|cuserzzzz01/.test(blob));
    const off = buildAttention({ ...base, policyAssignments: { ...h, enforced: false } }, now);
    check("attention: severity warning when the switch is off (exposure before enforcement)", off.items.filter((i) => i.entity.kind === "customer").every((r) => r.severity === "warning")
      && /Beta default today/.test(off.items.find((i) => i.entity.kind === "customer")!.problem));
    check("attention: an unread authority is NAMED as failed (absent ≡ null)", buildAttention(base, now).authorities.failed.includes("policy-assignments"));
    const clean = buildAttention({ ...base, policyAssignments: buildPolicyAssignmentHealth({ unassignedCount: 0, unassignedRows: [], unknownCount: 0, unknownRows: [], enforced: true }, now) }, now);
    check("attention: nothing affected ⇒ checked, no rows, no floor", clean.authorities.checked.includes("policy-assignments") && clean.items.length === 0 && clean.floors.length === 0);
    check("describe: unassigned wording", /No policy-group assignment recorded/.test(describePolicyAssignmentIssue({ ref: "user …abc123", reason: "UNASSIGNED", unknownKey: null, since: null }, true)));

    // Alert rule
    const rule = ALERT_RULES.find((r) => r.id === "policy-assignment-invalid");
    check("alert rule: registered, live, on by default, reads the policy-assignments authority",
      !!rule && rule.live && rule.defaultEnabled && rule.authority === "policy-assignments" && rule.kind === "policy-assignment");
    const sig = evaluatePolicyAssignmentInvalid(rule!, h);
    check("alert: one breach per listed customer + one :unlisted remainder", sig.length === POLICY_ASSIGNMENT_ISSUE_CAP + 1 && sig.at(-1)!.dedupeKey === "policy-assignment-invalid:critical:unlisted");
    // Review fix: severity is part of the dedupe key, so a state change is never
    // suppressed by an older breach inside the re-notify window.
    check("alert: critical when enforced, dedupe on severity + the opaque tail", sig.every((s) => s.severity === "critical") && sig[0].dedupeKey === "policy-assignment-invalid:critical:zzzz01");
    check("alert: summaries carry opaque refs only", !/@|cuserzzzz01|cuser000000/.test(JSON.stringify(sig)) && /user …zzzz01/.test(sig[0].summary));
    // Review fix: no EMAIL while the switch is off (nothing is refused; legacy
    // unassigned accounts would page daily) — the Attention item carries the warning.
    check("alert: no breach while the switch is off", evaluatePolicyAssignmentInvalid(rule!, { ...h, enforced: false }).length === 0);
    check("alert: nothing affected ⇒ no breach", evaluatePolicyAssignmentInvalid(rule!, { ...h, total: 0, unassigned: 0, unknown: 0, items: [], truncated: false }).length === 0);
    const viaEngine = evaluateAlertRules({ jobHealth: null, connectionHealth: null, resourceFreshness: null, aiFailures: null, aiSpend: null, syncIncidents: null, policyAssignments: h }, () => true);
    check("alert: the canonical evaluation dispatches the rule", viaEngine.filter((s) => s.kind === "policy-assignment").length === sig.length);
    check("alert: not gathered ⇒ no breach (never fabricated)", evaluateAlertRules({ jobHealth: null, connectionHealth: null, resourceFreshness: null, aiFailures: null, aiSpend: null, syncIncidents: null }, () => true).length === 0);

    // CS search makes the opaque reference actionable
    check("CS search: `user …abc123` ⇒ id tail", opaqueRefTail("user …zzzz01") === "zzzz01" && opaqueRefTail("…zzzz01") === "zzzz01" && opaqueRefTail("zzzz01") === "zzzz01");
    check("CS search: an email is not an id tail", opaqueRefTail("a@b.co") === null);
    check("CS search: the list query ORs an id endsWith clause", /\{\s*id:\s*\{\s*endsWith:\s*idTail\s*\}\s*\}/.test(strip("lib/platform/customer/customers.ts")));
  }

  console.log("8. no write / delete in the new code paths");
  {
    const MUTATE = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw|\$executeRaw|\$executeRawUnsafe)\s*\(/;
    for (const f of ["lib/entitlements/assignment-health.ts", "lib/entitlements/assignment-health-core.ts", "lib/entitlements/resolve.ts", "lib/entitlements/catalogue.ts", "lib/entitlements/consume.ts"]) {
      check(`${f}: no create / update / delete call`, !MUTATE.test(strip(f)));
    }
    const ah = strip("lib/entitlements/assignment-health.ts");
    check("assignment-health: selects no email / name / username", !/\b(email|name|username)\s*:\s*true/.test(ah));
    const core = strip("lib/entitlements/assignment-health-core.ts");
    check("assignment-health-core: pure (no db, no env, no clock read)", !/@\/lib\/db|systemDb|process\.env|@\/lib\/env|new Date\(\)/.test(core));
    const resolve = strip("lib/entitlements/resolve.ts");
    check("resolve.ts stays pure (no env / db import)", !/@\/lib\/env|@\/lib\/db|process\.env/.test(resolve));
  }

  console.log("review fix — Investments cannot be started by a fail-closed customer");
{
  const en = code("app/api/plaid/investments/enable/route.ts");
  check("investments enable refuses fail-closed before the limiter and any provider call",
    en.indexOf('refuseIfFailClosed(await entitlementsForUser(user.id), "Enable Investments")') > -1
      && en.indexOf('refuseIfFailClosed(await entitlementsForUser(user.id), "Enable Investments")') < en.indexOf("limitByUser(")
      && en.indexOf('refuseIfFailClosed(await entitlementsForUser(user.id), "Enable Investments")') < en.indexOf("refreshPlaidItem("));
  const lt = code("app/api/plaid/link-token/route.ts");
  check("an investments-consent link token is refused when fail-closed (plain update mode still repairs)",
    /if \(consentParam === "investments"\) \{[\s\S]{0,200}refuseIfFailClosed\(/.test(lt));
  const ah = code("lib/entitlements/assignment-health.ts");
  check("affected parties exclude deactivated / non-customer accounts", /deactivatedAt: null, policyAssignment: \{ is: null \}/.test(ah) && /user: \{ role: "USER" as const, deactivatedAt: null \}/.test(ah));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
