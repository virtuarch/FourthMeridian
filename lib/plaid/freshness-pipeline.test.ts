/**
 * lib/plaid/freshness-pipeline.test.ts  (CONN-3)
 *
 * Source-scan invariants for the L3 freshness pipeline. Standalone `tsx` (no DB).
 * Proves:
 *   - ONE balance authority (refreshBalancesForItem), reused — not duplicated
 *   - webhook (runDeferredHistorySync) + cron (sync-banks) now refresh balances
 *     + regenerate today's snapshot after syncTransactionsForItem
 *   - the manual Refresh path still refreshes balances via the same authority
 *   - no new snapshot engine (existing regenerateSnapshotsForAccounts)
 *   - L1 semantics untouched: syncTransactionsForItem still never calls accountsGet;
 *     no FlowType/DayFacts changes in the freshness wiring
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const src  = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

const refresh = code("lib/plaid/refresh.ts");
const bg      = code("lib/plaid/backgroundHistorySync.ts");
const cron    = code("jobs/sync-banks.ts");
const txSync  = code("lib/plaid/syncTransactions.ts");

console.log("ONE balance authority — extracted + reused, not duplicated");
{
  check("refresh.ts exports refreshBalancesForItem", /export async function refreshBalancesForItem/.test(refresh));
  check("the authority calls accountsGet", refresh.includes("accountsGet"));
  check("the authority writes the balance-verified stamp (lastUpdated)", /lastUpdated:\s*new Date\(\)/.test(refresh));
  // Exactly one accountsGet call site in refresh.ts (refreshPlaidItem delegates).
  check("only ONE accountsGet CALL in refresh.ts (refreshPlaidItem delegates)",
    (refresh.match(/plaidClient\.accountsGet\(/g) ?? []).length === 1);
  check("refreshPlaidItem delegates to refreshBalancesForItem", refresh.includes("await refreshBalancesForItem("));
}

console.log("Webhook path (runDeferredHistorySync) now refreshes balances + today's snapshot");
{
  check("webhook imports the balance authority", src("lib/plaid/backgroundHistorySync.ts").includes('from "@/lib/plaid/refresh"'));
  check("webhook calls refreshBalancesForItem", bg.includes("refreshBalancesForItem("));
  check("webhook regenerates today's snapshot", bg.includes("regenerateSnapshotsForAccounts("));
}

console.log("Cron path (sync-banks) now refreshes balances + today's snapshot");
{
  check("cron calls refreshBalancesForItem", cron.includes("refreshBalancesForItem("));
  check("cron regenerates today's snapshot", cron.includes("regenerateSnapshotsForAccounts("));
}

console.log("No new engine; L1 semantics untouched");
{
  // Reuses the existing snapshot authority, not a new one.
  check("uses existing regenerateSnapshotsForAccounts (no new snapshot engine)",
    bg.includes("regenerateSnapshotsForAccounts(") && cron.includes("regenerateSnapshotsForAccounts("));
  // The transaction engine is unchanged — still no balance refresh in it.
  check("syncTransactionsForItem still never calls accountsGet", !txSync.includes("accountsGet"));
  check("syncTransactionsForItem still never writes FinancialAccount.balance", !/financialAccount\.update/.test(txSync));
  // Freshness wiring must not touch FlowType / DayFacts.
  check("freshness wiring does not change FlowType", !/flowType\s*[:=]/.test(bg) && !/flowType\s*[:=]/.test(cron));
  check("freshness wiring does not touch DayFacts", !bg.includes("DayFacts") && !cron.includes("DayFacts"));
}

if (failures > 0) { console.error(`\nfreshness-pipeline: ${failures} failure(s).`); process.exit(1); }
console.log("\nfreshness-pipeline: all passed.");
