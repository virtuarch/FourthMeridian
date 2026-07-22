/**
 * lib/investments/investments-time-machine-coverage.test.ts
 *
 * The A10 COVERAGE regression wall (the "two investment truths" slice). Standalone:
 *
 *     npx tsx lib/investments/investments-time-machine-coverage.test.ts
 *
 * Proves the class of bug behind the hero "+364%" cannot silently return:
 *   1. A partial opening is DETECTED — a period change over a coverage-inconsistent
 *      pair carries `coverageConsistent: false`, so a consumer can never present it
 *      as a whole-portfolio return.
 *   2. Coverage metadata is CORRECT — valuedValue / observedValue / estimatedValue /
 *      unavailableCount / unavailableValue / coverageByCount / fullyObserved, with
 *      the invariant `observedValue + estimatedValue === valuedSubtotal`.
 *   3. A10 authority is INTACT — one valuation engine (getInvestmentValueAsOf),
 *      silent-absence closed via holdConstantBeforeEarliest, NO snapshot substitution,
 *      coverage computed in ONE place.
 *
 * Pure: builds real views from the canonical valuation fixtures (no hand-forged
 * shapes), plus type-level + source-scan structural guards. No DB, no prisma generate.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InvestmentEventType } from "@prisma/client";
import { valueInstrumentAsOf, valuePortfolioAsOf, type InvestmentValuationView } from "./valuation-core";
import { vInput, observedPrice, estimatedPrice, priceMiss, identityFxCtx } from "./valuation.fixtures";
import { summarizePeriodFlows, type FlowEvent } from "./investment-flows-core";
import {
  assembleInvestmentsTimeMachine,
  buildValuationCoverage,
  type ChangeInterpretation,
  type InvestmentsPortfolio,
  type InvestmentsReconciliation,
  type PortfolioValuationCoverage,
} from "./investments-time-machine-core";

// ── TYPE-LEVEL guards (compile-time; tsc is the gate) ────────────────────────
// Coverage is REQUIRED on the contract — a consumer can never receive a subtotal
// without the coverage that qualifies it (the "no valuedSubtotal-as-total" guard).
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type _PortfolioHasCoverage   = Expect<Equal<InvestmentsPortfolio["coverage"], PortfolioValuationCoverage>>;
type _ReconOpeningCoverage   = Expect<Equal<InvestmentsReconciliation["openingCoverage"], PortfolioValuationCoverage>>;
type _ReconClosingCoverage   = Expect<Equal<InvestmentsReconciliation["closingCoverage"], PortfolioValuationCoverage>>;
type _ReconConsistentVerdict = Expect<Equal<InvestmentsReconciliation["coverageConsistent"], boolean>>;
// `unavailableValue` is honestly nullable (a missing price has no magnitude — never 0-as-known).
type _UnavailableNullable    = Expect<Equal<PortfolioValuationCoverage["unavailableValue"], number | null>>;
// The return verdict is a required, fixed-vocabulary field — a consumer must read it
// before showing a percentage; it can never be silently absent.
type _ChangeVerdictRequired  = Expect<Equal<InvestmentsReconciliation["changeInterpretation"], ChangeInterpretation>>;
type _ChangeVerdictUnion     = Expect<Equal<ChangeInterpretation, "return" | "value-change" | "incomparable">>;
type _HasExternalFlagReq     = Expect<Equal<InvestmentsReconciliation["hasExternalFlows"], boolean>>;

// ── Runtime harness ──────────────────────────────────────────────────────────
let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const USD = identityFxCtx("USD");
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** An observed valued component (real price, tier observed). */
function observed(id: string, qty: number, price: number) {
  return valueInstrumentAsOf(vInput({ instrumentId: id, quantity: qty, price: observedPrice(price) }), "2026-06-30", USD);
}
/** An ESTIMATED valued component (walked-back price ⇒ overall tier estimated). */
function estimated(id: string, qty: number, price: number) {
  return valueInstrumentAsOf(vInput({ instrumentId: id, quantity: qty, price: estimatedPrice(price) }), "2026-06-30", USD);
}
/** An UNVALUED component (price miss ⇒ reportingValue null, an unavailable remainder). */
function unvalued(id: string, qty: number) {
  return valueInstrumentAsOf(vInput({ instrumentId: id, quantity: qty, price: priceMiss() }), "2026-06-30", USD);
}
function viewOf(asOf: string, comps: ReturnType<typeof valueInstrumentAsOf>[]): InvestmentValuationView {
  return valuePortfolioAsOf(comps, asOf, "USD");
}

