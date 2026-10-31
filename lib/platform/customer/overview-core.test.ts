/**
 * lib/platform/customer/overview-core.test.ts  (Platform Spaces 2.0 — Customer Success)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/customer/overview-core.test.ts
 */

import { buildCsOverview, type CsOverviewFacts } from "./overview-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const NOW = new Date("2026-11-20T15:00:00.000Z");
const at = (s: string) => new Date(s);
const user = (id: string, created: string, verified = true) => ({ id, createdAt: at(created), emailVerifiedAt: verified ? at(created) : null, acceptedTermsAt: null, deactivatedAt: null });
const zero = { HEALTHY: 0, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 };

const facts: CsOverviewFacts = {
  activeCustomerIds: new Set(["a", "b", "c", "d"]),
  deactivatedCustomers: 1,
  funnel: {
    users: [user("a", "2026-11-01T00:00:00Z"), user("b", "2026-11-02T00:00:00Z"), user("c", "2026-11-19T00:00:00Z"), user("d", "2026-10-01T00:00:00Z"), user("x", "2026-10-01T00:00:00Z")],
    firstSessions: [{ userId: "a", at: at("2026-11-01T01:00:00Z") }, { userId: "b", at: at("2026-11-02T01:00:00Z") }, { userId: "d", at: at("2026-10-01T01:00:00Z") }, { userId: "x", at: at("2026-10-01T01:00:00Z") }],
    firstAiTurns: [], firstBriefViews: [], lastEngagements: [],
    plaidItems: [], walletConnections: [{ userId: "a", createdAt: at("2026-11-01T02:00:00Z"), status: "ACTIVE" }], manualAssets: [],
  },
  reconnectOwners: ["a", "x"],
  incidentOwners: ["a"],
  policyIssueOwners: [],
  connections: { total: 2, counts: { ...zero, HEALTHY: 1, NEEDS_REAUTH: 1 }, retired: { revoked: 0, ownerInactive: 0 } },
  incidentDays: [{ day: "2026-11-20", opened: 1, resolved: 0 }],
  incidentsFloor: false,
  openByKind: [{ kind: "MISSING_ACCOUNT", count: 1 }],
};

console.log("1. stages, attention, union");
{
  const r = buildCsOverview(facts, NOW, 30);
  const stage = (k: string) => r.stages.find((s) => s.key === k)?.count;
  check("only ACTIVE customers are in the stage distribution (x is not)", r.stages.reduce((a, s) => a + s.count, 0) === 4);
  check("strict funnel: a → first connection, b and d → first session, c (no session) → verified", stage("firstConnection") === 1 && stage("firstSession") === 2 && stage("verified") === 1, r.stages);
  const reason = (k: string) => r.attention.reasons.find((x) => x.key === k)?.count;
  check("reconnect counts active owners only (x is not active)", reason("reconnect") === 1);
  check("stalled = not connected 7+ days after registering (b, d — not c, registered yesterday)", reason("stalled") === 2);
  check("the headline counts each customer once (a twice → once)", r.attention.customers === 3);
  check("open issues summed and labelled", r.incidents.open === 1 && r.incidents.openByKind[0].label === "Missing account");
  check("onboarding cohorts come from the shared strict funnel (8 weeks)", r.onboarding.rows.length === 8 && r.onboarding.stages.length === 5);
  check("support tickets and health scores are declared not available", r.notes.some((n) => /support tickets/.test(n) && /health scores/.test(n)));
  check("no identity in the body", !JSON.stringify(r).includes('"a"') && !JSON.stringify(r).includes("userId"));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
