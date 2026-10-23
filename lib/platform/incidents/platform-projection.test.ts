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

import { PLATFORM_INCIDENT_KEYS, projectIncidentForPlatform, subjectLabel } from "./platform-projection";
import type { IncidentPreviewItem } from "./preview-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const item: IncidentPreviewItem = {
  id: "inc_01",
  title: "Transaction persistence failed",
  operationLabel: "storing delivered transactions",
  description: "Delivered bank transactions were not stored.",
  severity: "critical",
  domain: "transactions",
  nature: "condition",
  state: "active",
  subject: { primary: "Chase", secondary: "Checking" },
  firstOccurredAt: "2026-10-10T06:00:00.000Z",
  lastOccurredAt: "2026-10-14T06:00:00.000Z",
  occurrenceCount: 3,
  occurrenceCountKnown: true,
  recovery: "automatic-available",
  executionCorrelated: true,
  // Fields that must NEVER appear downstream, injected to prove the projection drops them.
  ...({ email: "owner@example.test", userId: "user_123", walletAddress: "bc1qSECRET", accessToken: "tok_SECRET", plaidItemId: "item_123", financialAccountId: "acct_123" } as object),
};

console.log("subject label");
{
  check("institution · account", subjectLabel({ primary: "Chase", secondary: "Checking" }) === "Chase · Checking");
  check("institution only", subjectLabel({ primary: "Chase", secondary: null }) === "Chase");
  check("unknown → null, never a guess", subjectLabel({ primary: null, secondary: null }) === null);
  check("blank strings are not a label", subjectLabel({ primary: "  ", secondary: "" }) === null);
}

console.log("projection");
{
  const p = projectIncidentForPlatform(item, "exec_abc123");
  const json = JSON.stringify(p);
  check("carries exactly the declared keys", Object.keys(p).sort().join(",") === [...PLATFORM_INCIDENT_KEYS].sort().join(","), Object.keys(p).join(","));
  for (const leak of ["owner@example.test", "user_123", "bc1qSECRET", "tok_SECRET", "item_123", "acct_123"]) {
    check(`drops ${leak}`, !json.includes(leak));
  }
  check("no key named email/userId/address/token", !/"(email|userId|walletAddress|accessToken|plaidItemId|financialAccountId)"/.test(json));
  check("subject is the institution · account label", p.subject === "Chase · Checking");
  check("severity and state are READ, not re-derived", p.severity === "critical" && p.state === "active");
  check("the correlated execution is named as evidence", p.refreshExecutionId === "exec_abc123");
  check("occurrence depth and its knowability travel together", p.occurrenceCount === 3 && p.occurrenceCountKnown === true);
  const none = projectIncidentForPlatform({ ...item, subject: { primary: null, secondary: null }, firstOccurredAt: "", lastOccurredAt: "" }, null);
  check("an unresolvable subject is null, an empty timestamp is null", none.subject === null && none.firstOccurredAt === null && none.lastOccurredAt === null);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
