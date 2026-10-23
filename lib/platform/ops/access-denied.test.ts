/**
 * lib/platform/ops/access-denied.test.ts  (OBS-009)
 *
 * The refusal audit is rate-limited per (user, area), process-budgeted, PII-free
 * and never on the request's critical path.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ops/access-denied.test.ts
 */

import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import { projectAnomalyTrip } from "@/lib/platform/security/anomalies-core";
import {
  ACCESS_DENIED_ANOMALY_TYPE, ACCESS_DENIED_WINDOW_MINUTES, DenialThrottle, accessDeniedKey, buildAccessDeniedAudit, recordPlatformAccessDenied,
} from "./access-denied";

process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const MIN = 60_000;
const T0 = Date.parse("2026-10-21T12:00:00.000Z");

async function main(): Promise<void> {
console.log("1. throttle — one row per key per window, later refusals only count");
{
  const t = new DenialThrottle(60 * MIN, 50, 500);
  const a = t.admit("k1", T0);
  const b = t.admit("k1", T0 + 5 * MIN);
  const c = t.admit("k1", T0 + 59 * MIN);
  check("first refusal writes", a.write && a.count === 1);
  check("second and third in the window do not write but count", !b.write && b.count === 2 && !c.write && c.count === 3);
  const d = t.admit("k1", T0 + 61 * MIN);
  check("a new window writes again with the count reset", d.write && d.count === 1);
  const other = t.admit("k2", T0 + 1 * MIN);
  check("a different key is its own clock", other.write);
}

console.log("2. throttle — the process budget caps rows per window; the key map is bounded");
{
  const t = new DenialThrottle(60 * MIN, 3, 4);
  const writes = ["a", "b", "c", "d", "e"].map((k) => t.admit(k, T0).write);
  check("3 of 5 distinct keys write (budget 3)", writes.filter(Boolean).length === 3 && writes.slice(0, 3).every(Boolean));
  const next = t.admit("f", T0 + 61 * MIN);
  check("the budget resets with the window", next.write);
  const small = new DenialThrottle(60 * MIN, 100, 2);
  small.admit("x", T0); small.admit("y", T0); small.admit("z", T0);
  check("evicted oldest key is admitted as new again (bounded memory, not exactness)", small.admit("x", T0 + MIN).write);
}

console.log("3. the row — canon action, anomaly-trip shape, no PII");
{
  const row = buildAccessDeniedAudit({ userId: "ckuser000000000000000001", area: "SECURITY_OPS", needed: "READ", grant: "none", ipAddress: "203.0.113.9", userAgent: "ua" }, 1);
  const m = row.metadata as Record<string, unknown>;
  check("action is the canon's SECURITY_ANOMALY_DETECTED", row.action === "SECURITY_ANOMALY_DETECTED");
  check("type platform_access_denied, window, threshold 1", m.type === ACCESS_DENIED_ANOMALY_TYPE && m.windowMinutes === ACCESS_DENIED_WINDOW_MINUTES && m.threshold === 1);
  check("key = platform-denied:<area>:<userId>", m.key === accessDeniedKey("ckuser000000000000000001", "SECURITY_OPS"));
  check("enum words only: area / needed / grant", m.area === "SECURITY_OPS" && m.needed === "READ" && m.grant === "none");
  check("no email, no username, no session token in the row", !/@|username|sessionToken/.test(JSON.stringify(row)));
  // The Security Ops route projects the key to an opaque digest: the id never leaves the server.
  const trip = projectAnomalyTrip({ id: "r1", createdAt: new Date(T0), metadata: row.metadata }, 15);
  check("projects as a trip of the new type with an opaque key ref", trip.type === ACCESS_DENIED_ANOMALY_TYPE && trip.keyRef.startsWith("…") && !trip.keyRef.includes("ckuser"));
}

console.log("4. the writer — fire-and-forget, never throws into the caller, honours the throttle");
{
  const writes: Prisma.AuditLogUncheckedCreateInput[][] = [];
  const client = { auditLog: { createMany: async (args: { data: Prisma.AuditLogUncheckedCreateInput[] }) => { writes.push(args.data); return { count: 1 }; } } };
  const t = new DenialThrottle();
  const facts = { userId: "u1", area: "PLATFORM_OPS" as const, needed: "CONTROL" as const, grant: "insufficient" as const };
  const first = recordPlatformAccessDenied(facts, { client, nowMs: T0, throttle: t });
  const second = recordPlatformAccessDenied(facts, { client, nowMs: T0 + MIN, throttle: t });
  check("first refusal → one write queued; second → none", first.write && !second.write);
  const broken = { auditLog: { createMany: async () => { throw new Error("db down"); } } };
  const realWarn = console.warn; let warned = 0; console.warn = () => { warned++; };
  let threw = false;
  try { recordPlatformAccessDenied({ ...facts, userId: "u2" }, { client: broken, nowMs: T0, throttle: new DenialThrottle() }); } catch { threw = true; }
  await new Promise((r) => setTimeout(r, 5));
  console.warn = realWarn;
  check("a failing client never throws into the caller (console only)", !threw && warned === 1);
  check("exactly one row data was handed to the client", writes.length === 1 && (writes[0][0].metadata as Record<string, unknown>).type === ACCESS_DENIED_ANOMALY_TYPE);
}

console.log("5. authorize.ts wiring — on the deny branch only, after the 403 is decided, not awaited");
{
  const src = readFileSync("lib/platform/authorize.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("imports the recorder", /recordPlatformAccessDenied/.test(src));
  check("the recorder is not awaited (off the critical path)", !/await\s+recordPlatformAccessDenied/.test(src));
  const denyIdx = src.indexOf("forbidden()");
  const recIdx = src.indexOf("recordPlatformAccessDenied(");
  check("the call sits in the deny branch beside forbidden()", denyIdx > 0 && recIdx > 0 && Math.abs(recIdx - denyIdx) < 600);
  check("SYSTEM_ADMIN bypass precedes it (never recorded as a refusal)", src.indexOf("UserRole.SYSTEM_ADMIN") < recIdx);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
}

void main();
