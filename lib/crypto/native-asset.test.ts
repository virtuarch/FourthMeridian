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
  BTC_NATIVE, ETH_NATIVE, SOL_NATIVE, NATIVE_ASSETS,
  nativeAssetForChain, nativeAssetForSymbol,
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

// ── Resolution ───────────────────────────────────────────────────────────────

check("a known chain resolves to its native asset", nativeAssetForChain("BTC") === BTC_NATIVE);
check("resolution is case-insensitive and trims", nativeAssetForChain("  eth ") === ETH_NATIVE);
check("symbol lookup mirrors chain lookup", nativeAssetForSymbol("sol") === SOL_NATIVE);

// THE defect W-M0 removes. Every one of these previously answered "BTC" at the
// point of use, because the point of use was a literal rather than a question.
for (const chain of [null, undefined, "", "   ", "MATIC", "AVAX", "DOT", "ADA", "XRP", "OTHER", "bitcoin"]) {
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

console.log(`\nnative-asset: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
