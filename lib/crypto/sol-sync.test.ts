/**
 * lib/crypto/sol-sync.test.ts
 *
 * W-M1c — native Solana wallet sync: pure provider tests + source-scan
 * invariants.
 *
 *     npx tsx lib/crypto/sol-sync.test.ts
 *
 * PART A exercises the PURE provider layer (lib/crypto/sol-rpc.ts) with an
 * injected `fetch`. PART B source-scans lib/crypto/sol-sync.ts, which pulls
 * @/lib/db and cannot import under bare tsx.
 *
 * The tests that matter most are the u64 ones. Solana returns lamports as a bare
 * JSON number, so `JSON.parse` rounds a large balance before any parser of ours
 * can object — a failure mode Ethereum does not have, because wei arrives as a
 * hex string.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  LAMPORTS_PER_SOL, SOLANA_ADDRESS_BYTES,
  lamportsToSol, parseSolLamports, extractLamportLiteral,
  base58DecodedLength, isSolAddressShape, normalizeSolAddress,
  fetchSolLamports, SolRpcError,
} from "./sol-rpc";
import { SOL_NATIVE, BTC_NATIVE, ledgerEpsilonFor } from "./native-asset";
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
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

/** A response whose BODY TEXT is what the parser must see (not a re-serialised object). */
const textResponse = (body: string, ok = true, status = 200) =>
  ({ ok, status, text: async () => body }) as unknown as Response;
const stubFetch = (resp: Response, capture?: { init?: RequestInit }) =>
  (async (_url: string, init: RequestInit) => { if (capture) capture.init = init; return resp; }) as unknown as typeof fetch;

const RPC = "https://rpc.example/sol";
/** A real, well-formed mainnet address (the SOL mint's canonical form). */
const ADDR = "So11111111111111111111111111111111111111112";
const balanceBody = (lamports: string) =>
  `{"jsonrpc":"2.0","result":{"context":{"apiVersion":"2.0.0","slot":300000000},"value":${lamports}},"id":1}`;

