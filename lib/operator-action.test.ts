/**
 * lib/operator-action.test.ts — the operator-action chokepoint's envelope,
 * reason requirement and scrubber. Run: npx tsx lib/operator-action.test.ts
 */
import { AuditAction } from "@/lib/audit-actions";
import {
  OperatorActionValidationError, REASON_REQUIRED_ACTIONS, assertOperatorNoteSafe, buildOperatorActionData,
  parseOperatorReason, recordOperatorAction,
} from "@/lib/audit";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const throws = (fn: () => unknown) => { try { fn(); return false; } catch (e) { return e instanceof OperatorActionValidationError; } };

console.log("envelope");
{
  const d = buildOperatorActionData({
    actor: { userId: "op1", via: "PLATFORM_GRANT", area: "CUSTOMER_SUCCESS" },
    action: AuditAction.CUSTOMER_POLICY_ASSIGNED,
    target: { kind: "USER", id: "cust1" },
    reason: { code: "BETA_ONBOARDING", note: "first five" },
    change: { before: { policyGroup: null }, after: { policyGroup: "BETA_FULL_ACCESS_V1" } },
    result: "SUCCESS",
  });
  const m = d.metadata as Record<string, unknown>;
  check("USER target → userId is the CUSTOMER, performedByAdminId the operator", d.userId === "cust1" && d.performedByAdminId === "op1");
  check("fixed envelope keys present", ["actorType", "result", "actor", "target", "reason", "change"].every((k) => k in m));
  check("actorType is PLATFORM_OPERATOR for a grant holder", m.actorType === "PLATFORM_OPERATOR");
  const d2 = buildOperatorActionData({ actor: { userId: "adm", via: "SYSTEM_ADMIN" }, action: AuditAction.OPERATOR_REFRESH_ALL,
    target: { kind: "PLAID_ITEM", id: "pi1" }, result: "SUCCESS", execution: { refreshExecutionId: "re1" } });
  check("non-USER target leaves userId unset and carries the execution ref", d2.userId === undefined && (d2.metadata as { execution: { refreshExecutionId: string } }).execution.refreshExecutionId === "re1");
  check("SYSTEM_ADMIN actorType", (d2.metadata as { actorType: string }).actorType === "SYSTEM_ADMIN");
  const d3 = buildOperatorActionData({ actor: { userId: "op1", via: "PLATFORM_GRANT" }, action: AuditAction.PLATFORM_OPERATION_EXECUTED,
    target: { kind: "SPACE", id: "sp1" }, result: "SUCCESS", detail: { target: "SHOULD_LOSE", outcome: "executed" } });
  check("SPACE target sets spaceId", d3.spaceId === "sp1");
  check("fixed envelope keys win over detail collisions", (d3.metadata as { target: { kind: string } }).target.kind === "SPACE" && (d3.metadata as { outcome: string }).outcome === "executed");
}

console.log("reason requirement");
{
  check("policy assignment without a reason is refused", throws(() => buildOperatorActionData({ actor: { userId: "o", via: "PLATFORM_GRANT" },
    action: AuditAction.CUSTOMER_POLICY_ASSIGNED, target: { kind: "USER", id: "u" }, result: "SUCCESS" })));
  check("cadence change requires a reason", REASON_REQUIRED_ACTIONS.has(AuditAction.JOB_CADENCE_CHANGED));
  check("Run Now does not", !REASON_REQUIRED_ACTIONS.has(AuditAction.PLATFORM_OPERATION_EXECUTED));
  check("a harmless action builds without a reason", !throws(() => buildOperatorActionData({ actor: { userId: "o", via: "PLATFORM_GRANT" },
    action: AuditAction.CONNECTION_RESYNC_TRIGGERED, target: { kind: "PLAID_ITEM", id: "p" }, result: "SUCCESS" })));
}

console.log("scrubber");
{
  check("plain note passes", assertOperatorNoteSafe("  dogfood run  ") === "dogfood run");
  check("email refused", throws(() => assertOperatorNoteSafe("ping someone@example.com")));
  check("long digit run refused", throws(() => assertOperatorNoteSafe("card 4111111111111111")));
  check("secret words refused", throws(() => assertOperatorNoteSafe("the password is hunter2")));
  check("over-long refused", throws(() => assertOperatorNoteSafe("x".repeat(281))));
  check("parseOperatorReason accepts a valid body", parseOperatorReason({ code: "TESTING", note: "ok" }).code === "TESTING");
  check("parseOperatorReason refuses an unknown code", throws(() => parseOperatorReason({ code: "WHATEVER" })));
  check("parseOperatorReason refuses a non-object", throws(() => parseOperatorReason("TESTING")));
}

console.log("recorder");
{
  const rows: unknown[] = [];
  const fake = { auditLog: { create: async ({ data }: { data: unknown }) => { rows.push(data); } } };
  recordOperatorAction(fake, { actor: { userId: "o", via: "PLATFORM_GRANT" }, action: AuditAction.JOB_CADENCE_CHANGED,
    target: { kind: "JOB", id: "sync-banks" }, reason: { code: "TESTING" }, change: { before: { hours: 24 }, after: { hours: 12 } }, result: "SUCCESS" })
    .then(() => recordOperatorAction(fake, { actor: { userId: "o", via: "PLATFORM_GRANT" }, action: AuditAction.JOB_CADENCE_CHANGED,
      target: { kind: "JOB", id: "sync-banks" }, result: "SUCCESS" }).then(() => false, (e) => e instanceof OperatorActionValidationError))
    .then((refused) => {
      check("one row written for the valid action", rows.length === 1);
      check("recorder THROWS (does not write) when the reason is missing", refused === true && rows.length === 1);
      if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
      console.log("\nall checks passed");
    });
}
