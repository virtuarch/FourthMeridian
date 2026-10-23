/**
 * lib/crypto/eth-history-sync.test.ts
 *
 * ETH-H2 — the persistence half, and the promises it must keep.
 *
 *     npx tsx lib/crypto/eth-history-sync.test.ts
 *
 * ETH-H1 proved Ethereum's quantity history is recoverable from state reads
 * alone and deliberately stopped before persistence, because a third
 * reconstruction with no production caller was exactly the mistake W6f had just
 * finished correcting. This module is the persistence, wired to that same
 * lifecycle from the start.
 *
 * Pinned here: that wei never round-trips through a float, that a non-EOA is
 * refused rather than partially served, that COMPLETE coverage cannot be reached
 * without an exact reconciliation, and that Ethereum reuses the one replay
 * engine rather than acquiring a second.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { weiToEthExact, ETH_RECONSTRUCTION_SOURCE } from "./eth-history-sync";
import { isPlainEoa, provablyUnchanged, EARLIEST_PROVABLE_BLOCK } from "./eth-history";
import { ETH_NATIVE, BTC_NATIVE } from "./native-asset";
import { chainSupportsHistory, walletChainSupport } from "./wallet-sync-dispatch";
import { coinIdForSymbol } from "@/lib/prices/providers/coingecko";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const body = (s: string) => {
  const m = [...s.matchAll(/^import[\s\S]*?;$/gm)];
  return m.length ? s.slice(m[m.length - 1].index! + m[m.length - 1][0].length) : s;
};
const SYNC = code(read("lib", "crypto", "eth-history-sync.ts"));

// ══ THE PROOF'S PREMISES, AND WHAT BREAKS THEM ════════════════════════════════
{
  const eoa = { balance: BigInt(5), nonce: BigInt(1), code: "0x" };
  check("a plain EOA satisfies the premise", isPlainEoa(eoa));
  check("an account with code does not", !isPlainEoa({ ...eoa, code: "0x60" }));
  check("…including an EIP-7702 delegation, which is code",
    !isPlainEoa({ ...eoa, code: "0xef01005a1b…" }));

  check("equal nonce AND balance on an EOA proves the interval empty",
    provablyUnchanged(eoa, { ...eoa }));
  check("a moved nonce breaks it — the account originated something",
    !provablyUnchanged(eoa, { ...eoa, nonce: BigInt(2) }));
  check("a moved balance breaks it — a credit arrived",
    !provablyUnchanged(eoa, { ...eoa, balance: BigInt(6) }));
  check("a CONTRACT with everything equal STILL breaks it",
    !provablyUnchanged({ ...eoa, code: "0x60" }, { ...eoa, code: "0x60" }),
    "balance equality alone is the cancelling-omission hazard; the nonce "
    + "condition is what eliminates it, and it only holds for an EOA");

  check("the provable floor sits after the DAO fork and EIP-161",
    EARLIEST_PROVABLE_BLOCK === 4_370_000);
}

// ══ WEI NEVER ROUND-TRIPS THROUGH A FLOAT ═════════════════════════════════════
{
  check("the module converts exactly ONCE, at the canonical boundary",
    (SYNC.match(/weiToEthExact\(/g) ?? []).length <= 2,
    "every extra conversion is a chance to reconstruct a wei figure from a float");
  check("Bitcoin's satoshi anchor pattern is NOT copied",
    !/Math\.round\([^)]*\*/.test(SYNC),
    "safe at 8 decimals across the whole BTC supply; at 18 it manufactures an "
    + "anchor differing from the chain's, and a missed movement equal to that "
    + "error would reconcile spuriously");
  check("reconciliation is handed the chain's own wei, not a scaled quantity",
    /reconcileMovementsAgainstBalance\(movements, anchorBalanceWei\)/.test(SYNC));
  check("the residual leaves as a STRING so no consumer can float it",
    /residualWei: recon\.residual\.toString\(\)/.test(SYNC));

  // The conversion itself, at the magnitudes that matter.
  check("1 wei survives", weiToEthExact(BigInt(1)) === 1e-18);
  check("whole ETH is exact", weiToEthExact(BigInt("1500000000000000000")) === 1.5);
  check("a large balance keeps every digit float64 can hold",
    Math.abs(weiToEthExact(BigInt("109094285860885586773903")) - 109094.28586088559) < 1e-9);
  check("zero is zero", weiToEthExact(BigInt(0)) === 0);
  check("the split avoids Number(wei) precision loss above 2^53 wei",
    /const whole = wei \/ unit;/.test(read("lib", "crypto", "eth-history-sync.ts")));
}

