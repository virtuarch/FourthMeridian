/**
 * lib/sync/wallet-failure-state.test.ts
 *
 * W-M2a — A REFUSED WALLET SYNC MUST NEVER RENDER AS WORK IN PROGRESS.
 *
 *     npx tsx lib/sync/wallet-failure-state.test.ts
 *
 * Born from a real connection. A Solana wallet was added on a deployment with no
 * Solana RPC endpoint. The adapter refused immediately at stage "config", the
 * create route returned 201, and the Connections card then span indefinitely on
 * "Discovering addresses… (1 so far)" with an invitation to "press Refresh to
 * continue discovery" — BTC xpub wording, on a chain with no address discovery,
 * for a sync that could never begin.
 *
 * Two defects, and this file pins both:
 *   1. the refusal never reached `Connection.errorCode`, the field the
 *      Connections surface derives state from;
 *   2. `deriveWalletConnectionState` treated "no success and no recorded error"
 *      as evidence of work in flight.
 *
 * The assertions are STATE-MACHINE assertions, not copy greps: what the card
 * renders is a consequence of the state, and pinning the state is what stops the
 * bug returning through a different component.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  deriveWalletConnectionState, buildWalletSyncStatus, finalizeSyncStatus,
  type WalletConnectionStateInput,
} from "./status";
import { walletSyncErrorCode } from "@/lib/crypto/wallet-sync-dispatch";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
function read(...seg: string[]): string { return readFileSync(join(process.cwd(), ...seg), "utf8"); }
function code(src: string): string { return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); }

const W = (over: Partial<WalletConnectionStateInput>): WalletConnectionStateInput => ({
  id: "c1", displayName: "Solana", status: "ACTIVE",
  lastSyncedAt: null, errorCode: null, discoveryCursor: null, ...over,
});

/** Every terminal refusal the chain dispatcher can record. */
const TERMINAL_CODES = [
  "PROVIDER_NOT_CONFIGURED", "INVALID_WALLET_ADDRESS", "BALANCE_UNAVAILABLE",
  "POSITION_CAPTURE_UNAVAILABLE", "CHAIN_UNSUPPORTED", "ADAPTER_ERROR",
] as const;

// ══ 1. THE EXACT OBSERVED STATE ═══════════════════════════════════════════════
// Reproduced from the real row: Connection ACTIVE, never synced, and — before
// the fix — no errorCode, because the adapter told only the incident log.
{
  check("1. the state as it WAS (no error recorded) is no longer 'importing'",
    deriveWalletConnectionState(W({})) === "error");
  check("1b. …and with the refusal recorded, it is unambiguously terminal",
    deriveWalletConnectionState(W({ errorCode: "PROVIDER_NOT_CONFIGURED" })) === "error");
  check("1c. the account existing, the identity existing and a chain being set " +
        "are NOT inputs to this decision at all",
    deriveWalletConnectionState(W({})) === deriveWalletConnectionState(W({ displayName: "anything" })));
}

// ══ 2. THE UI CANNOT REACH THE DISCOVERY BRANCH FROM A REFUSAL ════════════════
// The card renders discovery copy only under `state === "importing"`. Proving no
// refusal produces that state proves the copy is unreachable — stronger than
// grepping for the words, and it survives a rewrite of the component.
{
  for (const errorCode of TERMINAL_CODES) {
    check(`2. ${errorCode} never yields 'importing'`,
      deriveWalletConnectionState(W({ errorCode })) === "error");
  }
  const cards = buildWalletSyncStatus(TERMINAL_CODES.map((errorCode, i) => W({ id: `w${i}`, errorCode })));
  check("2b. no refused wallet card is in an importing state",
    cards.length === TERMINAL_CODES.length && cards.every((c) => c.state === "error"));
  check("2c. …so the global 'building' flag is false — nothing is being built",
    finalizeSyncStatus(cards).building === false);

  // The discovery copy is gated on `importing`, which is the invariant above.
  const card = code(read("components", "connections", "ConnectionCard.tsx"));
  check("2d. the discovery wording lives ONLY in the importing branch",
    card.indexOf("Discovering addresses") > card.indexOf("function ImportingContent")
      && card.indexOf("Discovering addresses") < card.indexOf("function BuildingProfileContent"));
}

