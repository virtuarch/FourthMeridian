/**
 * lib/audit.test.ts
 *
 * Unit tests for the PO-1 operator/security audit shape. Pure — exercises
 * buildAuditData() only (no DB). Locks the required-field mapping onto AuditLog.
 */

import { buildAuditData } from "@/lib/audit";
import { AuditAction } from "@/lib/audit-actions";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

console.log("audit — buildAuditData required-field mapping");

// The mission's canonical example: an admin login with TOTP verified.
const login = buildAuditData({
  actorId:   "user_admin_1",
  actorType: "SYSTEM_ADMIN",
  action:    AuditAction.LOGIN,
  result:    "SUCCESS",
  ipAddress: "203.0.113.7",
  userAgent: "jest",
  metadata:  { role: "SYSTEM_ADMIN", mfa: "totp" },
});
const loginMeta = login.metadata as Record<string, unknown>;

check("actor → userId column", login.userId === "user_admin_1");
check("action → action column (typed vocab)", login.action === AuditAction.LOGIN);
check("actor type → metadata.actorType", loginMeta.actorType === "SYSTEM_ADMIN");
check("result → metadata.result", loginMeta.result === "SUCCESS");
check("ipAddress passthrough", login.ipAddress === "203.0.113.7");
check("caller metadata is preserved (mfa)", loginMeta.mfa === "totp");
check("timestamp is NOT hardcoded (DB default now() owns createdAt)", login.createdAt === undefined);

// A future operator example: a platform operator resyncs one connection.
const resync = buildAuditData({
  actorId:   "user_op_2",
  actorType: "PLATFORM_OPERATOR",
  action:    AuditAction.PLAID_REFRESH,
  result:    "SUCCESS",
  target:    { type: "connection", id: "conn_9" },
  performedByAdminId: "user_op_2",
});
const resyncMeta = resync.metadata as Record<string, unknown>;

check("target → metadata.target ({type,id})",
  JSON.stringify(resyncMeta.target) === JSON.stringify({ type: "connection", id: "conn_9" }));
check("performedByAdminId → dedicated column", resync.performedByAdminId === "user_op_2");
check("PLATFORM_OPERATOR actorType recorded", resyncMeta.actorType === "PLATFORM_OPERATOR");

// Anonymous / pre-account event: no actorId → no userId key (FK stays null).
const anon = buildAuditData({
  actorType: "USER",
  action:    AuditAction.LOGIN_FAILED,
  result:    "FAILURE",
  metadata:  { reason: "user_not_found" },
});
check("omitting actorId leaves userId unset (nullable FK)", !("userId" in anon));
check("failure result recorded", (anon.metadata as Record<string, unknown>).result === "FAILURE");

if (failures > 0) {
  console.error(`\naudit: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\naudit: all checks passed.");
