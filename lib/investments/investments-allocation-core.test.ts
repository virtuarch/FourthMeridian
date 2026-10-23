/**
 * lib/investments/investments-allocation-core.test.ts
 *
 * Pure fixture test for the Allocation view assembly (house convention, no
 * prisma generate):  npx tsx lib/investments/investments-allocation-core.test.ts
 *
 * Pins: valued-only breakdowns, shares summing to 1, deterministic order,
 * unvalued rows disclosed-not-folded, and concentration excluding cash while the
 * asset-class axis still shows a Cash slice.
 *
 * Consolidated file: absorbs investments-allocation-drill.test.ts (UX-CLOSE-3
 * era) — the holdingsInSlice MEMBERSHIP AGREEMENT (a drill sums to the segment
 * that opened it, on every axis) and the null-bucket sentinel pins.
 */

import {
  computeAllocation, holdingsInSlice, ALLOCATION_KEY_OF,
  type AllocationDimension,
} from "./investments-allocation-core";
import type { ValuedHoldingRow } from "./investments-time-machine-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

/** Minimal ValuedHoldingRow — only the fields the allocation core reads. */
function row(p: {
  instrumentId: string; accountId: string; reportingValue: number | null;
  currency?: string | null; assetClass?: string; sector?: string | null;
  isCash?: boolean; symbol?: string | null; name?: string | null;
}): ValuedHoldingRow {
  return {
    instrumentId: p.instrumentId,
    accountId:    p.accountId,
    reportingValue: p.reportingValue,
    currency:     p.currency ?? "USD",
    assetClass:   p.assetClass ?? "UNKNOWN",
    sector:       p.sector ?? null,
    isCash:       p.isCash ?? false,
    symbol:       p.symbol ?? null,
    name:         p.name ?? null,
    share:        null,
  } as unknown as ValuedHoldingRow;
}

