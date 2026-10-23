/**
 * lib/investments/valuation.reconstruction-residue.test.ts
 *
 * V26-INVESTMENTS-HISTORY — RECONSTRUCTION RESIDUE IS NOT A SHORT POSITION.
 *
 * The regression this pins is a real one, measured on a live Schwab account: its
 * backward reconstruction ran out of provider event history and produced NEGATIVE
 * opening quantities for six positions, each with `unexplainedOpeningQuantity ==
 * openingQuantity` (nothing explained) and `reconciliation` PARTIAL or FAILED.
 * Valuation multiplied those by real market closes and booked ~−$3.4k of
 * portfolio value that no market event ever produced.
 *
 * The distinction that must survive every future edit:
 *
 *   a real SHORT              → still valued, sign intact (the money must not move)
 *   a reconstruction RESIDUE  → unvalued, with a reason, evidence preserved
 *
 * Standalone tsx script:  npx tsx lib/investments/valuation.reconstruction-residue.test.ts
 */

import {
  isReconstructionResidue,
  reconstructionResidueReason,
  valueInstrumentAsOf,
  valuePortfolioAsOf,
  type InstrumentValuation,
} from "./valuation-core";
import { vInput, observedPrice, identityFxCtx } from "./valuation.fixtures";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const ASOF = "2026-06-25";
const USD = identityFxCtx("USD");
const ACCT = "acct_schwab_llc";

/**
 * The six positions from the incident, with the openings the reconstruction
 * actually persisted and a market close from that date. Prices are only needed
 * to prove the residue would otherwise have become money.
 */
const RESIDUE = [
  { symbol: "INTC", quantity: -5,      reconciliation: "PARTIAL", price: 132.87 },
  { symbol: "NVDA", quantity: -2.003,  reconciliation: "PARTIAL", price: 195.99 },
  { symbol: "NKE",  quantity: -4,      reconciliation: "PARTIAL", price:  40.90 },
  { symbol: "JPM",  quantity: -1,      reconciliation: "PARTIAL", price: 335.12 },
  { symbol: "TXN",  quantity: -1,      reconciliation: "PARTIAL", price: 311.81 },
  { symbol: "TQQQ", quantity: -20,     reconciliation: "FAILED",  price:  74.95 },
] as const;

/** Shape an excluded component exactly as valuation.ts does when it refuses one. */
function excludedComponent(instrumentId: string, quantity: number, reason: string): InstrumentValuation {
  return {
    instrumentId, accountId: ACCT, quantity,
    nativePrice: null, nativeValue: null, reportingValue: null,
    currency: null, reportingCurrency: "USD",
    quantityTier: "derived", priceTier: "unknown", fxTier: "unknown",
    overallTier: "unknown", basisUsed: null,
    priceDate: null, staleDays: null, reason, conflicted: false,
  };
}

