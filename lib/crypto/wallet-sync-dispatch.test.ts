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
  walletChainSupport, isSyncableChain, chainSupportsHistory, feedsLegacyWealthHistory,
  SYNCABLE_CHAINS, usesLegacyColumnForCurrentValue,
} from "./wallet-sync-dispatch";
import { PRODUCT_CHAIN_VALUES, isProductSupportedChain } from "./product-chains";

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
// ETH-H2 — Ethereum was CURRENT_POSITION_SUPPORTED here for as long as its
// history was unproven. It was promoted on its own real-wallet acceptance:
// COMPLETE coverage from state reads alone, 16 movements reconciling at ZERO WEI,
// 3238 replayed days. The ladder was not weakened to let it through.
check("ETH is HISTORY_SUPPORTED — earned on real-wallet evidence",
  walletChainSupport("ETH") === "HISTORY_SUPPORTED");
// W-M2b — SOL PROMOTED, and only on real-wallet evidence: acquisition over
// standard RPC back to 2022, a ZERO-lamport reconciliation against the observed
// balance, a replayed quantity timeline, and dated valuation that refuses beyond
// the price floor. Having an adapter never earned this; the evidence did.
check("SOL is HISTORY_SUPPORTED — earned on real-wallet evidence",
  walletChainSupport("SOL") === "HISTORY_SUPPORTED");

// A chain is promoted to HISTORY_SUPPORTED only when historical acquisition and
// reconstruction are PROVEN — never because an adapter exists. Pinned, so
// promoting ETH or SOL by accident fails here first.
check("exactly BTC, SOL and ETH claim history support",
  SYNCABLE_CHAINS.filter((c) => chainSupportsHistory(c)).sort().join(",") === "BTC,ETH,SOL");
// BNB and AVAX are now the live proof that the ladder still bites: both have a
// working adapter and a configured provider, and neither is history-supported,
// because neither has had its historical acquisition built or proven. That is
// the same bar ETH cleared rather than an exception made for it.
check("having an adapter is NOT the same as having history (BNB, AVAX)",
  isSyncableChain("BNB") && !chainSupportsHistory("BNB")
    && isSyncableChain("AVAX") && !chainSupportsHistory("AVAX"));

// ── W6c — THE LEGACY HISTORICAL AUTHORITY IS NOW EMPTY ───────────────────────
// The wealth-history regenerator used to compose crypto from FinancialAccount
// .nativeBalance carried backward. Bitcoin was the last chain doing that; it now
// earns a replayed, reconciled timeline with a persisted coverage licence, so no
// chain answers true here any more.
//
// The predicate is kept rather than deleted: it is where a future chain with a
// legacy ingest path and no reconstruction would declare itself. Asserting its
// EMPTINESS is what makes re-populating it a deliberate act.
check("no chain uses the legacy historical authority any more",
  ["BTC", "SOL", "ETH", "BNB", "AVAX", "MATIC"].every((c) => !feedsLegacyWealthHistory(c)));
check("…and W6d closed the current half too — no chain reads it either",
  ["BTC", "SOL", "ETH", "BNB", "AVAX", "MATIC"].every((c) => !usesLegacyColumnForCurrentValue(c)),
  "the adapter may still WRITE the column; what matters is that nothing READS it");
check("…so capability and the regeneration gate are genuinely different questions",
  chainSupportsHistory("SOL") && !feedsLegacyWealthHistory("SOL"));

// UNSUPPORTED CHAINS STAY UNSUPPORTED — including every label the wallet route
// accepts at CREATION time. Recording custody and reading the chain are
// different capabilities, and conflating them is what would turn "we cannot read
// this" into "it holds nothing".
for (const chain of ["MATIC", "DOT", "ADA", "XRP", "OTHER", "DOGE", "LTC"]) {
  check(`${chain} is explicitly UNSUPPORTED by sync`,
    walletChainSupport(chain) === "UNSUPPORTED" && !isSyncableChain(chain) && !chainSupportsHistory(chain));
}
for (const absent of [null, undefined, "", "   ", "bitcoin", "Ethereum "]) {
  check(`an absent or non-canonical chain token is UNSUPPORTED (${JSON.stringify(absent)})`,
    walletChainSupport(absent) === "UNSUPPORTED");
}
check("canonical tokens resolve case-insensitively", walletChainSupport(" eth ") === "HISTORY_SUPPORTED");

check("the syncable set is exactly the five chains that have earned it",
  SYNCABLE_CHAINS.join(",") === "AVAX,BNB,BTC,ETH,SOL", SYNCABLE_CHAINS.join(","));

