/**
 * lib/platform/operator-action-adoption.test.ts  (P1 — operator actions)
 *
 * The existing operator routes record through the ONE chokepoint
 * (lib/audit.ts recordOperatorAction), consequential actions require a reason,
 * execution references are recorded, and the feed never projects the note.
 * Source scans + a pure projection test. Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/operator-action-adoption.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { OPERATOR_REASON_CODES } from "@/lib/audit";
import { projectOperatorActionEvent } from "@/lib/platform/security/operator-actions-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const strip = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const OPERATIONS = "app/api/platform/platform-ops/operations/route.ts";
const RESYNC     = "app/api/platform/platform-ops/connections/[id]/resync/route.ts";
const REAUTH     = "app/api/platform/platform-ops/connections/[id]/request-reauth/route.ts";
const CLEANUP    = "app/api/platform/platform-ops/provider-cleanup/route.ts";
const USERS      = "app/api/platform/growth-revenue/users/[userId]/route.ts";
const WIDGET     = "components/platform/widgets/OpsUsersWidget.tsx";
const FEED_ROUTE = "app/api/platform/security-ops/operator-actions/route.ts";
const FEED_WIDGET= "components/platform/widgets/SecOperatorActionsWidget.tsx";

console.log("adoption — every converted route records through the chokepoint, none through auditLog.create");
for (const f of [OPERATIONS, RESYNC, REAUTH, CLEANUP, USERS]) {
  const s = strip(f);
  check(`${f}: uses recordOperatorAction`, /recordOperatorAction\(/.test(s));
  check(`${f}: no direct auditLog.create remains`, !/auditLog\.create\(/.test(s));
  check(`${f}: actor derived from the resolved PlatformAuth (operatorActorFrom)`, /operatorActorFrom\(auth/.test(s));
}

console.log("Run Now — the JobRun id is the execution reference; the JOB is the target");
{
  const s = strip(OPERATIONS);
  check("target kind JOB", /target:\s*\{\s*kind:\s*"JOB"/.test(s));
  check("execution carries commandId + jobRunId", /execution:\s*\{\s*commandId:[^}]*jobRunId:/.test(s));
  check("in-flight is recorded as REFUSED, a body failure as FAILURE", /"in-flight"\s*\?\s*"REFUSED"/.test(s) && /"failed"\s*\?\s*"FAILURE"/.test(s));
  check("Run Now does not require a reason (the action is the reason)", !/parseOperatorReason/.test(s));
}

console.log("connection actions — PLAID_ITEM target, refresh execution reference, no identity");
{
  const r = strip(RESYNC);
  check("resync target kind PLAID_ITEM", /target:\s*\{\s*kind:\s*"PLAID_ITEM"/.test(r));
  check("resync records the RefreshExecution id captured from runFullRefresh", /refreshExecutionId = runId/.test(r) && /execution:\s*\{\s*refreshExecutionId\s*\}/.test(r));
  check("not-admitted is REFUSED, failure is FAILURE", /"not-admitted",\s*"REFUSED"/.test(r) && /"failed",\s*"FAILURE"/.test(r));
  for (const f of [RESYNC, REAUTH, CLEANUP]) {
    const s = strip(f);
    check(`${f}: selects no email and writes no userId subject`, !/email:\s*true/.test(s) && !/userId:\s*item\.userId/.test(s));
  }
}

console.log("deactivate / reactivate — reason REQUIRED, change + audit in ONE transaction");
{
  const s = strip(USERS);
  check("parses the reason before any read", s.indexOf("parseOperatorReason(") < s.indexOf("db.user.findUnique("));
  check("an invalid reason is a 400", /OperatorActionValidationError[\s\S]{0,120}status:\s*400/.test(s));
  check("state change and audit share a $transaction", (s.match(/\$transaction\(async \(tx\) =>/g) ?? []).length === 2 && /recordOperatorAction\(tx,/.test(s));
  check("target kind USER (the customer is the row's subject)", /target:\s*\{\s*kind:\s*"USER",\s*id:\s*userId\s*\}/.test(s));
  check("before/after change recorded", /change:\s*\{\s*before,\s*after:/.test(s));
  const w = src(WIDGET);
  const m = /const REASON_CODES = \[([^\]]+)\]/.exec(w);
  const widgetCodes = m ? m[1].split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean) : [];
  check("the widget's reason-code list equals OPERATOR_REASON_CODES", JSON.stringify(widgetCodes) === JSON.stringify([...OPERATOR_REASON_CODES]), JSON.stringify(widgetCodes));
  check("the widget sends the reason with the action", /JSON\.stringify\(\{ action, reason \}\)/.test(w));
  check("the widget no longer fires the action straight from the row buttons", !/onClick=\{\(\) => act\(u\.id/.test(w));
}

console.log("feed — projects the envelope, never the note, never email");
{
  const row = {
    id: "a1", action: "CUSTOMER_POLICY_ASSIGNED", createdAt: new Date("2026-10-08T01:00:00Z"), performedByAdminId: "op",
    metadata: { actorType: "PLATFORM_OPERATOR", result: "SUCCESS", target: { kind: "USER", id: "cust_123456789" },
      reason: { code: "BETA_ONBOARDING", note: "SECRET NOTE someone@example.com" }, execution: { jobRunId: "jr_abcdef123456" }, email: "leak@example.com" },
    subjectUsername: null,
  };
  const e = projectOperatorActionEvent(row, "chris");
  const json = JSON.stringify(e);
  check("operator name projected", e.operator === "chris");
  check("USER target rendered opaquely from the envelope", e.target === "user …456789");
  check("reason code projected", e.reasonCode === "BETA_ONBOARDING");
  check("the NOTE is never projected", !json.includes("SECRET NOTE") && !json.includes("example.com"));
  check("result projected", e.result === "SUCCESS");
  check("execution handle projected", e.execution?.jobRunId === "jr_abcdef123456");
  const legacy = projectOperatorActionEvent({ id: "a2", action: "CONNECTION_RESYNC_TRIGGERED", createdAt: new Date(), performedByAdminId: null,
    metadata: { connectionId: "x", institution: "Chase", outcome: "synced" }, subjectUsername: null }, null);
  check("legacy rows fall back to the non-PII token and 'operator'", legacy.target === "Chase" && legacy.operator === "operator" && legacy.reasonCode === null);
  const subj = projectOperatorActionEvent({ ...row, subjectUsername: "alice" }, "chris");
  check("a subject username wins over the opaque label", subj.target === "alice");
  const fr = strip(FEED_ROUTE), fw = src(FEED_WIDGET);
  check("feed route projects through the pure core", /projectOperatorActionEvent\(/.test(fr));
  check("feed route selects no email/ip/ua", !/email:\s*true|ipAddress:\s*true|userAgent:\s*true/.test(fr));
  check("feed widget labels the P1 actions", ["CUSTOMER_POLICY_ASSIGNED", "CUSTOMER_COHORT_ASSIGNED", "JOB_CADENCE_CHANGED", "OPERATOR_REFRESH_ALL"].every((a) => fw.includes(a)));
  check("feed widget never renders a note", !/\.note\b/.test(fw));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
