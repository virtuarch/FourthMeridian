/**
 * lib/ai/assemblers/holdings-core.test.ts
 *
 * P2-4 — pure shaper for the AI 'holdings_summary' domain. Standalone tsx:
 *
 *     npx tsx lib/ai/assemblers/holdings-core.test.ts
 *
 * Pins the canonical cutover guarantees WITHOUT a DB:
 *   1. FULL detail comes from the canonical current-position rows (fullRows).
 *   2. Non-FULL detail never leaks — hidden value enters only via allScope, and
 *      is disclosed (positionsPartiallyHidden + dataLimits), never as a symbol.
 *   3. Aggregate hidden value is preserved honestly in the totals.
 *   4. Concentration is byte-identical to the Investments Allocation panel
 *      (computeAllocation → same computeConcentration helper) on a spine-only
 *      FULL fixture.
 *   5. Unvalued positions handled honestly; same instrument across accounts
 *      collapses; crypto compatibility preserved (blended + disclosed).
 */

import {
  buildHoldingsSummary,
  excludeCanonicalCryptoAccounts,
  type CanonicalPositionRow,
  type AllScopeAggregate,
  type CryptoHoldingsInput,
} from "./holdings-core";
import { computeAllocation } from "@/lib/investments/investments-allocation-core";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const NO_CRYPTO: CryptoHoldingsInput = {
  total: 0, invested: 0, cash: 0, fullPositions: [], anyEstimated: false, anyUnconverted: false, hasAny: false,
};
function agg(over: Partial<AllScopeAggregate> = {}): AllScopeAggregate {
  return { valuedSubtotal: 0, cashValue: 0, anyFxEstimated: false, hasAny: true, ...over };
}
function row(over: Partial<CanonicalPositionRow>): CanonicalPositionRow {
  return { instrumentId: "i1", symbol: "AAA", name: "Alpha", reportingValue: 1000, isCash: false, ...over };
}

// A ValuedHoldingRow the Allocation panel would consume — only the fields
// computeAllocation reads matter; the rest are structurally-valid filler.
function vhr(over: Partial<ValuedHoldingRow>): ValuedHoldingRow {
  return {
    instrumentId: "i1", accountId: "a1", quantity: 1, nativePrice: null, nativeValue: null,
    reportingValue: 1000, currency: "USD", reportingCurrency: "USD",
    quantityTier: "observed", priceTier: "observed", fxTier: "observed", overallTier: "observed",
    basisUsed: "raw-close", priceDate: null, staleDays: null, reason: "", conflicted: false,
    symbol: "AAA", name: "Alpha", share: null, assetClass: "EQUITY", sector: null, isCash: false,
    ...over,
  } as ValuedHoldingRow;
}

// ── 1. Empty domain ───────────────────────────────────────────────────────────
console.log("1. empty domain");
{
  const out = buildHoldingsSummary({
    scopeHint: "full", fullRows: [], allScope: agg({ hasAny: false }), crypto: NO_CRYPTO,
  });
  check("no spine + no crypto ⇒ null (domain cleanly empty)", out === null);
}

// ── 2. FULL detail from canonical rows ──────────────────────────────────────────
console.log("2. FULL detail sourced from canonical current-position rows");
{
  const fullRows = [
    row({ instrumentId: "i1", symbol: "AAA", reportingValue: 6000 }),
    row({ instrumentId: "i2", symbol: "BBB", name: "Beta", reportingValue: 4000 }),
    row({ instrumentId: "iCash", symbol: "CASH", isCash: true, reportingValue: 2000 }),
  ];
  const out = buildHoldingsSummary({
    scopeHint: "full", fullRows,
    allScope: agg({ valuedSubtotal: 12000, cashValue: 2000 }),
    crypto: NO_CRYPTO,
  })!;
  const syms = (out.topPositions ?? []).map((p) => p.symbol);
  check("FULL non-cash positions surfaced", syms.includes("AAA") && syms.includes("BBB"));
  check("cash excluded from positions/concentration", !syms.includes("CASH") && out.positionCount === 2);
  check("analyzedInvestedValue = Σ FULL non-cash (6000+4000)", approx(out.analyzedInvestedValue, 10000));
  check("cashValue from all-scope aggregate", approx(out.cashValue, 2000));
  check("totalPortfolioValue = all-scope valued subtotal", approx(out.totalPortfolioValue, 12000));
  check("investedValue = total − cash", approx(out.investedValue, 10000));
  check("cashPct = 2000/12000", approx(out.cashPct, 2000 / 12000));
  check("not partially hidden when all value is FULL", out.positionsPartiallyHidden === false);
}

