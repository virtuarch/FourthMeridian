/**
 * lib/investments/space-data-composition.test.ts  (PCS-1D)
 *
 * Pure fixture test for the four-slice workspace composition (house convention,
 * no prisma generate):  npx tsx lib/investments/space-data-composition.test.ts
 *
 * Pins the ownership boundary: `activity` IS `historical.flows` (same reference,
 * no re-read), `trust` IS `buildInvestmentsTrustSummary(historical)` (same
 * reduction), a current-only compose carries none of the historical slices, and a
 * historical result with no window carries trust but no activity. Composition adds
 * NO arithmetic — it re-surfaces already-canonical values.
 */

import { assembleInvestmentsSpaceData } from "./space-data-core";
import type { CurrentPortfolio } from "./space-data-core";
import { buildInvestmentsTrustSummary } from "./investments-trust";
import type { PeriodFlows } from "./investment-flows-core";
import type { InvestmentsTimeMachineResult, InvestmentsReconciliation } from "./investments-time-machine-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const CUR = "USD";

function currentPortfolio(): CurrentPortfolio {
  return {
    asOf: "2026-07-16",
    reportingCurrency: CUR,
    holdings: [],
    portfolio: {
      reportingCurrency: CUR, valuedSubtotal: 1200, valuedCount: 3, unvaluedCount: 0,
      unvalued: [], completeness: { tier: "observed", conflict: false, reason: "ok", byInstrument: {} },
    },
    allocation: {
      valuedTotal: 1200, valuedCount: 3, unvaluedCount: 0,
      byAssetClass: [], bySector: [], byAccount: [], byCurrency: [],
      concentration: { classification: "INSUFFICIENT_DATA", topSymbol: null, topWeight: null, top5Weight: null, herfindahl: null, effectiveHoldings: null },
    },
  } as unknown as CurrentPortfolio;
}

function flows(): PeriodFlows {
  return {
    from: "2026-01-01", to: "2026-03-31", reportingCurrency: CUR, eventCount: 3,
    contributions: 0, withdrawals: 0, transfersIn: 0, transfersOut: 0,
    buys: 0, sells: 0, income: 0, fees: 0, netExternalFlows: 0, byCategory: [],
    inKindTransferCount: 0, unclassifiedCount: 0, externalAmountMissingCount: 0,
    fxEstimated: false, completeness: "observed", reason: "3 events in the period.",
  } as unknown as PeriodFlows;
}

function reconciliation(): InvestmentsReconciliation {
  return {
    from: "2026-01-01", to: "2026-03-31", reportingCurrency: CUR,
    openingValue: 1000, closingValue: 1200, totalChange: 200,
    netExternalFlows: 50, residualChange: 150, residualReason: "residual",
    completeness: "observed", conflict: false, endpointIncomplete: false, reason: "reconciled",
  } as unknown as InvestmentsReconciliation;
}

function historical(withWindow: boolean): InvestmentsTimeMachineResult {
  return {
    asOf: "2026-03-31",
    compareTo: withWindow ? "2026-01-01" : null,
    reportingCurrency: CUR,
    holdings: [],
    portfolio: {
      reportingCurrency: CUR, valuedSubtotal: 1200, valuedCount: 3, unvaluedCount: 0,
      unvalued: [], completeness: { tier: "observed", conflict: false, reason: "ok", byInstrument: {} },
    },
    flows: withWindow ? flows() : null,
    reconciliation: withWindow ? reconciliation() : null,
    completeness: { tier: "observed", conflict: false, reason: "ok", byComponent: {} },
  } as unknown as InvestmentsTimeMachineResult;
}

function main(): void {
  const current = currentPortfolio();

  console.log("1. current-only compose — no historical slices");
  const currentOnly = assembleInvestmentsSpaceData({ current });
  check("current present (same reference)", currentOnly.current === current);
  check("historical absent", currentOnly.historical === undefined);
  check("activity absent", currentOnly.activity === undefined);
  check("trust absent", currentOnly.trust === undefined);
  check("null historical treated as current-only", assembleInvestmentsSpaceData({ current, historical: null }).trust === undefined);

  console.log("2. with historical + window — all four slices, re-surfaced not re-computed");
  const h = historical(true);
  const full = assembleInvestmentsSpaceData({ current, historical: h });
  check("current still same reference", full.current === current);
  check("historical IS the A10 result (same reference)", full.historical === h);
  check("activity IS historical.flows (same reference)", full.activity === h.flows);
  check("trust equals buildInvestmentsTrustSummary(historical)",
    JSON.stringify(full.trust) === JSON.stringify(buildInvestmentsTrustSummary(h)));
  check("trust reports the period residual (from reconciliation)", full.trust!.residual === 150);

  console.log("3. historical without a window — trust yes, activity no");
  const hNoWindow = historical(false);
  const noWindow = assembleInvestmentsSpaceData({ current, historical: hNoWindow });
  check("historical present", noWindow.historical === hNoWindow);
  check("activity absent (flows null)", noWindow.activity === undefined);
  check("trust present", noWindow.trust !== undefined);
  check("trust activityCaveat null (no window)", noWindow.trust!.activityCaveat === null);

  console.log("4. determinism");
  const a = JSON.stringify(assembleInvestmentsSpaceData({ current, historical: h }));
  const b = JSON.stringify(assembleInvestmentsSpaceData({ current, historical: h }));
  check("identical inputs → byte-identical JSON", a === b);

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll space-data-composition checks passed.");
}

main();
