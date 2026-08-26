/**
 * lib/crypto/wallet-sync-dispatch.test.ts
 *
 * W-M1d — wallet route activation: the chain registry and the two routes.
 *
 *     npx tsx lib/crypto/wallet-sync-dispatch.test.ts
 *
 * PART A exercises the PURE registry functions (support levels, syncability,
 * history capability) — the dispatch module imports the adapters, which import
 * @/lib/db, so `syncWalletByChain` itself is covered by source-scan rather than
 * execution. That is the same constraint every wallet test in this directory
 * documents.
 *
 * PART B source-scans both routes. The claims that matter are NEGATIVE: BTC's
 * behaviour is unchanged, ETH/SOL reach only their own adapters, unsupported
 * chains are refused by name, and no route can write a balance column for a
 * chain whose adapter refuses to.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  walletChainSupport, isSyncableChain, chainSupportsHistory, SYNCABLE_CHAINS,
} from "./wallet-sync-dispatch";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
function read(...seg: string[]): string {
  return readFileSync(join(process.cwd(), ...seg), "utf8");
}
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}
/**
 * Everything AFTER the import block.
 *
 * Ordering assertions must compare CALL SITES, not import specifiers: an
 * `import { syncWalletByChain, isSyncableChain }` line puts both names near
 * offset zero and makes any indexOf comparison meaningless. Stripping the
 * imports first is the difference between testing control flow and testing
 * alphabetical order in an import list.
 */
