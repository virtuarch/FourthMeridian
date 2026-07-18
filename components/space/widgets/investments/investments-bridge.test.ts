/**
 * components/space/widgets/investments/investments-bridge.test.ts
 *
 * Pure tests for the Change Bridge presentation model. Deterministic, DB-free
 * (house pattern):
 *
 *   npx tsx components/space/widgets/investments/investments-bridge.test.ts
 *
 * Locks:
 *   1. null reconciliation ⇒ no-comparison state.
 *   2. The identity holds row-by-row across sign fixtures:
 *      opening + moneyIn + moneyOut + residual = closing.
 *   3. Fees/buys/sells are NEVER added to money-in/out (they're inside residual);
 *      money_in = contributions + transfersIn, money_out = withdrawals + transfersOut.
 *   4. endpointIncomplete / conflict surface a caveat; a clean reconciliation does not.
 *   5. A broken identity throws (the dev guard), rather than rendering a lie.
 */

import type { InvestmentsReconciliation } from "@/lib/investments/investments-time-machine-core";
import type { PeriodFlows, FlowCategorySummary } from "@/lib/investments/investment-flows-core";
import { buildBridgeRows } from "./investments-bridge";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function recon(over: Partial<InvestmentsReconciliation>): InvestmentsReconciliation {
  const openingValue = over.openingValue ?? 10000;
  const closingValue = over.closingValue ?? 12000;
  const netExternalFlows = over.netExternalFlows ?? 0;
  return {
    from: "2026-01-01", to: "2026-02-01", reportingCurrency: "USD",
    openingValue, closingValue,
    totalChange: closingValue - openingValue,
    netExternalFlows,
    residualChange: (closingValue - openingValue) - netExternalFlows,
    residualReason: "Change not explained by external contributions, withdrawals, or transfers.",
    completeness: "observed", conflict: false, endpointIncomplete: false,
    openingCoverage: bridgeCov(openingValue), closingCoverage: bridgeCov(closingValue), coverageConsistent: true,
    hasExternalFlows: netExternalFlows !== 0,
    changeInterpretation: netExternalFlows !== 0 ? "value-change" : "return",
    reason: "Closing value = opening value + net external flows + residual.",
    ...over,
  };
}

/** A fully-covered coverage fixture for the bridge tests (the bridge reads levels,
 *  not coverage, so a single observed block per endpoint suffices). */
function bridgeCov(valuedValue: number): InvestmentsReconciliation["openingCoverage"] {
  return {
    valuedValue, observedValue: valuedValue, estimatedValue: 0,
    valuedCount: 1, unavailableCount: 0, unavailableValue: null,
    coverageByCount: 1, fullyObserved: true,
  };
}

function flows(over: Partial<PeriodFlows> & { byCategory?: FlowCategorySummary[] }): PeriodFlows {
  return {
    from: "2026-01-01", to: "2026-02-01", reportingCurrency: "USD",
    eventCount: 1,
    contributions: 0, withdrawals: 0, transfersIn: 0, transfersOut: 0,
    buys: 0, sells: 0, income: 0, fees: 0, netExternalFlows: 0,
    byCategory: over.byCategory ?? [],
    inKindTransferCount: 0, unclassifiedCount: 0, externalAmountMissingCount: 0, fxEstimated: false,
    completeness: "observed", reason: "",
    ...over,
  };
}

/** Assert the identity directly from the returned rows. */
function identityHolds(rows: ReturnType<typeof buildBridgeRows>["rows"]): boolean {
  const by = Object.fromEntries(rows.map((r) => [r.key, r.amount]));
  const lhs = by.opening + by.money_in + by.money_out + by.residual;
  return Math.abs(lhs - by.closing) < 0.005;
}

console.log("1. null reconciliation ⇒ no-comparison");
{
  const m = buildBridgeRows(null, null);
  check("state is no-comparison", m.state === "no-comparison");
  check("no rows", m.rows.length === 0);
}

