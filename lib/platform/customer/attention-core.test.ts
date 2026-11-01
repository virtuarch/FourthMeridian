/**
 * lib/platform/customer/attention-core.test.ts  (PB-4 — "who needs help, and why")
 *
 * ONE definition for both reads: the overview's per-reason counts equal the
 * Customers list filtered to that reason, for every reason and for "any";
 * the policy reason flags only an unknown / invalid / retired assignment, never
 * the unassigned default; the list carries the reasons on each row and the
 * route keeps its CUSTOMER_SUCCESS READ gate.
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
// d: stalled · owner: connected, no assignment (NOT in policyIssueOwners — the reader never lists the default) · x: deactivated, reconnect
const facts: CsOverviewFacts = {
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
  connections: { total: 2, counts: { ...zero, HEALTHY: 1, NEEDS_REAUTH: 1 }, retired: { revoked: 0, ownerInactive: 0 } },
  incidentDays: [], incidentsFloor: false, openByKind: [],
};

console.log("1. overview counts == the list filtered to each reason (one fold)");
{
  const o = buildCsOverview(facts, NOW, 30);
  const fold = foldAttention(facts, NOW);
  for (const key of ATTENTION_KEYS) {
    const count = o.attention.reasons.find((r) => r.key === key)?.count;
    check(`${key}: overview count ${count} == filtered list ${idsForAttention(fold, key).size}`, count === idsForAttention(fold, key).size);
  }
  check("any: the headline == the list filtered to any reason", o.attention.customers === idsForAttention(fold, "any").size && o.attention.customers === 3);
  check("the reasons are listed in ATTENTION_KEYS order with the shared labels",
    JSON.stringify(o.attention.reasons.map((r) => [r.key, r.label])) === JSON.stringify(ATTENTION_KEYS.map((k) => [k, ATTENTION_LABELS[k]])));
  check("a row's reasons are in display order and a customer counts once per reason", JSON.stringify(attentionOf(fold, "a")) === JSON.stringify(["reconnect", "incident"]));
  check("stalled + policy for b", JSON.stringify(attentionOf(fold, "b")) === JSON.stringify(["policy", "stalled"]));
  check("no reason ⇒ [] (c registered yesterday; owner on the default policy)", attentionOf(fold, "c").length === 0 && attentionOf(fold, "owner").length === 0);
  check("a deactivated account never needs help (x)", attentionOf(fold, "x").length === 0 && !idsForAttention(fold, "any").has("x"));
  check("the overview DTO stays counts-only", !JSON.stringify(o).includes('"owner"') && !JSON.stringify(o).includes("userId"));
}

console.log("2. the policy reason (owner ruling 2026-11-02)");
{
  check("label names an unknown / invalid / retired group, not 'missing'", ATTENTION_LABELS.policy === "Assigned policy group is unknown, invalid or retired" && !/missing/i.test(ATTENTION_LABELS.policy));
  const reader = code("lib/platform/customer/attention.ts");
  check("the reader never treats an UNASSIGNED customer as a policy issue", !/policyAssignment:\s*\{\s*is:\s*null\s*\}/.test(reader));
  check("only assignments naming a group not assignable now (unknown, invalid or archived) are flagged",
    /assignableGroups\(await loadPolicyGroupCatalogue\(\)\)/.test(reader) && /customerPolicyAssignment\.findMany\(\{ where: \{ policyGroup: \{ notIn: live \} \}/.test(reader)
    && /policyIssueOwners: invalid\.map\(\(a\) => a\.userId\)/.test(reader));
}

console.log("3. filter parsing");
{
  check("absent / empty ⇒ no filter", parseAttentionFilter(null) === null && parseAttentionFilter("") === null && parseAttentionFilter(undefined) === null);
  check("every key and 'any' parse", [...ATTENTION_KEYS, "any"].every((k) => parseAttentionFilter(k) === k));
  check("anything else is refused (undefined)", parseAttentionFilter("everyone") === undefined && parseAttentionFilter("constructor") === undefined);
  check("every reason has a chip word", ATTENTION_KEYS.every((k) => typeof ATTENTION_SHORT[k] === "string" && ATTENTION_SHORT[k].length > 0));
}

console.log("4. one source of truth (source pins)");
{
  const core = code("lib/platform/customer/overview-core.ts");
  check("the overview core folds through foldAttention and builds no reason set of its own",
    /foldAttention\(facts, now\)/.test(core) && !/reconnect:\s*only\(|new Set\(ids\.filter/.test(core));
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
