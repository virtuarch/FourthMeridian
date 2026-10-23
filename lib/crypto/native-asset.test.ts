/**
 * lib/crypto/native-asset.test.ts
 *
 * W-M0 — the chain → native-asset registry and the per-asset ledger tolerance.
 *
 *     npx tsx lib/crypto/native-asset.test.ts
 *
 * Pure: the module under test imports nothing, so this runs under bare tsx with
 * no DB, no Prisma client and no preload.
 */

import {
  BTC_NATIVE, ETH_NATIVE, SOL_NATIVE, BNB_NATIVE, POL_NATIVE, AVAX_NATIVE, NATIVE_ASSETS,
  nativeAssetForChain, nativeAssetForSymbol, nativeAssetForKey,
  ledgerEpsilonFor, LEDGER_EPSILON_FLOOR,
} from "./native-asset";
import { LEDGER_EPSILON } from "./ledger-completeness.core";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

// ── Descriptors ──────────────────────────────────────────────────────────────

check("BTC: 8 decimals (satoshi), USD-quoted",
  BTC_NATIVE.symbol === "BTC" && BTC_NATIVE.chain === "BTC"
    && BTC_NATIVE.decimals === 8 && BTC_NATIVE.currency === "USD");
check("ETH: 18 decimals (wei), USD-quoted",
  ETH_NATIVE.symbol === "ETH" && ETH_NATIVE.chain === "ETH"
    && ETH_NATIVE.decimals === 18 && ETH_NATIVE.currency === "USD");
check("SOL: 9 decimals (lamport), USD-quoted",
  SOL_NATIVE.symbol === "SOL" && SOL_NATIVE.chain === "SOL"
    && SOL_NATIVE.decimals === 9 && SOL_NATIVE.currency === "USD");

check("every descriptor is uniquely keyed by chain AND by symbol",
  new Set(NATIVE_ASSETS.map((a) => a.chain)).size === NATIVE_ASSETS.length
    && new Set(NATIVE_ASSETS.map((a) => a.symbol)).size === NATIVE_ASSETS.length);

// ── W-M1a — assetKey is THE identity ─────────────────────────────────────────