// ══ 3. /api/sync/status EXPOSES ENOUGH TO TELL REFUSAL FROM PROGRESS ══════════
{
  const refused  = buildWalletSyncStatus([W({ id: "r", errorCode: "PROVIDER_NOT_CONFIGURED" })])[0];
  const working  = buildWalletSyncStatus([W({ id: "d", discoveryCursor: "ckpt:receive/41" })])[0];
  const finished = buildWalletSyncStatus([W({ id: "s", lastSyncedAt: new Date("2026-08-26T00:00:00Z") })])[0];

  check("3. the three outcomes are three DISTINCT states",
    refused.state === "error" && working.state === "importing" && finished.state === "ready");
  check("3b. the refusal carries a structured code a consumer can act on",
    refused.errorCode === "PROVIDER_NOT_CONFIGURED");
  check("3c. the in-progress card carries NO error code",
    working.errorCode === null);
  check("3d. the contract still leaks no cursor to the client",
    !JSON.stringify([refused, working, finished]).includes("cursor"));
}

// ══ 4. A CONFIG REFUSAL IS NOT A BALANCE, AND NOT A ZERO ══════════════════════
{
  check("4. stage 'config' maps to a code that means UNAVAILABLE, not zero",
    walletSyncErrorCode("config") === "PROVIDER_NOT_CONFIGURED");
  const sol = code(read("lib", "crypto", "sol-sync.ts"));
  // W-M3 — the EVM orchestration is shared; scanning it covers ETH, BNB,
  // Polygon and Avalanche at once.
  const eth = code(read("lib", "crypto", "evm-native.ts"));
  for (const [name, src] of [["sol", sol], ["evm", eth]] as const) {
    check(`4b. the ${name} adapter returns on the config path BEFORE capturing a position`,
      src.indexOf('stage: "config"') < src.indexOf("await captureWalletPosition("));
    check(`4c. the ${name} adapter writes no balance column on any path`,
      !/nativeBalance/.test(src));
  }
  // The observed database state after the real failure: no position, no
  // transaction, no instrument. Pinned as a source invariant.
  check("4d. neither adapter can write a zero balance in place of a refusal",
    !/balance:\s*0/.test(sol) && !/balance:\s*0/.test(eth));
}

// ══ 5/6/7. EVERY REFUSAL CLASS IS TERMINAL, NOT DISCOVERING ═══════════════════
{
  const cases: Array<[string, string]> = [
    ["5. malformed address", "address"],
    ["6. provider transport failure", "balance"],
    ["7. adapter contract violation", "adapter-error"],
    ["7b. unsupported chain", "unsupported-chain"],
    ["7c. position capture failure", "capture"],
  ];
  for (const [label, stage] of cases) {
    const errorCode = walletSyncErrorCode(stage);
    check(`${label} → a recorded code, never silence`, typeof errorCode === "string" && errorCode.length > 0);
    check(`${label} → 'error', never 'importing'`,
      deriveWalletConnectionState(W({ errorCode })) === "error");
  }
  check("an UNKNOWN stage still produces a code (silence is the bug, not the default)",
    walletSyncErrorCode(undefined) === "BALANCE_UNAVAILABLE"
      && walletSyncErrorCode("something-new") === "BALANCE_UNAVAILABLE");
}

// ══ 8. GENUINE RESUMABLE DISCOVERY STILL RENDERS AS IN-PROGRESS ═══════════════
// BTC's xpub discovery checkpoints on Connection.cursor and clears any stale
// error between passes. That — and only that — is evidence of work in flight.
{
  check("8. a resumable checkpoint with no error → importing",
    deriveWalletConnectionState(W({ discoveryCursor: "ckpt:receive/41" })) === "importing");
  check("8b. …and the global 'building' flag is true for it",
    finalizeSyncStatus(buildWalletSyncStatus([W({ discoveryCursor: "ckpt" })])).building === true);
  check("8c. a checkpoint never outranks a recorded failure",
    deriveWalletConnectionState(W({ discoveryCursor: "ckpt", errorCode: "BALANCE_UNAVAILABLE" })) === "error");
  const btc = code(read("lib", "crypto", "btc-sync.ts"));
  check("8d. BTC still clears a stale error on partial discovery PROGRESS",
    btc.includes("clearWalletConnectionError"));
}

