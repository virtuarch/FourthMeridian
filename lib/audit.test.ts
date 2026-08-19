/**
 * lib/audit.test.ts
 *
 * Unit tests for the PO-1 operator/security audit shape. Pure — exercises
 * buildAuditData() only (no DB). Locks the required-field mapping onto AuditLog.
 *
 * Also carries the V25-CLOSE-3 Part 4 audit-authority pin (merged from
 * lib/audit-authority.test.ts): recordAuditEvent stays deleted until it has a
 * real consumer, and buildAuditData stays a CONSUMED authority (repo scan).
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { buildAuditData } from "@/lib/audit";
import { AuditAction } from "@/lib/audit-actions";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
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

// ── merged from lib/audit-authority.test.ts (V25-CLOSE-3 Part 4) ──────────────
// DECISION: `buildAuditData` is the one audit-shape authority (pure, consumed by
// lib/auth.ts, pinned by lib/security-surface.test.ts). The thin `recordAuditEvent`
// adapter — which had ZERO production callers — was REMOVED rather than promoted:
// full promotion means migrating every direct writer, an architecture migration
// out of scope for an honesty slice; and per the project's rule (never ship an
// authority without a consumer) an unadopted adapter is worse than none. This
// guard fails if `recordAuditEvent` is reintroduced without a real consumer, so
// the "adopt or delete, never a half state" outcome stays true.

console.log("\naudit — authority decision (recordAuditEvent stays deleted)");

const ROOT = process.cwd();
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}
function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "prototype") continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(rel);
  }
  return acc;
}

// The kept authority works and is genuinely used.
check("buildAuditData is exported and callable", typeof buildAuditData === "function");
{
  const row = buildAuditData({ actorType: "SYSTEM_ADMIN", action: "LOGIN", result: "SUCCESS" });
  const md = row.metadata as unknown as Record<string, unknown>;
  check(
    "buildAuditData folds actorType/result into metadata",
    md.actorType === "SYSTEM_ADMIN" && md.result === "SUCCESS",
  );
}

const auditSrc = stripComments(readFileSync(join(ROOT, "lib/audit.ts"), "utf8"));

// The removed adapter must not return without a consumer.
const files = [...walk("lib"), ...walk("app")].filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
const recordAuditRefs = files.filter((f) =>
  stripComments(readFileSync(join(ROOT, f), "utf8")).includes("recordAuditEvent"),
);

check(
  "recordAuditEvent is not defined in lib/audit.ts",
  !/export\s+(async\s+)?function\s+recordAuditEvent/.test(auditSrc),
  "the zero-consumer adapter is back — either give it real consumers or keep it deleted",
);

check(
  "no production code references recordAuditEvent",
  recordAuditRefs.length === 0,
  `referenced by: ${recordAuditRefs.join(", ")}`,
);

// buildAuditData is not itself orphaned (the decision keeps a CONSUMED authority).
const buildAuditConsumers = files.filter(
  (f) => f !== "lib/audit.ts" && stripComments(readFileSync(join(ROOT, f), "utf8")).includes("buildAuditData"),
);
check(
  "buildAuditData has at least one production consumer",
  buildAuditConsumers.length >= 1,
  "if buildAuditData loses all consumers it becomes the same anti-pattern — reassess the decision",
);

if (failures > 0) {
  console.error(`\naudit: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\naudit: all checks passed.");