// ── W-M3 — PROMOTION IS PER CHAIN, AND POLYGON DID NOT GET ONE ──────────────
// BNB and Avalanche earned CURRENT_POSITION on the same evidence ETH has.
// Polygon is configured, reachable and identity-settled — and stays UNSUPPORTED
// because its native asset has no unambiguous price identity. Being offerable,
// reachable and implemented are three things; none of them is capability.
check("BNB and AVAX earned CURRENT_POSITION_SUPPORTED",
  walletChainSupport("BNB") === "CURRENT_POSITION_SUPPORTED"
    && walletChainSupport("AVAX") === "CURRENT_POSITION_SUPPORTED");
// PRODUCT-C1 — Polygon left the picker, and its capability answer is unchanged:
// still UNSUPPORTED, still on the unresolved pricing identity. Withdrawing a
// chain from the product surface must not disturb what it had earned.
check("Polygon remains UNSUPPORTED — an unpriceable asset still earns nothing",
  !isProductSupportedChain("MATIC") && !isSyncableChain("MATIC")
    && walletChainSupport("MATIC") === "UNSUPPORTED");
// ETH-H2 — Ethereum is now the one EVM chain with history, and it earned it the
// same way BTC and SOL did: on its own real-wallet acceptance. Adding an EVM
// adapter still grants nothing, which is exactly what BNB/AVAX/MATIC assert.
check("no EVM chain claims HISTORY without earning it",
  ["BNB", "AVAX", "MATIC"].every((c) => !chainSupportsHistory(c)));
check("…so history is exactly BTC, SOL and ETH",
  SYNCABLE_CHAINS.filter((c) => chainSupportsHistory(c)).sort().join(",") === "BTC,ETH,SOL");
check("no new chain expanded balance-column authority",
  ["BNB", "AVAX"].every((c) => !feedsLegacyWealthHistory(c)));

// ── PART B — the registry wires each chain to ITS OWN adapter ────────────────

const dispatch = code(read("lib", "crypto", "wallet-sync-dispatch.ts"));

check("BTC dispatches to syncBtcWallet", /\[BTC_CHAIN\]:[\s\S]*?syncBtcWallet\(id\)/.test(dispatch));
check("ETH dispatches to syncEthWallet", /\[ETH_CHAIN\]:[\s\S]*?syncEthWallet\(id\)/.test(dispatch));
check("SOL dispatches to syncSolWallet", /\[SOL_CHAIN\]:[\s\S]*?syncSolWallet\(id\)/.test(dispatch));
check("chain keys come from the adapters' descriptors, never literals",
  !/["']BTC["']\s*:/.test(dispatch) && !/["']ETH["']\s*:/.test(dispatch) && !/["']SOL["']\s*:/.test(dispatch));

// The shared EVM adapter is reached once per registered network, each with its
// OWN config — that is what stops one chain being served another's balance.
check("each EVM network binds the shared adapter to its own config",
  /syncEvmWallet\(id, BNB_NETWORK\)/.test(dispatch) && /syncEvmWallet\(id, AVAX_NETWORK\)/.test(dispatch));