// ── 3. Non-FULL detail never leaks; hidden aggregate value preserved ────────────
console.log("3. hidden value preserved without leaking detail");
{
  // FULL detail is 10000 invested; all-scope invested is 15000 → 5000 hidden.
  const fullRows = [
    row({ instrumentId: "i1", symbol: "AAA", reportingValue: 6000 }),
    row({ instrumentId: "i2", symbol: "BBB", reportingValue: 4000 }),
  ];
  const out = buildHoldingsSummary({
    scopeHint: "full", fullRows,
    allScope: agg({ valuedSubtotal: 15000, cashValue: 0 }),
    crypto: NO_CRYPTO,
  })!;
  check("aggregate includes hidden value (total 15000)", approx(out.totalPortfolioValue, 15000));
  check("hidden invested value preserved in investedValue", approx(out.investedValue, 15000));
  check("concentration only sees FULL detail (analyzed = 10000)", approx(out.analyzedInvestedValue, 10000));
  check("partial-visibility flagged", out.positionsPartiallyHidden === true);
  check("dataLimits discloses partial visibility",
    out.dataLimits.some((d) => /shared below full visibility/.test(d)));
  const syms = (out.topPositions ?? []).map((p) => p.symbol);
  check("no hidden symbol leaks into positions", syms.length === 2 && !syms.includes("CASH"));
}

// ── 4. Concentration parity with the Investments Allocation panel ───────────────
console.log("4. concentration parity — same helper + per-instrument aggregation as computeAllocation");
{
  // Same instrument (i1 = NVDA) held in TWO FULL accounts + two more names.
  const canonical: CanonicalPositionRow[] = [
    { instrumentId: "i1", symbol: "NVDA", name: "Nvidia", reportingValue: 5000, isCash: false },
    { instrumentId: "i1", symbol: "NVDA", name: "Nvidia", reportingValue: 3000, isCash: false }, // second account
    { instrumentId: "i2", symbol: "VTI",  name: "Vanguard Total", reportingValue: 4000, isCash: false },
    { instrumentId: "i3", symbol: "BND",  name: "Bonds", reportingValue: 2000, isCash: false },
    { instrumentId: "iCash", symbol: "CASH", name: "Cash", reportingValue: 1000, isCash: true }, // excluded
  ];
  const allocRows: ValuedHoldingRow[] = [
    vhr({ instrumentId: "i1", accountId: "a1", symbol: "NVDA", reportingValue: 5000 }),
    vhr({ instrumentId: "i1", accountId: "a2", symbol: "NVDA", reportingValue: 3000 }),
    vhr({ instrumentId: "i2", accountId: "a1", symbol: "VTI",  reportingValue: 4000 }),
    vhr({ instrumentId: "i3", accountId: "a1", symbol: "BND",  reportingValue: 2000 }),
    vhr({ instrumentId: "iCash", accountId: "a1", symbol: "CASH", reportingValue: 1000, isCash: true }),
  ];

  const uiConcentration = computeAllocation(allocRows).concentration;
  const out = buildHoldingsSummary({
    scopeHint: "full", fullRows: canonical,
    allScope: agg({ valuedSubtotal: 15000, cashValue: 1000 }),
    crypto: NO_CRYPTO,
  })!;

  check("AI concentration === Allocation-panel concentration (byte-identical)",
    JSON.stringify(out.concentration) === JSON.stringify(uiConcentration),
    `ai=${JSON.stringify(out.concentration)} ui=${JSON.stringify(uiConcentration)}`);
  check("same-instrument-across-accounts collapses (NVDA = 8000, top)",
    out.concentration.topSymbol === "NVDA" && approx(out.concentration.topWeight!, 8000 / 14000));
  check("positionCount is distinct instruments, not rows (NVDA once)", out.positionCount === 3);
}