function main(): void {
  // NVDA held in two accounts (8000 total), VOO 3000, cash 1000; one unvalued.
  const holdings: ValuedHoldingRow[] = [
    row({ instrumentId: "A", accountId: "acct1", reportingValue: 6000, assetClass: "EQUITY", sector: "Technology", symbol: "NVDA" }),
    row({ instrumentId: "B", accountId: "acct1", reportingValue: 3000, assetClass: "ETF", symbol: "VOO" }),
    row({ instrumentId: "C", accountId: "acct2", reportingValue: 1000, assetClass: "CASH", isCash: true, symbol: "CASH", currency: "USD" }),
    row({ instrumentId: "A", accountId: "acct2", reportingValue: 2000, assetClass: "EQUITY", sector: "Technology", symbol: "NVDA" }),
    row({ instrumentId: "D", accountId: "acct2", reportingValue: null, assetClass: "EQUITY", symbol: "XYZ" }), // unvalued
  ];
  const r = computeAllocation(holdings, { acct1: "Brokerage", acct2: "Roth IRA" });

  console.log("1. honesty counts");
  check("valuedTotal = 12000 (unvalued excluded)", r.valuedTotal === 12000);
  check("valuedCount = 4, unvaluedCount = 1", r.valuedCount === 4 && r.unvaluedCount === 1);

  console.log("2. by asset class — Equity aggregates both accounts, Cash is its own slice");
  check("order: Equity(8000) > ETF(3000) > Cash(1000)",
    r.byAssetClass.map((s) => `${s.key}:${s.value}`).join(",") === "EQUITY:8000,ETF:3000,CASH:1000");
  check("labels humanized", r.byAssetClass[0].label === "Equity" && r.byAssetClass[2].label === "Cash");
  check("shares sum to 1", approx(r.byAssetClass.reduce((s, x) => s + x.share, 0), 1));
  check("Equity share = 8000/12000", approx(r.byAssetClass[0].share, 8000 / 12000));

  console.log("3. by account / sector / currency");
  check("byAccount: Brokerage 9000, Roth IRA 3000",
    r.byAccount[0].label === "Brokerage" && r.byAccount[0].value === 9000 && r.byAccount[1].value === 3000);
  check("bySector: Technology 8000, then Unknown 4000",
    r.bySector[0].label === "Technology" && r.bySector[0].value === 8000 && r.bySector[1].label === "Unknown" && r.bySector[1].value === 4000);
  check("byCurrency: single USD slice = 12000", r.byCurrency.length === 1 && r.byCurrency[0].value === 12000);

  console.log("4. concentration excludes cash, aggregates per instrument");
  check("topSymbol = NVDA (8000 of 11000 non-cash)", r.concentration.topSymbol === "NVDA");
  check("topWeight = 8000/11000", approx(r.concentration.topWeight!, 8000 / 11000));
  check("classification HIGHLY_CONCENTRATED (top ≥ 0.40)", r.concentration.classification === "HIGHLY_CONCENTRATED");
  check("effectiveHoldings ≈ 1.66", approx(r.concentration.effectiveHoldings!, 1 / (Math.pow(8000 / 11000, 2) + Math.pow(3000 / 11000, 2)), 1e-4));

  console.log("5. empty portfolio");
  const empty = computeAllocation([], {});
  check("empty → zero total, no slices", empty.valuedTotal === 0 && empty.byAssetClass.length === 0);
  check("empty → INSUFFICIENT_DATA concentration", empty.concentration.classification === "INSUFFICIENT_DATA");

  console.log("6. determinism");
  const a = JSON.stringify(computeAllocation(holdings, { acct1: "Brokerage", acct2: "Roth IRA" }));
  const b = JSON.stringify(computeAllocation(holdings, { acct1: "Brokerage", acct2: "Roth IRA" }));
  check("identical inputs → byte-identical JSON", a === b);

  // ═══ 7. Merged from investments-allocation-drill.test.ts (UX-CLOSE-3 era) ══
  //
  // UX-CLOSE-3 made Allocation segments interrogable. The load-bearing property
  // is MEMBERSHIP AGREEMENT: the rows a drill-down shows must sum to the value
  // of the segment that opened it, on every axis. `computeAllocation` and
  // `holdingsInSlice` therefore share one set of key functions
  // (ALLOCATION_KEY_OF); this section proves they agree rather than trusting
  // that two "identical" expressions stay identical. Also pins the
  // null-bucketing that a naive re-derivation would get wrong: a null sector
  // and a null currency fall into a sentinel bucket, NOT into a literal
  // "null"/"Unknown" string, and asset class falls back on empty-string.

  /** Minimal row — only the fields the allocation axes read. */
  function H(p: Partial<ValuedHoldingRow> & { instrumentId: string; accountId: string }): ValuedHoldingRow {
    return {
      quantity: 1, nativePrice: null, nativeValue: null,
      reportingValue: 100, currency: "USD", reportingCurrency: "USD",
      quantityTier: "observed", priceTier: "observed", fxTier: "observed", overallTier: "observed",
      basisUsed: "institution-value", priceDate: null, staleDays: 0, reason: null, conflicted: false,
      symbol: null, name: null, share: 0, assetClass: "EQUITY", sector: "Tech", isCash: false,
      ...p,
    } as ValuedHoldingRow;
  }

  const ROWS: ValuedHoldingRow[] = [
    H({ instrumentId: "i1", accountId: "a1", reportingValue: 500, assetClass: "EQUITY",  sector: "Tech",   currency: "USD" }),
    H({ instrumentId: "i2", accountId: "a1", reportingValue: 300, assetClass: "EQUITY",  sector: "Health", currency: "USD" }),
    H({ instrumentId: "i3", accountId: "a2", reportingValue: 200, assetClass: "ETF",     sector: null,     currency: "EUR" }),
    H({ instrumentId: "i4", accountId: "a2", reportingValue: 100, assetClass: "CRYPTO",  sector: null,     currency: null }),
    H({ instrumentId: "i5", accountId: "a3", reportingValue: 50,  assetClass: "",        sector: "Tech",   currency: "USD" }),
    // Unvalued — contributes to no slice and must never appear in a drill.
    H({ instrumentId: "i6", accountId: "a1", reportingValue: null, assetClass: "EQUITY", sector: "Tech",   currency: "USD" }),
  ];

  const AXES: { dim: AllocationDimension; of: (r2: ReturnType<typeof computeAllocation>) => { key: string; value: number }[] }[] = [
    { dim: "assetClass", of: (a2) => a2.byAssetClass },
    { dim: "sector",     of: (a2) => a2.bySector },
    { dim: "account",    of: (a2) => a2.byAccount },
    { dim: "currency",   of: (a2) => a2.byCurrency },
  ];

  const alloc = computeAllocation(ROWS, { a1: "Brokerage", a2: "IRA", a3: "Other" });

  console.log("7.1. MEMBERSHIP AGREEMENT — a drill sums to the segment that opened it");
  for (const { dim, of } of AXES) {
    for (const slice of of(alloc)) {
      const rows = holdingsInSlice(ROWS, dim, slice.key);
      const summed = rows.reduce((s, x) => s + (x.reportingValue as number), 0);
      check(`${dim}/${slice.key}: rows sum to the slice value`, summed === slice.value,
        `${summed} vs ${slice.value}`);
    }
  }

  console.log("7.2. partition — every valued row lands in exactly one slice per axis");
  const valuedIds = ROWS.filter((x) => x.reportingValue != null).map((x) => x.instrumentId).sort();
  for (const { dim, of } of AXES) {
    const drilled = of(alloc).flatMap((s) => holdingsInSlice(ROWS, dim, s.key).map((x) => x.instrumentId)).sort();
    check(`${dim}: drills cover every valued row exactly once`,
      drilled.join() === valuedIds.join(), `${drilled.join()} vs ${valuedIds.join()}`);
  }

  console.log("7.3. unvalued rows never surface");
  for (const { dim, of } of AXES) {
    const anyUnvalued = of(alloc).some((s) =>
      holdingsInSlice(ROWS, dim, s.key).some((x) => x.reportingValue == null));
    check(`${dim}: no unvalued row appears in any drill`, !anyUnvalued);
  }

  console.log("7.4. null bucketing — the part a re-derivation gets wrong");
  check("a null sector buckets to the sentinel, not the string 'null'",
    ALLOCATION_KEY_OF.sector(ROWS[2]) === "__unknown__",
    ALLOCATION_KEY_OF.sector(ROWS[2]));
  check("a null currency buckets to the sentinel",
    ALLOCATION_KEY_OF.currency(ROWS[3]) === "__unknown__");
  check("an empty assetClass falls back to UNKNOWN",
    ALLOCATION_KEY_OF.assetClass(ROWS[4]) === "UNKNOWN");
  const unknownSector = holdingsInSlice(ROWS, "sector", "__unknown__");
  check("both null-sector rows drill together", unknownSector.length === 2);
  check("the unknown-sector slice reconciles",
    unknownSector.reduce((s, x) => s + (x.reportingValue as number), 0) === 300);

  console.log("7.5. ordering + edges");
  const eq = holdingsInSlice(ROWS, "assetClass", "EQUITY");
  check("rows are largest first", eq[0]?.reportingValue === 500 && eq[1]?.reportingValue === 300);
  check("EQUITY excludes the unvalued row", eq.length === 2);
  check("an unknown key yields nothing", holdingsInSlice(ROWS, "account", "nope").length === 0);
  check("no holdings yields nothing", holdingsInSlice([], "assetClass", "EQUITY").length === 0);

  console.log("7.6. known totals");
  check("valuedTotal excludes the unvalued row", alloc.valuedTotal === 1150, String(alloc.valuedTotal));
  check("unvaluedCount is 1", alloc.unvaluedCount === 1);
  check("account a1 totals 800",
    alloc.byAccount.find((s) => s.key === "a1")?.value === 800);

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll investments-allocation-core checks passed.");
}

main();