check("…and no two registry entries share a config",
  (dispatch.match(/syncEvmWallet\(id, \w+\)/g) ?? []).length
    === new Set(dispatch.match(/syncEvmWallet\(id, \w+\)/g) ?? []).size);

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
  // Bounded to the ADAPTERS literal itself — `feedsLegacyWealthHistory` names the
  // same constant below, and counting occurrences past the closing brace would
  // measure the predicate rather than the registrations.
  const registryStart = dispatch.indexOf("const ADAPTERS");
  const registry = dispatch.slice(registryStart, dispatch.indexOf("\n};", registryStart));
  check("BTC alone is registered as contributing through the legacy balance column",
    (registry.match(/LEGACY_BALANCE_COLUMN/g) ?? []).length === 1
      && registry.indexOf("LEGACY_BALANCE_COLUMN") < registry.indexOf("ETH_CHAIN"));
  check("SOL's promotion did NOT quietly expand balance authority",
    registry.slice(registry.indexOf("SOL_CHAIN")).includes("WITHHELD_PENDING_CONVERGENCE"));
  check("every non-BTC registered chain is WITHHELD_PENDING_CONVERGENCE",
    (registry.match(/WITHHELD_PENDING_CONVERGENCE/g) ?? []).length === 4);
}
// PLATFORM OPS OBSERVABILITY — every wallet sync is an execution in the ONE
// refresh ledger, recorded through the canonical envelope (never a second
// ledger, never a direct row write), with the adapter's own stage name and the
// generic code contributing the verdict.
check("the dispatcher records each sync through the canonical execution envelope",
  /runFullRefresh<WalletSyncOutcome>\(/.test(dispatch) && /source: \{ kind: "WALLET", ref: accountId, network: key \}/.test(dispatch)
    && /profile: "WALLET_SYNC"/.test(dispatch));
check("…the adapter run is the PROVIDER stage and the history refresh the DERIVED stage",
  /recorder\.begin\("WALLET_SYNC", "PROVIDER"\)/.test(dispatch) && /recorder\.begin\("HISTORY_BACKFILL", "DERIVED"\)/.test(dispatch));
check("…the verdict carries the adapter's stage and the classified category, on failure only",
  /failureStage: result\.stage/.test(dispatch) && /classifyFailureCategory\(\{ code: result\.errorCode, message: result\.reason \}\)/.test(dispatch));
check("…the trigger comes from the caller or the ambient JobRun, never guessed from a chain",
  /walletRefreshTrigger\(context\.trigger\)/.test(dispatch) && /currentJobRun\(\)/.test(dispatch));
check("…and it never writes the ledger directly",
  !/refreshExecution\./.test(dispatch) && !/refreshEndpointResult\./.test(dispatch));
check("the dispatcher writes nothing itself (no DB access at all)",
  !/@\/lib\/db/.test(dispatch) && !/financialAccount\./.test(dispatch)
    && !/positionObservation/i.test(dispatch));

// ── PART B2 — the MANUAL SYNC route ─────────────────────────────────────────

const syncRoute = code(read("app", "api", "accounts", "[id]", "sync", "route.ts"));

check("the sync route names no chain and no adapter",
  !/syncBtcWallet|syncEthWallet|syncSolWallet/.test(syncRoute)
    && !/BTC_CHAIN|ETH_CHAIN|SOL_CHAIN/.test(syncRoute));
check("…and dispatches through the registry",
  /syncWalletByChain\(id, account\.walletChain(, \{ trigger: "MANUAL" \})?\)/.test(syncRoute));
check("…and records the press as a MANUAL execution",
  /syncWalletByChain\(id, account\.walletChain, \{ trigger: "MANUAL" \}\)/.test(syncRoute));
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
// 2026-09-21 — the scope is `snapshotAccountsForOutcome(result)`: this account
// when revalued, plus every holder of a re-quoted asset (executed in
// lib/prices/current-quote.test.ts / btc-partial-sync.test.ts).
check("snapshot regen runs over the outcome's scope (this account ∪ re-quoted holders)",
  /snapshotAccountsForOutcome\(result\)/.test(syncRoute) && /regenerateSnapshotsForAccounts\(snapshotAccounts\)/.test(syncRoute));
check("the ORCH-1 changedSince stamp still precedes the sync",
  body(syncRoute).indexOf("syncStartedAt = new Date()") < body(syncRoute).indexOf("syncWalletByChain("));

// HISTORY REGEN IS NOW A CHAIN CAPABILITY, and only BTC has it.
// W6f — this pinned `feedsLegacyWealthHistory`, which asked where a chain's
// history was STORED. That answered the capability question only by coincidence,
// and W6c broke the coincidence: the predicate went empty for every chain and
// this call site silently stopped regenerating anything. The assertion pinned
// the defect in place, so it now pins the question the comment always described.
check("wealth-history regen is gated on the CAPABILITY predicate",
  /if \(chainSupportsHistory\(account\.walletChain\)\)/.test(syncRoute));
check("…and not on the emptied storage predicate",
  !/feedsLegacyWealthHistory\(/.test(syncRoute));
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

check("all THREE wealth-history calls are gated on the CAPABILITY predicate",
  (walletRoute.match(/chainSupportsHistory\(chain\)/g) ?? []).length === 3);
check("…and none is left on the emptied storage predicate",
  !/feedsLegacyWealthHistory\(/.test(walletRoute));
check("no wealth-history call is left keyed on the BTC literal",
  !/BTC_CHAIN\) await regenWalletWealthHistory/.test(walletRoute));

// BTC-SPECIFIC INPUT HANDLING STAYS BTC-SPECIFIC. An xpub is a Bitcoin
// descriptor concept; normalising an Ethereum address as one would be nonsense.
check("xpub normalisation remains guarded to BTC",
  /chain === BTC_CHAIN \? normalizeExtendedKeyInput/.test(walletRoute)
    && /chain === BTC_CHAIN && isExtendedKey/.test(walletRoute));

// ── W-M2c — THREE CONCEPTS, THREE ANSWERS ───────────────────────────────────
// The product surface still offers MORE chains than this system can sync, which
// is the point: recording that you hold a wallet is useful before the balance
// can be read. What changed is that "which chains may be added" is now ONE
// definition shared by the picker and the route, instead of two lists that had
// already drifted (BNB was offered by the menu and refused by the endpoint).
check("the create route validates against the ONE product-surface authority",
  /isProductSupportedChain\(chain\)/.test(walletRoute) && !/SUPPORTED_CHAINS = \[/.test(walletRoute));
// PRODUCT-C1 — THE RELATIONSHIP INVERTED, AND THAT IS THE POINT.
//
// The surface used to exceed capability: Polygon was offerable and unreadable,
// so recording custody was possible where reading the chain was not. It is now a
// strict SUBSET — BNB and Avalanche are fully syncable and deliberately not
// offered — which is the other legitimate direction. Both are product decisions;
// neither is a capability claim, and the two questions stay independent.
check("every OFFERED chain is syncable — nothing offered is unreadable",
  PRODUCT_CHAIN_VALUES.every((c) => isSyncableChain(c)),
  PRODUCT_CHAIN_VALUES.filter((c) => !isSyncableChain(c)).join(","));
check("…and capability EXCEEDS the surface — a withdrawn chain keeps what it earned",
  SYNCABLE_CHAINS.some((c) => !PRODUCT_CHAIN_VALUES.includes(c)),
  SYNCABLE_CHAINS.filter((c) => !PRODUCT_CHAIN_VALUES.includes(c)).join(","));

// The narrowed surface, pinned so a removed chain cannot drift back.
check("the picker offers EXACTLY the three product chains",
  PRODUCT_CHAIN_VALUES.join(",") === "BTC,ETH,SOL", PRODUCT_CHAIN_VALUES.join(","));
for (const gone of ["ADA", "XRP", "OTHER", "DOT", "BNB", "MATIC", "AVAX"]) {
  check(`${gone} is NOT offerable`, !isProductSupportedChain(gone));
}
check("…and the API refuses them too — hiding a menu option is not a restriction",
  ["ADA", "XRP", "OTHER", "DOT", "ada", " xrp "].every((c) => !isProductSupportedChain(c)));
check("product tokens resolve case-insensitively, as the route normalises them",
  isProductSupportedChain(" btc ") && isProductSupportedChain("sol"));
// Hiding is not deleting: the canonical machinery for a removed chain survives.
check("removing a chain from the surface did NOT delete its canonical type",
  /'ADA'/.test(read("types", "index.ts")) && /'XRP'/.test(read("types", "index.ts")));
check("the picker renders the authority rather than a copy of it",
  /const CHAINS = PRODUCT_CHAINS/.test(code(read("components", "dashboard", "AddWalletModal.tsx"))));

// PRODUCT support earns NOTHING. BNB/MATIC/AVAX are offerable and unreadable.
// PRODUCT-C1 — and the converse: being WITHDRAWN does not revoke capability.
// BNB and Avalanche keep CURRENT_POSITION_SUPPORTED with their adapters, network
// definitions, asset identities and provider support entirely intact; only the
// menu changed, so re-offering one is a single line in product-chains.ts.
check("a withdrawn chain keeps its earned capability",
  !isProductSupportedChain("BNB") && isSyncableChain("BNB")
    && walletChainSupport("BNB") === "CURRENT_POSITION_SUPPORTED"
    && !isProductSupportedChain("AVAX") && isSyncableChain("AVAX")
    && walletChainSupport("AVAX") === "CURRENT_POSITION_SUPPORTED");
check("…and still claims no history it did not earn",
  ["BNB", "MATIC", "AVAX"].every((c) => !chainSupportsHistory(c)));

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
  // 2026-09-21 — the gate is `outcomeRevalued(result)`, strictly narrower than
  // `result.ok` (false whenever ok is false; also false for an unpriced BTC run),
  // executed in btc-partial-sync.test.ts.
  const gate = "if (outcomeRevalued(result))";
  // Snapshots follow the outcome's scope (empty for a failed sync — a failed
  // sync is neither revalued nor re-quoted); wealth HISTORY stays behind the gate.
  check("wealth history regen runs ONLY inside the revalued (⊂ ok) branch",
    b.indexOf(gate) > 0 && b.indexOf(gate) < b.indexOf("regenerateWealthHistoryForAccounts("));
  check("snapshot regen is bounded by the outcome's scope, not unconditional",
    /if \(snapshotAccounts\.length > 0\)/.test(b));
}
check("the dispatcher surfaces the adapter's own stage/reason rather than inventing one",
  /stage:\s*result\.stage/.test(dispatch) && /reason:\s*result\.reason/.test(dispatch));

// Both adapters' config refusals are reachable through the registry — the path a
// deployment with no ETH/SOL endpoint actually takes.
for (const f of ["evm-native", "sol-sync"]) {
  const adapter = code(read("lib", "crypto", `${f}.ts`));
  check(`${f} still refuses on missing provider config (stage=config)`,
    /stage: "config"/.test(adapter) && /is configured on this deployment/.test(adapter));
  check(`${f} still writes no balance column`, !/nativeBalance:/.test(adapter));
}

console.log(`\nwallet-sync-dispatch: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