// ── 5. Unvalued handled honestly ────────────────────────────────────────────────
console.log("5. unvalued positions honest");
{
  const fullRows = [
    row({ instrumentId: "i1", symbol: "AAA", reportingValue: 5000 }),
    row({ instrumentId: "i2", symbol: "MISS", reportingValue: null }), // unvalued FULL row
  ];
  const out = buildHoldingsSummary({
    scopeHint: "full", fullRows,
    allScope: agg({ valuedSubtotal: 5000, cashValue: 0 }),
    crypto: NO_CRYPTO,
  })!;
  const syms = (out.topPositions ?? []).map((p) => p.symbol);
  check("unvalued row excluded from concentration/positions", !syms.includes("MISS") && out.positionCount === 1);
  check("unvalued disclosed in dataLimits", out.dataLimits.some((d) => /could not be valued/.test(d)));
}

// ── 6. Crypto transitional compatibility (blended + disclosed) ──────────────────
console.log("6. crypto compatibility preserved (transitional)");
{
  const crypto: CryptoHoldingsInput = {
    total: 30000, invested: 30000, cash: 0,
    fullPositions: [{ symbol: "BTC", name: "Bitcoin", value: 30000 }],
    anyEstimated: false, anyUnconverted: false, hasAny: true,
  };
  const out = buildHoldingsSummary({
    scopeHint: "full",
    fullRows: [row({ instrumentId: "i1", symbol: "AAA", reportingValue: 10000 })],
    allScope: agg({ valuedSubtotal: 10000, cashValue: 0 }),
    crypto,
  })!;
  const syms = (out.topPositions ?? []).map((p) => p.symbol);
  check("crypto value included in totals (10000 + 30000)", approx(out.totalPortfolioValue, 40000));
  check("crypto FULL position not silently dropped (surfaced in positions)",
    syms.includes("BTC") && syms.includes("AAA"));
  check("crypto participates in concentration (BTC top at 30000/40000)",
    out.concentration.topSymbol === "BTC" && approx(out.concentration.topWeight!, 30000 / 40000));
  check("crypto disclosed in dataLimits", out.dataLimits.some((d) => /wallet balances/.test(d)));

  // Empty-spine + crypto-only Space is NOT empty.
  const cryptoOnly = buildHoldingsSummary({
    scopeHint: "full", fullRows: [], allScope: agg({ hasAny: false }), crypto,
  });
  check("crypto-only Space is not a null domain", cryptoOnly !== null);
}

// ── 7. brief scopeHint omits topPositions ───────────────────────────────────────
console.log("7. scopeHint='brief' omits topPositions");
{
  const out = buildHoldingsSummary({
    scopeHint: "brief",
    fullRows: [row({ instrumentId: "i1", symbol: "AAA", reportingValue: 5000 })],
    allScope: agg({ valuedSubtotal: 5000 }),
    crypto: NO_CRYPTO,
  })!;
  check("topPositions omitted for brief", out.topPositions === undefined);
  check("concentration still computed for brief", out.concentration.topSymbol === "AAA");
}