function body(src: string): string {
  const lastImport = src.lastIndexOf("\nimport ");
  if (lastImport < 0) return src;
  const end = src.indexOf(";", src.indexOf("from", lastImport));
  return end < 0 ? src : src.slice(end + 1);
}
/** The argument block of a call, bounded to that call — never the rest of the file. */
function callBlock(src: string, needle: string): string {
  const at = src.indexOf(needle);
  if (at < 0) return "";
  let depth = 0;
  for (let i = at + needle.length - 1; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return src.slice(at);
}

// ── PART A — the support ladder ──────────────────────────────────────────────

// THE DEFINITION THIS SLICE ESTABLISHES. Three levels, three different promises.
check("BTC is HISTORY_SUPPORTED (ledger, reconciliation, licensed carry)",
  walletChainSupport("BTC") === "HISTORY_SUPPORTED");
check("ETH is CURRENT_POSITION_SUPPORTED — a position, not a history",
  walletChainSupport("ETH") === "CURRENT_POSITION_SUPPORTED");
check("SOL is CURRENT_POSITION_SUPPORTED — a position, not a history",
  walletChainSupport("SOL") === "CURRENT_POSITION_SUPPORTED");

// A chain is promoted to HISTORY_SUPPORTED only when historical acquisition and
// reconstruction are PROVEN — never because an adapter exists. Pinned, so
// promoting ETH or SOL by accident fails here first.
check("ONLY BTC claims history support",
  SYNCABLE_CHAINS.filter((c) => chainSupportsHistory(c)).join(",") === "BTC");
check("having an adapter is NOT the same as having history",
  isSyncableChain("ETH") && !chainSupportsHistory("ETH")
    && isSyncableChain("SOL") && !chainSupportsHistory("SOL"));

// UNSUPPORTED CHAINS STAY UNSUPPORTED — including every label the wallet route
// accepts at CREATION time. Recording custody and reading the chain are
// different capabilities, and conflating them is what would turn "we cannot read
// this" into "it holds nothing".
for (const chain of ["MATIC", "AVAX", "DOT", "ADA", "XRP", "OTHER", "DOGE", "LTC"]) {
  check(`${chain} is explicitly UNSUPPORTED by sync`,
    walletChainSupport(chain) === "UNSUPPORTED" && !isSyncableChain(chain) && !chainSupportsHistory(chain));
}
for (const absent of [null, undefined, "", "   ", "bitcoin", "Ethereum "]) {
  check(`an absent or non-canonical chain token is UNSUPPORTED (${JSON.stringify(absent)})`,
    walletChainSupport(absent) === "UNSUPPORTED");
}
check("canonical tokens resolve case-insensitively", walletChainSupport(" eth ") === "CURRENT_POSITION_SUPPORTED");

check("the syncable set is exactly the three implemented chains",
  SYNCABLE_CHAINS.join(",") === "BTC,ETH,SOL");

// ── PART B — the registry wires each chain to ITS OWN adapter ────────────────

const dispatch = code(read("lib", "crypto", "wallet-sync-dispatch.ts"));

check("BTC dispatches to syncBtcWallet", /\[BTC_CHAIN\]:[\s\S]*?syncBtcWallet\(id\)/.test(dispatch));
check("ETH dispatches to syncEthWallet", /\[ETH_CHAIN\]:[\s\S]*?syncEthWallet\(id\)/.test(dispatch));
check("SOL dispatches to syncSolWallet", /\[SOL_CHAIN\]:[\s\S]*?syncSolWallet\(id\)/.test(dispatch));
check("chain keys come from the adapters' descriptors, never literals",
  !/["']BTC["']\s*:/.test(dispatch) && !/["']ETH["']\s*:/.test(dispatch) && !/["']SOL["']\s*:/.test(dispatch));

// Each adapter is reached EXACTLY once — no chain can fall through to another's.
for (const fn of ["syncBtcWallet", "syncEthWallet", "syncSolWallet"]) {
  check(`${fn} is invoked from exactly one registry entry`,
    (dispatch.match(new RegExp(`${fn}\\(id\\)`, "g")) ?? []).length === 1);
}

// An unknown chain is a STATED outcome carrying a reason, never a silent success.
check("an unknown chain returns ok:false with a reason naming what IS supported",
  /if \(!adapter\)/.test(dispatch) && /SYNCABLE_CHAINS\.join/.test(dispatch));
check("a failed sync reports NO net-worth participation whatever the chain",
  /result\.ok \? adapter\.netWorthParticipation : "NONE"/.test(dispatch));
// Scoped to the REGISTRY literal, so the type union's mention of each value
// does not count as a registration.
{
  const registry = dispatch.slice(dispatch.indexOf("const ADAPTERS"));
  check("BTC alone is registered as contributing through the legacy balance column",
    (registry.match(/LEGACY_BALANCE_COLUMN/g) ?? []).length === 1
      && registry.indexOf("LEGACY_BALANCE_COLUMN") < registry.indexOf("ETH_CHAIN"));
  check("ETH and SOL are both registered WITHHELD_PENDING_CONVERGENCE",
    (registry.match(/WITHHELD_PENDING_CONVERGENCE/g) ?? []).length === 2);
}
check("the dispatcher writes nothing itself (no DB access at all)",
  !/@\/lib\/db/.test(dispatch) && !/financialAccount\./.test(dispatch)
    && !/positionObservation/i.test(dispatch));

// ── PART B2 — the MANUAL SYNC route ─────────────────────────────────────────

const syncRoute = code(read("app", "api", "accounts", "[id]", "sync", "route.ts"));

check("the sync route names no chain and no adapter",
  !/syncBtcWallet|syncEthWallet|syncSolWallet/.test(syncRoute)
    && !/BTC_CHAIN|ETH_CHAIN|SOL_CHAIN/.test(syncRoute));
check("…and dispatches through the registry",
  /syncWalletByChain\(id, account\.walletChain\)/.test(syncRoute));
check("the BTC-only rejection message is gone",
  !/Only BTC wallet sync is supported/.test(syncRoute));
{
  const b = body(syncRoute);
  check("an unsupported chain is refused BY NAME, before any adapter is reached",
    /!isSyncableChain\(account\.walletChain\)/.test(b)
      && /SYNCABLE_CHAINS\.join/.test(b)
      && b.indexOf("isSyncableChain") < b.indexOf("syncWalletByChain"));
}

// BTC COMPATIBILITY — the surrounding behaviour is untouched.
check("owner-only + no existence disclosure is unchanged",
  /ownerUserId !== user\.id/.test(syncRoute) && /Wallet not found/.test(syncRoute));
check("the per-user rate limit is unchanged",
  /limitByUser\(user\.id, "wallet-resync", \{ limit: 6, windowSec: 3600 \}\)/.test(syncRoute));
check("the honest 200/502 contract is unchanged",
  /status: result\.ok \? 200 : 502/.test(syncRoute));
check("snapshot regen still runs for every successful sync",
  /regenerateSnapshotsForAccounts\(\[id\]\)/.test(syncRoute));
check("the ORCH-1 changedSince stamp still precedes the sync",
  body(syncRoute).indexOf("syncStartedAt = new Date()") < body(syncRoute).indexOf("syncWalletByChain("));

// HISTORY REGEN IS NOW A CHAIN CAPABILITY, and only BTC has it.
check("wealth-history regen is gated on chainSupportsHistory",
  /if \(chainSupportsHistory\(account\.walletChain\)\)/.test(syncRoute));
check("…and still uses the canonical planner for the chains that have it",
  /resolveHistoricalWorkWindow/.test(syncRoute) && /regenerateWealthHistoryForAccounts/.test(syncRoute));

// ── PART B3 — the WALLET CREATE / RE-ADD / RESTORE route ────────────────────

const walletRoute = code(read("app", "api", "accounts", "wallet", "route.ts"));

check("the create route no longer calls an adapter directly",
  !/syncBtcWallet|syncEthWallet|syncSolWallet/.test(walletRoute));
check("all THREE connect paths dispatch through one helper",
  (walletRoute.match(/syncWalletBestEffort\(/g) ?? []).length === 4,
  `found ${(walletRoute.match(/syncWalletBestEffort\(/g) ?? []).length} (1 definition + 3 call sites)`);
check("…and that helper goes through the registry",
  /syncWalletByChain\(financialAccountId, chain\)/.test(walletRoute));
check("connection still succeeds when the chain cannot be read (best-effort)",
  /if \(!outcome\.ok\)/.test(walletRoute) && /console\.warn/.test(walletRoute));

check("all THREE wealth-history calls are gated on chain capability",
  (walletRoute.match(/chainSupportsHistory\(chain\)/g) ?? []).length === 3);
check("no wealth-history call is left keyed on the BTC literal",
  !/BTC_CHAIN\) await regenWalletWealthHistory/.test(walletRoute));

// BTC-SPECIFIC INPUT HANDLING STAYS BTC-SPECIFIC. An xpub is a Bitcoin
// descriptor concept; normalising an Ethereum address as one would be nonsense.
check("xpub normalisation remains guarded to BTC",
  /chain === BTC_CHAIN \? normalizeExtendedKeyInput/.test(walletRoute)
    && /chain === BTC_CHAIN && isExtendedKey/.test(walletRoute));

// The route still accepts MORE chains than it can sync, deliberately.
check("account creation still accepts unreadable chains (custody ≠ readability)",
  /SUPPORTED_CHAINS = \[/.test(walletRoute) && /"ADA"/.test(walletRoute) && /"XRP"/.test(walletRoute));

// ── PART B4 — NO ROUTE MAY EXPAND BALANCE AUTHORITY ─────────────────────────
//
// The adapters refuse to write `balance`/`nativeBalance` for ETH and SOL; a
// route must not do it on their behalf. Neither route writes those columns at
// all — the only wallet-balance writer in the system is an adapter.
for (const [name, src] of [["sync route", syncRoute], ["wallet route", walletRoute]] as const) {
  check(`${name} writes no balance column`,
    !/balance:\s*[a-zA-Z]/.test(src) && !/nativeBalance:\s*[a-zA-Z]/.test(src));
}
// The create route seeds a new row at 0/0 — that is row creation, not a sync
// result, and it predates this slice. Pinned so it cannot quietly become one.
check("the create route seeds a new wallet at zero…",
  /balance:\s*0,/.test(walletRoute) && /nativeBalance:\s*0,/.test(walletRoute));
check("…and its only account UPDATE touches lifecycle, never a balance",
  !/balance/.test(callBlock(walletRoute, "financialAccount.update(")),
  callBlock(walletRoute, "financialAccount.update("));

// ── PART B5 — provider/config failures never touch position state ───────────
//
// The adapters are the only writers, and each returns before its capture call on
// every refusal (pinned in eth-sync.test.ts / sol-sync.test.ts). What this file
// adds is the ROUTE half: a refused sync must not trigger any of the write-side
// work a successful one does.
{
  const b = body(syncRoute);
  check("snapshot + history regen run ONLY inside the result.ok branch",
    b.indexOf("if (result.ok)") > 0
      && b.indexOf("if (result.ok)") < b.indexOf("regenerateSnapshotsForAccounts(")
      && b.indexOf("if (result.ok)") < b.indexOf("regenerateWealthHistoryForAccounts("));
}
check("the dispatcher surfaces the adapter's own stage/reason rather than inventing one",
  /stage:\s*result\.stage/.test(dispatch) && /reason:\s*result\.reason/.test(dispatch));

// Both adapters' config refusals are reachable through the registry — the path a
// deployment with no ETH/SOL endpoint actually takes.
for (const f of ["eth-sync", "sol-sync"]) {
  const adapter = code(read("lib", "crypto", `${f}.ts`));
  check(`${f} still refuses on missing provider config (stage=config)`,
    /stage: "config"/.test(adapter) && /is configured on this deployment/.test(adapter));
  check(`${f} still writes no balance column`, !/nativeBalance/.test(adapter));
}

console.log(`\nwallet-sync-dispatch: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
