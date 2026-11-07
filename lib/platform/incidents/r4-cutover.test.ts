/**
 * lib/platform/incidents/r4-cutover.test.ts  (PB-1 Phase 2 R4 — the projection reads module verdicts)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/r4-cutover.test.ts
 *
 * Synthetic ids only; pure + source pins.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { deriveIncidentVerdicts } from "./intelligence/core";
import { incidentViewOf } from "./projections";
import type { IncidentFacts, IncidentRowFacts } from "./intelligence/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const NOW = new Date("2026-11-03T12:00:00Z");
const D = (iso: string) => new Date(iso);
function row(id: string, over: Partial<IncidentRowFacts> = {}): IncidentRowFacts {
  return {
    id, kind: "UPSERT_ERROR", provider: "PLAID", plaidItemId: "item_a", financialAccountId: null, plaidTransactionId: null,
    detail: { stage: "transaction-persist", cursorBlocking: true }, resolved: false, incidentKey: null, previousIncidentId: null,
    createdAt: D("2026-11-01T00:00:00Z"), firstOccurredAt: D("2026-11-01T00:00:00Z"), lastOccurredAt: D("2026-11-02T00:00:00Z"),
    resolvedAt: null, resolutionKind: null, resolutionReasonCode: null, lifecycleState: null, acknowledgedAt: null,
    recoveringSince: null, archivedAt: null, subjectUserId: "u_9", causeStatus: null, causeCode: null, evidence: null,
    occurrenceCount: 0, correlatedOccurrenceCount: 0, ...over,
  };
}
const facts = (rows: IncidentRowFacts[]): IncidentFacts => ({
  rows, scanTruncated: false,
  subjects: {
    items: new Map([["item_a", { status: "ACTIVE", userId: "u_9" }], ["item_rev", { status: "REVOKED", userId: "u_9" }]]),
    accounts: new Map([["acct_soft", { deletedAt: D("2026-10-01T00:00:00Z"), ownerUserId: "u_9", createdByUserId: "u_9" }]]),
  },
});

console.log("incidentViewOf — the IncidentView shape every consumer reads, from one verdict");
{
  const [v] = deriveIncidentVerdicts(facts([row("r1", { incidentKey: "v1::PLAID::item:item_a::transactions::transaction-persist", previousIncidentId: "r0", occurrenceCount: 2 })]), { now: NOW, audience: "PLATFORM_OPS" }).all;
  const view = incidentViewOf(v);
  check("ids, kind, provider and the real incidentKey", view.id === "r1" && view.kind === "UPSERT_ERROR" && view.plaidItemId === "item_a"
    && view.incidentKey === "v1::PLAID::item:item_a::transactions::transaction-persist");
  check("state is active; classification from the semantics authority (incl. cursorBlocking)",
    view.state === "active" && view.classification.severity === "critical" && view.classification.domain === "transactions"
    && view.classification.nature === "condition" && view.classification.cursorBlocking === true && view.classification.customerActionable === true, view.classification);
  check("D7 times; recurrence; counts", view.firstOccurredAt === "2026-11-01T00:00:00.000Z" && view.lastOccurredAt === "2026-11-02T00:00:00.000Z"
    && view.previousIncidentId === "r0" && view.occurrenceCount === 2 && view.legacyUncorrelated === false);
  const legacy = incidentViewOf(deriveIncidentVerdicts(facts([row("r2")]), { now: NOW, audience: "PLATFORM_OPS" }).all[0]);
  check("a keyless legacy row has incidentKey null (never 'legacy:<id>') and is legacy-uncorrelated", legacy.incidentKey === null && legacy.legacyUncorrelated === true);
  const cs = incidentViewOf(deriveIncidentVerdicts(facts([row("r3")]), { now: NOW, audience: "CUSTOMER_SUCCESS" }).all[0]);
  check("identity-free whatever the tier: a CS-tier verdict yields no customer id", !("subjectUserId" in cs) && !JSON.stringify(cs).includes("u_9"));
}

console.log("D2 / D2b / D10 — what leaves the active page");
{
  const vs = deriveIncidentVerdicts(facts([
    row("live"), row("revoked", { plaidItemId: "item_rev" }), row("soft", { plaidItemId: null, financialAccountId: "acct_soft" }),
  ]), { now: NOW, audience: "PLATFORM_OPS" }).all;
  const broken = vs.filter((v) => v.brokenNow).map((v) => v.id);
  check("only the live incident is broken now (REVOKED item and soft-deleted account read connection removed)", broken.join() === "live", broken);
}

console.log("source pins — every caller mints its own tier");
{
  const src = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
  for (const f of [
    "app/api/platform/customer-success/customers/route.ts",
    "app/api/platform/customer-success/overview/route.ts",
    "app/api/platform/customer-success/sync-issues/route.ts",
  ]) check(`${f}: mints the CUSTOMER_SUCCESS token from its own guard result`, /const incidentToken = incidentAudienceFor\(auth\);/.test(src(f)) && /incidentToken\.audience !== "CUSTOMER_SUCCESS"/.test(src(f)));
  check("the Ops attention route mints at the Ops tier", /atOpsTier\(incidentAudienceFor\(auth\)\)/.test(src("app/api/platform/platform-ops/attention/route.ts")));
  const proj = src("lib/platform/incidents/projections.ts");
  check("the projection's referent check is the subjects-core rule (deletedAt + REVOKED honoured)",
    /isSubjectRemoved\(subjectVerdict\(r, facts\)\)/.test(proj) && !/liveAccounts\.has|liveItems\.has/.test(proj));
  check("the projection never reads the alertable set (SYSTEM stays in lib/alerts)", !/\.alertable\(/.test(proj));
}

if (failures) { console.error(`\nr4-cutover.test: ${failures} failure(s).`); process.exit(1); }
console.log("\nr4-cutover.test: all passed.");
