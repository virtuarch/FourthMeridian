/**
 * lib/connections/connection-summary.test.ts  (Connections redesign — PR 1)
 *
 * The row summary is derived from the same authorities as the drawer, carries no
 * codes or ids, and the list renders compact rows + one drawer (no Liquid cards).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { relativeUpdated, summarizeConnection } from "@/lib/connections/connection-summary";
import { connectionActionError } from "@/lib/connections/action-errors";
import type { SyncConnection } from "@/lib/sync/status";
import type { ConnectionIntelligenceStatus } from "@/lib/connections/intelligence";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const conn = (over: Partial<SyncConnection> = {}): SyncConnection => ({
  id: "c1", provider: "PLAID", institution: "Chase", state: "ready", lastSyncedAt: "2026-10-27T10:00:00Z",
  errorCode: null, importedCount: null, historyBuild: null, deferredReason: null, investments: null, ...over,
});
const intel = (over: Partial<ConnectionIntelligenceStatus> = {}) => ({
  phase: "READY", sourceHealth: { state: "CURRENT", lastUpdatedAt: "2026-10-27T09:00:00Z", needsAttention: false }, ...over,
}) as unknown as ConnectionIntelligenceStatus;

console.log("health word per lifecycle state");
{
  check("ready + current → Up to date / ok", summarizeConnection(conn(), intel(), 2).status === "Up to date" && summarizeConnection(conn(), intel(), 2).tone === "ok");
  check("importing → Importing / progress", summarizeConnection(conn({ state: "importing" }), undefined, 0).tone === "progress");
  check("paused import is not called progress (nothing is running)", summarizeConnection(conn({ state: "import_paused" }), undefined, 0).tone === "neutral");
  check("deferred → Sync pending, neutral (not on the user)", summarizeConnection(conn({ state: "sync_deferred" }), undefined, 1).status === "Sync pending");
  check("needs_reauth → Reconnect needed / attention", summarizeConnection(conn({ state: "needs_reauth" }), undefined, 1).status === "Reconnect needed");
  check("error → Sync issue, never the code", summarizeConnection(conn({ state: "error", errorCode: "ITEM_LOGIN_REQUIRED" }), undefined, 1).status === "Sync issue");
  check("ready but intelligence building → Building history", summarizeConnection(conn(), intel({ phase: "BUILDING_INTELLIGENCE" }), 1).status === "Building history");
  check("ready but not built → History not built", summarizeConnection(conn(), intel({ phase: "INTELLIGENCE_NOT_BUILT" }), 1).status === "History not built");
  const stale = intel({ sourceHealth: { state: "OUT_OF_DATE", lastUpdatedAt: "2026-10-01T00:00:00Z", needsAttention: true } });
  check("ready with an out-of-date source agrees with the drawer's health line", summarizeConnection(conn(), stale, 1).status === "Out of date");
  check("no summary field ever carries the error code", !JSON.stringify(summarizeConnection(conn({ state: "error", errorCode: "RATE_LIMITED" }), undefined, 1)).includes("RATE_LIMITED"));
}

console.log("counts, provider, last update");
{
  check("plural accounts", summarizeConnection(conn(), intel(), 3).accountsLabel === "3 accounts");
  check("wallet noun", summarizeConnection(conn({ provider: "WALLET" }), intel(), 1).accountsLabel === "1 wallet");
  check("last update = the source-health clock (the Brief's)", summarizeConnection(conn(), intel(), 1).updatedAt === "2026-10-27T09:00:00Z");
  check("never synced → null (row says 'Not updated yet', never a borrowed clock)", summarizeConnection(conn({ lastSyncedAt: null, state: "importing" }), undefined, 0).updatedAt === null);
  const now = new Date("2026-10-28T12:00:00Z");
  check("relative: today / yesterday / days", relativeUpdated("2026-10-28T01:00:00Z", now) === "today" && relativeUpdated("2026-10-27T01:00:00Z", now) === "yesterday" && relativeUpdated("2026-10-25T01:00:00Z", now) === "3 days ago");
}

console.log("refusal codes become sentences");
{
  check("cooldown is not shown verbatim", connectionActionError("cooldown") !== "cooldown" && /refreshed recently/.test(connectionActionError("cooldown") ?? ""));
  check("in-flight is not shown verbatim", /already running/.test(connectionActionError("in-flight") ?? ""));
  check("not-admitted is not shown verbatim", /paused/.test(connectionActionError("not-admitted") ?? ""));
  check("route prose passes through", connectionActionError("Wallet not found.") === "Wallet not found.");
  check("non-string → null", connectionActionError(undefined) === null && connectionActionError(42) === null);
}

console.log("surface pins");
{
  const list = code("components/connections/ConnectionsList.tsx");
  check("list renders ConnectionRow inside one Surface", /<ConnectionRow/.test(list) && /<Surface/.test(list));
  check("one RightPanel drawer (auto bottom sheet on mobile) with ConnectionDetail", /<RightPanel/.test(list) && /<ConnectionDetail/.test(list));
  check("the drawer follows the live poll (selected looked up in status)", /status\.connections\.find\(\(c\) => c\.id === selectedId\)/.test(list));
  check("no Liquid WebGL cards on Connections", !/AtlasLiquid|useAtlasLiquid|LIQUID_CAP/.test(list + code("components/connections/ConnectionCard.tsx") + code("components/connections/ConnectionsActions.tsx")));
  const row = code("components/connections/ConnectionRow.tsx");
  check("row: the ⋯ menu is a sibling of the row button, not nested", /<\/button>\s*\{?[\s\S]{0,200}<ConnectionMenu/.test(row));
  check("row: no errorCode, id or deferredReason is rendered", !/errorCode|deferredReason|\{connection\.id\}/.test(row));
  const card = code("components/connections/ConnectionCard.tsx");
  check("error card never prints a raw provider code", !/\(\$\{errorCode\}\)/.test(card) && !/: errorCode;/.test(card));
  const menu = code("components/connections/ConnectionMenu.tsx");
  check("menu: a 200 {enabled:false} rebuild is reported, not treated as success", /data\?\.enabled === false/.test(menu));
  check("menu + wallet Refresh map refusal codes", /connectionActionError\(/.test(menu) && /connectionActionError\(/.test(code("components/dashboard/SyncWalletButton.tsx")));
}

if (failures > 0) {
  console.error(`\nconnection-summary: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nconnection-summary: all checks passed.");
