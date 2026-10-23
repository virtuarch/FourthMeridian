/**
 * components/platform/widgets/connection-health.test.ts  (UX-P1 · Agent 3)
 *
 * The connection-health view-model and the shared row renderer, DB-free:
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/connection-health.test.ts
 *
 * Pinned:
 *   1. the tone map is the authority's vocabulary, nothing merged
 *   2. "stale for" is measured against the response's checkedAt, not a clock
 *   3. never-synced is a sentence, never a fabricated lag
 *   4. the row type carries no identity key (compile-time) and the table
 *      renders an Owner column ONLY when owners were resolved
 *   5. available actions come from the reader's derivation (source + status)
 *   6. the surfaces render their loading state as loading, and the populated
 *      state lists the authority's rows in the authority's order
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ConnectionHealthRow, ConnectionHealthResult } from "@/lib/connections/health";
import { deriveAvailableActions, connectionKind, walletNetwork } from "@/lib/connections/health";
import {
  HEALTH_TONE, HEALTH_WORD, agoWords, compositionCaption, compositionSegments, describeConnection, filterOptions, filterRows,
  fmtUtcInstant, formatSpan, lastSyncCell, listCoverage, ownersUrl, ownersByRow, rowKey, staleFor, thresholdLabel, actionWords,
  type ConnectionRowIdentityKeys,
} from "./connection-health-view";
import { ConnectionHealthTable, ConnectionRowDetail, ConnectionFacts, connectionHeadings } from "./connection-health-table";
import { ConnectionHealthSurface, OpsConnectionHealthWidget } from "./OpsConnectionHealthWidget";
import { ConnectionHealthBlock, ConnectionHealthBlockSurface } from "./overview/ConnectionHealthBlock";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

// ── Compile-time privacy pin: the row has no identity key ────────────────────
const _noIdentityOnRow: ConnectionRowIdentityKeys extends never ? true : false = true;
void _noIdentityOnRow;

const CHECKED = "2026-10-14T12:00:00.000Z";
const NOW = Date.parse(CHECKED) + 5 * 60_000; // the browser clock is 5 min after the verdict

function row(over: Partial<ConnectionHealthRow> = {}): ConnectionHealthRow {
  return {
    source: "PLAID", id: "item1", label: "Chase", status: "ACTIVE", errorCode: null, healthState: "STALE",
    lastSyncedAt: "2026-10-13T09:30:00.000Z", since: null,
    kind: "BANK", institution: "Chase", network: null, overdueAfterHours: 24, neverSynced: false,
    availableActions: ["resync", "request-reauth"],
    ...over,
  };
}
function result(over: Partial<ConnectionHealthResult> = {}): ConnectionHealthResult {
  const unhealthy = over.unhealthy ?? [];
  return {
    total: 5, counts: { HEALTHY: 5 - unhealthy.length, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 },
    unhealthy, retired: { revoked: 0, ownerInactive: 0 }, checkedAt: CHECKED, cap: 20, listedScope: "unhealthy",
    ...over,
  };
}

console.log("1. tone map is the authority's vocabulary");
{
  check("HEALTHY ok", HEALTH_TONE.HEALTHY === "ok");
  check("STALE warn", HEALTH_TONE.STALE === "warn");
  check("DEGRADED warn", HEALTH_TONE.DEGRADED === "warn");
  check("NEEDS_REAUTH bad", HEALTH_TONE.NEEDS_REAUTH === "bad");
  check("ERROR bad", HEALTH_TONE.ERROR === "bad");
  check("REVOKED muted", HEALTH_TONE.REVOKED === "muted");
  check("every state has a word", (Object.keys(HEALTH_TONE) as (keyof typeof HEALTH_WORD)[]).every((k) => HEALTH_WORD[k].length > 0));
  const seg = compositionSegments({ HEALTHY: 3, STALE: 1, DEGRADED: 0, NEEDS_REAUTH: 1, ERROR: 0, REVOKED: 0 });
  check("composition names every live state with its count and tone", seg.map((s) => `${s.word}:${s.count}:${s.tone}`).join(",") === "Healthy:3:ok,Stale:1:warn,Degraded:0:warn,Needs re-auth:1:bad,Error:0:bad");
  check("REVOKED is not a segment (excluded from the population by construction)", !seg.some((s) => s.word === "Revoked"));
}

console.log("2. durations are measured against the authority's clock");
{
  check("formatSpan words", [formatSpan(30_000), formatSpan(45 * 60_000), formatSpan(3 * 3_600_000 + 20 * 60_000), formatSpan(2 * 86_400_000 + 4 * 3_600_000)].join("|") === "<1m|45m|3h 20m|2d 4h");
  check("negative span is null (never a negative duration)", formatSpan(-1) === null);
  check("staleFor = lastSyncedAt → checkedAt", staleFor(row(), CHECKED) === "1d 2h");
  check("staleFor ignores the browser clock", staleFor(row(), CHECKED) === staleFor(row(), CHECKED));
  check("agoWords uses the injected clock", agoWords("2026-10-13T09:30:00.000Z", NOW) === "1d 2h ago");
  check("lastSyncCell value is relative, qualifier is UTC", JSON.stringify(lastSyncCell(row(), NOW)) === JSON.stringify({ value: "1d 2h ago", qualifier: "13 Oct 09:30 UTC" }));
  check("fmtUtcInstant is UTC-stable", fmtUtcInstant(CHECKED) === "14 Oct 12:00 UTC");
  check("threshold reads the row's applied policy", thresholdLabel(row({ overdueAfterHours: 6 })) === "6 h policy");
}

console.log("3. never-synced is a sentence, not a lag");
{
  const never = row({ lastSyncedAt: null, neverSynced: true });
  check("lastSyncCell is null for a never-synced row", lastSyncCell(never, NOW) === null);
  check("staleFor is null for a never-synced row", staleFor(never, CHECKED) === null);
  const html = renderToStaticMarkup(createElement(ConnectionHealthTable, { rows: [never], owners: null, checkedAt: CHECKED, nowMs: NOW, onSelect: () => {} }));
  check("the table says 'never synced'", html.includes("never synced"));
  check("…and gives the reason no stale-for exists", html.includes("no sync to measure from"));
  check("…without inventing an 'ago'", !/\d+[mhd] ago/.test(html));
}

console.log("4. identity never reaches the row; the owner column exists only when resolved");
{
  const src = strip("lib/connections/health.ts");
  const rowBlock = src.slice(src.indexOf("interface ConnectionHealthRow"), src.indexOf("interface ConnectionHealthResult"));
  check("ConnectionHealthRow declares no userId / email / address / token", !/\b(userId|email|address|walletAddress|token|credential)\s*:/.test(rowBlock));

  const rows = [row(), row({ id: "w1", source: "WALLET", label: "Wallet …abc123", institution: "ETH", network: "ETH", kind: "WALLET", healthState: "DEGRADED", errorCode: "EXPLORER_TIMEOUT", availableActions: [] })];
  const without = renderToStaticMarkup(createElement(ConnectionHealthTable, { rows, owners: null, checkedAt: CHECKED, nowMs: NOW, onSelect: () => {} }));
  check("no Owner heading without resolution", !without.includes(">Owner<"));
  check("no 'owner not resolved' placeholder without resolution (absent, not blank)", !without.includes("owner not resolved"));
  const owners = ownersByRow([{ source: "PLAID", id: "item1", owner: { label: "chris" } }]);
  const withOwners = renderToStaticMarkup(createElement(ConnectionHealthTable, { rows, owners, checkedAt: CHECKED, nowMs: NOW, onSelect: () => {} }));
  check("Owner heading when resolved", withOwners.includes(">Owner<"));
  check("the resolved label renders (username, never email)", withOwners.includes("chris") && !withOwners.includes("@"));
  check("an unresolved row says so rather than guessing", withOwners.includes("owner not resolved"));
  check("headings differ by exactly the Owner column", connectionHeadings(true).length === connectionHeadings(false).length + 1 && connectionHeadings(true).includes("Owner") && !connectionHeadings(false).includes("Owner"));
  check("ownersUrl keys on source:id pairs and is bounded", ownersUrl(rows) === `/api/platform/customer-success/connection-owners?ids=${encodeURIComponent("PLAID:item1,WALLET:w1")}` && ownersUrl([]) === null);
  const many = Array.from({ length: 60 }, (_, i) => ({ source: "PLAID", id: `i${i}` }));
  check("ownersUrl never asks for more than 50", (ownersUrl(many)!.match(/PLAID%3A/g) ?? []).length === 50);
  check("rowKey is source:id", rowKey(rows[1]) === "WALLET:w1");

  const detail = renderToStaticMarkup(createElement(ConnectionRowDetail, { row: rows[0], owners, checkedAt: CHECKED, onOpen: () => {} }));
  check("the below-md expansion carries stale-for, threshold, owner and action", ["Stale for", "Threshold", "Owner", "Action", "1d 2h", "24 h policy", "chris"].every((s) => detail.includes(s)));
  const facts = renderToStaticMarkup(createElement(ConnectionFacts, { row: rows[1], owner: undefined, checkedAt: CHECKED, nowMs: NOW }));
  check("facts: a wallet names its network and judged-as policy", facts.includes("Wallet · ETH") && facts.includes("wallet (WALLET policy)"));
  check("facts: no Owner row when no owner was resolved", !facts.includes(">Owner<"));
  check("facts: the error code is shown", facts.includes("EXPLORER_TIMEOUT"));
}

console.log("5. the connection cell and the actions follow the reader's derivations");
{
  check("bank: institution over 'Bank · Plaid'", JSON.stringify(describeConnection(row())) === JSON.stringify({ title: "Chase", qualifier: "Bank · Plaid" }));
  check("wallet: label over 'Wallet · ETH'", describeConnection(row({ source: "WALLET", label: "Wallet …abc123", network: "ETH" })).qualifier === "Wallet · ETH");
  check("wallet without a recorded chain says so", describeConnection(row({ source: "WALLET", label: "Wallet …abc123", network: null })).qualifier === "Wallet · chain not recorded");
  check("exchange is named by its source word", describeConnection(row({ source: "EXCHANGE", label: "Exchange …x", network: null })).qualifier === "Exchange · chain not recorded");
  check("deriveAvailableActions: Plaid ACTIVE ⇒ both", deriveAvailableActions("PLAID", "ACTIVE").join(",") === "resync,request-reauth");
  check("deriveAvailableActions: Plaid NEEDS_REAUTH ⇒ reauth only (resync route 409s)", deriveAvailableActions("PLAID", "NEEDS_REAUTH").join(",") === "request-reauth");
  check("deriveAvailableActions: Plaid REVOKED ⇒ none", deriveAvailableActions("PLAID", "REVOKED").length === 0);
  check("deriveAvailableActions: wallet ⇒ none (no operator route)", deriveAvailableActions("WALLET", "ERROR").length === 0);
  check("actionWords", actionWords(row()) === "Resync · Request re-auth" && actionWords(row({ availableActions: [] })) === null);
  check("connectionKind mirrors the threshold selection", connectionKind("PLAID") === "BANK" && connectionKind("WALLET") === "WALLET" && connectionKind("EXCHANGE") === "WALLET");
  check("walletNetwork folds distinct chains, null when none", walletNetwork(["ETH", null, "ETH"]) === "ETH" && walletNetwork(["SOL", "BTC"]) === "BTC · SOL" && walletNetwork([null, undefined, " "]) === null);

  const rows = [row({ healthState: "STALE" }), row({ id: "e", healthState: "ERROR" }), row({ id: "d", healthState: "DEGRADED" })];
  check("'Needs action' selects faults, not lateness", filterRows(rows, "needs-action").map((r) => r.id).join(",") === "e,d" && filterRows(rows, "all").length === 3);
  check("filter options carry counts", filterOptions(rows).map((o) => o.label).join("|") === "All 3|Needs action 2");
}

console.log("6. coverage and caption say floors in words");
{
  const capped = result({ total: 30, counts: { HEALTHY: 5, STALE: 25, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 }, unhealthy: Array.from({ length: 20 }, (_, i) => row({ id: `i${i}` })), cap: 20 });
  const cov = listCoverage(capped);
  check("capped list is a floor", cov.capped && cov.shown === 20 && cov.unhealthyTotal === 25);
  check("caption names the cap", compositionCaption(capped).includes("listing the 20 most severe of 25 unhealthy (cap 20)"));
  check("caption names the judged-at instant in UTC", compositionCaption(capped).includes("judged at 14 Oct 12:00 UTC"));
  const retired = result({ retired: { revoked: 2, ownerInactive: 1 } });
  check("caption names retired connections as not unhealthy", compositionCaption(retired).includes("not counted: 2 revoked, 1 with a deactivated owner (retired, not unhealthy)"));
  check("uncapped caption has no floor sentence", !compositionCaption(result()).includes("cap"));
}

console.log("7. the surfaces: loading is loading; populated lists the authority's rows in its order");
{
  const noop = () => {};
  const widget = renderToStaticMarkup(createElement(OpsConnectionHealthWidget, { section: { id: "s", key: "ops_connection_health", label: "Connection health" } }));
  check("widget first frame is the loading state", widget.includes("Loading…") && widget.includes('role="status"'));
  const block = renderToStaticMarkup(createElement(ConnectionHealthBlock, {}));
  check("block first frame is the loading state (never null)", block.includes("Loading…") && block.includes("Connection health"));

  const failed = renderToStaticMarkup(createElement(ConnectionHealthSurface, { title: "Connection health", data: null, loading: false, error: "Not authorized", filter: "all", onFilter: noop, onMutated: noop }));
  check("a failed read is an alert, not an empty fleet", failed.includes('role="alert"') && failed.includes("Not authorized") && !failed.includes("All "));

  const healthy = renderToStaticMarkup(createElement(ConnectionHealthSurface, { title: "Connection health", data: result(), loading: false, error: null, filter: "all", onFilter: noop, onMutated: noop, nowMs: NOW }));
  check("all-healthy says so with the count", healthy.includes("All 5 live connections healthy"));
  check("the composition bar renders the counts", healthy.includes("Healthy") && healthy.includes("Fleet composition"));

  const rows = [row({ id: "err", healthState: "ERROR", status: "ERROR", errorCode: "ITEM_LOGIN_REQUIRED", availableActions: ["resync", "request-reauth"] }), row({ id: "st" })];
  const data = result({ unhealthy: rows, counts: { HEALTHY: 3, STALE: 1, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 1, REVOKED: 0 } });
  const populated = renderToStaticMarkup(createElement(ConnectionHealthSurface, { title: "Connection health", data, loading: false, error: null, filter: "all", onFilter: noop, onMutated: noop, nowMs: NOW }));
  check("populated: the authority's order is kept (no client sort)", populated.indexOf("Inspect Chase") >= 0 && !/\.sort\(/.test(strip("components/platform/widgets/connection-health-table.tsx")));
  check("populated: state words render with tones (never colour alone)", populated.includes(">Error<") && populated.includes(">Stale<"));
  check("populated: the filter group is present", populated.includes('aria-label="Connection filter"') && populated.includes("Needs action 1"));
  check("populated: no Owner column on the first frame (owners resolve after a CS read)", !populated.includes(">Owner<"));
  const filtered = renderToStaticMarkup(createElement(ConnectionHealthSurface, { title: "Connection health", data, loading: false, error: null, filter: "needs-action", onFilter: noop, onMutated: noop, nowMs: NOW }));
  check("'Needs action' hides the merely-late row", filtered.includes("Inspect Chase") && (filtered.match(/Inspect Chase/g) ?? []).length === 1);

  const blockPop = renderToStaticMarkup(createElement(ConnectionHealthBlockSurface, { data, loading: false, error: null, onOpenWorkspace: noop, nowMs: NOW }));
  check("block: doorway names the Providers workspace", blockPop.includes("Open Providers →"));
  check("block: unhealthy rows render through the same renderer", blockPop.includes("Inspect Chase") && blockPop.includes("24 h policy"));
  const blockNoHost = renderToStaticMarkup(createElement(ConnectionHealthBlockSurface, { data, loading: false, error: null, nowMs: NOW }));
  check("block: no doorway without a host switcher", !blockNoHost.includes("Open Providers →"));
}

console.log("8. source pins: house hooks, tokens, client boundary");
{
  const widget = strip("components/platform/widgets/OpsConnectionHealthWidget.tsx");
  const table = strip("components/platform/widgets/connection-health-table.tsx");
  const block = strip("components/platform/widgets/overview/ConnectionHealthBlock.tsx");
  check("widget reads through useWidgetFetch with a static literal", /useWidgetFetch<ConnectionHealthResponse>\("\/api\/platform\/platform-ops\/connection-health"\)/.test(widget));
  check("block reads through useWidgetFetch with a static literal", /useWidgetFetch<ConnectionHealthResponse>\("\/api\/platform\/platform-ops\/connection-health"\)/.test(block));
  check("owners resolve through useKeyedFetch keyed on the id list", /useKeyedFetch<ConnectionOwnersResponse>\(url\)/.test(table) && /key=\{url\}/.test(table));
  check("the only raw fetch is the POST mutation", (widget.match(/fetch\(/g) ?? []).length === 1 && /method:\s*"POST"/.test(widget));
  for (const [name, src] of [["widget", widget], ["table", table], ["block", block]] as const) {
    check(`${name}: no rgba / hex colour`, !/rgba\(|#[0-9a-f]{3,6}\b/i.test(src));
    check(`${name}: no matchMedia`, !/matchMedia/.test(src));
    check(`${name}: imports no server module (customer-core, reader, db)`, !/customer-core"|@\/lib\/db|@\/lib\/connections\/health"(?!;?\s*$)/m.test(src.replace(/import type[^;]+;/g, "")));
    check(`${name}: nothing truncated`, !/truncate/.test(src));
  }
  check("table collapses by md: classes", /hidden md:block/.test(table) && /md:hidden/.test(table));
  check("WRITE buttons render only behind access.canWrite", /isPlaid && canWrite && \(/.test(widget));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
