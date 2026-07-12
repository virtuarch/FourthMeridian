/**
 * lib/investments/investments-time-machine-core.test.ts
 *
 * A10 — pure time-machine assembly tests. Standalone tsx script:
 *
 *     npx tsx lib/investments/investments-time-machine-core.test.ts
 *
 * Builds realistic InvestmentValuationView inputs from the canonical valuation
 * fixtures (no hand-fabricated shapes), then pins: composition shares, holding
 * order, symbol/name join, the reconciliation identity (closing = opening +
 * netExternalFlows + residual), contributions-not-market, endpoint-incompleteness,
 * completeness propagation, current-only path, and determinism.
 */

import { valueInstrumentAsOf, valuePortfolioAsOf, type InvestmentValuationView } from "./valuation-core";
import { vInput, observedPrice, priceMiss, identityFxCtx } from "./valuation.fixtures";
import { summarizePeriodFlows, type FlowEvent } from "./investment-flows-core";
import { assembleInvestmentsTimeMachine } from "./investments-time-machine-core";
import type { InvestmentEventType } from "@prisma/client";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const USD = identityFxCtx("USD");

/** A fully-valued portfolio view at `asOf` from (instrumentId → quantity × price). */
function view(asOf: string, rows: Array<{ id: string; qty: number; price: number }>, extra: ReturnType<typeof valueInstrumentAsOf>[] = []): InvestmentValuationView {
  const components = rows.map((r) =>
    valueInstrumentAsOf(vInput({ instrumentId: r.id, quantity: r.qty, price: observedPrice(r.price) }), asOf, USD),
  );
  return valuePortfolioAsOf([...components, ...extra], asOf, "USD");
}

function ev(type: InvestmentEventType, amount: number | null, date: string, opts: Partial<FlowEvent> = {}): FlowEvent {
  return { type, date, amount, fxEstimated: opts.fxEstimated ?? false, hasQuantity: opts.hasQuantity ?? false };
}

const ASOF = "2026-06-30";
const CMP = "2026-03-31";
const DISPLAY = { i1: { symbol: "AAA", name: "Alpha" }, i2: { symbol: "BBB", name: "Beta" }, i3: { symbol: null, name: "Gamma" } };

