/**
 * lib/connections/real-assets.test.ts  (Connections 2.0 — categories + real assets)
 *
 * Pure: category counts (no double counting, never a total), category
 * filtering, wallets grouped by blockchain, manual-asset copy (no provider
 * language, the 12-month freshness rule, no fabricated history), activity from
 * the user's own audit rows (accountId only). Source pins: the loader's
 * ownership gate and tenant client, the drawer/menu reuse the EXISTING routes
 * (no new write path), provider rows still carry no balances.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  categoryCounts, categoryEmptyState, categoryOptionLabel, connectionsInCategory, groupWalletsByChain,
  groupAssetActivity, manualAssetFreshness, manualAssetHealth, summarizeManualAsset, removeAssetMessage,
  CATEGORY_ORDER, MANUAL_ASSET_KIND_LABEL, MANUAL_ASSET_SOURCE_LABEL,
} from "@/lib/connections/real-assets.core";
import type { SyncConnection } from "@/lib/sync/status";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const conn = (id: string, provider: SyncConnection["provider"]): SyncConnection => ({
  id, provider, institution: id, state: "ready", lastSyncedAt: null,
  errorCode: null, importedCount: null, historyBuild: null, deferredReason: null, investments: null,
} as SyncConnection);

const NOW = new Date("2026-10-28T12:00:00Z");
const PROVIDER_WORDS = /\b(sync|synced|syncing|connected|connection|provider|refresh|import|imported|plaid|reconnect)\b/i;

console.log("categories: counts and filtering");
{
  const conns = [conn("chase", "PLAID"), conn("btc", "WALLET"), conn("amex", "PLAID"), conn("sol", "WALLET"), conn("eth", "WALLET")];
  const assets = [{ id: "home" }, { id: "car" }];
  const c = categoryCounts(conns, assets);
  check("banks = Plaid institutions", c.banks === 2);
  check("crypto = wallets", c.crypto === 3);
  check("real assets = manual assets", c.real_assets === 2);
  check("All is the sum — every item in exactly one category (no double counting)", c.all === c.banks + c.crypto + c.real_assets && c.all === 7);
  check("no category is empty-safe broken (zero everything)", JSON.stringify(categoryCounts([], [])) === JSON.stringify({ all: 0, banks: 0, crypto: 0, real_assets: 0 }));
  check("order: All · Banks · Crypto · Real assets", CATEGORY_ORDER.join() === "all,banks,crypto,real_assets");
  check("labels carry a COUNT, never money", categoryOptionLabel("banks", c) === "Banks · 2" && !/\$|€|£/.test(CATEGORY_ORDER.map((k) => categoryOptionLabel(k, c)).join()));
  check("All keeps every connection in its given order", connectionsInCategory(conns, "all").map((x) => x.id).join() === "chase,btc,amex,sol,eth");
  check("Banks keeps only Plaid", connectionsInCategory(conns, "banks").every((x) => x.provider === "PLAID") && connectionsInCategory(conns, "banks").length === 2);
  check("Crypto keeps only wallets", connectionsInCategory(conns, "crypto").every((x) => x.provider === "WALLET") && connectionsInCategory(conns, "crypto").length === 3);
  check("Real assets shows no provider connection", connectionsInCategory(conns, "real_assets").length === 0);
  for (const k of CATEGORY_ORDER) {
    const e = categoryEmptyState(k);
    check(`empty state for ${k} is honest and actionable`, e.title.length > 0 && /above|get started/.test(e.body));
  }
}

console.log("crypto: grouped by blockchain");
{
  const conns = [conn("w-sol", "WALLET"), conn("w-btc", "WALLET"), conn("chase", "PLAID"), conn("w-eth", "WALLET"), conn("w-btc2", "WALLET"), conn("w-x", "WALLET"), conn("w-avax", "WALLET")];
  const accounts = {
    "w-sol": [{ chain: "SOL" }], "w-btc": [{ chain: "BTC" }], "w-eth": [{ chain: "eth" }], "w-btc2": [{ chain: "BTC" }],
    "w-x": [{ chain: null }], "w-avax": [{ chain: "AVAX" }], chase: [{ chain: null }],
  };
  const g = groupWalletsByChain(conns, accounts);
  check("Bitcoin, Ethereum, Solana first, others after, unknown last", g.map((x) => x.label).join() === "Bitcoin,Ethereum,Solana,Avalanche,Other networks", g.map((x) => x.label).join());
  check("two Bitcoin wallets share one group", g[0].connections.map((x) => x.id).join() === "w-btc,w-btc2");
  check("a bank never lands in a chain group", !g.some((x) => x.connections.some((c) => c.provider === "PLAID")));
  check("chain is never guessed — unknown is 'Other networks'", g.at(-1)!.key === "unknown" && g.at(-1)!.connections[0].id === "w-x");
}

console.log("manual assets: copy, freshness, health");
{
  const fresh = summarizeManualAsset({ valuedAsOfISO: "2026-06-01" }, NOW);
  check("row says what it is and who values it", fresh.kind === MANUAL_ASSET_KIND_LABEL && fresh.source === MANUAL_ASSET_SOURCE_LABEL && fresh.source === "Valued by you");
  check("row names the valuation date", fresh.valued === "Valued Jun 1, 2026", fresh.valued);
  check("a recent estimate is not flagged", fresh.tone === "ok" && fresh.status === "Your estimate");
  check("exactly 12 months is still recent (rule is MORE than 12 months)", !manualAssetFreshness("2025-10-28", NOW).stale);
  const old = manualAssetFreshness("2025-10-01", NOW);
  check("older than 12 months ⇒ Consider updating", old.stale && /Consider updating/.test(old.note));
  check("…and the row says so", summarizeManualAsset({ valuedAsOfISO: "2024-01-01" }, NOW).status === "Consider updating");
  const undated = manualAssetFreshness(null, NOW);
  check("no date ⇒ asks for one, never invents an age", undated.stale && !/\d/.test(undated.note));
  const h = manualAssetHealth({ valuedAsOfISO: "2026-06-01" }, NOW);
  check("Health headline: You value this asset yourself", h.headline === "You value this asset yourself");
  check("Health states the last valuation date", h.lines.some((l) => l.key === "valuation" && l.text === "Jun 1, 2026"));
  const allCopy = [
    fresh.kind, fresh.source, fresh.valued, fresh.status, old.note, undated.note, manualAssetFreshness("2026-10-01", NOW).note,
    h.headline, ...h.lines.flatMap((l) => [l.label, l.text]),
    ...manualAssetHealth({ valuedAsOfISO: null }, NOW).lines.map((l) => l.text),
    removeAssetMessage("Austin Home"), categoryEmptyState("real_assets").body,
  ].join(" | ");
  check("no provider / sync language anywhere in manual-asset copy", !PROVIDER_WORDS.test(allCopy), allCopy.match(PROVIDER_WORDS)?.[0]);
  check("Remove explains archive semantics: history kept, restorable", /history is kept/.test(removeAssetMessage("X")) && /restore/.test(removeAssetMessage("X")));
}

console.log("activity: the user's own audit rows, accountId only");
{
  const rows = [
    { action: "MANUAL_ASSET_ADD",    createdAt: new Date("2026-01-02T00:00:00Z"), metadata: { accountId: "home", currency: "USD" } },
    { action: "MANUAL_ASSET_UPDATE", createdAt: new Date("2026-05-02T00:00:00Z"), metadata: { accountId: "home", balance: 512000 } },
    { action: "ACCOUNT_RENAMED",     createdAt: "2026-03-02T00:00:00Z",           metadata: { accountId: "home", displayName: "Lake house" } },
    { action: "MANUAL_ASSET_UPDATE", createdAt: new Date("2026-05-03T00:00:00Z"), metadata: { accountId: "someone-else" } },
    { action: "PLAID_HISTORY_SYNCED", createdAt: new Date("2026-05-04T00:00:00Z"), metadata: { accountId: "home" } },
    { action: "MANUAL_ASSET_ADD",    createdAt: new Date("2026-05-05T00:00:00Z"), metadata: null },
  ];
  const a = groupAssetActivity(rows, new Set(["home", "car"]));
  check("only this user's asset ids", Object.keys(a).join() === "home");
  check("only asset-lifecycle actions (unknown actions dropped)", a.home.length === 3);
  check("newest first", a.home.map((x) => x.label).join() === "Valuation recorded,Renamed,Added");
  check("kinds and dates only — no value, name or other metadata survives", a.home.every((x) => Object.keys(x).sort().join() === "action,atISO,label")
    && !JSON.stringify(a).includes("512000") && !JSON.stringify(a).includes("Lake house"));
  check("an asset with no audit rows has no activity (never fabricated)", a.car === undefined);
}

console.log("source pins: loader ownership gate + tenant client");
{
  const loader = code("lib/connections/real-assets.ts");
  check("takes the caller's client (no global db import)", /client: ReadClient, userId: string/.test(loader) && !/from ["']@\/lib\/db["']/.test(loader));
  check("ownership gate: the user's OWN manual assets, not deleted", /ownerUserId: userId/.test(loader) && /syncStatus:\s+"manual"/.test(loader)
    && /type:\s+AccountType\.other/.test(loader) && /deletedAt:\s+null/.test(loader));
  check("audit read is the user's own rows (userId = me)", /auditLog\.findMany\(\{\s*where:\s+\{ userId, action:/.test(loader));
  check("value = FinancialAccount.balance (the ledger's latest), date from the valuation ledger", /value:\s+r\.balance/.test(loader) && /assetValuation\.groupBy/.test(loader));
  check("nothing summed (no total)", !/reduce\(|\+=\s*r\.balance/.test(loader));
  const sd = code("lib/connections/space-data.ts");
  check("Connections loader reads manual assets in the same phase", /const manualAssets = await loadConnectionsManualAssets\(client, userId\)/.test(sd));
  check("the 4 s poller does NOT read manual assets", /loadConnectionsSyncStatus[\s\S]*?await loadProviderConnections\(client, userId\)/.test(sd));
  check("PCS-2 kept for provider accounts: groupConnectionAccounts selects no balance", !/balance/.test(sd.slice(sd.indexOf("export function groupConnectionAccounts"), sd.indexOf("async function loadPlaidConnectionAccounts"))));
}

console.log("source pins: route reuse (no new write path)");
{
  const menu = code("components/connections/ManualAssetMenu.tsx");
  check("rename reuses PATCH /api/accounts/[id] { displayName }", /fetch\(`\/api\/accounts\/\$\{encodeURIComponent\(asset\.id\)\}`, \{\s*method: "PATCH"/.test(menu) && /displayName: trimmed/.test(menu));
  check("valuation reuses UpdateAssetValueModal (PATCH /api/accounts/manual/[id])", /<UpdateAssetValueModal/.test(menu) && /acquisitionDate=\{asset\.acquisitionDateISO\}/.test(menu));
  check("remove reuses the archive DELETE /api/accounts/manual/[id] behind a ConfirmDialog", /\/api\/accounts\/manual\/\$\{encodeURIComponent\(asset\.id\)\}`, \{ method: "DELETE" \}/.test(menu) && /<ConfirmDialog/.test(menu));
  check("every action refreshes the page data", (menu.match(/router\.refresh\(\)/g) ?? []).length >= 3);
  check("menu: Escape and outside click close it", /e\.key !== "Escape"/.test(menu) && /mousedown/.test(menu) && /aria-haspopup="menu"/.test(menu));
  check("a failure is said out loud (role=alert)", (menu.match(/role="alert"/g) ?? []).length >= 2);
  check("no new API route for manual assets", !/\/api\/connections\/assets|\/api\/accounts\/manual\/[^$`]*details/.test(menu));
  const detail = code("components/connections/ManualAssetDetail.tsx");
  check("detail shares the tab primitive with the connection drawer", /<DetailTabs/.test(detail) && /from "@\/components\/connections\/ConnectionDetailTabs"/.test(detail));
  check("History: valuation ledger (existing route) and activity, separately labelled", /<AssetValuationHistory/.test(detail) && /<SectionLabel>Valuation history<\/SectionLabel>/.test(detail) && /<SectionLabel>Activity<\/SectionLabel>/.test(detail));
  const tabs = code("components/connections/ConnectionDetailTabs.tsx");
  check("provider detail still reads no balances (PCS-2)", !/\.balance\b|currentBalance|formatCurrency/.test(tabs));
  const row = code("components/connections/ConnectionRow.tsx");
  check("provider rows still carry no balances", !/balance|formatCurrency/.test(row));
  const list = code("components/connections/ConnectionsList.tsx");
  check("list: segmented categories with counts", /<SegmentedControl/.test(list) && /categoryOptionLabel\(id, counts\)/.test(list));
  check("list: real assets render ManualAssetRow and open their own drawer", /<ManualAssetRow/.test(list) && /ariaLabel="Asset detail" size="lg"/.test(list) && /<ManualAssetDetail key=\{selectedAsset\.id\}/.test(list));
  check("list: honest per-category empty state", /categoryEmptyState\(category\)/.test(list) && /data-connections-category-empty/.test(list));
  check("list: no money total anywhere", !/reduce\(|totalValue|sumValue/.test(list));
  const assetRow = code("components/connections/ManualAssetRow.tsx");
  check("asset row: manual is marked, value shown in whole units (outside a Space)", />Manual</.test(assetRow) && /formatCurrencyWhole\(asset\.value, asset\.currency\)/.test(assetRow));
}

if (failures > 0) { console.error(`\nreal-assets: ${failures} failed.`); process.exit(1); }
console.log("\nreal-assets: all checks passed.");
