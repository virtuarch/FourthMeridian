/**
 * lib/crypto/evm-native.test.ts
 *
 * W-M3 — one EVM adapter, four networks, and the semantics that must survive it.
 *
 *     npx tsx lib/crypto/evm-native.test.ts
 *
 * Deterministic and offline. The live provider acceptance (real balances on all
 * four chains, exact wei) is reported separately; what is pinned here is the
 * behaviour that must hold whatever the provider does — above all the four-way
 * distinction between a valued asset, an unpriced one, an unknown one and a
 * confirmed zero, and the rule that a current observation licenses no history.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { ETH_NETWORK, BNB_NETWORK, POLYGON_NETWORK, AVAX_NETWORK, evmNetworkFor, EVM_NETWORKS } from "./evm-networks";
import { fetchEvmNativeWei } from "./evm-native";
import { EthRpcError, weiToEth } from "./eth-rpc";
import { ETH_NATIVE, BNB_NATIVE, POL_NATIVE, AVAX_NATIVE } from "./native-asset";
import { coinIdForSymbol } from "@/lib/prices/providers/coingecko";
import { valueCryptoDay } from "./historical-crypto-valuation.core";
import { resolvePositionAsOf } from "@/lib/investments/reconstruction-read";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const ADDR = "0x742d35cc6634c0532925a3b844bc454e4438f44e";
const RPC  = "https://rpc.example/evm";
const resp = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;
const stub = (r: Response, seen?: { init?: RequestInit }) =>
  (async (_u: string, init: RequestInit) => { if (seen) seen.init = init; return r; }) as unknown as typeof fetch;
const W = BigInt("1000000000000000000");

async function throwsAsync(fn: () => Promise<unknown>) {
  try { await fn(); return null; } catch (e) { return e; }
}

async function main(): Promise<void> {
  // ══ CONFIGURATION, NOT COPIES ═════════════════════════════════════════════
  {
    const nets = [ETH_NETWORK, BNB_NETWORK, POLYGON_NETWORK, AVAX_NETWORK];
    check("all four EVM networks are configured", Object.keys(EVM_NETWORKS).length === 4);
    check("each names a DISTINCT chain, asset and provider network",
      new Set(nets.map((n) => n.chain)).size === 4
        && new Set(nets.map((n) => n.asset.assetKey)).size === 4
        && new Set(nets.map((n) => n.network)).size === 4);
    check("every EVM native asset is 18 decimals", nets.every((n) => n.asset.decimals === 18));
    check("lookup is by chain token, case-insensitively",
      evmNetworkFor("bnb") === BNB_NETWORK && evmNetworkFor("AVAX") === AVAX_NETWORK);
    check("a non-EVM chain resolves to nothing",
      evmNetworkFor("BTC") === null && evmNetworkFor("SOL") === null && evmNetworkFor(null) === null);

    const adapter = code(read("lib", "crypto", "evm-native.ts"));
    check("the adapter carries NO per-chain branch",
      !/config\.chain === ["']/.test(adapter) && !/=== "BNB"|=== "AVAX"|=== "MATIC"|=== "ETH"/.test(adapter));
    check("…and exactly one orchestration serves them all",
      (adapter.match(/export async function syncEvmWallet/g) ?? []).length === 1);
  }

  // ══ POLYGON — CHAIN, ASSET AND TICKER ARE THREE AUTHORITIES ═══════════════
  {
    check("the chain identity survives the ticker rename",
      POL_NATIVE.assetKey.startsWith("eip155:137/") && POLYGON_NETWORK.chain === "MATIC");
    check("the display symbol is the CURRENT ticker",
      POL_NATIVE.symbol === "POL" && POL_NATIVE.name === "Polygon");
    check("the product chain code is a CHAIN identifier, not an asset symbol",
      POLYGON_NETWORK.chain !== POL_NATIVE.symbol);
    // A 1:1 rename of the same coin on the same chain is not a new economic
    // asset — so the key keeps its slot rather than migrating.
    check("the asset key was NOT migrated to chase the ticker",
      POL_NATIVE.assetKey === "eip155:137/slip44:966");
    check("Polygon has NO price identity, so it is not syncable",
      coinIdForSymbol("POL") === null && coinIdForSymbol("MATIC") === null);
    check("…and the reason is documented where the decision would be made",
      /polygon-ecosystem-token/.test(read("lib", "prices", "providers", "coingecko.ts"))
        && /matic-network/.test(read("lib", "prices", "providers", "coingecko.ts")));
  }

  // ══ PRICE IDENTITY FOR THE CHAINS THAT EARNED IT ══════════════════════════
  {
    check("ETH → ethereum",     coinIdForSymbol(ETH_NATIVE.symbol)  === "ethereum");
    check("BNB → binancecoin",  coinIdForSymbol(BNB_NATIVE.symbol)  === "binancecoin");
    check("AVAX → avalanche-2", coinIdForSymbol(AVAX_NATIVE.symbol) === "avalanche-2");
    const cg = code(read("lib", "prices", "providers", "coingecko.ts"));
    check("no adapter hardcodes a price", !/price\s*[:=]\s*\d/.test(code(read("lib", "crypto", "evm-native.ts"))));
    check("the mapping table remains the single configuration point",
      /COINGECKO_COIN_IDS/.test(cg));
  }

  // ══ ACQUISITION: EXACT BASE UNITS ═════════════════════════════════════════
  {
    const seen: { init?: RequestInit } = {};
    const wei = await fetchEvmNativeWei(ADDR, BNB_NETWORK, {
      rpcUrl: RPC, fetchImpl: stub(resp({ result: "0xde0b6b3a7640000" }), seen) });
    check("returns the wire wei exactly", wei === W);
    const body = JSON.parse(String(seen.init?.body)) as { method: string; params: [string, string] };
    check("asks eth_getBalance at the configured block tag",
      body.method === "eth_getBalance" && body.params[1] === BNB_NETWORK.blockTag);
    check("…and normalises the address", body.params[0] === ADDR);

    check("1 wei is 1e-18", weiToEth(BigInt(1)) === 1e-18);
    check("a value above 2^53 wei survives exactly",
      (await fetchEvmNativeWei(ADDR, ETH_NETWORK, { rpcUrl: RPC,
        fetchImpl: stub(resp({ result: "0x" + BigInt("9007199254740993").toString(16) })) })) === BigInt("9007199254740993"));
    check("whole units far above 2^53 wei stay exact",
      weiToEth(BigInt(21000000) * W) === 21000000);
  }

  // ══ CONFIRMED ZERO IS A REAL OBSERVATION ══════════════════════════════════
  {
    const wei = await fetchEvmNativeWei(ADDR, AVAX_NETWORK, { rpcUrl: RPC, fetchImpl: stub(resp({ result: "0x0" })) });
    check("a provider-returned zero is zero — a fact, not an absence", wei === BigInt("0"));
    // And it is reachable ONLY through a successful read.
    check("…and only a successful read can produce it",
      (await throwsAsync(() => fetchEvmNativeWei(ADDR, AVAX_NETWORK, { rpcUrl: null }))) instanceof EthRpcError);
  }

  // ══ UNKNOWN IS NEVER ZERO ═════════════════════════════════════════════════
  {
    const cases: Array<[string, () => Promise<unknown>, string]> = [
      ["no endpoint configured", () => fetchEvmNativeWei(ADDR, ETH_NETWORK, { rpcUrl: null }), "config"],
      ["malformed address",      () => fetchEvmNativeWei("nope", ETH_NETWORK, { rpcUrl: RPC, fetchImpl: stub(resp({ result: "0x0" })) }), "address"],
      // 403 is what a network the vendor has not enabled actually answers.
      ["HTTP 403 (network disabled)", () => fetchEvmNativeWei(ADDR, ETH_NETWORK, { rpcUrl: RPC, fetchImpl: stub(resp({}, false, 403)) }), "balance"],
      ["HTTP 429 (throttled)",   () => fetchEvmNativeWei(ADDR, ETH_NETWORK, { rpcUrl: RPC, fetchImpl: stub(resp({}, false, 429)) }), "balance"],
      ["JSON-RPC error member",  () => fetchEvmNativeWei(ADDR, ETH_NETWORK, { rpcUrl: RPC, fetchImpl: stub(resp({ error: { code: -32000, message: "x" } })) }), "balance"],
      ["unparseable quantity",   () => fetchEvmNativeWei(ADDR, ETH_NETWORK, { rpcUrl: RPC, fetchImpl: stub(resp({ result: "not-hex" })) }), "balance"],
    ];
    for (const [label, fn, stage] of cases) {
      const err = await throwsAsync(fn);
      check(`${label} REFUSES (stage=${stage}) and never returns 0`,
        err instanceof EthRpcError && (err as EthRpcError).stage === stage,
        err instanceof EthRpcError ? (err as EthRpcError).stage : String(err));
    }
    const adapter = code(read("lib", "crypto", "evm-native.ts"));
    check("every refusal returns BEFORE the capture call",
      ['stage: "config"', 'stage: "address"', 'wei < BigInt("0")'].every(
        (g) => adapter.indexOf(g) > 0 && adapter.indexOf(g) < adapter.indexOf("await captureWalletPosition(")));
  }

  // ══ THE FOUR STATES A CONSUMER MUST TELL APART ════════════════════════════
  //
  // valued · NO_PRICE · unknown (no observation) · confirmed zero.
  // Conflating any two of these is how a wallet silently reports the wrong
  // thing, so each is asserted to produce a DIFFERENT consumer answer.
  {
    const K = { btc: "bip122:x/slip44:0", avax: AVAX_NATIVE.assetKey };
    const acct = (id: string, qty: number | null, key: string, sym: string) =>
      ({ financialAccountId: id, name: id, nativeBalance: qty, assetKey: key, symbol: sym });

    const valued = valueCryptoDay({
      accounts: [acct("btc", 0.25, K.btc, "BTC")],
      unitPriceByAssetKey: { [K.btc]: 60000 }, quantityLicensed: true });
    check("VALUED: a priced material position produces a value",
      valued.licensed && valued.nativeTotal === 15000);

    const zero = valueCryptoDay({
      accounts: [acct("btc", 0.25, K.btc, "BTC"), acct("avax", 0, K.avax, "AVAX")],
      unitPriceByAssetKey: { [K.btc]: 60000 }, quantityLicensed: true });
    check("CONFIRMED ZERO: an observed zero is not a position and blacks out nothing",
      zero.licensed && zero.nativeTotal === 15000 && zero.positionCount === 1);

    // W6 — an unknown quantity splits in two, and which one applies is decided by
    // whether the account was inside its existence interval on the day.
    //
    // NOT APPLICABLE: the wallet was not here yet. It is not part of the
    // question, so it neither contributes nor blacks out BTC.
    const notYet = valueCryptoDay({
      accounts: [acct("btc", 0.25, K.btc, "BTC"), { ...acct("avax", null, K.avax, "AVAX"), applicable: false }],
      unitPriceByAssetKey: { [K.btc]: 60000 }, quantityLicensed: true });
    check("NOT_APPLICABLE: a wallet outside its existence interval does not black out BTC",
      notYet.licensed && notYet.nativeTotal === 15000 && notYet.positionCount === 1);

    // UNKNOWN: the wallet WAS here and what it held is unrecoverable. Reporting
    // BTC's total as the day's crypto would be a complete-looking number with a
    // material constituent silently missing — the W6 defect.
    const unknown = valueCryptoDay({
      accounts: [acct("btc", 0.25, K.btc, "BTC"), acct("avax", null, K.avax, "AVAX")],
      unitPriceByAssetKey: { [K.btc]: 60000 }, quantityLicensed: true });
    check("UNKNOWN: an unknown quantity inside the interval REFUSES the day",
      !unknown.licensed && unknown.refusal === "QUANTITY_UNKNOWN");
    check("…naming the account whose history is missing, and counting it as existing",
      unknown.unknownQuantityAccountIds.join(",") === "avax" && unknown.positionCount === 2);
    check("…and publishing no number at all — never BTC alone passed off as the total",
      unknown.nativeTotal === 0 && unknown.positions.length === 0);

    // The one case that MUST refuse: a MATERIAL asset nobody can price. Reporting
    // BTC alone would claim a complete crypto total while silently omitting a
    // holding we know exists — the dishonesty the all-or-nothing rule prevents.
    const unpriced = valueCryptoDay({
      accounts: [acct("btc", 0.25, K.btc, "BTC"), acct("avax", 5, K.avax, "AVAX")],
      unitPriceByAssetKey: { [K.btc]: 60000, [K.avax]: null }, quantityLicensed: true });
    check("NO_PRICE on a MATERIAL asset refuses the day rather than under-reporting",
      !unpriced.licensed && unpriced.refusal === "NO_PRICE");
    check("…naming the unpriceable asset by identity",
      unpriced.unpricedAssetKeys.join(",") === K.avax);
    check("…and reporting BOTH positions as having existed", unpriced.positionCount === 2);
    check("…and producing NO number at all — never BTC-only, never zero",
      unpriced.nativeTotal === 0 && unpriced.positions.length === 0);
    // This is exactly why an unpriceable chain is not registered for sync.
    check("the registry keeps unpriceable chains out, so the refusal stays hypothetical",
      !code(read("lib", "crypto", "wallet-sync-dispatch.ts")).includes("POLYGON_NETWORK"));
  }

  // ══ A CURRENT OBSERVATION LICENSES NO HISTORY ═════════════════════════════
  //
  // The c160500 bridge lets a spine position feed historical wealth. That must
  // never let TODAY's EVM balance appear on a date before it was observed.
  {
    const today = [{ date: "2026-08-26", quantity: 12.5, origin: "OBSERVED" as const, completeness: null }];
    check("a date BEFORE the only observation resolves to NOTHING, not the quantity",
      resolvePositionAsOf(today, "2026-02-27").quantity === null);
    check("…and not to zero either — it is unknown, and says so",
      resolvePositionAsOf(today, "2026-02-27").origin === null);
    check("the observation stands on its OWN date",
      resolvePositionAsOf(today, "2026-08-26").quantity === 12.5);
    // A null quantity is not a position, so it contributes nothing and refuses nothing.
    const day = valueCryptoDay({
      accounts: [{ financialAccountId: "evm", name: "evm", nativeBalance: null,
                   assetKey: AVAX_NATIVE.assetKey, symbol: "AVAX", applicable: false }],
      unitPriceByAssetKey: {}, quantityLicensed: true });
    check("…so a pre-observation date contributes no crypto value at all",
      day.licensed && day.nativeTotal === 0 && day.positionCount === 0);

    const regen = code(read("lib", "snapshots", "regenerate-history.ts"));
    check("the historical bridge resolves per day through the canonical resolver",
      /resolvePositionAsOf\(rows, dISO\)\.quantity/.test(regen));
    check("…and never falls back to a current balance for a spine account",
      /rows === undefined/.test(regen));
  }

  // ══ NO AUTHORITY EXPANSION, NO LEGACY RESURRECTION ════════════════════════
  {
    const adapter = code(read("lib", "crypto", "evm-native.ts"));
    check("the EVM adapter writes no balance column",
      !/nativeBalance:/.test(adapter) && !/balance:\s*[a-zA-Z0-9]/.test(adapter.replace(/weiBalance:/g, "")));
    check("the only account update is lifecycle",
      /data:\s*\{\s*syncStatus:\s*["']synced["'],\s*lastUpdated:\s*new Date\(\)\s*\}/.test(adapter));
    check("no legacy Holding writer or crypto bridge returns",
      !/\.holding\./.test(adapter) && !/legacy-crypto/.test(adapter));
    check("net-worth participation stays withheld for every EVM chain",
      /WITHHELD_PENDING_CONVERGENCE/.test(adapter));
    check("the endpoint is never logged (it carries the credential)",
      !/console\.(log|warn|error)\([^)]*url/i.test(adapter));
  }

  console.log(`\nevm-native: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main();