function main(): void {
  // ── 1. current-only (no compareTo): holdings, composition, no reconciliation ─
  console.log("1. current-only assembly");
  {
    const v = view(ASOF, [{ id: "i1", qty: 10, price: 200 }, { id: "i2", qty: 5, price: 100 }]); // 2000 + 500
    const r = assembleInvestmentsTimeMachine({ asOf: ASOF, compareTo: null, view: v, compareView: null, flows: null, display: DISPLAY });
    check("no compareTo → null reconciliation & flows", r.reconciliation === null && r.flows === null);
    check("portfolio subtotal = 2500", r.portfolio.valuedSubtotal === 2500);
    check("holdings joined with symbol/name", r.holdings[0].symbol === "AAA" && r.holdings[0].name === "Alpha");
    check("composition shares sum to 1", approx((r.holdings[0].share ?? 0) + (r.holdings[1].share ?? 0), 1));
    check("share reflects value weight (2000/2500 = 0.8)", approx(r.holdings.find((h) => h.instrumentId === "i1")!.share!, 0.8));
    check("overall completeness tier observed", r.completeness.tier === "observed");
  }

  // ── 2. holding order: value desc, unvalued last, ties by id ────────────────
  console.log("2. holding order");
  {
    const missing = valueInstrumentAsOf(vInput({ instrumentId: "i3", quantity: 7, price: priceMiss() }), ASOF, USD);
    const v = view(ASOF, [{ id: "i1", qty: 1, price: 100 }, { id: "i2", qty: 1, price: 900 }], [missing]);
    const r = assembleInvestmentsTimeMachine({ asOf: ASOF, compareTo: null, view: v, compareView: null, flows: null, display: DISPLAY });
    check("order: i2 (900) > i1 (100) > i3 (unvalued)", r.holdings.map((h) => h.instrumentId).join(",") === "i2,i1,i3");
    check("unvalued holding has null share", r.holdings.find((h) => h.instrumentId === "i3")!.share === null);
    check("portfolio unvalued remainder explicit", r.portfolio.unvaluedCount === 1 && r.completeness.tier === "incomplete");
  }

  // ── 3. reconciliation identity: closing = opening + netExternal + residual ─
  console.log("3. reconciliation identity");
  {
    const opening = view(CMP, [{ id: "i1", qty: 10, price: 100 }]);  // 1000
    const closing = view(ASOF, [{ id: "i1", qty: 10, price: 130 }]); // 1300 (+300 market)
    // User also contributed 200 cash and bought/sold internally in the period.
    const flows = summarizePeriodFlows([
      ev("CONTRIBUTION", 200, "2026-05-01"),
      ev("BUY", -200, "2026-05-02"),   // internal — must not affect netExternal
      ev("DIVIDEND", 15, "2026-06-01"),// internal income
    ], CMP, ASOF, "USD");
    const r = assembleInvestmentsTimeMachine({ asOf: ASOF, compareTo: CMP, view: closing, compareView: opening, flows, display: DISPLAY });
    const rec = r.reconciliation!;
    check("openingValue 1000, closingValue 1300", rec.openingValue === 1000 && rec.closingValue === 1300);
    check("totalChange 300", rec.totalChange === 300);
    check("netExternalFlows = 200 (contribution only; buy/dividend excluded)", rec.netExternalFlows === 200);
    check("residualChange = 300 − 200 = 100 (market + income, unlabelled as gain)", rec.residualChange === 100);
    check("identity holds: closing = opening + netExternal + residual",
      approx(rec.openingValue + rec.netExternalFlows + rec.residualChange, rec.closingValue));
    check("residual carries the honest bundle label", /market movement/.test(rec.residualReason));
    check("fully-valued endpoints → not endpointIncomplete, observed", rec.endpointIncomplete === false && rec.completeness === "observed");
  }

  // ── 4. contribution is not market performance ──────────────────────────────
  console.log("4. contribution ≠ market");
  {
    // Value unchanged; the whole increase is an external contribution.
    const opening = view(CMP, [{ id: "i1", qty: 10, price: 100 }]);  // 1000
    const closing = view(ASOF, [{ id: "i1", qty: 12, price: 100 }]); // 1200 (200 from a $200 buy funded by contribution)
    const flows = summarizePeriodFlows([ev("CONTRIBUTION", 200, "2026-05-01"), ev("BUY", -200, "2026-05-01", { hasQuantity: true })], CMP, ASOF, "USD");
    const rec = assembleInvestmentsTimeMachine({ asOf: ASOF, compareTo: CMP, view: closing, compareView: opening, flows, display: DISPLAY }).reconciliation!;
    check("all change attributed to external flow, zero residual (no fabricated market gain)",
      rec.netExternalFlows === 200 && rec.residualChange === 0);
  }

  // ── 5. endpoint incompleteness makes the reconciliation partial ────────────
  console.log("5. endpoint incompleteness");
  {
    const missing = valueInstrumentAsOf(vInput({ instrumentId: "i2", quantity: 5, price: priceMiss() }), ASOF, USD);
    const opening = view(CMP, [{ id: "i1", qty: 10, price: 100 }]);
    const closing = view(ASOF, [{ id: "i1", qty: 10, price: 120 }], [missing]); // one unvalued holding
    const rec = assembleInvestmentsTimeMachine({ asOf: ASOF, compareTo: CMP, view: closing, compareView: opening, flows: null, display: DISPLAY }).reconciliation!;
    check("endpointIncomplete set", rec.endpointIncomplete === true);
    check("completeness incomplete", rec.completeness === "incomplete");
    check("reason states the partial", /partial/.test(rec.reason));
  }

  // ── 6. completeness propagation across flows ───────────────────────────────
  console.log("6. completeness propagation");
  {
    const opening = view(CMP, [{ id: "i1", qty: 10, price: 100 }]);
    const closing = view(ASOF, [{ id: "i1", qty: 10, price: 120 }]);
    const flows = summarizePeriodFlows([ev("TRANSFER_IN", null, "2026-05-01", { hasQuantity: true })], CMP, ASOF, "USD"); // in-kind → incomplete
    const r = assembleInvestmentsTimeMachine({ asOf: ASOF, compareTo: CMP, view: closing, compareView: opening, flows, display: DISPLAY });
    check("in-kind flow drags overall envelope to incomplete", r.completeness.tier === "incomplete");
    check("byComponent keeps per-part tiers", r.completeness.byComponent!.asOf === "observed" && r.completeness.byComponent!.flows === "incomplete");
  }

  // ── 7. empty portfolio ─────────────────────────────────────────────────────
  console.log("7. empty portfolio");
  {
    const v = valuePortfolioAsOf([], ASOF, "USD");
    const r = assembleInvestmentsTimeMachine({ asOf: ASOF, compareTo: null, view: v, compareView: null, flows: null, display: {} });
    check("empty → no holdings, unknown tier", r.holdings.length === 0 && r.completeness.tier === "unknown");
  }

  // ── 8. determinism ─────────────────────────────────────────────────────────
  console.log("8. determinism");
  {
    const opening = view(CMP, [{ id: "i1", qty: 10, price: 100 }]);
    const closing = view(ASOF, [{ id: "i1", qty: 10, price: 130 }, { id: "i2", qty: 2, price: 50 }]);
    const flows = summarizePeriodFlows([ev("CONTRIBUTION", 200, "2026-05-01")], CMP, ASOF, "USD");
    const a = assembleInvestmentsTimeMachine({ asOf: ASOF, compareTo: CMP, view: closing, compareView: opening, flows, display: DISPLAY });
    const b = assembleInvestmentsTimeMachine({ asOf: ASOF, compareTo: CMP, view: closing, compareView: opening, flows, display: DISPLAY });
    check("identical inputs → byte-identical JSON", JSON.stringify(a) === JSON.stringify(b));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll investments-time-machine-core checks passed.");
  process.exit(0);
}

main();