function main(): void {
  // ── 1. Coverage metadata correctness + the observed/estimated split invariant ─
  console.log("1. coverage metadata correctness");
  {
    // 1 observed ($2000) + 1 estimated ($500) + 1 unvalued (no price).
    const v = viewOf("2026-06-30", [observed("i1", 10, 200), estimated("i2", 5, 100), unvalued("i3", 3)]);
    const cov = buildValuationCoverage(v);

    check("valuedValue == valuedSubtotal (the confident floor)", approx(cov.valuedValue, v.valuedSubtotal));
    check("valuedValue == 2500", approx(cov.valuedValue, 2500));
    check("observedValue == 2000 (only the observed-tier position)", approx(cov.observedValue, 2000));
    check("estimatedValue == 500 (the reconstructed portion)", approx(cov.estimatedValue, 500));
    check("INVARIANT observedValue + estimatedValue == valuedSubtotal",
      approx(cov.observedValue + cov.estimatedValue, v.valuedSubtotal));
    check("valuedCount == 2", cov.valuedCount === 2);
    check("unavailableCount == 1 (the price-miss position)", cov.unavailableCount === 1);
    check("unavailableValue == null (no honest magnitude — never 0-as-known)", cov.unavailableValue === null);
    check("coverageByCount == 2/3", approx(cov.coverageByCount, 2 / 3));
    check("fullyObserved == false (an estimate AND an unavailable both present)", cov.fullyObserved === false);
  }

  // ── 2. A fully-observed view is fully covered ────────────────────────────────
  console.log("2. fully-observed coverage");
  {
    const v = viewOf("2026-06-30", [observed("i1", 10, 200), observed("i2", 4, 50)]); // 2000 + 200
    const cov = buildValuationCoverage(v);
    check("fullyObserved == true", cov.fullyObserved === true);
    check("estimatedValue == 0", cov.estimatedValue === 0);
    check("unavailableCount == 0", cov.unavailableCount === 0);
    check("coverageByCount == 1", cov.coverageByCount === 1);
    check("observedValue == valuedValue", approx(cov.observedValue, cov.valuedValue));
  }
  {
    // Empty portfolio: nothing held ⇒ trivially covered (never a divide-by-zero).
    const cov = buildValuationCoverage(viewOf("2026-06-30", []));
    check("empty portfolio ⇒ coverageByCount == 1 (no NaN)", cov.coverageByCount === 1);
    check("empty portfolio ⇒ fullyObserved == true", cov.fullyObserved === true);
  }

  // ── 3. A PARTIAL OPENING CANNOT SILENTLY CREATE A FAKE RETURN ────────────────
  console.log("3. partial opening ⇒ coverageConsistent false (the +364% guard)");
  {
    // Opening: only $1000 could be valued, and a position was UNVALUED (partial).
    const opening = viewOf("2026-03-31", [observed("i1", 5, 200), unvalued("i2", 10)]); // valued 1000, 1 unavailable
    // Closing: the whole book valued at $10000 (coverage filled in).
    const closing = viewOf("2026-06-30", [observed("i1", 20, 200), observed("i2", 60, 100)]); // 4000 + 6000
    const rec = assembleInvestmentsTimeMachine({
      asOf: "2026-06-30", compareTo: "2026-03-31", view: closing, compareView: opening, flows: null, display: {},
    }).reconciliation!;

    // The naive percentage a partial opening WOULD produce — proof the raw number lies.
    const naivePct = (rec.totalChange / rec.openingValue) * 100;
    check("naive totalChange/openingValue is absurd here (>300%)", naivePct > 300);

    check("openingCoverage.unavailableCount > 0 (the opening dropped a position)", rec.openingCoverage.unavailableCount > 0);
    check("openingCoverage.coverageByCount < 1", rec.openingCoverage.coverageByCount < 1);
    check("openingCoverage.fullyObserved == false", rec.openingCoverage.fullyObserved === false);
    check("closingCoverage.fullyObserved == true", rec.closingCoverage.fullyObserved === true);
    check("VERDICT coverageConsistent == false ⇒ change is NOT a whole-portfolio return",
      rec.coverageConsistent === false);
    check("endpointIncomplete flags the partial subtotal (existing signal preserved)", rec.endpointIncomplete === true);
  }

  // ── 4. A like-for-like change stays consistent ───────────────────────────────
  console.log("4. like-for-like change ⇒ coverageConsistent true");
  {
    const opening = viewOf("2026-03-31", [observed("i1", 10, 180), observed("i2", 5, 80)]);  // 1800 + 400
    const closing = viewOf("2026-06-30", [observed("i1", 10, 200), observed("i2", 5, 100)]); // 2000 + 500
    const rec = assembleInvestmentsTimeMachine({
      asOf: "2026-06-30", compareTo: "2026-03-31", view: closing, compareView: opening, flows: null, display: {},
    }).reconciliation!;
    check("both endpoints fully valued ⇒ coverageConsistent == true", rec.coverageConsistent === true);
    check("a sane percentage (~13.6%)", approx((rec.totalChange / rec.openingValue) * 100, 300 / 2200 * 100, 1e-3));
  }

  // ── 5. Coverage is SURFACED on the portfolio (consumers read it, not internals) ─
  console.log("5. coverage surfaced on the portfolio");
  {
    const v = viewOf("2026-06-30", [observed("i1", 10, 200), unvalued("i2", 3)]);
    const portfolio = assembleInvestmentsTimeMachine({
      asOf: "2026-06-30", compareTo: null, view: v, compareView: null, flows: null, display: {},
    }).portfolio;
    const direct = buildValuationCoverage(v);
    check("portfolio.coverage matches buildValuationCoverage(view)",
      JSON.stringify(portfolio.coverage) === JSON.stringify(direct));
    check("portfolio.coverage.unavailableCount reflects the unvalued remainder", portfolio.coverage.unavailableCount === 1);
  }

  // ── 6. A10 AUTHORITY INTACT (source-scan) ────────────────────────────────────
  console.log("6. A10 authority intact");
  {
    const tm = read("lib/investments/investments-time-machine.ts");
    check("A10 values via getInvestmentValueAsOf (the single engine, not a second authority)",
      /getInvestmentValueAsOf\s*\(/.test(tm));
    check("A10 enables holdConstantBeforeEarliest (silent absence → disclosed estimate)",
      /holdConstantBeforeEarliest:\s*true/.test(tm));
    check("A10 does NOT substitute snapshots for valuation (no SpaceSnapshot / portfolio-series read)",
      !/getRecentSnapshots|SpaceSnapshot|spaceSnapshot|portfolio-series/.test(tm));
    check("A10 defines no second valuation engine (no valuePortfolioAsOf/valueInstrumentAsOf here)",
      !/valuePortfolioAsOf|valueInstrumentAsOf/.test(tm));

    const core = read("lib/investments/investments-time-machine-core.ts");
    check("coverage is derived by buildValuationCoverage (the by-count formula lives there)",
      /coverageByCount:\s*held === 0 \? 1 :/.test(core));
    check("coverageConsistent is the like-for-like verdict (both endpoints unavailable-free)",
      /unavailableCount === 0 &&\s*closingCoverage\.unavailableCount === 0/.test(core));
  }

  // ── 7. RETURN INTEGRITY — a % is a return only when flows are zero ────────────
  console.log("7. change interpretation (return vs value-change vs incomparable)");
  const ev = (type: InvestmentEventType, amount: number | null, hasQuantity = false): FlowEvent =>
    ({ type, date: "2026-05-15", amount, fxEstimated: false, hasQuantity });
  const flowsOf = (events: FlowEvent[]) => summarizePeriodFlows(events, "2026-03-31", "2026-06-30", "USD");
  const recon = (opening: InvestmentValuationView, closing: InvestmentValuationView, flows: ReturnType<typeof flowsOf> | null) =>
    assembleInvestmentsTimeMachine({
      asOf: "2026-06-30", compareTo: "2026-03-31", view: closing, compareView: opening, flows, display: {},
    }).reconciliation!;
  const full = (v: number) => viewOf("x", [observed("i1", 1, v)]); // one observed position worth v

  {
    // Comparable universe, NO external flows ⇒ a genuine holding-period return.
    const rec = recon(full(1000), full(1100), flowsOf([]));
    check("comparable + flow-free ⇒ hasExternalFlows false", rec.hasExternalFlows === false);
    check("comparable + flow-free ⇒ changeInterpretation 'return'", rec.changeInterpretation === "return");
  }
  {
    // THE +550% long-range case: opening $10k, +$50k contributions, closing $65k.
    const rec = recon(full(10_000), full(65_000), flowsOf([ev("CONTRIBUTION", 50_000)]));
    check("long-range naive pct is +550% (the misleading number)", approx((rec.totalChange / rec.openingValue) * 100, 550));
    check("but hasExternalFlows == true", rec.hasExternalFlows === true);
    check("VERDICT changeInterpretation 'value-change' (NOT a return)", rec.changeInterpretation === "value-change");
    check("residualChange isolates the ~$5k not explained by flows", approx(rec.residualChange, 5_000));
  }
  {
    // Net-zero offsetting flows STILL break the simple return (gross, not net).
    const rec = recon(full(1000), full(1100), flowsOf([ev("CONTRIBUTION", 1000), ev("WITHDRAWAL", -1000)]));
    check("offsetting flows ⇒ netExternalFlows == 0", rec.netExternalFlows === 0);
    check("offsetting flows ⇒ hasExternalFlows STILL true (gross, not net)", rec.hasExternalFlows === true);
    check("offsetting flows ⇒ 'value-change', never 'return'", rec.changeInterpretation === "value-change");
  }
  {
    // Unmeasured external value (in-kind transfer: units, no cash leg) ⇒ value-change.
    const rec = recon(full(1000), full(1100), flowsOf([ev("TRANSFER_IN", null, true)]));
    check("in-kind transfer ⇒ hasExternalFlows true (unmeasured external value)", rec.hasExternalFlows === true);
    check("in-kind transfer ⇒ 'value-change'", rec.changeInterpretation === "value-change");
  }
  {
    // Coverage inconsistency OUTRANKS flows ⇒ incomparable (no defensible %).
    const opening = viewOf("x", [observed("i1", 1, 500), unvalued("i2", 3)]); // partial opening
    const rec = recon(opening, full(2000), flowsOf([])); // even flow-free
    check("partial opening ⇒ coverageConsistent false", rec.coverageConsistent === false);
    check("partial opening ⇒ changeInterpretation 'incomparable' (outranks flow-free)", rec.changeInterpretation === "incomparable");
  }

  // Reference the type-level asserts so they are load-bearing.
  void (null as unknown as [_ChangeVerdictRequired, _ChangeVerdictUnion, _HasExternalFlagReq,
    _PortfolioHasCoverage, _ReconOpeningCoverage, _ReconClosingCoverage, _ReconConsistentVerdict, _UnavailableNullable]);

  if (failures > 0) { console.error(`\n${failures} coverage check(s) failed.`); process.exit(1); }
  console.log("\nAll A10 coverage + return-integrity checks passed.");
}

main();