// ══ REFUSALS WRITE NOTHING ════════════════════════════════════════════════════
{
  const b = body(SYNC);
  const tx = b.indexOf("$transaction");
  const refusals = [...b.matchAll(/ok: false/g)].map((m) => m.index!);
  check("every refusal returns before the write transaction",
    refusals.length >= 4 && refusals.every((i) => i < tx),
    "a refusal reaching the delete would replace proven history with nothing");

  check("a non-EOA refuses with PROOF_PREMISES_UNMET",
    /refusal: premisesUnmet \? "PROOF_PREMISES_UNMET"/.test(SYNC));
  check("…and says the data was fine, so nobody retries forever",
    /not a plain EOA/.test(read("lib", "crypto", "eth-history-sync.ts")));
  check("a non-COMPLETE coverage never reaches the replay",
    b.indexOf('coverage.kind !== "COMPLETE"') < b.indexOf("replayEthHistory("));
  check("a broken reconciliation never reaches the replay",
    b.indexOf('"LEDGER_DOES_NOT_RECONCILE"') < b.indexOf("replayEthHistory("),
    "COMPLETE coverage plus an unclosed residual is not a licence");
  check("a missing anchor balance refuses rather than assuming zero",
    /anchorBalanceWei === null/.test(SYNC));
}

// ══ ONE ENGINE, ONE LICENCE, ONE IDENTITY ═════════════════════════════════════
{
  const ROWS = code(read("lib", "crypto", "eth-history-rows.ts"));
  check("Ethereum replays through THE engine, via the one derivation both paths share",
    /replayEthHistory\(/.test(SYNC) && /replayQuantityTimeline\(/.test(ROWS) && !/function replay[A-Z]/.test(SYNC)
      && /replayEthHistory\(/.test(code(read("lib", "crypto", "eth-history-incremental.ts"))));
  check("…and converts movements with the shared normaliser",
    /movementsToQuantityEvents\(/.test(ROWS));
  check("…and persists its licence beside the rows, in one transaction",
    /persistPositionCoverage\(tx, accountId, instrumentId, coverage\)/.test(SYNC));
  check("…resolving identity through the canonical crypto instrument authority",
    /resolveCryptoInstrumentId\(ETH_ASSET\)/.test(SYNC));
  check("rows carry their own source so they never collide with another chain's",
    ETH_RECONSTRUCTION_SOURCE === "eth-reconstruction");
  check("the scan is bounded by the FINALIZED head, never `latest`",
    /finalizedBlockNumber\(/.test(SYNC),
    "a reorg-able block is not evidence to anchor a licence against");

  // The interpreted index stays out of the truth model.
  check("no transfer index is consulted anywhere in the reconstruction",
    !/getAssetTransfers/i.test(SYNC) && !/getAssetTransfers/i.test(code(read("lib", "crypto", "eth-history.ts"))),
    "measured empirically incomplete: 0 transfers reported while an address "
    + "gained 1.008975659 ETH in validator withdrawals");
}

// ══ WIRED TO PRODUCTION, NOT TO A TEST ════════════════════════════════════════
{
  const refresh = code(read("lib", "crypto", "wallet-history-refresh.ts"));
  check("ETH is dispatched by the production sync refresh",
    /key === ETH_NATIVE\.chain \? reconstructEthHistory/.test(refresh),
    "a third reconstruction with no caller is the W6f defect repeated");
  check("…alongside BTC and SOL, by chain identity rather than a literal",
    /BTC_NATIVE\.chain/.test(refresh) && /SOL_NATIVE\.chain/.test(refresh));
}

// ══ PRICING GOES THROUGH THE CANONICAL PATH ═══════════════════════════════════
{
  check("ETH has a canonical price identity already",
    coinIdForSymbol(ETH_NATIVE.symbol) === "ethereum");
  const regen = code(read("lib", "snapshots", "regenerate-history.ts"));
  check("the crypto price backfill prices what is HELD, not Bitcoin",
    /resolveCryptoInstrumentId\(a\)/.test(regen) && !/resolveBtcInstrumentId/.test(regen),
    "it resolved BTC's instrument unconditionally, so a Space holding SOL or "
    + "ETH had its quantities reconstructed and its prices never acquired");
  check("…still through the SAME backfill every asset class uses",
    /backfillHeldInstrumentPrices\(/.test(regen));
  check("no ETH-specific pricing path was created",
    !/eth.?price/i.test(regen));
}

// ══ CAPABILITY IS NOT PROMOTED BY WRITING CODE ════════════════════════════════
{
  // ETH-H2 acceptance — PROMOTED on the real wallet, not on the adapter existing:
  // COMPLETE 2017-10-16..2026-08-27, zero caveats, 16 movements reconciling at
  // ZERO WEI, 3238 replayed days, dated prices through the canonical backfill,
  // and a refused acquisition preserving every row.
  check("ETH is HISTORY_SUPPORTED after real-wallet acceptance",
    walletChainSupport("ETH") === "HISTORY_SUPPORTED" && chainSupportsHistory("ETH"));
  check("…which is what makes the sync route regenerate its chart",
    chainSupportsHistory("ETH"),
    "the regeneration gate asks capability; an unpromoted chain never redraws");
  check("BTC and SOL keep theirs",
    chainSupportsHistory("BTC") && chainSupportsHistory("SOL"));
  check("BNB/AVAX are untouched by this slice",
    walletChainSupport("BNB") === "CURRENT_POSITION_SUPPORTED"
      && walletChainSupport("AVAX") === "CURRENT_POSITION_SUPPORTED");
  check("the two chains' assets stay distinct",
    ETH_NATIVE.assetKey !== BTC_NATIVE.assetKey && ETH_NATIVE.decimals === 18);
}

console.log(`\neth-history-sync: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
