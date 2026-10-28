/**
 * lib/connections/connection-detail.test.ts  (Connections detail — tabbed refinement)
 *
 * What the Overview / Health / History tabs say, from the same authorities the
 * row reads — never one blended "Healthy", never a claimed completeness that
 * the coverage licence does not prove, never a balance or a code.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { groupAccounts, connectionHealth, connectionHistory, abbreviateAddress, accountGroupKey, chartReadyRange } from "@/lib/connections/connection-detail.core";
import { summarizeConnection } from "@/lib/connections/connection-summary";
import { connectionDestinations } from "@/lib/connections/connection-facts";
import type { SyncConnection } from "@/lib/sync/status";
import type { ConnectionIntelligenceStatus } from "@/lib/connections/intelligence";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-10-28T12:00:00Z");
const conn = (over: Partial<SyncConnection>): SyncConnection => ({
  id: "c1", provider: "PLAID", institution: "Chase", state: "ready", lastSyncedAt: "2026-10-28T08:00:00Z", investments: null, ...over,
} as SyncConnection);
const intel = (over: Partial<ConnectionIntelligenceStatus>): ConnectionIntelligenceStatus => ({
  phase: "READY", intelligenceReady: true, availableHistory: null, earliestTransactionDate: "2024-10-01",
  lastReconstructedAt: "2026-10-28T08:05:00Z", connectedAt: null, lastSyncedAt: "2026-10-28T08:00:00Z",
  balancesUpdatedAt: "2026-10-28T08:00:00Z", sourceHealth: null, positionObservedAt: null, transactionsSyncedAt: null,
  valuationUpdatedAt: null, valuationIsReadTime: false, walletHistory: null, ...over,
} as ConnectionIntelligenceStatus);

console.log("Overview — account groups");
{
  const groups = groupAccounts([
    { id: "1", name: "Total Checking", type: "checking", mask: "1234" },
    { id: "2", name: "Sapphire", type: "debt", subtype: "credit card" },
    { id: "3", name: "Savings", type: "savings" },
    { id: "4", name: "Home loan", type: "debt", subtype: "mortgage" },
    { id: "5", name: "Checking 2", type: "checking" },
  ]);
  check("only the categories that exist, in a stable order, with accurate counts",
    JSON.stringify(groups.map((g) => [g.label, g.accounts.length])) === JSON.stringify([["Checking", 2], ["Savings", 1], ["Credit cards", 1], ["Loans", 1]]));
  check("real account records are kept inside each group", groups[0].accounts.map((a) => a.id).join() === "1,5");
  check("debt with no subtype is not guessed into cards or loans", accountGroupKey({ type: "debt", subtype: null }) === "debt");
  check("addresses are abbreviated, never shown whole", abbreviateAddress("7irKphsVxEfU8wtDhVgCyq7nQXUo9Q13ivUevk8qBMSN") === "7irK…BMSN");
}

console.log("Health — multidimensional");
{
  const ok = connectionHealth(conn({}), intel({}), NOW);
  check("a current bank connection: 'Connected and up to date'", ok.headline === "Connected and up to date" && ok.tone === "ok");
  check("…with separate lines for connection, balances, transactions, history",
    ["connection", "balances", "transactions", "history"].every((k) => ok.lines.some((l) => l.key === k)));
  const noClock = connectionHealth(conn({ lastSyncedAt: null }), intel({ earliestTransactionDate: "2026-07-01" }), NOW);
  check("transactions evidenced without a sync clock read 'Available', never 'Not imported yet'",
    noClock.lines.find((l) => l.key === "transactions")?.text === "Available");
  const reauth = connectionHealth(conn({ state: "needs_reauth" }), intel({}), NOW);
  check("needs reconnecting ⇒ 'Connection needs attention'", reauth.headline === "Connection needs attention" && reauth.tone === "attention");
  const importing = connectionHealth(conn({ state: "importing" }), intel({ phase: "IMPORTING", intelligenceReady: false }), NOW);
  check("importing ⇒ current balances available; historical transactions still importing", /still importing/.test(importing.headline));

  const wallet = conn({ provider: "WALLET", institution: "My SOL" });
  const partial = connectionHealth(wallet, intel({ positionObservedAt: "2026-10-28", valuationIsReadTime: true,
    walletHistory: { supported: true, licensed: false, licensedFromISO: null, licensedToISO: null, activityFromISO: null } }), NOW);
  check("a wallet with fresh holdings but unproven history is NOT 'up to date' (limited, not green)", partial.headline === "Current holdings ready; some history is limited" && partial.tone === "neutral", partial.headline);
  check("…and the row badge agrees", summarizeConnection(wallet, intel({ walletHistory: { supported: true, licensed: false, licensedFromISO: null, licensedToISO: null, activityFromISO: null } }), 1).status === "History incomplete");
  check("wallet health has no banking fields", !partial.lines.some((l) => l.key === "balances" || l.key === "investments"));
  const proven = connectionHealth(wallet, intel({ positionObservedAt: "2026-10-28", valuationIsReadTime: true,
    walletHistory: { supported: true, licensed: true, licensedFromISO: "2023-01-01", licensedToISO: "2026-10-28", activityFromISO: "2023-02-01",
      priceFromISO: "2020-01-01", chart: { fromISO: "2023-02-01", toISO: "2026-10-28", days: 1366, continuous: true } } }), NOW);
  check("a wallet whose chart reaches the start of its proven history reads 'Current holdings ready' — never 'up to date'", proven.headline === "Current holdings ready" && proven.tone === "ok", proven.headline);
  const short = connectionHealth(wallet, intel({ positionObservedAt: "2026-10-28", valuationIsReadTime: true,
    walletHistory: { supported: true, licensed: true, licensedFromISO: "2022-03-26", licensedToISO: "2026-10-28", activityFromISO: "2022-03-26",
      priceFromISO: "2026-09-27", chart: { fromISO: "2026-09-27", toISO: "2026-10-28", days: 32, continuous: true } } }), NOW);
  check("native history verified but chart shorter ⇒ 'some history is limited', not green", short.headline === "Current holdings ready; some history is limited" && short.tone === "neutral");
  check("wallet Health has separate lines: monitoring, holdings, native, tokens, prices, value",
    ["connection", "holdings", "history", "tokens", "prices", "valuation"].every((k) => short.lines.some((l) => l.key === k))
    && short.lines.find((l) => l.key === "tokens")?.text === "Not reconstructed"
    && short.lines.find((l) => l.key === "prices")?.text === "Available since Sep 27, 2026");
  check("dates are absolute (no relative 'today' that goes stale)", short.lines.find((l) => l.key === "holdings")?.text === "Updated Oct 28, 2026");
  const importingW = connectionHealth(wallet, intel({ positionObservedAt: "2026-10-28", facts: { destinations: [], bankTransactions: null, onChain: null, historyWorkerEnabled: false },
    walletHistory: { supported: true, licensed: false, licensedFromISO: null, licensedToISO: null, activityFromISO: null, historyImport: { state: "IMPORTING", provenFromISO: "2025-01-01", lastProgressAtISO: null, signaturesProcessed: 10, lastFailureCode: null } } }), NOW);
  check("an importing wallet says so — and claims 'continues automatically' ONLY when the worker is enabled",
    importingW.headline === "Current holdings ready; history is being imported" && importingW.lines.find((l) => l.key === "import")?.text === "In progress");
  const all = JSON.stringify([ok, reauth, importing, partial, proven]);
  check("no codes or provider vocabulary in any sentence", !/[A-Z]{3,}_[A-Z]{3,}|error code|plaid/i.test(all.replace(/"key":"[^"]*"/g, "")));
}

console.log("History — never claims what is not proven");
{
  const bank = connectionHistory(conn({}), intel({}));
  check("a bank's history is AVAILABLE from its earliest transaction, never 'complete'", bank.coverage === "AVAILABLE" && bank.fromISO === "2024-10-01");
  check("a bank with no transactions says so (no zeroes, no empty chart)", connectionHistory(conn({}), intel({ earliestTransactionDate: null })).coverage === "UNAVAILABLE");
  check("importing is IMPORTING with no percentage", connectionHistory(conn({ state: "importing" }), intel({})).coverage === "IMPORTING"
    && !/%/.test(JSON.stringify(connectionHistory(conn({ state: "importing" }), intel({})))));
  const solAccounts = [{ id: "a", name: "SOL", type: "crypto", chain: "SOL" }];
  const sol = connectionHistory(conn({ provider: "WALLET" }), intel({ walletHistory: { supported: true, licensed: false, licensedFromISO: null, licensedToISO: null, activityFromISO: null } }), solAccounts);
  check("an unproven Solana wallet is PARTIAL with no dates", sol.coverage === "PARTIAL" && sol.fromISO === null && sol.toISO === null);
  check("…and names the import limitation honestly (never estimated)", sol.limitations.some((l) => /5,000/.test(l) && /never estimated/.test(l)));
  const done = connectionHistory(conn({ provider: "WALLET" }), intel({ walletHistory: { supported: true, licensed: true, licensedFromISO: "2017-10-16", licensedToISO: "2026-10-28", activityFromISO: "2021-04-27" } }));
  const solAcct = [{ id: "a", name: "SOL", type: "crypto", chain: "SOL" }];
  const two = connectionHistory(conn({ provider: "WALLET" }), intel({ walletHistory: { supported: true, licensed: true, licensedFromISO: "2022-03-26", licensedToISO: "2026-10-28", activityFromISO: "2022-03-26",
    priceFromISO: "2026-09-27", chart: { fromISO: "2026-09-27", toISO: "2026-10-28", days: 32, continuous: true } } }), solAcct);
  check("wallet history states NATIVE scope, never an unqualified 'Complete'", /^Native SOL history verified/.test(two.summary) && !/^Complete/.test(two.summary) && two.blockchain?.label === "Native SOL");
  check("…and carries the chart-ready range separately, with the explanatory sentence when they differ",
    two.chart?.fromISO === "2026-09-27" && two.chart.days === 32 && two.rangeNote === "Older blockchain activity is preserved. Earlier chart values require historical prices.");
  check("…and the SPL token limitation is stated, not implied complete", two.limitations.some((l) => /SPL token balances are not reconstructed/.test(l)));
  const same = connectionHistory(conn({ provider: "WALLET" }), intel({ walletHistory: { supported: true, licensed: true, licensedFromISO: "2026-09-27", licensedToISO: "2026-10-28", activityFromISO: "2026-09-27",
    priceFromISO: "2025-01-01", chart: { fromISO: "2026-09-27", toISO: "2026-10-28", days: 32, continuous: true } } }), [{ id: "b", name: "BTC", type: "crypto", chain: "BTC" }]);
  check("no range note when the chart reaches the start of verified history; no token caveat for Bitcoin", same.rangeNote === null && same.limitations.length === 0 && same.blockchain?.label === "Native BTC");
  check("a licensed wallet is COMPLETE from its ACTIVITY start, not the proof floor", done.coverage === "COMPLETE" && done.fromISO === "2021-04-27");
  check("an unsupported network is UNAVAILABLE", connectionHistory(conn({ provider: "WALLET" }), intel({ walletHistory: { supported: false, licensed: false, licensedFromISO: null, licensedToISO: null, activityFromISO: null } })).coverage === "UNAVAILABLE");
}

console.log("Chart-ready range (balances × prices × snapshots)");
{
  const wh = { licensed: true, licensedFromISO: "2022-03-26", licensedToISO: "2026-10-28", activityFromISO: "2022-03-26" };
  const days = (from: string, n: number) => Array.from({ length: n }, (_, k) => new Date(Date.parse(`${from}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10));
  const r = chartReadyRange(wh, "2026-09-27", days("2026-09-27", 32));
  check("2-yr balances + 31 days of prices ⇒ chart-ready from the price floor, 32 real snapshot days", r?.fromISO === "2026-09-27" && r?.toISO === "2026-10-28" && r?.days === 32 && r?.continuous === true, JSON.stringify(r));
  const g = chartReadyRange(wh, "2026-09-27", days("2026-09-27", 32).filter((d) => d !== "2026-10-05"));
  check("a missing snapshot day is reported as a gap, never bridged", g?.days === 31 && g?.continuous === false);
  check("prices older than balances ⇒ chart starts at the balance licence", chartReadyRange({ ...wh, activityFromISO: "2026-10-01", licensedFromISO: "2026-10-01" }, "2020-01-01", days("2026-09-27", 32))?.fromISO === "2026-10-01");
  check("no prices ⇒ no chart-ready history (never zero-valued days)", chartReadyRange(wh, null, days("2026-09-27", 32)) === null);
  check("unlicensed history ⇒ none", chartReadyRange({ ...wh, licensed: false }, "2026-09-27", days("2026-09-27", 32)) === null);
}

console.log("Honest facts — only destinations that genuinely consume the data");
{
  check("a crypto wallet feeds Net Worth, Assets, Investments — NEVER Cash Flow / Spending / Transactions",
    JSON.stringify(connectionDestinations(["crypto"], false)) === JSON.stringify(["Net Worth", "Assets", "Investments"]));
  check("a checking account with banking rows feeds Cash and the transaction views",
    JSON.stringify(connectionDestinations(["checking"], true)) === JSON.stringify(["Net Worth", "Assets", "Cash", "Transactions", "Cash Flow", "Spending"]));
  check("a bank account with NO banking rows does not claim the transaction views", !connectionDestinations(["savings"], false).includes("Cash Flow"));
  check("a credit card feeds Debt (and its spending only via banking rows)", connectionDestinations(["debt"], false).join() === "Net Worth,Debt");
  check("a manual real asset feeds Net Worth and Assets only", connectionDestinations(["other"], false).join() === "Net Worth,Assets");
  const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
  const tl = read("components/connections/ConnectionTimeline.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
  check("the accordion no longer says 'Wealth timeline built', 'Cash flow available' or 'Transactions available'",
    !/Wealth timeline built|Cash flow available|Transactions available|Financial intelligence|Data acquisition/.test(tl));
  check("…no decorative checkmarks, absolute dates only", !/<Check\b|fmtRelative/.test(tl) && /fmtDay\(/.test(tl));
  check("…'Used in' comes from the loader's destinations, not from a job finishing", /f\??\.destinations\.join/.test(tl));
  const sd = read("lib/connections/space-data.ts");
  check("destinations use THE banking population (crypto-owned rows excluded) for the transaction views",
    /transactionAccountPopulation\(client,/.test(sd) && /connectionDestinations\(accts\.map\(\(a\) => a\.type\), banking\.length > 0\)/.test(sd));
  // 2026-10-28: per connection chain (SOL / BTC / ETH each have their own worker gate).
  check("'continues automatically' is claimed only from the real worker flag", /historyWorkerEnabled: c\.provider === "WALLET" && historyWorkerEnabledFor\(chain\)/.test(sd)
    && /if \(k === "SOL"\) return env\.SOL_BACKFILL_ENABLED === "true";/.test(read("lib/crypto/history-checkpoint-status.ts")));
  const menu = read("components/connections/ConnectionMenu.tsx");
  const list = read("components/connections/ConnectionsList.tsx");
  check("no customer-facing 'Restore financial intelligence' / rebuild panel", !/Restore financial intelligence|build-intelligence/.test(menu) && !/<BuildIntelligencePanel/.test(list));
  for (const [f, re] of [["jobs/sync-banks.ts", /regenerateWealthHistoryForAccounts\(/], ["lib/refresh/wallet-post-sync.ts", /regenerateWealthHistoryForAccounts\(/],
    ["jobs/sol-history-backfill.ts", /regenerateWealthHistoryForAccounts\(/], ["lib/plaid/backgroundHistorySync.ts", /regenerateWealthHistoryForAccounts\(/]] as const) {
    check(`the automatic lifecycle still rebuilds history: ${f}`, re.test(read(f)));
  }
  check("the first-snapshot card separates CURRENT from HISTORICAL", /Your current financial snapshot is ready/.test(list) && /historyStillArriving/.test(list));
}

console.log("Wiring and accessibility");
{
  const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
  const tabs = read("components/connections/ConnectionDetailTabs.tsx");
  check("tabs: tablist / tab / tabpanel roles, aria-selected, aria-controls, roving tabIndex",
    /role="tablist"/.test(tabs) && /role="tab"/.test(tabs) && /role="tabpanel"/.test(tabs) && /aria-selected=\{selected\}/.test(tabs)
    && /aria-controls=/.test(tabs) && /tabIndex=\{selected \? 0 : -1\}/.test(tabs));
  check("tabs: arrow keys, Home and End", /ArrowRight/.test(tabs) && /ArrowLeft/.test(tabs) && /"Home"/.test(tabs) && /"End"/.test(tabs));
  check("account groups are buttons with aria-expanded", /aria-expanded=\{isOpen\}/.test(tabs));
  check("Overview is the default tab", /useState<TabKey>\("overview"\)/.test(tabs));
  check("no balances in the detail (PCS-2): no balance / amount fields read", !/\.balance\b|currentBalance|formatCurrency/.test(tabs));
  const card = read("components/connections/ConnectionCard.tsx");
  check("every existing state renderer still feeds the Health tab", /healthExtra=\{<>\{content\}\{walletActions\}<\/>\}/.test(card));
  check("the timeline and historical import move to History", /historyExtra=\{<>\{intelligence && <ConnectionTimeline intelligence=\{intelligence\} provider=\{connection\.provider\} \/>\}\{importAction\}<\/>\}/.test(card));
  const list = read("components/connections/ConnectionsList.tsx");
  check("desktop drawer is wider (lg) and the phone sheet has a '‹ Connections' back control",
    /ariaLabel="Connection detail" size="lg"/.test(list) && /sm:hidden">\s*<ChevronLeft aria-hidden size=\{16\} \/> Connections/.test(list));
  check("the ⋯ menu stays in the drawer header", /actions=\{selected\.state !== "importing" \? <ConnectionMenu connection=\{selected\} \/> : undefined\}/.test(list));
}

if (failures > 0) { console.error(`\nconnection-detail: ${failures} failed.`); process.exit(1); }
console.log("\nconnection-detail: all checks passed.");
