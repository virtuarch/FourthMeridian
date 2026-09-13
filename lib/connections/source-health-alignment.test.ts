/**
 * lib/connections/source-health-alignment.test.ts
 *
 * THE BRIEF AND THE CONNECTIONS PAGE AGREE ABOUT A SOURCE.
 *
 * The Brief's "Review connections" link sends the user to /dashboard/connections.
 * Each fixture below is ONE set of raw provider rows, projected the way each page
 * projects it — the Brief through deriveSpaceDataHealth, Connections through
 * sourceHealthForConnection → deriveConnectionIntelligence — and the two must
 * agree on state, last successful update and whether it needs attention.
 *
 *   npx tsx lib/connections/source-health-alignment.test.ts
 */

import { readFileSync } from "node:fs";
import { deriveSpaceDataHealth, type DataHealthAccountInput, type SourceHealthInput } from "./space-data-health.core";
import { deriveConnectionIntelligence, deriveConnectionTimeline, sourceHealthForConnection } from "./intelligence";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-09-13T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const VIEWER = "user_viewer";

interface Fixture {
  name: string;
  provider: "PLAID" | "WALLET";
  owner?: string;
  plaid?: NonNullable<SourceHealthInput["plaid"]>;
  wallet?: NonNullable<SourceHealthInput["wallet"]>;
  accounts: Date[] | (Date | null)[];
  expect: string;
}

const plaid = (over: Partial<NonNullable<SourceHealthInput["plaid"]>> = {}) =>
  ({ status: "ACTIVE", lastSyncedAt: daysAgo(0.2), syncIncompleteAt: null, historyBuildStartedAt: null, ...over });
const wallet = (over: Partial<NonNullable<SourceHealthInput["wallet"]>> = {}) =>
  ({ status: "ACTIVE", errorCode: null, lastSyncedAt: daysAgo(0.1), discoveryCursor: false, ...over });

const FIXTURES: Fixture[] = [
  { name: "1. one fresh account", provider: "PLAID", plaid: plaid(), accounts: [daysAgo(0.2)], expect: "CURRENT" },
  { name: "2. multi-account source, all fresh", provider: "PLAID", plaid: plaid(), accounts: [daysAgo(0.2), daysAgo(0.5), daysAgo(0.3)], expect: "CURRENT" },
  { name: "3. multi-account source, one stale (A recent, B 12 days)", provider: "PLAID", plaid: plaid(), accounts: [daysAgo(0.1), daysAgo(12)], expect: "OUT_OF_DATE" },
  { name: "4. reconnect required (Schwab)", provider: "PLAID", plaid: plaid({ status: "NEEDS_REAUTH", lastSyncedAt: daysAgo(26) }), accounts: [daysAgo(26), daysAgo(26)], expect: "NEEDS_RECONNECT" },
  { name: "5. connection error", provider: "PLAID", plaid: plaid({ status: "ERROR" }), accounts: [daysAgo(0.2)], expect: "CONNECTION_ERROR" },
  { name: "6. stale wallet, not errored (Ethereum)", provider: "WALLET", wallet: wallet({ lastSyncedAt: daysAgo(17) }), accounts: [daysAgo(17)], expect: "OUT_OF_DATE" },
  { name: "7. never-updated wallet", provider: "WALLET", wallet: wallet({ lastSyncedAt: null }), accounts: [null], expect: "NEVER_UPDATED" },
  { name: "8. a source the viewer did not connect", provider: "PLAID", owner: "someone_else", plaid: plaid({ status: "NEEDS_REAUTH" }), accounts: [daysAgo(3)], expect: "NEEDS_RECONNECT" },
  { name: "wallet whose last update failed after an earlier success", provider: "WALLET", wallet: wallet({ errorCode: "BALANCE_UNAVAILABLE", lastSyncedAt: daysAgo(2) }), accounts: [daysAgo(2)], expect: "SYNC_INCOMPLETE" },
];

for (const f of FIXTURES) {
  console.log(f.name);
  const owner = f.owner ?? VIEWER;
  // The Brief's projection: one row per account linked into the Space.
  const rows: DataHealthAccountInput[] = f.accounts.map((updated, i) => ({
    detailVisible: true, accountName: `Account ${i}`, lastUpdated: updated, syncStatus: "synced",
    plaid: f.plaid ? { key: "conn", ownerUserId: owner, institutionName: "Bank", ...f.plaid } : null,
    wallet: f.wallet ? { key: "conn", ownerUserId: owner, ...f.wallet } : null,
  }));
  const brief = deriveSpaceDataHealth(rows, VIEWER, NOW).sources[0];
  // The Connections projection: the same raw fields, per connection.
  const health = sourceHealthForConnection({ provider: f.provider, accountsUpdated: f.accounts, plaid: f.plaid, wallet: f.wallet }, NOW);
  const intel = deriveConnectionIntelligence({
    provider: f.provider, state: "ready", historySyncedAt: null, earliestTxDate: null, connectedAt: null,
    lastSyncedAt: null, balancesUpdatedAt: null, sourceHealth: health,
  }, NOW);

  check(`state ${f.expect} on both pages`, brief.state === f.expect && intel.sourceHealth?.state === f.expect,
    `brief ${brief.state} / connections ${intel.sourceHealth?.state}`);
  check("same last successful update", brief.lastUpdatedAt === intel.sourceHealth?.lastUpdatedAt
    && deriveConnectionTimeline(intel).freshness.lastUpdatedAt === brief.lastUpdatedAt);
  check("same needs-attention", brief.needsAttention === intel.sourceHealth?.needsAttention);
  check("actionable only for the member who connected it (Connections lists only the viewer's own)",
    brief.actionable === (owner === VIEWER));
}

console.log("\n10. no reader relies on an unwritten error state or the newest child");
{
  const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  const SPACE_DATA = code("lib/connections/space-data.ts");
  const PACKAGE = code("lib/ai/brief/package.ts");
  check("Connections derives health through the shared rule", /sourceHealthForConnection\(/.test(SPACE_DATA));
  check("Connections no longer keeps the newest account date", !/b > balance/.test(SPACE_DATA) && /b < balancesUpdated/.test(SPACE_DATA));
  check("the Brief package no longer reads the sync-error count nothing writes",
    !/health\.errorCount|accountsWithSyncErrors/.test(PACKAGE) && /connectionsNeedingAttention/.test(PACKAGE));
  check("neither page's health code tests syncStatus 'error'", !/syncStatus\s*===?\s*['"]error/.test(
    SPACE_DATA + code("lib/connections/space-data-health.core.ts") + code("lib/connections/space-data-health.ts") + PACKAGE));
  check("one wording for states, used by both pages",
    /sourceStatusText\(/.test(code("components/brief/DailyBriefClient.tsx")) && /sourceStatusText\(/.test(code("components/connections/ConnectionCard.tsx")));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
