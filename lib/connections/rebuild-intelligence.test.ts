/**
 * lib/connections/rebuild-intelligence.test.ts  (CONN-2B)
 *
 * Source-scan invariants for the multi-account intelligence rebuild. Standalone
 * `tsx` (no DB). Proves the CONN-2 constraints the mission requires:
 *   - reuses the ONE reconstruction authority (regenerateWealthHistoryForAccounts)
 *   - creates NO duplicate authority (no refreshMultipleAccounts / refresh path)
 *   - changes NO balance/snapshot freshness logic (L3 untouched)
 *   - is owner-scoped + rate-limited + kill-switch-honest
 *   - reconstruction status derives from existing sources (no persisted intel store)
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
// Strip line + block comments so matches reflect real code, not prose.
const code = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

const ROUTE = "app/api/connections/rebuild-intelligence/route.ts";
const route = code(ROUTE);

console.log("Reuses the ONE reconstruction authority");
{
  check("calls regenerateWealthHistoryForAccounts", route.includes("regenerateWealthHistoryForAccounts("));
  check("imports it from the snapshots authority", src(ROUTE).includes('from "@/lib/snapshots/regenerate-history"'));
}

console.log("No duplicate authority / no re-acquisition / no L3 freshness");
{
  check("no refreshMultipleAccounts", !route.includes("refreshMultipleAccounts"));
  check("does not call refreshAllActiveItemsForUser", !route.includes("refreshAllActiveItemsForUser"));
  check("does not call refreshPlaidItem", !route.includes("refreshPlaidItem"));
  check("does not call accountsGet (no balance re-acquire)", !route.includes("accountsGet"));
  check("does not regenerate today's snapshot (L3)", !route.includes("regenerateSpaceSnapshot") && !route.includes("regenerateSnapshotsForAccounts"));
  check("does not write FinancialAccount.balance", !/financialAccount\.update|\.balance\s*=/.test(route));
}

console.log("Owner-scoped + rate-limited + kill-switch-honest");
{
  check("gated by requireUser", route.includes("requireUser("));
  check("ownership via plaidItem.userId", /plaidItem:\s*\{\s*userId/.test(route));
  check("ownership via connection.userId", /connection:\s*\{\s*userId/.test(route));
  check("rate-limited per user", route.includes("limitByUser("));
  check("honors the wealth-regen kill switch", route.includes("wealthRegenerationEnabled("));
  check("returns enabled:false rather than silently no-op", route.includes("enabled: false"));
  check("records CONNECTION_INTELLIGENCE_REBUILT for traceability", route.includes("CONNECTION_INTELLIGENCE_REBUILT"));
}

console.log("Reconstruction status derives from existing sources (no persisted intel store)");
{
  const intel = code("lib/connections/intelligence.ts");
  check("no persisted intelligence table (pure derivation only)", !/prisma|db\.|@prisma\/client/.test(intel));
  const loader = code("lib/connections/space-data.ts");
  check("intelligence anchored on PLAID_HISTORY_SYNCED", loader.includes("PLAID_HISTORY_SYNCED"));
  check("+ manual CONNECTION_INTELLIGENCE_REBUILT anchor", loader.includes("CONNECTION_INTELLIGENCE_REBUILT"));
  check("available history from Transaction min date (not a constant)", /transaction\.groupBy|_min:\s*\{\s*date/.test(loader));
}

if (failures > 0) { console.error(`\nrebuild-intelligence: ${failures} failure(s).`); process.exit(1); }
console.log("\nrebuild-intelligence: all passed.");
