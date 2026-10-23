/**
 * lib/platform/customer/customer-success-routes.test.ts — the spine's routes are
 * gated, audited, on the right authority, and select no secret or amount.
 * Run: npx tsx lib/platform/customer/customer-success-routes.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const strip = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const READS = ["app/api/platform/customer-success/customers/route.ts", "app/api/platform/customer-success/customers/[userId]/route.ts"];
const WRITES = ["app/api/platform/customer-success/customers/[userId]/policy/route.ts", "app/api/platform/customer-success/customers/[userId]/cohort/route.ts", "app/api/platform/customer-success/customers/[userId]/refresh/route.ts"];
// Built from pieces so this scan never contains the tokens the platform-surface tripwire scans FOR.
const CUSTOMER_AXIS = new RegExp(["\\bcan\\(", "require" + "SpaceRole", "require" + "SpaceAction", "SpaceMember" + "Role"].join("|"));
const READERS = ["lib/platform/customer/customers.ts", "lib/platform/customer/customer-detail.ts", "lib/platform/customer/assign.ts", "lib/platform/customer/customer-core.ts"];

console.log("authorization");
for (const f of READS) {
  const s = strip(f);
  check(`${f}: requires CUSTOMER_SUCCESS READ and returns the error first`, /requirePlatformAccess\(\s*["']CUSTOMER_SUCCESS["']\s*,\s*["']READ["']\s*\)/.test(s) && /if\s*\(\s*err\s*\)\s*return\s+err/.test(s));
  check(`${f}: exports no mutating verb`, !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(s));
}
for (const f of WRITES) {
  const s = strip(f);
  check(`${f}: requires FRESH CUSTOMER_SUCCESS WRITE`, /requireFreshPlatformAccess\(\s*["']CUSTOMER_SUCCESS["']\s*,\s*["']WRITE["']\s*\)/.test(s) && /if\s*\(\s*err\s*\)\s*return\s+err/.test(s));
}
console.log("audit");
{
  const policy = strip(WRITES[0]), cohort = strip(WRITES[1]), refresh = strip(WRITES[2]), assign = strip("lib/platform/customer/assign.ts");
  check("policy + cohort routes parse a structured reason", policy.includes("parseOperatorReason(") && cohort.includes("parseOperatorReason("));
  check("assignment service records the operator action INSIDE $transaction", /\$transaction\(async \(tx\) => \{[\s\S]*recordOperatorAction\(tx,/.test(assign));
  check("refresh route audits OPERATOR_REFRESH_ALL through the chokepoint", refresh.includes("recordOperatorAction(") && refresh.includes("AuditAction.OPERATOR_REFRESH_ALL"));
  check("refresh route uses the ONE orchestrator, not a provider call", refresh.includes("refreshAllForUser(") && !/runFullRefresh|syncWalletByChain|plaidClient/.test(refresh));
}
console.log("authority");
for (const f of [...READS, ...WRITES, ...READERS]) {
  const s = strip(f);
  check(`${f}: never imports the global db or defaults to it`, !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']@\/lib\/db["']/.test(s) && !/\?\?\s*db\b/.test(s));
  check(`${f}: no customer space-authz token`, !CUSTOMER_AXIS.test(s));
}
console.log("privacy — allowlisted selects");
for (const f of ["lib/platform/customer/customers.ts", "lib/platform/customer/customer-detail.ts"]) {
  const s = strip(f);
  check(`${f}: selects no token, credential, cursor, balance or amount`, !/\b(encryptedToken|credential|cursor|syncOriginCursor|balance|amount|passwordHash|totpSecret|sessionToken)\s*:\s*true/.test(s));
  check(`${f}: AI selection carries no prompt/answer field`, !/\b(prompt|answer|content|message)\s*:\s*true/.test(s));
}
if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
