/**
 * lib/account-deletion/purge-registry.test.ts  (PB-1 Phase 1)
 *
 * GENERATED FROM THE PRISMA DMMF: every scalar column named userId /
 * subjectUserId / plaidItemId / plaidItemDbId / financialAccountId / subject…Id
 * must be an FK the purge's hard deletes cascade through, or carry an explicit
 * disposition in lib/account-deletion/purge-registry.ts. An unsorted column
 * fails CI.
 *
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/account-deletion/purge-registry.test.ts
 */

import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { PURGE_REGISTRY } from "./purge-registry";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const SUBJECT_COLUMN = /^(userId|subjectUserId|plaidItemId|plaidItemDbId|financialAccountId|subject\w*Id)$/;
/** Parents the purge hard-deletes: an FK Cascade from these is a real disposition. */
const PURGED_PARENTS = new Set(["User", "FinancialAccount", "PlaidItem"]);

const found: string[] = [];
const cascade: string[] = [];
const unsorted: string[] = [];
for (const m of Prisma.dmmf.datamodel.models) {
  for (const f of m.fields) {
    if (f.kind !== "scalar" || !SUBJECT_COLUMN.test(f.name)) continue;
    const key = `${m.name}.${f.name}`;
    found.push(key);
    const rel = m.fields.find((r) => r.kind === "object" && (r.relationFromFields ?? []).includes(f.name));
    if (rel && rel.relationOnDelete === "Cascade" && PURGED_PARENTS.has(rel.type) && !PURGE_REGISTRY[key]) { cascade.push(key); continue; }
    if (!PURGE_REGISTRY[key]) unsorted.push(key);
  }
}

console.log("the registry is generated from the schema, not hand-listed");
check("the DMMF scan found the incident subject columns", ["SyncIssue.subjectUserId", "SyncIssueArchive.subjectUserId", "SyncIssueOccurrence.subjectAccountId"].every((k) => found.includes(k)));
check("every subject-reference column has a disposition", unsorted.length === 0, unsorted.join(", "));
check("every registry entry names a real column (no stale entries)",
  Object.keys(PURGE_REGISTRY).every((k) => found.includes(k)), Object.keys(PURGE_REGISTRY).filter((k) => !found.includes(k)).join(", "));
check("every RETAIN carries a reason that names its retention or policy",
  Object.values(PURGE_REGISTRY).filter((e) => e.disposition === "RETAIN").every((e) => /days|policy|cascade/i.test(e.reason)));

console.log("\nDELETE dispositions are real");
{
  const purge = readFileSync("lib/account-deletion/purge.ts", "utf8");
  const incidents = readFileSync("lib/platform/incidents/purge.ts", "utf8");
  check("the account purge resolves the incident set BEFORE the tail and deletes it INSIDE it",
    purge.indexOf("resolveIncidentPurgeSet(") > 0 && purge.indexOf("resolveIncidentPurgeSet(") < purge.indexOf("await client.$transaction(")
    && purge.indexOf("purgeIncidentSet(tx") > purge.indexOf("await client.$transaction("));
  check("the incident purge matches subjectUserId, the user's Items, accounts and occurrence subjects",
    /subjectUserId: scope\.userId/.test(incidents) && /plaidItemId: \{ in: items \}/.test(incidents)
    && /financialAccountId: \{ in: accounts \}/.test(incidents) && /occurrences: \{ some: \{ subjectAccountId/.test(incidents));
  check("…and deletes incidents, events, relations (either end) and archives",
    /syncIssue\.deleteMany/.test(incidents) && /syncIssueEvent\.deleteMany/.test(incidents)
    && /fromIncidentId: \{ in: all \}/.test(incidents) && /toIncidentId: \{ in: all \}/.test(incidents) && /syncIssueArchive\.deleteMany/.test(incidents));
}

console.log(`\n  ${found.length} subject-reference columns — cascade ${cascade.length}, registry ${Object.keys(PURGE_REGISTRY).length}`);
if (failures > 0) { console.error(`\n❌ purge registry: ${failures} check(s) failed`); process.exit(1); }
console.log("\n✅ purge registry: all checks passed");