check("each descriptor carries a stable chain-qualified CAIP-19 assetKey",
  BTC_NATIVE.assetKey === "bip122:000000000019d6689c085ae165831e93/slip44:0"
    && ETH_NATIVE.assetKey === "eip155:1/slip44:60"
    && SOL_NATIVE.assetKey === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501");
check("assetKeys are unique across the registry",
  new Set(NATIVE_ASSETS.map((a) => a.assetKey)).size === NATIVE_ASSETS.length);
check("assetKey identifies the CHAIN before the asset (so tickers may repeat)",
  NATIVE_ASSETS.every((a) => a.assetKey.split("/").length === 2 && a.assetKey.split("/")[0].includes(":")));
check("identity lookup by assetKey is exact and round-trips",
  NATIVE_ASSETS.every((a) => nativeAssetForKey(a.assetKey) === a));
check("an unknown or absent assetKey resolves to nothing",
  nativeAssetForKey("eip155:1/erc20:0xdead") === null
    && nativeAssetForKey(null) === null && nativeAssetForKey("") === null);
// The identity lookup is NOT case-forgiving: an assetKey is a machine
// identifier, and quietly accepting a variant would make two spellings of one
// identity — the very thing the key exists to prevent.
check("assetKey matching is exact, never case-folded",
  nativeAssetForKey(BTC_NATIVE.assetKey.toUpperCase()) === null);

// ── Resolution ───────────────────────────────────────────────────────────────

check("a known chain resolves to its native asset", nativeAssetForChain("BTC") === BTC_NATIVE);
check("resolution is case-insensitive and trims", nativeAssetForChain("  eth ") === ETH_NATIVE);
// Symbol lookup survives ONLY as a denomination question (Transaction.currency
// on a native movement row). It is unambiguous today because native tickers are
// unique — pinned above — and it is never how identity is resolved.
check("symbol lookup answers the DENOMINATION question", nativeAssetForSymbol("sol") === SOL_NATIVE);

// THE defect W-M0 removes. Every one of these previously answered "BTC" at the
// point of use, because the point of use was a literal rather than a question.
for (const chain of [null, undefined, "", "   ", "DOT", "ADA", "XRP", "OTHER", "bitcoin"]) {
  check(`an unnamed/unsupported chain resolves to NOTHING, never to BTC (${JSON.stringify(chain)})`,
    nativeAssetForChain(chain) === null);
}

// "bitcoin" deliberately does NOT alias to BTC: the write path uppercases and
// validates against a fixed list, so a near-miss means the writer changed, and
// papering over that is the failure mode this module exists to remove.
check("no aliasing — a near-miss is a refusal, not a guess",
  nativeAssetForChain("bitcoin") === null && nativeAssetForSymbol("Bitcoin") === null);

// ── Ledger tolerance ─────────────────────────────────────────────────────────

check("BTC tolerance is one satoshi — IDENTICAL to the pre-W-M0 fixed constant",
  ledgerEpsilonFor(BTC_NATIVE) === 1e-8 && ledgerEpsilonFor(BTC_NATIVE) === LEDGER_EPSILON);
check("SOL tolerance is one lamport (finer than a satoshi)",
  ledgerEpsilonFor(SOL_NATIVE) === 1e-9 && ledgerEpsilonFor(SOL_NATIVE) < ledgerEpsilonFor(BTC_NATIVE));

// The wei case, stated rather than pretended. 1e-18 is below float64's ability
// to distinguish two numbers near 1.0, so a wei-exact tolerance would classify
// every ETH ledger as short. The floor is a documented limit of the Float
// columns, not a claim about wei.
check("ETH tolerance is the stated float64 floor, not one wei",
  ledgerEpsilonFor(ETH_NATIVE) === LEDGER_EPSILON_FLOOR && ledgerEpsilonFor(ETH_NATIVE) > 1e-18);
check("…and the floor really is above float64 noise at unit magnitudes",
  LEDGER_EPSILON_FLOOR > Number.EPSILON);
check("an unknown asset gets the floor (and callers refuse on the asset first)",
  ledgerEpsilonFor(null) === LEDGER_EPSILON_FLOOR);

check("every tolerance is positive and finite",
  NATIVE_ASSETS.every((a) => Number.isFinite(ledgerEpsilonFor(a)) && ledgerEpsilonFor(a) > 0));

// ── W-M3 — EVM native assets ────────────────────────────────────────────────
check("BNB: chain id 56, SLIP-44 9006 (Smart Chain, NOT the 714 Beacon Chain)",
  BNB_NATIVE.assetKey === "eip155:56/slip44:9006"
    && BNB_NATIVE.chain === "BNB" && BNB_NATIVE.symbol === "BNB" && BNB_NATIVE.decimals === 18);
check("AVAX: chain id 43114 (C-Chain), SLIP-44 9000",
  AVAX_NATIVE.assetKey === "eip155:43114/slip44:9000"
    && AVAX_NATIVE.chain === "AVAX" && AVAX_NATIVE.symbol === "AVAX" && AVAX_NATIVE.decimals === 18);
check("every EVM native asset is 18 decimals",
  [ETH_NATIVE, BNB_NATIVE, POL_NATIVE, AVAX_NATIVE].every((a) => a.decimals === 18));
check("each EVM asset key is chain-qualified by its CHAIN ID",
  [["eip155:1", ETH_NATIVE], ["eip155:56", BNB_NATIVE], ["eip155:137", POL_NATIVE], ["eip155:43114", AVAX_NATIVE]]
    .every(([ref, a]) => (a as typeof ETH_NATIVE).assetKey.startsWith(`${ref}/`)));

// ── POLYGON — THE CHAIN IS NOT THE TICKER ───────────────────────────────────
// The native asset was renamed MATIC → POL 1:1 on the same chain. The rename
// moves the SYMBOL and nothing else: a 1:1 rename of the same coin is not a new
// economic asset, so the key keeps its slot — renaming it would orphan every
// position and price already recorded against it.
check("Polygon's CHAIN CODE and its display SYMBOL are deliberately different",
  POL_NATIVE.chain === "MATIC" && POL_NATIVE.symbol === "POL");
check("…the chain identity is the chain id, untouched by the ticker rename",
  POL_NATIVE.assetKey === "eip155:137/slip44:966");
check("…and the product chain code still resolves the asset",
  nativeAssetForChain("MATIC") === POL_NATIVE);
check("…while the ticker resolves it by its CURRENT symbol only",
  nativeAssetForSymbol("POL") === POL_NATIVE && nativeAssetForSymbol("MATIC") === null);

// Identity remains globally unique across the widened registry.
check("all six native assets have distinct keys, chains and symbols",
  new Set(NATIVE_ASSETS.map((a) => a.assetKey)).size === 6
    && new Set(NATIVE_ASSETS.map((a) => a.chain)).size === 6
    && new Set(NATIVE_ASSETS.map((a) => a.symbol)).size === 6);
check("no EVM asset collides with another chain's key",
  NATIVE_ASSETS.every((a) => NATIVE_ASSETS.filter((b) => b.assetKey === a.assetKey).length === 1));

console.log(`\nnative-asset: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
