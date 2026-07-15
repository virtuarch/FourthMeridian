/**
 * lib/investments/space-data-core.test.ts
 *
 * Pure fixture test for the current-portfolio contract assembly (house convention,
 * no prisma generate):  npx tsx lib/investments/space-data-core.test.ts
 *
 * Pins: `holdings`/`portfolio`/`asOf`/`reportingCurrency` are the CurrentPositions
 * fields verbatim (no copy, no re-derivation), allocation is the shared
 * computeAllocation over the same rows (asset-class/account axes + concentration),
 * by-account labels use the supplied name map, and assembly is deterministic.
 */

import { assembleCurrentPortfolio } from "./space-data-core";
import { computeAllocation } from "./investments-allocation-core";
import type { CurrentPositions, CurrentPositionRow } from "./current-positions-core";
import type { InvestmentsPortfolio } from "./investments-time-machine-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

/** Minimal CurrentPositionRow — only the fields allocation + the contract read. */
function row(p: {
  instrumentId: string; accountId: string; reportingValue: number | null;
  currency?: string | null; assetClass?: string; sector?: string | null;
  isCash?: boolean; symbol?: string | null; costBasis?: number | null;
}): CurrentPositionRow {
  return {
    instrumentId:   p.instrumentId,
    accountId:      p.accountId,
    reportingValue: p.reportingValue,
    currency:       p.currency ?? "USD",
    assetClass:     p.assetClass ?? "UNKNOWN",
    sector:         p.sector ?? null,
    isCash:         p.isCash ?? false,
    symbol:         p.symbol ?? null,
    name:           p.symbol ?? null,
    share:          null,
    costBasis:      p.costBasis ?? null,
  } as unknown as CurrentPositionRow;
}

function main(): void {
  const rows: CurrentPositionRow[] = [
    row({ instrumentId: "A", accountId: "acct1", reportingValue: 6000, assetClass: "EQUITY", sector: "Technology", symbol: "NVDA", costBasis: 4000 }),
    row({ instrumentId: "B", accountId: "acct1", reportingValue: 3000, assetClass: "ETF", symbol: "VOO" }),
    row({ instrumentId: "C", accountId: "acct2", reportingValue: 1000, assetClass: "CASH", isCash: true, symbol: "CASH" }),
    row({ instrumentId: "A", accountId: "acct2", reportingValue: 2000, assetClass: "EQUITY", sector: "Technology", symbol: "NVDA" }),
    row({ instrumentId: "D", accountId: "acct2", reportingValue: null, assetClass: "EQUITY", symbol: "XYZ" }), // unvalued
  ];
  const portfolio: InvestmentsPortfolio = {
    reportingCurrency: "USD",
    valuedSubtotal:    12000,
    valuedCount:       4,
    unvaluedCount:     1,
    unvalued:          [],
    completeness:      { tier: "incomplete", conflict: false, reason: "one position unvalued", byInstrument: {} },
  };
  const positions: CurrentPositions = { asOf: "2026-07-16", reportingCurrency: "USD", rows, portfolio };
  const names = { acct1: "Brokerage", acct2: "Roth IRA" };

  const current = assembleCurrentPortfolio(positions, names);

  console.log("1. verbatim passthrough — no copy, no re-derivation");
  check("asOf passed through", current.asOf === "2026-07-16");
  check("reportingCurrency passed through", current.reportingCurrency === "USD");
  check("holdings IS positions.rows (same reference)", current.holdings === rows);
  check("portfolio IS positions.portfolio (same reference)", current.portfolio === portfolio);
  check("holdings retain costBasis (getCurrentPositions additive field)", current.holdings[0].costBasis === 4000);

  console.log("2. allocation folded in — matches the shared computeAllocation");
  const expected = computeAllocation(rows, names);
  check("allocation === computeAllocation(rows, names)",
    JSON.stringify(current.allocation) === JSON.stringify(expected));
  check("valuedTotal = 12000 (unvalued excluded)", current.allocation.valuedTotal === 12000);
  check("byAccount uses supplied names (Brokerage 9000)",
    current.allocation.byAccount[0].label === "Brokerage" && current.allocation.byAccount[0].value === 9000);
  check("concentration excludes cash — topSymbol NVDA", current.allocation.concentration.topSymbol === "NVDA");
  check("NVDA topWeight = 8000/11000", approx(current.allocation.concentration.topWeight!, 8000 / 11000));

  console.log("3. missing name → Unknown account fallback (no throw)");
  const noNames = assembleCurrentPortfolio(positions);
  check("byAccount label falls back to 'Unknown account'",
    noNames.allocation.byAccount.every((s) => s.label === "Unknown account"));

  console.log("4. empty portfolio");
  const empty = assembleCurrentPortfolio({
    asOf: "2026-07-16", reportingCurrency: "USD", rows: [],
    portfolio: { ...portfolio, valuedSubtotal: 0, valuedCount: 0, unvaluedCount: 0 },
  });
  check("empty → no holdings, zero allocation total",
    empty.holdings.length === 0 && empty.allocation.valuedTotal === 0);
  check("empty → INSUFFICIENT_DATA concentration",
    empty.allocation.concentration.classification === "INSUFFICIENT_DATA");

  console.log("5. determinism");
  const a = JSON.stringify(assembleCurrentPortfolio(positions, names));
  const b = JSON.stringify(assembleCurrentPortfolio(positions, names));
  check("identical inputs → byte-identical JSON", a === b);

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll space-data-core checks passed.");
}

main();
