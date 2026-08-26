/**
 * lib/crypto/eth-sync.test.ts
 *
 * W-M1b — native Ethereum wallet sync: pure provider tests + source-scan
 * invariants.
 *
 *     npx tsx lib/crypto/eth-sync.test.ts
 *
 * PART A exercises the PURE provider layer (lib/crypto/eth-rpc.ts) with an
 * injected `fetch`, so parse / validate / normalise is verified fully offline.
 * PART B source-scans lib/crypto/eth-sync.ts, which pulls @/lib/db and cannot
 * import under bare tsx — the same constraint the sibling btc-sync.test.ts
 * documents, for the same reason.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  WEI_PER_ETH, weiToEth, parseHexQuantity, parseEthBalanceWei,
  isEthAddressShape, normalizeEthAddress, fetchEthWeiBalance, EthRpcError,
} from "./eth-rpc";
import { ETH_NATIVE, BTC_NATIVE, ledgerEpsilonFor } from "./native-asset";
import { ledgerNotApplicable, reconcileWalletLedger } from "./ledger-completeness.core";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
async function throwsAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); return null; } catch (e) { return e; }
}
function read(...seg: string[]): string {
  return readFileSync(join(process.cwd(), ...seg), "utf8");
}
/** strip comments so scans match real code, not prose. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const failResponse = (status: number) =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response;
const stubFetch = (resp: Response) => (async () => resp) as unknown as typeof fetch;
const RPC = "https://rpc.example/eth";
const ADDR = "0x742d35cc6634c0532925a3b844bc454e4438f44e";

async function main(): Promise<void> {
  // ── PART A1 — EXACT BASE-UNIT NORMALIZATION ────────────────────────────────
  // Wei is an 18-decimal integer; float64 carries ~15–16 significant digits. The
  // boundaries below are where a Number-first implementation goes wrong, and
  // they are the reason the wire value is parsed and held as BigInt.

  check("WEI_PER_ETH is 10^18", WEI_PER_ETH === BigInt("1000000000000000000"));

  check("zero wei is exactly zero ETH", weiToEth(BigInt("0")) === 0);
  check("one wei is 1e-18 ETH", weiToEth(BigInt("1")) === 1e-18);
  check("exactly 1 ETH", weiToEth(WEI_PER_ETH) === 1);
  check("exactly 1.5 ETH", weiToEth(BigInt("1500000000000000000")) === 1.5);
  check("one gwei is 1e-9 ETH", weiToEth(BigInt("1000000000")) === 1e-9);
  check("a sub-unit balance", Math.abs(weiToEth(BigInt("123456789000000000")) - 0.123456789) < 1e-18);

  // THE PRECISION CASE. 1234567.891234567891234567 ETH exceeds float64's
  // significant digits, so the result is necessarily approximate — but the
  // INTEGER part must be exact, which is what splitting before conversion buys.
  // A naive `Number(wei) / 1e18` loses the integer side too.
  {
    const wei = BigInt("1234567891234567891234567");
    const naive = Number(wei) / Number(WEI_PER_ETH);
    const exact = weiToEth(wei);
    check("a huge balance keeps its INTEGER part exact",
      Math.trunc(exact) === 1234567, `got ${Math.trunc(exact)}`);
    check("…and the split conversion is at least as accurate as the naive one",
      Math.abs(exact - 1234567.8912345679) <= Math.abs(naive - 1234567.8912345679));
  }

  // The classic float64 boundary: 2^53 wei is where Number stops being able to
  // represent consecutive integers. Held as BigInt, this is exact.
  {
    const wei = BigInt("9007199254740993"); // 2^53 + 1
    check("a wei value above 2^53 survives parsing exactly",
      parseHexQuantity("0x" + wei.toString(16)) === wei);
  }

  // Whole-ETH amounts far above 2^53 wei must still land on the exact integer.
  for (const eth of [BigInt("10"), BigInt("1000"), BigInt("21000000")]) {
    check(`${eth} ETH normalises exactly`, weiToEth(eth * WEI_PER_ETH) === Number(eth));
  }

  // ── PART A2 — hex quantity parsing ─────────────────────────────────────────

  check("parses a canonical hex quantity", parseHexQuantity("0x1bc16d674ec80000") === BigInt("2000000000000000000"));
  check("parses zero", parseHexQuantity("0x0") === BigInt("0"));
  check("trims surrounding whitespace", parseHexQuantity("  0xff  ") === BigInt("255"));

  for (const bad of ["", "0x", "ff", "0xzz", "1e18", null, undefined, 42, {}, "0x-1"]) {
    const err = await throwsAsync(async () => parseHexQuantity(bad));
    check(`a malformed quantity THROWS rather than becoming zero (${JSON.stringify(bad)})`,
      err instanceof EthRpcError);
  }

  // A JSON-RPC error member is a PROVIDER refusal, never an empty wallet.
  {
    const err = await throwsAsync(async () => parseEthBalanceWei({ error: { code: -32000, message: "rate limited" } }));
    check("a JSON-RPC error is a refusal, not a zero balance",
      err instanceof EthRpcError && /rate limited/.test((err as Error).message));
  }
  check("a valid envelope yields the quantity",
    parseEthBalanceWei({ jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" }) === WEI_PER_ETH);

  // ── PART A3 — address validation ───────────────────────────────────────────

  check("accepts a lowercase address", isEthAddressShape(ADDR));
  check("accepts a checksummed (mixed-case) address",
    isEthAddressShape("0x742d35Cc6634C0532925a3b844Bc454e4438f44e"));
  check("normalises to lowercase so two spellings compare equal",
    normalizeEthAddress("0x742d35Cc6634C0532925a3b844Bc454e4438f44e") === ADDR);

  for (const bad of [
    "",                                              // empty
    "0x",                                            // prefix only
    "742d35cc6634c0532925a3b844bc454e4438f44e",      // no 0x
    "0x742d35cc6634c0532925a3b844bc454e4438f44",     // 39 nibbles
    "0x742d35cc6634c0532925a3b844bc454e4438f44ee",   // 41 nibbles
    "0x742d35cc6634c0532925a3b844bc454e4438f44g",    // non-hex
    "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",    // a BITCOIN address
    "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpLVCrkeFn5Rby",  // a SOLANA address
  ]) {
    check(`rejects a malformed address (${bad.slice(0, 22)}…)`, !isEthAddressShape(bad));
  }

  // ── PART A4 — fetch path, fully offline ────────────────────────────────────

  {
    const wei = await fetchEthWeiBalance(ADDR, { rpcUrl: RPC, fetchImpl: stubFetch(okResponse({ result: "0xde0b6b3a7640000" })) });
    check("fetch returns the wire wei exactly", wei === WEI_PER_ETH);
  }

  // THE DARK PATH. No configured endpoint is an honest refusal — never a zero.
  {
    const err = await throwsAsync(async () => fetchEthWeiBalance(ADDR, { rpcUrl: null }));
    check("an unconfigured provider REFUSES (stage=config), never returns 0",
      err instanceof EthRpcError && (err as EthRpcError).stage === "config");
  }
  {
    const err = await throwsAsync(async () =>
      fetchEthWeiBalance("nonsense", { rpcUrl: RPC, fetchImpl: stubFetch(okResponse({ result: "0x0" })) }));
    check("a malformed address REFUSES before any network call (stage=address)",
      err instanceof EthRpcError && (err as EthRpcError).stage === "address");
  }
  {
    const err = await throwsAsync(async () =>
      fetchEthWeiBalance(ADDR, { rpcUrl: RPC, fetchImpl: stubFetch(failResponse(503)) }));
    check("a non-2xx response REFUSES (stage=balance)",
      err instanceof EthRpcError && (err as EthRpcError).stage === "balance");
  }
  {
    const boom = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const err = await throwsAsync(async () => fetchEthWeiBalance(ADDR, { rpcUrl: RPC, fetchImpl: boom }));
    check("a transport failure REFUSES, never returns 0",
      err instanceof EthRpcError && /ECONNREFUSED/.test((err as Error).message));
  }
  // A genuinely empty wallet returns zero — the fact a failure must never mimic.
  {
    const wei = await fetchEthWeiBalance(ADDR, { rpcUrl: RPC, fetchImpl: stubFetch(okResponse({ result: "0x0" })) });
    check("an EMPTY wallet returns exactly zero wei — and only a successful read can", wei === BigInt("0"));
  }

  // ── PART A5 — ledger state ─────────────────────────────────────────────────

  {
    const na = ledgerNotApplicable(1.5);
    check("a balance-only chain reports NOT_APPLICABLE, never a reconciliation",
      na.refusal === "NOT_APPLICABLE" && na.complete === false);
    check("…and is DISTINCT from a Bitcoin wallet whose ledger is empty",
      reconcileWalletLedger({ observedBalance: 1.5, movements: [] }).refusal === "NO_MOVEMENTS");
    check("…and says so in words, without claiming reconciliation",
      /no movement ledger/i.test(na.reason) && !/reconcil(ed|es)\b/i.test(na.reason));
    check("NOT_APPLICABLE still withholds history (complete=false gates the carry)",
      na.complete === false);
  }

  check("the ETH ledger tolerance is the asset's, not Bitcoin's",
    ledgerEpsilonFor(ETH_NATIVE) !== ledgerEpsilonFor(BTC_NATIVE));

  // ── PART B — source-scan invariants ────────────────────────────────────────

  const rpc = code(read("lib", "crypto", "eth-rpc.ts"));
  check("the provider layer stays pure (no @/lib/db)", !rpc.includes("@/lib/db"));
  check("the provider layer stays pure (no next/*)", !/from\s+["']next\//.test(rpc));
  check("wei is parsed as BigInt, never through Number first",
    /BigInt\(/.test(rpc) && !/Number\(raw/.test(rpc));

  // W-M3 — the orchestration moved to the GENERIC EVM adapter, so these scans
  // now target it. That is a strengthening rather than a relocation: one scan
  // covers Ethereum, BNB, Polygon and Avalanche, and an invariant can no longer
  // hold on one chain while quietly lapsing on another.
  const sync = code(read("lib", "crypto", "evm-native.ts"));
  const syncRaw = read("lib", "crypto", "evm-native.ts");
  const ethBinding = code(read("lib", "crypto", "eth-sync.ts"));

  // WRONG-CHAIN GUARD, from the shared descriptor rather than a literal.
  // The guard is now per-CONFIG, so one adapter cannot serve the wrong chain.
  check("sync guards to the configured chain only",
    /walletChain !== config\.chain/.test(sync) && !/walletChain !== ["']ETH["']/.test(sync));
  check("Ethereum's chain token comes from the descriptor, not a literal",
    /ETH_CHAIN\s*=\s*ETH_NATIVE\.chain/.test(ethBinding));
  check("…and Ethereum binds the generic adapter to its own network config",
    /syncEvmWallet\(accountId, ETH_NETWORK, deps\)/.test(ethBinding));

  // THE CANONICAL WRITE PATH — the same writer, no chain-specific shape.
  check("sync writes through the SHARED canonical capture path",
    sync.includes("captureWalletPosition"));
  check("identity is the CONFIGURED canonical asset, never a ticker or a fresh descriptor",
    /asset:\s*config\.asset/.test(sync) && !/tickerSymbol/.test(sync) && !/assetKey:\s*["']/.test(sync));
  check("no chain-specific PositionObservation shape exists here",
    !/positionObservation/i.test(sync));
  check("sync writes NO InvestmentEvent from a balance",
    !/investmentEvent/i.test(sync));

  // NET-WORTH BOUNDARY — the invariant this whole slice turns on.
  check("sync NEVER writes FinancialAccount.balance",
    !/balance:\s/.test(sync.replace(/weiBalance:/g, "").replace(/nativeBalance/g, "")));
  check("sync NEVER writes nativeBalance",
    !/nativeBalance/.test(sync));
  check("the only FinancialAccount update is lifecycle (syncStatus + lastUpdated)",
    /data:\s*\{\s*syncStatus:\s*["']synced["'],\s*lastUpdated:\s*new Date\(\)\s*\}/.test(sync));
  check("the withheld net-worth boundary is reported, not implied",
    /netWorthParticipation/.test(sync) && /WITHHELD_PENDING_CONVERGENCE/.test(sync));
  check("…and documented at the write site",
    /stays explicitly withheld/.test(syncRaw)
      && /Writes NO `FinancialAccount\.balance` and NO `nativeBalance`/.test(syncRaw));

  // LEDGER SEMANTICS.
  check("sync reports ledgerNotApplicable, never a reconciliation",
    sync.includes("ledgerNotApplicable") && !sync.includes("reconcileWalletLedger"));
  check("sync imports NO transactions (no ledger is faked to satisfy BTC's lifecycle)",
    !/transaction\.(findMany|create|createMany|upsert)/.test(sync));

  // FAILURE POLICY — a refusal must never become a position or a zero.
  // The CALL, not the import — every refusal must return before any row is
  // written, so an unreachable provider can never leave a position behind.
  {
    const captureAt = sync.indexOf("await captureWalletPosition(");
    const guards = ['stage: "config"', 'stage: "address"', 'wei < BigInt("0")', "not a syncable ${config.chain} wallet"];
    check("every refusal returns BEFORE the capture call",
      captureAt > 0 && guards.every((g) => sync.indexOf(g) > 0 && sync.indexOf(g) < captureAt),
      guards.map((g) => `${g}@${sync.indexOf(g)}`).join(" ") + ` capture@${captureAt}`);
  }
  check("failures record an honest staged SyncIssue",
    sync.includes("WALLET_SYNC_FAILED") && /provider:\s*["']WALLET["']/.test(sync));
  check("sync never flips the account to 'error'", !/syncStatus:\s*["']error["']/.test(sync));
  check("sync never hides, deletes or unshares the account",
    !/deletedAt:\s*new Date/.test(sync) && !/spaceAccountLink/i.test(sync));
  check("an uncaptured position does NOT report synced (no silent nothing)",
    /if \(!positionCaptured\)/.test(sync));

  // W5 / legacy tombstones stay dead.
  check("no legacy Holding writer or reader is resurrected",
    !/\.holding\./.test(sync) && !/legacy-crypto/.test(sync));

  // BTC IS UNTOUCHED — this adapter shares the spine and nothing else.
  const btc = code(read("lib", "crypto", "btc-sync.ts"));
  check("btc-sync does not import any EVM adapter",
    !btc.includes("eth-sync") && !btc.includes("eth-rpc") && !btc.includes("evm-native"));
  check("the EVM adapter does not import the BTC or SOL adapters",
    !sync.includes("btc-sync") && !sync.includes("btc-explorer") && !sync.includes("sol-sync"));

  // ── W-M3 — ONE ADAPTER, FOUR NETWORKS, ZERO COPIES ────────────────────────
  const nets = code(read("lib", "crypto", "evm-networks.ts"));
  check("every EVM network is CONFIG, not a copied adapter",
    ["ETH_NETWORK", "BNB_NETWORK", "POLYGON_NETWORK", "AVAX_NETWORK"].every((n) => nets.includes(n)));
  check("…and there is exactly ONE orchestration for all of them",
    (sync.match(/export async function syncEvmWallet/g) ?? []).length === 1);
  check("chain-specific truth models were NOT introduced — no per-chain branch",
    !/config\.chain === ["']/.test(sync) && !/=== "BNB"|=== "AVAX"|=== "MATIC"/.test(sync));
  check("BTC and SOL were not rewritten for provider uniformity",
    code(read("lib", "crypto", "sol-sync.ts")).includes("captureWalletPosition")
      && btc.includes("fetchConfirmedSatsForAddresses"));

  // Polygon: configured, and deliberately NOT syncable.
  check("Polygon is configured but absent from the sync registry",
    nets.includes("POLYGON_NETWORK")
      && !code(read("lib", "crypto", "wallet-sync-dispatch.ts")).includes("POLYGON_NETWORK"));

  // A provider 403 (a network the vendor has not enabled) is a REFUSAL.
  check("a non-2xx from any EVM network is a refusal, never a zero balance",
    /HTTP \$\{res\.status\} from the \$\{config\.chain\} RPC endpoint/.test(sync));
  check("provider text is redacted before it can reach a log or an incident",
    /redactProviderSecrets/.test(sync));
  check("BTC still writes its own balance columns (unchanged by this slice)",
    /nativeBalance,\s*balance:\s*balanceUsd/.test(btc));

  // W-M1d owns activation. Nothing may dispatch to this adapter yet.
  const walletRoute = code(read("app", "api", "accounts", "wallet", "route.ts"));
  const syncRoute = code(read("app", "api", "accounts", "[id]", "sync", "route.ts"));
  check("routes still name no adapter — dispatch owns activation",
    !walletRoute.includes("syncEthWallet") && !syncRoute.includes("syncEthWallet")
      && !walletRoute.includes("syncEvmWallet") && !syncRoute.includes("syncEvmWallet"));

  console.log(`\neth-sync: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main();