// ── 8. Crypto dedup — CANONICAL WINS by custody account (P2-4 convergence) ──────
console.log("8. crypto dedup — canonical wins, dedup boundary is the wallet account");
{
  // ── 8a. The pure exclusion rule ────────────────────────────────────────────
  type Bridge = { financialAccountId: string; symbol: string; name: string; value: number };
  const bridge: Bridge[] = [
    { financialAccountId: "walletA", symbol: "BTC", name: "Bitcoin", value: 30000 }, // A — also on spine
    { financialAccountId: "walletB", symbol: "BTC", name: "Bitcoin", value: 25000 }, // B — bridge-only
  ];
  // Wallet A is on the canonical spine; B is not.
  const keptA = excludeCanonicalCryptoAccounts(bridge, new Set(["walletA"]));
  check("on-spine wallet A dropped from the bridge (canonical wins)",
    keptA.length === 1 && keptA[0].financialAccountId === "walletB");
  check("off-spine wallet B retained via the bridge", keptA.some((p) => p.financialAccountId === "walletB"));

  // Dedup boundary is the ACCOUNT, not the symbol: two different BTC wallets, none
  // on the spine → BOTH kept even though they share the ticker.
  const keptNone = excludeCanonicalCryptoAccounts(bridge, new Set<string>());
  check("two distinct BTC wallets both remain when neither is canonical",
    keptNone.length === 2 && keptNone.every((p) => p.symbol === "BTC"));

  // ── 8b. End-to-end: no double count once the dedup feeds the shaper ─────────
  // Wallet A is on the spine (canonical BTC row + counted in allScope). The bridge
  // carried A and B; after the exclusion only B rides in. Assert single-count.
  const canonicalRows: CanonicalPositionRow[] = [
    { instrumentId: "iAAA", symbol: "AAA", name: "Alpha",   reportingValue: 10000, isCash: false },
    { instrumentId: "iBTC", symbol: "BTC", name: "Bitcoin", reportingValue: 30000, isCash: false }, // wallet A
  ];
  const kept = excludeCanonicalCryptoAccounts(bridge, new Set(["walletA"]));
  const crypto: CryptoHoldingsInput = {
    total: kept.reduce((s, p) => s + p.value, 0),          // 25000 (B only)
    invested: kept.reduce((s, p) => s + p.value, 0),
    cash: 0,
    fullPositions: kept.map((p) => ({ symbol: p.symbol, name: p.name, value: p.value })),
    anyEstimated: false, anyUnconverted: false, hasAny: kept.length > 0,
  };
  const out = buildHoldingsSummary({
    scopeHint: "full",
    fullRows: canonicalRows,
    // "all"-scope valuation INCLUDES wallet A's canonical BTC (10000 + 30000).
    allScope: agg({ valuedSubtotal: 40000, cashValue: 0 }),
    crypto,
  })!;

  check("totalPortfolioValue not double-counted (10000 + 30000 canonical + 25000 bridge = 65000)",
    approx(out.totalPortfolioValue, 65000));
  check("analyzedInvestedValue not double-counted (65000, wallet A once)",
    approx(out.analyzedInvestedValue, 65000));

  const btcValues = (out.topPositions ?? []).filter((p) => p.symbol === "BTC").map((p) => p.value).sort((a, b) => b - a);
  check("wallet A's BTC (30000) counted once — not merged/doubled into 60000",
    !btcValues.includes(60000) && !btcValues.includes(55000));
  check("two distinct BTC wallets coexist (canonical A=30000 + bridge B=25000, each once)",
    btcValues.length === 2 && approx(btcValues[0], 30000) && approx(btcValues[1], 25000));
  check("topPositions carry no duplicate wallet-A entry (AAA + 2 distinct BTC = 3)",
    (out.topPositions ?? []).length === 3);
  check("BTC is the top position (30000/65000)",
    out.concentration.topSymbol === "BTC" && approx(out.concentration.topWeight!, 30000 / 65000));
}

// ── Exit ────────────────────────────────────────────────────────────────────
if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll holdings-core checks passed.");