function main(): void {
  // ── 1. Every incident position is refused ─────────────────────────────────
  console.log("1. The six incident positions are reconstruction residue (DERIVED + not COMPLETE)");
  for (const p of RESIDUE) {
    check(`${p.symbol} (${p.quantity}, ${p.reconciliation}) is residue`,
      isReconstructionResidue({ quantity: p.quantity, origin: "DERIVED", reconciliation: p.reconciliation }));
  }

  // ── 2. The SAME quantity, observed, is a real short and must still value ──
  console.log("2. The same negative quantity OBSERVED is a real short — never refused");
  for (const p of RESIDUE) {
    check(`${p.symbol} (${p.quantity}) observed is NOT residue`,
      !isReconstructionResidue({ quantity: p.quantity, origin: "OBSERVED", reconciliation: p.reconciliation }));
  }
  check("an IMPORTED negative (statement-reported short) is NOT residue",
    !isReconstructionResidue({ quantity: -5, origin: "IMPORTED", reconciliation: "PARTIAL" }));
  check("a USER_ASSERTED negative is NOT residue",
    !isReconstructionResidue({ quantity: -5, origin: "USER_ASSERTED", reconciliation: null }));

  // ── 3. A derived short whose books DID close stays valued ─────────────────
  console.log("3. A COMPLETE reconstruction is trusted — a reconciled derived short is real");
  for (const p of RESIDUE) {
    check(`${p.symbol} (${p.quantity}) derived + COMPLETE is NOT residue`,
      !isReconstructionResidue({ quantity: p.quantity, origin: "DERIVED", reconciliation: "COMPLETE" }));
  }

  // ── 4. The guard must not over-fire ───────────────────────────────────────
  console.log("4. The guard touches nothing but unexplained derived negatives");
  check("a positive derived quantity under PARTIAL is untouched",
    !isReconstructionResidue({ quantity: 20, origin: "DERIVED", reconciliation: "PARTIAL" }));
  check("a positive derived quantity under FAILED is untouched",
    !isReconstructionResidue({ quantity: 5, origin: "DERIVED", reconciliation: "FAILED" }));
  check("an explicit closed-zero is left to the known-zero contract, not refused here",
    !isReconstructionResidue({ quantity: 0, origin: "DERIVED", reconciliation: "PARTIAL" }));
  check("an uncovered (null) quantity is left to the hold-constant contract",
    !isReconstructionResidue({ quantity: null, origin: "DERIVED", reconciliation: "PARTIAL" }));
  check("a tiny derived negative is still residue (no epsilon escape hatch)",
    isReconstructionResidue({ quantity: -1e-9, origin: "DERIVED", reconciliation: "PARTIAL" }));

  // ── 5. Silence is not evidence ────────────────────────────────────────────
  console.log("5. A missing reconstruction summary is read as NOT complete");
  check("derived negative with no summary is residue",
    isReconstructionResidue({ quantity: -20, origin: "DERIVED", reconciliation: null }));
  check("an unknown-origin negative is NOT refused — the guard is narrow by design",
    !isReconstructionResidue({ quantity: -20, origin: null, reconciliation: null }));

  // ── 6. The refusal explains itself ────────────────────────────────────────
  console.log("6. The refusal reason states the evidence status and claims no short");
  {
    const r = reconstructionResidueReason(-20, "FAILED");
    check("names the reconciliation status", r.includes("FAILED"));
    check("names the quantity it refused", r.includes("-20"));
    check("does not describe the position as a short", !/is a short/i.test(r));
    check("a missing summary is reported as MISSING, not invented",
      reconstructionResidueReason(-5, null).includes("MISSING"));
  }

  // ── 7. Refused components are UNVALUED, not absent, not zero ──────────────
  console.log("7. Refused components survive into the view with evidence intact");
  {
    const components = RESIDUE.map((p) =>
      excludedComponent(p.symbol, p.quantity, reconstructionResidueReason(p.quantity, p.reconciliation)));
    const view = valuePortfolioAsOf(components, ASOF, "USD");

    check("none of the six contributes to the subtotal", view.valuedSubtotal === 0);
    check("all six are counted as unvalued", view.unvaluedCount === 6);
    check("all six are still present as components", view.components.length === 6);
    check("each keeps its instrument identity",
      RESIDUE.every((p) => view.unvalued.some((u) => u.instrumentId === p.symbol)));
    check("each keeps its account",
      view.unvalued.every((u) => u.accountId === ACCT));
    check("each keeps its refused quantity — NOT clamped to zero",
      RESIDUE.every((p) => view.unvalued.some((u) => u.instrumentId === p.symbol && u.quantity === p.quantity)));
    check("no refused quantity was rewritten to 0",
      view.unvalued.every((u) => u.quantity !== 0));
    check("each keeps its evidence tier",
      view.unvalued.every((u) => u.quantityTier === "derived"));
    check("each carries a reason",
      view.unvalued.every((u) => u.reason.length > 0 && u.reason.includes("reconciliation")));
    check("the portfolio tier degrades rather than reporting a clean total",
      view.completeness.tier === "unknown");
    check("the view says the total is partial",
      view.completeness.reason.includes("partial subtotal"));
  }

  // ── 8. The money that must not move: a real short still values ────────────
  console.log("8. A real short still produces real (negative) value");
  {
    const v = valueInstrumentAsOf(
      vInput({ instrumentId: "INTC", accountId: ACCT, quantity: -5, quantityTier: "observed", price: observedPrice(132.28) }),
      ASOF, USD);
    check("observed short is valued, not refused", v.reportingValue !== null);
    check("value keeps its negative sign", approx(v.reportingValue!, -661.40));
    check("it enters the subtotal as negative value",
      approx(valuePortfolioAsOf([v], ASOF, "USD").valuedSubtotal, -661.40));
  }

  // ── 9. The incident total: what the guard prevents ────────────────────────
  console.log("9. The incident magnitude — residue can no longer become portfolio value");
  {
    // Valued the old way: every residue quantity × a real close, summed.
    const unguarded = RESIDUE.map((p) =>
      valueInstrumentAsOf(
        vInput({ instrumentId: p.symbol, accountId: ACCT, quantity: p.quantity, quantityTier: "derived", price: observedPrice(p.price) }),
        ASOF, USD));
    const unguardedTotal = valuePortfolioAsOf(unguarded, ASOF, "USD").valuedSubtotal;
    check("without the guard the six book a large negative subtotal",
      unguardedTotal < -3000, `subtotal ${unguardedTotal.toFixed(2)}`);

    // With the guard every one is refused before a price is ever applied.
    check("with the guard all six are refused",
      RESIDUE.every((p) => isReconstructionResidue({ quantity: p.quantity, origin: "DERIVED", reconciliation: p.reconciliation })));
    const guarded = valuePortfolioAsOf(
      RESIDUE.map((p) => excludedComponent(p.symbol, p.quantity, reconstructionResidueReason(p.quantity, p.reconciliation))),
      ASOF, "USD");
    check("the refused subtotal is 0 — an absence, disclosed as 6 unvalued holdings",
      guarded.valuedSubtotal === 0 && guarded.unvaluedCount === 6);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll reconstruction-residue guards passed.");
  process.exit(0);
}

main();
