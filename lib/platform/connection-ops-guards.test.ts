/**
 * lib/platform/connection-ops-guards.test.ts  (PO-4A)
 *
 * SOURCE-SCAN test (deterministic, no runtime/DB): the per-connection operator
 * actions obey the PO-1 contract (fresh PLATFORM_OPS WRITE + AuditLog +
 * performedByAdminId), REUSE the existing per-item sync path (no second engine,
 * cooldown/lock preserved), NEVER auto-revoke, and expose NO customer financial
 * data. Also pins the operator-feed wiring.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { OPERATOR_ACTION_FEED_ACTIONS, AuditAction } from "@/lib/audit-actions";

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Source with comments stripped — so a prose mention ("never calls itemRemove")
 *  can't false-positive a forbidden-CALL scan. */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

const RESYNC = "app/api/platform/platform-ops/connections/[id]/resync/route.ts";
const REAUTH = "app/api/platform/platform-ops/connections/[id]/request-reauth/route.ts";

console.log("connection-ops-guards — WRITE-gated + audited (PO-4A)");
for (const [file, action] of [[RESYNC, "CONNECTION_RESYNC_TRIGGERED"], [REAUTH, "CONNECTION_REAUTH_REQUESTED"]] as const) {
  const s = src(file);
  check(`${action}: fresh PLATFORM_OPS WRITE gate`,
    /requireFreshPlatformAccess\(\s*["']PLATFORM_OPS["']\s*,\s*["']WRITE["']\s*\)/.test(s));
  check(`${action}: writes AuditLog ${action} with performedByAdminId`,
    s.includes("auditLog.create") && s.includes(`AuditAction.${action}`) && s.includes("performedByAdminId"));
}

console.log("sync safety — reuse the ONE per-item path, preserve lock + cooldown");
{
  const resync = src(RESYNC);
  check("resync reuses withPlaidItemSyncLock + syncTransactionsForItem (no second engine)",
    resync.includes("withPlaidItemSyncLock(") && resync.includes("syncTransactionsForItem("));
  check("resync respects the existing manual cooldown",
    resync.includes("checkManualRefreshCooldown") && resync.includes("markManualRefreshed"));
  check("resync does NOT define its own sync loop (reuses the imported body)",
    !/for\s*\(.*plaidAccount|itemPublicTokenExchange|transactionsSync\(/.test(resync));
}

console.log("never auto-revoke");
for (const file of [RESYNC, REAUTH]) {
  const s = code(file); // comment-stripped: prose "never calls itemRemove" must not trip this
  check(`${file.split("/").slice(-2)[0]}: never calls itemRemove / destroys the item`,
    !/itemRemove|deletePlaidItem|disconnectPlaidItem|plaidItem\.delete/.test(s));
}
{
  const reauth = src(REAUTH);
  check("reauth marks NEEDS_REAUTH via the health chokepoint (lights owner reconnect)",
    reauth.includes("setPlaidItemHealth") && reauth.includes("NEEDS_REAUTH"));
}

console.log("no customer financial data exposed");
for (const file of [RESYNC, REAUTH, "app/api/platform/platform-ops/connection-health/route.ts"]) {
  const s = src(file);
  check(`${file.split("/").slice(-2)[0]}: never queries transactions/balances/holdings/positions`,
    !/db\.(transaction|accountBalance|balance|holding|position|investmentTransaction)\b/.test(s));
  check(`${file.split("/").slice(-2)[0]}: no balance/amount fields selected or returned`,
    !/\b(balance|amount|holdings|currentBalance|availableBalance)\s*:/.test(s));
}
{
  // The connection-health read model itself is non-PII / non-financial.
  const health = src("lib/connections/health.ts");
  check("connection-health selects only operational fields (no userId/email/balances)",
    !/userId:\s*true|email:\s*true|balance/.test(health));
}

console.log("operator feed wiring");
check("both new actions surface in the Security Ops operator feed",
  OPERATOR_ACTION_FEED_ACTIONS.includes(AuditAction.CONNECTION_RESYNC_TRIGGERED) &&
  OPERATOR_ACTION_FEED_ACTIONS.includes(AuditAction.CONNECTION_REAUTH_REQUESTED));

if (failures > 0) { console.error(`\nconnection-ops-guards: ${failures} failure(s).`); process.exit(1); }
console.log("\nconnection-ops-guards: all passed.");