console.log("2 & 3. Identity across sign fixtures; in/out split excludes internal flows");
{
  // net external = 3000 in - 1000 out = +2000; residual = 2000 - 2000 = 0.
  const f = flows({
    contributions: 2500, transfersIn: 500, withdrawals: -600, transfersOut: -400,
    buys: -5000, sells: 1200, income: 300, fees: -50, netExternalFlows: 2000,
  });
  const r = recon({ openingValue: 10000, closingValue: 14000, netExternalFlows: 2000 });
  const m = buildBridgeRows(r, f);
  check("reconciled", m.state === "reconciled");
  check("identity holds", identityHolds(m.rows));
  const by = Object.fromEntries(m.rows.map((x) => [x.key, x.amount]));
  check("money_in = contributions + transfersIn (3000)", by.money_in === 3000);
  check("money_out = withdrawals + transfersOut (-1000)", by.money_out === -1000);
  check("residual excludes fees/buys/sells (= 2000)", by.residual === 2000);
  check("five rows opening→closing", m.rows.map((x) => x.key).join(",") === "opening,money_in,money_out,residual,closing");

  // Negative-change fixture: net external -2000, portfolio dropped further.
  const r2 = recon({ openingValue: 20000, closingValue: 15000, netExternalFlows: -2000 });
  const f2 = flows({ withdrawals: -1500, transfersOut: -500, netExternalFlows: -2000 });
  const m2 = buildBridgeRows(r2, f2);
  check("negative fixture identity holds", identityHolds(m2.rows));
  check("negative fixture residual = -3000", Object.fromEntries(m2.rows.map((x) => [x.key, x.amount])).residual === -3000);

  // Null flows alongside a reconciliation: whole net collapses, identity still holds.
  const m3 = buildBridgeRows(recon({ openingValue: 5000, closingValue: 6000, netExternalFlows: 0 }), null);
  check("null-flows identity holds", identityHolds(m3.rows));
}

console.log("4. Caveats from endpointIncomplete / conflict; clean ⇒ none");
{
  const clean = buildBridgeRows(recon({}), flows({}));
  check("clean ⇒ no caveat", clean.caveat === null);
  const incomplete = buildBridgeRows(recon({ endpointIncomplete: true, reason: "Opening or closing value is a partial subtotal." }), flows({}));
  check("endpointIncomplete ⇒ caveat present", incomplete.caveat === "Opening or closing value is a partial subtotal.");
  const conflicted = buildBridgeRows(recon({ conflict: true, reason: "A position carries a reconstruction conflict." }), flows({}));
  check("conflict ⇒ caveat present", conflicted.caveat === "A position carries a reconstruction conflict.");
  check("residualReason surfaced", clean.residualReason != null && clean.residualReason.length > 0);
}

console.log("5. Broken identity throws (dev guard)");
{
  // Force disagreement: reconciliation says residual makes it close, but we hand
  // flows whose in/out split contradicts netExternalFlows AND the levels.
  let threw = false;
  try {
    buildBridgeRows(
      { from: "2026-01-01", to: "2026-02-01", reportingCurrency: "USD",
        openingValue: 100, closingValue: 200, totalChange: 100, netExternalFlows: 0,
        residualChange: 999, // deliberately wrong: 100 + 0 + 0 + 999 ≠ 200
        residualReason: "x", completeness: "observed", conflict: false, endpointIncomplete: false,
        openingCoverage: bridgeCov(100), closingCoverage: bridgeCov(200), coverageConsistent: true,
        hasExternalFlows: false, changeInterpretation: "return", reason: "x" },
      null,
    );
  } catch { threw = true; }
  check("mismatched residual throws", threw);
}

if (failures > 0) { console.error(`\n${failures} investments-bridge check(s) failed`); process.exit(1); }
console.log("\nAll investments-bridge checks passed");
