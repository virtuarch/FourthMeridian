/**
 * lib/platform/customer/attention-core.test.ts  (PB-4 — "who needs help, and why")
 *
 * ONE definition for both reads: the overview's per-reason counts equal the
 * Customers list filtered to that reason, for every reason and for "any", in
 * both fail-closed modes; the policy reason flags only an unknown / invalid /
 * retired assignment; an UNASSIGNED customer is a reason only while
 * POLICY_ASSIGNMENT_FAIL_CLOSED=enforce, read through the resolver's own mode
 * and the Platform Ops alert's own predicate (S2 ruling, 2026-11-02); a capped
 * read is a floor; the list route keeps its CUSTOMER_SUCCESS READ gate.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/customer/attention-core.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCsOverview, type CsOverviewFacts } from "./overview-core";
import {
  ATTENTION_KEYS, ATTENTION_LABELS, ATTENTION_SHORT, attentionOf, foldAttention, idsForAttention, parseAttentionFilter,
} from "./attention-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const NOW = new Date("2026-11-20T15:00:00.000Z");
const at = (s: string) => new Date(s);
const user = (id: string, created: string) => ({ id, createdAt: at(created), emailVerifiedAt: at(created), acceptedTermsAt: null, deactivatedAt: null });
const zero = { HEALTHY: 0, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 };

// a: connected, reconnect + incident · b: stalled + policy · c: registered yesterday (not stalled), no reason
// d: stalled · owner: connected, NO assignment (unassigned) · x: deactivated, reconnect + unassigned
const base: CsOverviewFacts = {
  activeCustomerIds: new Set(["a", "b", "c", "d", "owner"]),
  deactivatedCustomers: 1,
  funnel: {
    users: [user("a", "2026-11-01T00:00:00Z"), user("b", "2026-11-02T00:00:00Z"), user("c", "2026-11-19T00:00:00Z"), user("d", "2026-10-01T00:00:00Z"),
      user("owner", "2026-09-01T00:00:00Z"), user("x", "2026-10-01T00:00:00Z")],
    firstSessions: [{ userId: "a", at: at("2026-11-01T01:00:00Z") }, { userId: "b", at: at("2026-11-02T01:00:00Z") }, { userId: "d", at: at("2026-10-01T01:00:00Z") },
      { userId: "owner", at: at("2026-09-01T01:00:00Z") }],
    firstAiTurns: [], firstBriefViews: [], lastEngagements: [],
    plaidItems: [], manualAssets: [],
    walletConnections: [{ userId: "a", createdAt: at("2026-11-01T02:00:00Z"), status: "ACTIVE" }, { userId: "owner", createdAt: at("2026-09-01T02:00:00Z"), status: "ACTIVE" }],
  },
  reconnectOwners: ["a", "x", "a"],
  incidentOwners: ["a"],
  policyIssueOwners: ["b"],
  unassignedOwners: ["owner", "x"],
  connections: { total: 2, counts: { ...zero, HEALTHY: 1, NEEDS_REAUTH: 1 }, retired: { revoked: 0, ownerInactive: 0 } },
  incidentDays: [], incidentsFloor: false, openByKind: [],
};
const off: CsOverviewFacts = { ...base, policyFailClosed: false };
const enforce: CsOverviewFacts = { ...base, policyFailClosed: true };

console.log("1. overview counts == the list filtered to each reason (one fold), in BOTH modes");
for (const [mode, facts] of [["off/observe", off], ["enforce", enforce]] as const) {
  const o = buildCsOverview(facts, NOW, 30);
  const fold = foldAttention(facts, NOW);
  for (const r of o.attention.reasons) {
    check(`${mode} · ${r.key}: overview count ${r.count} == filtered list ${idsForAttention(fold, r.key).size}`, r.count === idsForAttention(fold, r.key).size);
  }
  check(`${mode} · any: the headline == the list filtered to any reason`, o.attention.customers === idsForAttention(fold, "any").size);
  check(`${mode} · reasons in ATTENTION_KEYS order with the shared labels`,
    JSON.stringify(o.attention.reasons.map((r) => r.key)) === JSON.stringify(fold.keys) && o.attention.reasons.every((r) => r.label === ATTENTION_LABELS[r.key])
    && JSON.stringify(fold.keys) === JSON.stringify(ATTENTION_KEYS.filter((k) => fold.keys.includes(k))));
  check(`${mode} · the overview DTO stays counts-only`, !JSON.stringify(o).includes('"owner"') && !JSON.stringify(o).includes("userId"));
}
{
  const fold = foldAttention(off, NOW);
  check("a row's reasons are in display order and a customer counts once per reason", JSON.stringify(attentionOf(fold, "a")) === JSON.stringify(["reconnect", "incident"]));
  check("policy + stalled for b", JSON.stringify(attentionOf(fold, "b")) === JSON.stringify(["policy", "stalled"]));
  check("no reason ⇒ [] (c registered yesterday)", attentionOf(fold, "c").length === 0);
  check("a deactivated account never needs help (x)", attentionOf(fold, "x").length === 0 && !idsForAttention(fold, "any").has("x"));
}

console.log("2. the policy reasons (owner ruling + S2 ruling, 2026-11-02)");
{
  check("policy label names an unknown / invalid / retired group, not 'missing'", ATTENTION_LABELS.policy === "Assigned policy group is unknown, invalid or retired" && !/missing/i.test(ATTENTION_LABELS.policy));
  check("unassigned has its own label", ATTENTION_LABELS.unassigned === "No policy group assigned (fail-closed: access restricted)");
  const offFold = foldAttention(off, NOW), onFold = foldAttention(enforce, NOW);
  check("off/observe: an unassigned customer (the owner's account) is NOT flagged and the reason row is absent",
    attentionOf(offFold, "owner").length === 0 && !offFold.keys.includes("unassigned") && idsForAttention(offFold, "unassigned").size === 0
    && !buildCsOverview(off, NOW, 30).attention.reasons.some((r) => r.key === "unassigned"));
  check("absent mode (no policyFailClosed) behaves as off", !foldAttention(base, NOW).keys.includes("unassigned") && attentionOf(foldAttention(base, NOW), "owner").length === 0);
  check("enforce: the unassigned customer IS flagged, under `unassigned` (not `policy`)",
    JSON.stringify(attentionOf(onFold, "owner")) === JSON.stringify(["unassigned"]) && onFold.keys.includes("unassigned") && !onFold.sets.policy.has("owner"));
  check("enforce: a deactivated unassigned account is still not flagged", !onFold.sets.unassigned.has("x"));
  check("enforce: the headline grows by exactly the unassigned customers", onFold.union.size === offFold.union.size + 1);
  const reader = code("lib/platform/customer/attention.ts");
  check("policy: only assignments naming a group not assignable now (unknown, invalid or archived)",
    /assignableGroups\(await loadPolicyGroupCatalogue\(\)\)/.test(reader) && /customerPolicyAssignment\.findMany\(\{ where: \{ policyGroup: \{ notIn: live \} \}/.test(reader)
    && /policyIssueOwners: invalid\.map\(\(a\) => a\.userId\)/.test(reader));
}

console.log("3. unassigned agrees with the entitlements resolver and the Platform Ops alert");
{
  const reader = code("lib/platform/customer/attention.ts");
  check("mode = the resolver's own (entitlementLoadOptions().failClosed), no env parse here",
    /entitlementLoadOptions\(\)\.failClosed/.test(reader) && !/process\.env|POLICY_ASSIGNMENT_FAIL_CLOSED|isPolicyAssignmentFailClosed/.test(reader));
  check("unassigned = the alert's predicate (UNASSIGNED_CUSTOMER_WHERE), read only when enforced",
    /failClosed\s*\?\s*client\.user\.findMany\(\{ where: UNASSIGNED_CUSTOMER_WHERE/.test(reader) && !/policyAssignment:\s*\{\s*is:\s*null/.test(reader));
  const health = code("lib/platform/policy-assignment-health.ts");
  check("the alert read uses the SAME predicate", /export const UNASSIGNED_CUSTOMER_WHERE = \{ role: "USER" as const, deactivatedAt: null, policyAssignment: \{ is: null \} \}/.test(health)
    && /const unassignedWhere = UNASSIGNED_CUSTOMER_WHERE;/.test(health));
  const consume = code("lib/entitlements/consume.ts");
  check("both modes come from the ONE getter: the resolver's options and the alert read env.isPolicyAssignmentFailClosed",
    /failClosed: env\.isPolicyAssignmentFailClosed/.test(consume) && /enforced: opts\.enforced \?\? env\.isPolicyAssignmentFailClosed/.test(health));
  const envSrc = code("lib/env.ts");
  check("…and that getter is the one parse: === \"enforce\"", /get isPolicyAssignmentFailClosed\(\) \{ return _e\.POLICY_ASSIGNMENT_FAIL_CLOSED === "enforce"; \}/.test(envSrc));
}

console.log("4. beta-scale cap → floor (the active-incident scan's pattern)");
{
  check("floor propagates from the facts to the fold and the overview", foldAttention({ ...off, floor: true }, NOW).floor && buildCsOverview({ ...off, floor: true }, NOW, 30).attention.floor
    && !buildCsOverview(off, NOW, 30).attention.floor);
  const reader = code("lib/platform/customer/attention.ts");
  const raw = readFileSync(path.join(process.cwd(), "lib/platform/customer/attention.ts"), "utf8");
  check("the beta-scale assumption is named in the reader", /BETA-SCALE ASSUMPTION/.test(raw) && /ACTIVE_INCIDENT_SCAN → `scanTruncated` → `openFloor`/.test(raw));
  const fleet = (reader.match(/findMany\(\{[^)]*\}\)/g) ?? []).filter((m) => !/id: \{ in:/.test(m));
  check("every fleet findMany this reader owns (5) is capped", fleet.length === 5 && fleet.every((m) => /take: cap/.test(m)), fleet);
  check("a read reaching the cap (or a truncated incident scan) marks the floor",
    /\[customers, plaidBroken, connBroken, invalid, unassigned\]\.some\(\(rows\) => rows\.length >= cap\) \|\| activePage\.scanTruncated/.test(reader) && /floor,\n\s*\};/.test(reader));
  const list = code("lib/platform/customer/customers.ts");
  check("the list reports the floor and names only the reasons that apply", /attentionFloor: att\.fold\.floor/.test(list) && /fold\.keys\.map/.test(list));
}

console.log("5. filter parsing");
{
  check("absent / empty ⇒ no filter", parseAttentionFilter(null) === null && parseAttentionFilter("") === null && parseAttentionFilter(undefined) === null);
  check("every key and 'any' parse", [...ATTENTION_KEYS, "any"].every((k) => parseAttentionFilter(k) === k));
  check("anything else is refused (undefined)", parseAttentionFilter("everyone") === undefined && parseAttentionFilter("constructor") === undefined && parseAttentionFilter(42) === undefined);
  check("every reason has a chip word", ATTENTION_KEYS.every((k) => typeof ATTENTION_SHORT[k] === "string" && ATTENTION_SHORT[k].length > 0));
}

console.log("6. one source of truth (source pins)");
{
  const core = code("lib/platform/customer/overview-core.ts");
  check("the overview core folds through foldAttention and builds no reason set of its own",
    /foldAttention\(facts, now\)/.test(core) && !/reconnect:\s*only\(|new Set\(ids\.filter/.test(core) && /reasons: att\.keys\.map/.test(core));
  const overview = code("lib/platform/customer/overview.ts");
  check("the overview reader reads the attention facts through loadAttention", /loadAttention\(now, client\)/.test(overview) && !/plaidItem\.findMany|customerPolicyAssignment/.test(overview));
  const list = code("lib/platform/customer/customers.ts");
  check("the list reads the SAME fold and filters BEFORE paging", /const att = await loadAttention\(now, client\)/.test(list) && /id: \{ in: \[\.\.\.idsForAttention\(att\.fold, filter\)\] \}/.test(list)
    && /client\.user\.count\(\{ where \}\)/.test(list));
  check("each row carries its reasons from the fold", /attention: attentionOf\(att\.fold, u\.id\)/.test(list));
  const route = code("app/api/platform/customer-success/customers/route.ts");
  check("the list route keeps CUSTOMER_SUCCESS READ first, then parses attention (400 on an unknown reason)",
    /requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\);\s*if \(err\) return err;/.test(route) && /parseAttentionFilter\(url\.searchParams\.get\("attention"\)\)/.test(route)
    && /status: 400/.test(route) && route.indexOf("requirePlatformAccess(") < route.indexOf("parseAttentionFilter("));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
