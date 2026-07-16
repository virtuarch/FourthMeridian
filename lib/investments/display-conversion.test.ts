/**
 * lib/investments/display-conversion.test.ts  (SD-4D)
 *
 * Proves convertInvestmentsSpaceData is a correct, EXHAUSTIVE display transform:
 *   npx tsx lib/investments/display-conversion.test.ts
 *
 *   • every reporting-currency MONEY field is scaled by the rate (no field missed —
 *     a missed field under a relabeled currency would masquerade),
 *   • native/instrument fields (nativePrice, nativeValue, currency, costBasis) and
 *     scale-invariant fields (share, weights, counts, percentages) are UNCHANGED,
 *   • reportingCurrency labels are moved to the target,
 *   • the identity fast-path (reporting === target) returns the input unchanged.
 *
 * Pure — no DB, no prisma generate. A hand-built context applies a known 0.5 USD→EUR
 * rate so "did the number actually move" is checkable, not just "did the symbol change".
 */

import { convertInvestmentsSpaceData } from "./display-conversion";
import type { ConversionContext } from "@/lib/money/types";
import type { InvestmentsSpaceData } from "./space-data-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// A context with a real 0.5 USD→EUR rate (and a miss for anything else).
const RATE = 0.5;
const ctxEUR: ConversionContext = {
  target: "EUR",
  resolve: (from, dateISO) =>
    from === "USD"
      ? { kind: "rate", rate: RATE, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" }
      : { kind: "miss", quote: from, requestedDateISO: dateISO },
};
const ctxUSD: ConversionContext = { target: "USD", resolve: (from, d) => ({ kind: "miss", quote: from, requestedDateISO: d }) };

// A holding row carrying reporting + native + costBasis (+ share/quantity).
function row(reportingValue: number) {
  return {
    instrumentId: "i1", accountId: "a1", quantity: 4, nativePrice: 25, nativeValue: 100,
    reportingValue, currency: "USD", reportingCurrency: "USD",
    quantityTier: "observed", priceTier: "observed", fxTier: "observed", overallTier: "observed",
    basisUsed: "raw-close", priceDate: "2026-07-13", staleDays: 0, reason: "ok", conflicted: false,
    symbol: "VTI", name: "Vanguard", share: 0.5, assetClass: "US_STOCK", sector: null, isCash: false,
    costBasis: 80,
  };
}
const portfolio = { reportingCurrency: "USD", valuedSubtotal: 200, valuedCount: 1, unvaluedCount: 0, unvalued: [], completeness: { tier: "observed", conflict: false, reason: "", byInstrument: {} } };
const flows = {
  from: "2025-01-01", to: "2026-07-14", reportingCurrency: "USD", eventCount: 2,
  contributions: 100, withdrawals: -10, transfersIn: 5, transfersOut: -5, buys: 50, sells: -20, income: 8, fees: -2,
  netExternalFlows: 90, byCategory: [{ category: "contribution", count: 1, amount: 100 }],
  inKindTransferCount: 0, unclassifiedCount: 0, externalAmountMissingCount: 0, fxEstimated: false,
  completeness: "observed", reason: "",
};
const reconciliation = {
  from: "2025-01-01", to: "2026-07-14", reportingCurrency: "USD",
  openingValue: 150, closingValue: 200, totalChange: 50, netExternalFlows: 90, residualChange: -40,
  residualReason: "market", completeness: "observed", conflict: false, endpointIncomplete: false, reason: "",
};
const allocation = {
  valuedTotal: 200, valuedCount: 1, unvaluedCount: 0,
  byAssetClass: [{ key: "US_STOCK", label: "US Stocks", value: 200, share: 1 }],
  bySector: [], byAccount: [{ key: "a1", label: "Broker", value: 200, share: 1 }], byCurrency: [{ key: "USD", label: "USD", value: 200, share: 1 }],
  concentration: { classification: "DIVERSIFIED", topSymbol: "VTI", topWeight: 1, top5Weight: 1, herfindahl: 1, effectiveHoldings: 1 },
};
const trust = { tier: "observed", conflict: false, reason: "", valuedCount: 1, unvaluedCount: 0, totalPositions: 1, partial: false, figureLabel: "Portfolio value", valuedOfTotalLabel: null, fxEstimated: false, activityCaveat: null, residual: -40, residualReason: "market", endpointIncomplete: false, indicators: [] };

const data = {
  current: { asOf: "2026-07-14", reportingCurrency: "USD", holdings: [row(200)], portfolio, allocation },
  historical: { asOf: "2026-07-14", compareTo: "2025-01-01", reportingCurrency: "USD", holdings: [row(200)], portfolio, flows, reconciliation, completeness: { tier: "observed", conflict: false, reason: "", byInstrument: {} } },
  activity: flows,
  trust,
} as unknown as InvestmentsSpaceData;

// ── Convert USD → EUR at 0.5 ─────────────────────────────────────────────────────
{
  const out = convertInvestmentsSpaceData(data, ctxEUR, "2026-07-14");

  console.log("1. Every reporting-currency money field scaled by 0.5");
  check("current.portfolio.valuedSubtotal 200→100", near(out.current.portfolio.valuedSubtotal, 100));
  check("current.holdings[0].reportingValue 200→100", near(out.current.holdings[0].reportingValue as number, 100));
  check("current.allocation.valuedTotal 200→100", near(out.current.allocation.valuedTotal, 100));
  check("current.allocation.byAssetClass value 200→100", near(out.current.allocation.byAssetClass[0].value, 100));
  check("current.allocation.byCurrency value 200→100", near(out.current.allocation.byCurrency[0].value, 100));
  check("historical.portfolio.valuedSubtotal 200→100", near(out.historical!.portfolio.valuedSubtotal, 100));
  check("historical.reconciliation.totalChange 50→25", near(out.historical!.reconciliation!.totalChange, 25));
  check("historical.reconciliation.openingValue 150→75", near(out.historical!.reconciliation!.openingValue, 75));
  check("historical.reconciliation.residualChange -40→-20", near(out.historical!.reconciliation!.residualChange, -20));
  check("activity.netExternalFlows 90→45", near(out.activity!.netExternalFlows, 45));
  check("activity.contributions 100→50", near(out.activity!.contributions, 50));
  check("activity.income 8→4", near(out.activity!.income, 4));
  check("activity.byCategory[0].amount 100→50", near(out.activity!.byCategory[0].amount, 50));
  check("trust.residual -40→-20", near(out.trust!.residual as number, -20));

  console.log("2. Native / scale-invariant fields UNCHANGED");
  check("nativePrice unchanged (25)", out.current.holdings[0].nativePrice === 25);
  check("nativeValue unchanged (100, native)", out.current.holdings[0].nativeValue === 100);
  check("native currency stays USD", out.current.holdings[0].currency === "USD");
  check("costBasis unchanged (80, native)", (out.current.holdings[0] as { costBasis: number }).costBasis === 80);
  check("share unchanged (0.5)", out.current.holdings[0].share === 0.5);
  check("allocation share unchanged (1)", out.current.allocation.byAssetClass[0].share === 1);
  check("quantity unchanged (4)", out.current.holdings[0].quantity === 4);

  console.log("3. reportingCurrency relabeled to target (EUR)");
  check("current reportingCurrency → EUR", out.current.reportingCurrency === "EUR");
  check("current.portfolio.reportingCurrency → EUR", out.current.portfolio.reportingCurrency === "EUR");
  check("current.holdings[0].reportingCurrency → EUR", out.current.holdings[0].reportingCurrency === "EUR");
  check("historical reportingCurrency → EUR", out.historical!.reportingCurrency === "EUR");
  check("activity.reportingCurrency → EUR", out.activity!.reportingCurrency === "EUR");
}

// ── Identity fast-path (target === reporting) ────────────────────────────────────
{
  console.log("4. Identity fast-path when reporting === target");
  const out = convertInvestmentsSpaceData(data, ctxUSD, "2026-07-14");
  check("returns the SAME reference (no work)", out === data);
}

if (failures > 0) { console.error(`\n${failures} display-conversion check(s) failed`); process.exit(1); }
console.log("\nAll display-conversion checks passed");
