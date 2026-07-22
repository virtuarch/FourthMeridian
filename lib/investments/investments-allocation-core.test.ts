/**
 * lib/investments/investments-allocation-core.test.ts
 *
 * Pure fixture test for the Allocation view assembly (house convention, no
 * prisma generate):  npx tsx lib/investments/investments-allocation-core.test.ts
 *
 * Pins: valued-only breakdowns, shares summing to 1, deterministic order,
 * unvalued rows disclosed-not-folded, and concentration excluding cash while the
 * asset-class axis still shows a Cash slice.
 */

import { computeAllocation } from "./investments-allocation-core";
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

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll investments-allocation-core checks passed.");
}

main();