async function main(): Promise<void> {
  // ── PART A1 — EXACT BASE-UNIT NORMALIZATION ────────────────────────────────

  check("LAMPORTS_PER_SOL is 10^9", LAMPORTS_PER_SOL === BigInt(1000000000));

  check("zero lamports is exactly zero SOL", lamportsToSol(BigInt(0)) === 0);
  check("one lamport is 1e-9 SOL", lamportsToSol(BigInt(1)) === 1e-9);
  check("exactly 1 SOL", lamportsToSol(LAMPORTS_PER_SOL) === 1);
  check("exactly 2.5 SOL", lamportsToSol(BigInt(2500000000)) === 2.5);
  // The rent-exempt minimum for a bare account — the balance a "empty" Solana
  // wallet actually carries, and a number the adapter must render exactly.
  check("the rent-exempt minimum normalises exactly",
    lamportsToSol(BigInt(890880)) === 0.00089088);

  // THE u64 RANGE. Lamports cross Number.MAX_SAFE_INTEGER at ~9,007,199 SOL,
  // which large holders exceed. Held as BigInt and split before conversion, the
  // whole-SOL side stays exact far beyond that.
  for (const sol of [BigInt(10), BigInt(9007199), BigInt(9007200), BigInt(100000000), BigInt(600000000)]) {
    check(`${sol} SOL normalises to the exact integer`,
      lamportsToSol(sol * LAMPORTS_PER_SOL) === Number(sol));
  }
  {
    // A balance whose lamport count is beyond float64's exact integer range.
    const lamports = BigInt("18446744073709551615"); // u64 max
    const naive = Number(lamports) / Number(LAMPORTS_PER_SOL);
    const exact = lamportsToSol(lamports);
    check("u64 max keeps its whole-SOL part exact",
      Math.trunc(exact) === 18446744073, `got ${Math.trunc(exact)}`);
    check("…and the split conversion is at least as accurate as the naive one",
      Math.abs(exact - 18446744073.709551615) <= Math.abs(naive - 18446744073.709551615));
  }

  // ── PART A2 — THE PARSE THAT JSON.parse WOULD HAVE RUINED ──────────────────

  {
    // 12,345,678.999999999 SOL. JSON.parse rounds this literal; the extractor
    // must not. This is the single most important assertion in the file.
    const literal = "12345678999999999";
    const body = balanceBody(literal);
    const viaJsonParse = (JSON.parse(body) as { result: { value: number } }).result.value;
    check("JSON.parse DOES lose the literal (the hazard is real, not theoretical)",
      String(viaJsonParse) !== literal, `JSON.parse gave ${viaJsonParse}`);
    check("the raw-text extractor recovers the EXACT digits",
      extractLamportLiteral(body) === literal);
    check("…and parseSolLamports returns them exactly",
      parseSolLamports(body) === BigInt(literal));
    check("…which JSON.parse could not have done",
      BigInt(viaJsonParse) !== BigInt(literal));
  }

  check("a small balance parses identically either way",
    parseSolLamports(balanceBody("2500000000")) === BigInt(2500000000));
  check("a zero balance parses as zero", parseSolLamports(balanceBody("0")) === BigInt(0));

  // The extractor is anchored after "result" so a `value` elsewhere cannot be
  // mistaken for the balance.
  check("the extractor is anchored to result, not to any 'value' key",
    extractLamportLiteral('{"value":999,"result":{"context":{"slot":1},"value":42}}') === "42");
  check("an absent result yields no literal",
    extractLamportLiteral('{"jsonrpc":"2.0","id":1}') === null);

  // A JSON-RPC error member is a PROVIDER refusal, never an empty wallet.
  {
    const err = await throwsAsync(async () =>
      parseSolLamports('{"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid param"},"id":1}'));
    check("a JSON-RPC error is a refusal, not a zero balance",
      err instanceof SolRpcError && /Invalid param/.test((err as Error).message));
  }
  for (const bad of ['', 'not json', '{"jsonrpc":"2.0","id":1}', '{"result":null}', '{"result":{"value":"12"}}', '{"result":{"value":-5}}']) {
    const err = await throwsAsync(async () => parseSolLamports(bad));
    check(`a malformed body THROWS rather than becoming zero (${bad.slice(0, 28)})`,
      err instanceof SolRpcError);
  }
  // The fallback refuses rather than recording a rounded quantity.
  {
    const err = await throwsAsync(async () =>
      parseSolLamports('{"result":{"context":{"slot":1},"value":1.8446744073709552e19}}'));
    check("an unreadable literal beyond exact range REFUSES, never rounds",
      err instanceof SolRpcError && /rounded quantity/.test((err as Error).message));
  }

  // ── PART A3 — ADDRESS VALIDATION IS A DECODE, NOT A LENGTH CHECK ───────────

  check("a real mainnet address is 32 bytes", base58DecodedLength(ADDR) === SOLANA_ADDRESS_BYTES);
  check("…and validates", isSolAddressShape(ADDR));
  check("another real address validates",
    isSolAddressShape("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpLVCrkeFn5Rby"));
  check("leading '1' characters are decoded as leading ZERO BYTES",
    base58DecodedLength("1" + "1".repeat(31)) === 32);
  check("addresses are case-SIGNIFICANT (base58), so normalising only trims",
    normalizeSolAddress("  " + ADDR + "  ") === ADDR);

  for (const bad of [
    "",                                              // empty
    "0",                                             // '0' is not in the alphabet
    "IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII",              // 'I' is not in the alphabet
    "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO",              // 'O' is not in the alphabet
    "llllllllllllllllllllllllllllllll",              // 'l' is not in the alphabet
    "So1111111111111111111111111111111111111111211", // 45 chars — too long
    "0x742d35cc6634c0532925a3b844bc454e4438f44e",    // an ETHEREUM address
    "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",    // a BITCOIN address
  ]) {
    check(`rejects a malformed address (${bad.slice(0, 24) || "<empty>"})`, !isSolAddressShape(bad));
  }
  {
    // THE CASE A LENGTH-AND-CHARSET CHECK WOULD WRONGLY ACCEPT: valid base58, in
    // the right character range, decoding to the WRONG number of bytes.
    const wrongSize = "z".repeat(44);
    check("valid base58 that decodes to the wrong byte count is REJECTED",
      base58DecodedLength(wrongSize) !== SOLANA_ADDRESS_BYTES && !isSolAddressShape(wrongSize),
      `decoded to ${base58DecodedLength(wrongSize)} bytes`);
  }

  // ── PART A4 — fetch path, fully offline ────────────────────────────────────

  {
    const cap: { init?: RequestInit } = {};
    const lamports = await fetchSolLamports(ADDR, {
      rpcUrl: RPC, fetchImpl: stubFetch(textResponse(balanceBody("12345678999999999")), cap),
    });
    check("fetch returns the wire lamports exactly", lamports === BigInt("12345678999999999"));

    const body = JSON.parse(String(cap.init?.body)) as { method: string; params: [string, { commitment: string }] };
    check("the request asks getBalance for the owner address", body.method === "getBalance" && body.params[0] === ADDR);
    // FINALIZED — a balance that can still be rolled back is not a balance.
    check("the request pins commitment=finalized (never confirmed/processed)",
      body.params[1].commitment === "finalized");
  }

  // THE DARK PATH.
  {
    const err = await throwsAsync(async () => fetchSolLamports(ADDR, { rpcUrl: null }));
    check("an unconfigured provider REFUSES (stage=config), never returns 0",
      err instanceof SolRpcError && (err as SolRpcError).stage === "config");
  }
  {
    const err = await throwsAsync(async () =>
      fetchSolLamports("nonsense", { rpcUrl: RPC, fetchImpl: stubFetch(textResponse(balanceBody("0"))) }));
    check("a malformed address REFUSES before any network call (stage=address)",
      err instanceof SolRpcError && (err as SolRpcError).stage === "address");
  }
  {
    const err = await throwsAsync(async () =>
      fetchSolLamports(ADDR, { rpcUrl: RPC, fetchImpl: stubFetch(textResponse("", false, 429)) }));
    check("a non-2xx response REFUSES (stage=balance)",
      err instanceof SolRpcError && (err as SolRpcError).stage === "balance");
  }
  {
    const boom = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const err = await throwsAsync(async () => fetchSolLamports(ADDR, { rpcUrl: RPC, fetchImpl: boom }));
    check("a transport failure REFUSES, never returns 0",
      err instanceof SolRpcError && /ECONNREFUSED/.test((err as Error).message));
  }
  {
    const lamports = await fetchSolLamports(ADDR, { rpcUrl: RPC, fetchImpl: stubFetch(textResponse(balanceBody("0"))) });
    check("an EMPTY wallet returns exactly zero — and only a successful read can", lamports === BigInt(0));
  }

  // ── PART A5 — ledger state ─────────────────────────────────────────────────

  {
    const na = ledgerNotApplicable(2.5);
    check("a balance-only chain reports NOT_APPLICABLE, never a reconciliation",
      na.refusal === "NOT_APPLICABLE" && na.complete === false);
    check("…and is DISTINCT from a Bitcoin wallet whose ledger is empty",
      reconcileWalletLedger({ observedBalance: 2.5, movements: [] }).refusal === "NO_MOVEMENTS");
  }
  check("the SOL ledger tolerance is one lamport, not one satoshi",
    ledgerEpsilonFor(SOL_NATIVE) === 1e-9 && ledgerEpsilonFor(SOL_NATIVE) !== ledgerEpsilonFor(BTC_NATIVE));

  // ── PART B — source-scan invariants ────────────────────────────────────────

  const rpc = code(read("lib", "crypto", "sol-rpc.ts"));
  check("the provider layer stays pure (no @/lib/db)", !rpc.includes("@/lib/db"));
  check("the provider layer stays pure (no next/*)", !/from\s+["']next\//.test(rpc));
  check("the RESPONSE TEXT is read, so JSON.parse never sources the quantity",
    /res\.text\(\)/.test(rpc) && !/res\.json\(\)/.test(rpc));
  check("the public rate-limited endpoint is not a silent default",
    !rpc.includes("api.mainnet-beta.solana.com"));
  check("NO SPL token enumeration exists in this slice",
    !/getTokenAccounts|getParsedTokenAccounts|TOKEN_PROGRAM|associated/i.test(rpc));

  const sync = code(read("lib", "crypto", "sol-sync.ts"));
  const syncRaw = read("lib", "crypto", "sol-sync.ts");

  check("sync guards to SOL only", /walletChain !== SOL_CHAIN/.test(sync));
  check("the chain token comes from the descriptor, not a literal",
    /SOL_CHAIN\s*=\s*SOL_NATIVE\.chain/.test(sync) && !/walletChain !== ["']SOL["']/.test(sync));

  check("sync writes through the SHARED canonical capture path",
    sync.includes("captureWalletPosition"));
  check("identity is SOL_ASSET (assetKey), never a ticker or a fresh descriptor",
    /asset:\s*SOL_ASSET/.test(sync) && !/tickerSymbol/.test(sync) && !/assetKey:\s*["']/.test(sync));
  check("no chain-specific PositionObservation shape exists here",
    !/positionObservation/i.test(sync));
  check("sync writes NO InvestmentEvent from a balance", !/investmentEvent/i.test(sync));

  check("sync NEVER writes FinancialAccount.balance",
    !/balance:\s/.test(sync.replace(/lamportBalance:/g, "")));
  check("sync NEVER writes nativeBalance", !/nativeBalance/.test(sync));
  check("the only FinancialAccount update is lifecycle (syncStatus + lastUpdated)",
    /data:\s*\{\s*syncStatus:\s*["']synced["'],\s*lastUpdated:\s*new Date\(\)\s*\}/.test(sync));
  check("the withheld net-worth boundary is reported, not implied",
    /netWorthParticipation/.test(sync) && /WITHHELD_PENDING_CONVERGENCE/.test(sync));
  check("…and documented at the write site",
    /SpaceSnapshot/.test(syncRaw) && /NOT NULL DEFAULT 0/.test(syncRaw));
  // The SOL-specific honesty clause: a SOL balance is not a portfolio.
  check("the SOL-only scope is documented where a reader would over-claim",
    /SPL token balances live/.test(syncRaw) && /not an answer to/i.test(syncRaw));

  check("sync reports ledgerNotApplicable, never a reconciliation",
    sync.includes("ledgerNotApplicable") && !sync.includes("reconcileWalletLedger"));
  check("sync imports NO transactions",
    !/transaction\.(findMany|create|createMany|upsert)/.test(sync));

  {
    const captureAt = sync.indexOf("await captureWalletPosition(");
    const guards = ['stage: "config"', 'stage: "address"', 'lamports < BigInt("0")', "not a syncable SOL wallet"];
    check("every refusal returns BEFORE the capture call",
      captureAt > 0 && guards.every((g) => sync.indexOf(g) > 0 && sync.indexOf(g) < captureAt),
      guards.map((g) => `${g}@${sync.indexOf(g)}`).join(" ") + ` capture@${captureAt}`);
  }
  check("failures record an honest staged SyncIssue",
    sync.includes("WALLET_SYNC_FAILED") && /provider:\s*["']WALLET["']/.test(sync));
  check("sync never flips the account to 'error'", !/syncStatus:\s*["']error["']/.test(sync));
  check("sync never hides, deletes or unshares the account",
    !/deletedAt:\s*new Date/.test(sync) && !/spaceAccountLink/i.test(sync));
  check("an uncaptured position does NOT report synced", /if \(!positionCaptured\)/.test(sync));
  check("no legacy Holding writer or reader is resurrected",
    !/\.holding\./.test(sync) && !/legacy-crypto/.test(sync));

  // THE OTHER TWO CHAINS ARE UNTOUCHED — one spine, three adapters, no coupling.
  const btc = code(read("lib", "crypto", "btc-sync.ts"));
  const eth = code(read("lib", "crypto", "eth-sync.ts"));
  check("btc-sync does not import the SOL adapter", !btc.includes("sol-sync") && !btc.includes("sol-rpc"));
  check("eth-sync does not import the SOL adapter", !eth.includes("sol-sync") && !eth.includes("sol-rpc"));
  check("the SOL adapter imports neither sibling adapter",
    !sync.includes("btc-sync") && !sync.includes("eth-sync") && !sync.includes("eth-rpc"));
  check("BTC still writes its own balance columns (unchanged by this slice)",
    /nativeBalance,\s*balance:\s*balanceUsd/.test(btc));
  // W-M3 — Ethereum's orchestration moved into the shared EVM adapter, so the
  // convergence is now BTC + SOL + the one EVM adapter that serves four chains.
  check("every adapter converges on ONE capture writer",
    btc.includes("captureWalletPosition") && sync.includes("captureWalletPosition")
      && code(read("lib", "crypto", "evm-native.ts")).includes("captureWalletPosition"));
  check("…and Ethereum reaches it through that shared adapter, not a copy",
    eth.includes("syncEvmWallet") && !eth.includes("captureWalletPosition"));

  // W-M1d owns activation.
  const walletRoute = code(read("app", "api", "accounts", "wallet", "route.ts"));
  const syncRoute = code(read("app", "api", "accounts", "[id]", "sync", "route.ts"));
  check("no route dispatches to the SOL adapter yet (W-M1d owns activation)",
    !walletRoute.includes("syncSolWallet") && !syncRoute.includes("syncSolWallet"));

  console.log(`\nsol-sync: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main();