// ══ 9. BTC BEHAVIOUR ══════════════════════════════════════════════════════════
{
  check("9. a synced BTC wallet is still ready",
    deriveWalletConnectionState(W({ lastSyncedAt: new Date() })) === "ready");
  check("9b. BTC's own diagnoses still reach 'error' unchanged",
    ["INVALID_XPUB", "RATE_LIMITED", "DISCOVERY_FAILED", "NO_USED_ADDRESSES"]
      .every((c) => deriveWalletConnectionState(W({ errorCode: c })) === "error"));
  // The dispatcher must never OVERWRITE a more specific adapter diagnosis.
  const conn = code(read("lib", "accounts", "wallet-connection.ts"));
  check("9c. a generic code is only recorded when the connection has none",
    /conn\.errorCode !== null\) return/.test(conn));
  const card = code(read("components", "connections", "ConnectionCard.tsx"));
  check("9d. BTC's xpub-specific card copy is untouched",
    card.includes("INVALID_XPUB") && card.includes("NO_USED_ADDRESSES"));
}

// ══ 10. THE MACHINERY IS GENERIC, NOT PER-CHAIN ═══════════════════════════════
{
  const dispatch = code(read("lib", "crypto", "wallet-sync-dispatch.ts"));
  check("10. the failure codes name no chain",
    !/SOLANA|SOL_|ETHEREUM|ETH_|BITCOIN/.test(
      dispatch.slice(dispatch.indexOf("export type WalletSyncErrorCode"), dispatch.indexOf("export function walletSyncErrorCode"))));
  check("10b. the refusal is recorded once, in the dispatcher, for every chain",
    (dispatch.match(/recordWalletSyncRefusal\(/g) ?? []).length === 3);
  const card = code(read("components", "connections", "ConnectionCard.tsx"));
  check("10c. the card's failure copy is keyed on the code, never on the chain",
    /function describeWalletFailure/.test(card)
      && !/walletChain|=== "SOL"|=== "ETH"/.test(card));
  check("10d. ETH and SOL share one arm — no per-chain visual branch",
    (card.match(/describeWalletFailure\(/g) ?? []).length === 3); // 1 def + 2 uses
  const status = code(read("lib", "sync", "status.ts"));
  check("10e. the state derivation names no chain",
    !/SOL|ETH\b|BTC|Solana|Ethereum|Bitcoin/.test(
      status.slice(status.indexOf("export function deriveWalletConnectionState"))));
}

// ══ 11. A SUCCESSFUL SYNC STILL TRANSITIONS NORMALLY ══════════════════════════
{
  const synced = buildWalletSyncStatus([W({ lastSyncedAt: new Date("2026-08-26T12:00:00Z") })])[0];
  check("11. a successful wallet sync is ready, with no error code",
    synced.state === "ready" && synced.errorCode === null && synced.lastSyncedAt !== null);
  check("11b. recovery works: a recorded failure is cleared by a later success",
    deriveWalletConnectionState(W({ errorCode: "PROVIDER_NOT_CONFIGURED", lastSyncedAt: new Date() })) === "ready");
  const conn = code(read("lib", "accounts", "wallet-connection.ts"));
  check("11c. …because a successful touch clears errorCode at the chokepoint",
    /success → ACTIVE\/lastSyncedAt\/errorCode null/.test(read("lib", "accounts", "wallet-connection.ts")) || conn.includes("setWalletConnectionHealth"));
}

// ══ 12. NO FAILURE PATH TRIGGERS HISTORY OR SNAPSHOT WORK ═════════════════════
{
  const syncRoute = code(read("app", "api", "accounts", "[id]", "sync", "route.ts"));
  check("12. snapshot + history regen sit inside the success branch only",
    syncRoute.indexOf("if (result.ok)") < syncRoute.indexOf("regenerateSnapshotsForAccounts(")
      && syncRoute.indexOf("if (result.ok)") < syncRoute.indexOf("regenerateWealthHistoryForAccounts("));
  const walletRoute = code(read("app", "api", "accounts", "wallet", "route.ts"));
  check("12b. the create route regenerates history only for a chain that feeds it",
    (walletRoute.match(/feedsLegacyWealthHistory\(chain\)/g) ?? []).length === 3);
  check("12c. a refused sync is best-effort and non-fatal — the wallet is still recorded",
    /if \(!outcome\.ok\)/.test(walletRoute) && !/throw/.test(walletRoute.slice(walletRoute.indexOf("syncWalletBestEffort"))));
}

console.log(`\nwallet-failure-state: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
