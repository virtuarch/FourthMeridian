/**
 * lib/connections/connection-detail.test.ts  (Connections detail — tabbed refinement)
 *
 * What the Overview / Health / History tabs say, from the same authorities the
 * row reads — never one blended "Healthy", never a claimed completeness that
 * the coverage licence does not prove, never a balance or a code.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { groupAccounts, connectionHealth, connectionHistory, abbreviateAddress, accountGroupKey } from "@/lib/connections/connection-detail.core";
import { summarizeConnection } from "@/lib/connections/connection-summary";
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
  const reauth = connectionHealth(conn({ state: "needs_reauth" }), intel({}), NOW);
  check("needs reconnecting ⇒ 'Connection needs attention'", reauth.headline === "Connection needs attention" && reauth.tone === "attention");
  const importing = connectionHealth(conn({ state: "importing" }), intel({ phase: "IMPORTING", intelligenceReady: false }), NOW);
  check("importing ⇒ current balances available; historical transactions still importing", /still importing/.test(importing.headline));

  const wallet = conn({ provider: "WALLET", institution: "My SOL" });
  const partial = connectionHealth(wallet, intel({ positionObservedAt: "2026-10-28", valuationIsReadTime: true,
    walletHistory: { supported: true, licensed: false, licensedFromISO: null, licensedToISO: null, activityFromISO: null } }), NOW);
  check("a wallet with fresh holdings but unproven history is NOT 'up to date'", partial.headline === "Current holdings available; historical coverage incomplete" && partial.tone !== "ok", partial.headline);
  check("…and the row badge agrees", summarizeConnection(wallet, intel({ walletHistory: { supported: true, licensed: false, licensedFromISO: null, licensedToISO: null, activityFromISO: null } }), 1).status === "History incomplete");
  check("wallet health has no banking fields", !partial.lines.some((l) => l.key === "balances" || l.key === "investments"));
  const proven = connectionHealth(wallet, intel({ positionObservedAt: "2026-10-28", valuationIsReadTime: true,
    walletHistory: { supported: true, licensed: true, licensedFromISO: "2023-01-01", licensedToISO: "2026-10-28", activityFromISO: "2023-02-01" } }), NOW);
  check("a proven wallet is 'Connected and up to date'", proven.headline === "Connected and up to date");
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
  const solAccounts = [{ id: "a", name: "SOL", type: "crypto", walletChain: "SOL" }];
  const sol = connectionHistory(conn({ provider: "WALLET" }), intel({ walletHistory: { supported: true, licensed: false, licensedFromISO: null, licensedToISO: null, activityFromISO: null } }), solAccounts);
  check("an unproven Solana wallet is PARTIAL with no dates", sol.coverage === "PARTIAL" && sol.fromISO === null && sol.toISO === null);
  check("…and names the import limitation honestly (never estimated)", sol.limitations.some((l) => /5,000/.test(l) && /never estimated/.test(l)));
  const done = connectionHistory(conn({ provider: "WALLET" }), intel({ walletHistory: { supported: true, licensed: true, licensedFromISO: "2017-10-16", licensedToISO: "2026-10-28", activityFromISO: "2021-04-27" } }));
  check("a licensed wallet is COMPLETE from its ACTIVITY start, not the proof floor", done.coverage === "COMPLETE" && done.fromISO === "2021-04-27");
  check("an unsupported network is UNAVAILABLE", connectionHistory(conn({ provider: "WALLET" }), intel({ walletHistory: { supported: false, licensed: false, licensedFromISO: null, licensedToISO: null, activityFromISO: null } })).coverage === "UNAVAILABLE");
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
  check("the timeline and historical import move to History", /historyExtra=\{<>\{intelligence && <ConnectionTimeline intelligence=\{intelligence\} \/>\}\{importAction\}<\/>\}/.test(card));
  const list = read("components/connections/ConnectionsList.tsx");
  check("desktop drawer is wider (lg) and the phone sheet has a '‹ Connections' back control",
    /ariaLabel="Connection detail" size="lg"/.test(list) && /sm:hidden">\s*<ChevronLeft aria-hidden size=\{16\} \/> Connections/.test(list));
  check("the ⋯ menu stays in the drawer header", /actions=\{selected\.state !== "importing" \? <ConnectionMenu connection=\{selected\} \/> : undefined\}/.test(list));
}

if (failures > 0) { console.error(`\nconnection-detail: ${failures} failed.`); process.exit(1); }
console.log("\nconnection-detail: all checks passed.");
