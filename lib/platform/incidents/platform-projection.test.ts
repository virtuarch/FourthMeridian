/**
 * lib/platform/incidents/platform-projection.test.ts  (UX-P1 · D5)
 *
 * The PLATFORM_OPS incident projection is identity-minimized: it carries the
 * institution · account label and the semantics authority's verdicts, and
 * NOTHING a careless upstream might attach — no email, no userId, no address,
 * no token, no raw ids beyond the opaque episode id.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/platform-projection.test.ts
 */

import { PLATFORM_INCIDENT_KEYS, projectVerdictForPlatform, subjectLabel } from "./platform-projection";
import { deriveIncidentVerdicts } from "./intelligence/core";
import type { CsIncidentVerdict, IncidentRowFacts } from "./intelligence/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// PB-1 R6a — the input is a real module verdict, at the CUSTOMER_SUCCESS tier on purpose (it carries
// subjectUserId) plus injected fields, to prove the field-by-field projection drops every one of them.
const NOW = new Date("2026-10-14T12:00:00.000Z");
const facts: IncidentRowFacts = {
  id: "inc_01", kind: "TRANSACTION_PERSISTENCE_FAILED", provider: "PLAID", plaidItemId: "item_123", financialAccountId: "acct_123",
  plaidTransactionId: null, detail: { stage: "transaction-persist", cursorBlocking: true }, resolved: false,
  incidentKey: "v1::PLAID::item:item_123::transactions::transaction-persist", previousIncidentId: null,
  createdAt: new Date("2026-10-10T06:00:00.000Z"), firstOccurredAt: new Date("2026-10-10T06:00:00.000Z"), lastOccurredAt: new Date("2026-10-14T06:00:00.000Z"),
  resolvedAt: null, resolutionKind: null, resolutionReasonCode: null, lifecycleState: null, acknowledgedAt: null, recoveringSince: null,
  archivedAt: null, subjectUserId: "user_123", causeStatus: null, causeCode: null, evidence: null, occurrenceCount: 3, correlatedOccurrenceCount: 1,
};
const [base] = deriveIncidentVerdicts({
  rows: [facts], scanTruncated: false,
  subjects: { items: new Map([["item_123", { status: "ACTIVE", userId: "user_123" }]]), accounts: new Map([["acct_123", { deletedAt: null, ownerUserId: "user_123", createdByUserId: "user_123" }]]) },
}, { now: NOW, audience: "CUSTOMER_SUCCESS" }).all as CsIncidentVerdict[];
const verdict = {
  ...base,
  // Fields that must NEVER appear downstream, injected to prove the projection drops them.
  ...({ email: "owner@example.test", walletAddress: "bc1qSECRET", accessToken: "tok_SECRET" } as object),
} as CsIncidentVerdict;

console.log("subject label");
{
  check("institution · account", subjectLabel({ primary: "Chase", secondary: "Checking" }) === "Chase · Checking");
  check("institution only", subjectLabel({ primary: "Chase", secondary: null }) === "Chase");
  check("unknown → null, never a guess", subjectLabel({ primary: null, secondary: null }) === null);
  check("blank strings are not a label", subjectLabel({ primary: "  ", secondary: "" }) === null);
}

console.log("projection");
{
  check("fixture: a CS-tier verdict that names the customer and the opaque ids", verdict.subjectUserId === "user_123" && verdict.plaidItemId === "item_123" && verdict.brokenNow);
  const p = projectVerdictForPlatform(verdict, { primary: "Chase", secondary: "Checking" }, "exec_abc123");
  const json = JSON.stringify(p);
  check("carries exactly the declared keys", Object.keys(p).sort().join(",") === [...PLATFORM_INCIDENT_KEYS].sort().join(","), Object.keys(p).join(","));
  for (const leak of ["owner@example.test", "user_123", "bc1qSECRET", "tok_SECRET", "item_123", "acct_123"]) {
    check(`drops ${leak}`, !json.includes(leak));
  }
  check("no key named email/userId/address/token", !/"(email|userId|subjectUserId|walletAddress|accessToken|plaidItemId|financialAccountId)"/.test(json));
  check("subject is the institution · account label", p.subject === "Chase · Checking");
  check("severity, effectiveSeverity, state, freshness and brokenNow are READ from the verdict, not re-derived",
    p.severity === verdict.severity && p.effectiveSeverity === verdict.effectiveSeverity && p.state === verdict.state && p.freshness === verdict.freshness && p.brokenNow === verdict.brokenNow);
  check("label and operation label are the module's", p.label === verdict.label && p.operationLabel === verdict.operationLabel);
  check("the correlated execution is named as evidence", p.refreshExecutionId === "exec_abc123");
  check("occurrence depth and its knowability travel together", p.occurrenceCount === 3 && p.occurrenceCountKnown === true);
  check("D7 times: first / last seen", p.firstOccurredAt === "2026-10-10T06:00:00.000Z" && p.lastOccurredAt === "2026-10-14T06:00:00.000Z");
  const none = projectVerdictForPlatform({ ...verdict, occurrenceCount: 0, firstSeenAt: "", lastSeenAt: "" }, { primary: null, secondary: null }, null);
  check("an unresolvable subject is null, an empty timestamp is null, zero depth is unknown",
    none.subject === null && none.firstOccurredAt === null && none.lastOccurredAt === null && none.occurrenceCountKnown === false);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
