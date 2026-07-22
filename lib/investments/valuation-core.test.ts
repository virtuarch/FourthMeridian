/**
 * lib/investments/valuation-core.test.ts
 *
 * A8-4 — pure valuation tests. Standalone tsx script:
 *
 *     npx tsx lib/investments/valuation-core.test.ts
 *
 * Required matrix: institutionValue precedence, institutionPrice precedence,
 * derived qty × exact price × exact FX, observed qty × walked-back price,
 * walked-back FX degradation, missing price ⇒ explicit unvalued row, partial
 * portfolio incomplete, cash valuation, multiple currencies, reconstruction
 * conflict propagation, date-before-coverage, price gap beyond staleness, basis
 * isolation (label), deterministic output, reconciliation (Σ institutionValue).
 */

import { readFileSync } from "fs";
import { join } from "path";

import { valueInstrumentAsOf, valuePortfolioAsOf } from "./valuation-core";
import {
  vInput, observedPrice, estimatedPrice, priceMiss,
  identityFxCtx, walkedBackFxCtx,
} from "./valuation.fixtures";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

const ASOF = "2026-06-05";
const USD = identityFxCtx("USD");

function main(): void {
  // ── 1. institutionValue precedence (observed anchor) ──────────────────────
  console.log("1. institutionValue precedence");
  {
    const v = valueInstrumentAsOf(vInput({ institutionValue: 2500, price: observedPrice(999) }), ASOF, USD);
    check("uses institutionValue, ignores market price", v.nativeValue === 2500 && v.reportingValue === 2500);
    check("basis institution-value", v.basisUsed === "institution-value");
    check("tier observed (FX identity)", v.overallTier === "observed" && v.priceTier === "observed");
  }

  // ── 2. institutionPrice precedence ────────────────────────────────────────
  console.log("2. institutionPrice precedence");
  {
    const v = valueInstrumentAsOf(vInput({ quantity: 10, institutionPrice: 210, institutionPriceDate: "2026-06-04", price: observedPrice(999) }), ASOF, USD);
    check("quantity × institutionPrice, market price ignored", v.nativeValue === 2100);
    check("basis institution-price, priceDate preserved", v.basisUsed === "institution-price" && v.priceDate === "2026-06-04");
    check("tier observed", v.overallTier === "observed");
  }

  // ── 3. derived qty × exact price × exact FX ───────────────────────────────
  console.log("3. derived quantity × exact price");
  {
    const v = valueInstrumentAsOf(vInput({ quantity: 10, quantityTier: "derived", price: observedPrice(200) }), ASOF, USD);
    check("value = 10 × 200", v.nativeValue === 2000 && v.reportingValue === 2000);
    check("overall = worst(derived, observed, observed) = derived", v.overallTier === "derived");
    check("basis raw-close, staleDays 0", v.basisUsed === "raw-close" && v.staleDays === 0);
  }

  // ── 4. observed qty × walked-back price (estimated) ───────────────────────
  console.log("4. walked-back price degradation");
  {
    const v = valueInstrumentAsOf(vInput({ quantity: 10, price: estimatedPrice(198, 2, "2026-06-03") }), ASOF, USD);
    check("value uses the walked-back close", v.nativeValue === 1980);
    check("priceTier estimated, staleDays 2", v.priceTier === "estimated" && v.staleDays === 2);
    check("overall = worst(observed, estimated, observed) = estimated", v.overallTier === "estimated");
  }

  // ── 5. walked-back FX degradation ─────────────────────────────────────────
  console.log("5. walked-back FX degradation");
  {
    const v = valueInstrumentAsOf(vInput({ quantity: 10, nativeCurrency: "EUR", price: observedPrice(200, { currency: "EUR" }) }), ASOF, walkedBackFxCtx("USD", 1.1));
    check("nativeValue in EUR = 2000", v.nativeValue === 2000);
    check("reportingValue converted at 1.1 = 2200", approx(v.reportingValue!, 2200));
    check("fxTier estimated (walked back)", v.fxTier === "estimated");
    check("overall = worst(observed, observed, estimated) = estimated", v.overallTier === "estimated");
  }

  // ── 6. missing price ⇒ explicit unvalued row (position retained) ──────────
  console.log("6. missing price");
  {
    const v = valueInstrumentAsOf(vInput({ quantity: 10, price: priceMiss() }), ASOF, USD);
    check("value null, quantity retained", v.reportingValue === null && v.quantity === 10);
    check("tier incomplete, basis null", v.overallTier === "incomplete" && v.basisUsed === null);
    check("reason carries the miss statement", /within 7 days/.test(v.reason));
  }

  // ── 7. cash instrument ────────────────────────────────────────────────────
  console.log("7. cash valuation");
  {
    const v = valueInstrumentAsOf(vInput({ isCash: true, quantity: 1500, nativeCurrency: "USD", price: null }), ASOF, USD);
    check("cash valued at balance × 1", v.nativeValue === 1500 && v.nativePrice === 1);
    check("basis cash, no market lookup", v.basisUsed === "cash");
    check("tier observed", v.overallTier === "observed");
    // Foreign cash still degrades via FX.
    const fx = valueInstrumentAsOf(vInput({ isCash: true, quantity: 1000, nativeCurrency: "EUR", price: null }), ASOF, walkedBackFxCtx("USD", 1.1));
    check("foreign cash reporting value converted, fx estimated", approx(fx.reportingValue!, 1100) && fx.overallTier === "estimated");
  }

  // ── 8. date before quantity coverage ──────────────────────────────────────
  console.log("8. before coverage");
  {
    const v = valueInstrumentAsOf(vInput({ quantity: null, quantityDate: null, quantityTier: "incomplete", price: observedPrice(200) }), ASOF, USD);
    check("no quantity ⇒ unvalued incomplete", v.reportingValue === null && v.overallTier === "incomplete");
    check("reason names the coverage gap", /No holdings history/.test(v.reason));
  }

  // ── 9. price gap beyond staleness (miss) already covered; basis label ─────
  console.log("9. basis label passthrough");
  {
    const v = valueInstrumentAsOf(vInput({ price: observedPrice(200, { basis: "NAV" as never }) }), ASOF, USD);
    check("NAV basis surfaced as nav", v.basisUsed === "nav");
  }

  // ── 10. Determinism ───────────────────────────────────────────────────────
  console.log("10. Determinism");
  {
    const a = valueInstrumentAsOf(vInput({ quantity: 3, price: estimatedPrice(150) }), ASOF, walkedBackFxCtx("USD", 1.25));
    const b = valueInstrumentAsOf(vInput({ quantity: 3, price: estimatedPrice(150) }), ASOF, walkedBackFxCtx("USD", 1.25));
    check("identical inputs → byte-identical JSON", JSON.stringify(a) === JSON.stringify(b));
  }

  // ── 11. Portfolio: partial is incomplete, subtotal never presented as whole ─
  console.log("11. Portfolio shaping");
  {
    const valued = valueInstrumentAsOf(vInput({ instrumentId: "i1", quantity: 10, price: observedPrice(200) }), ASOF, USD);
    const missing = valueInstrumentAsOf(vInput({ instrumentId: "i2", quantity: 5, price: priceMiss() }), ASOF, USD);
    const view = valuePortfolioAsOf([valued, missing], ASOF, "USD");
    check("valued subtotal sums only valued components", view.valuedSubtotal === 2000 && view.valuedCount === 1);
    check("unvalued remainder explicit", view.unvaluedCount === 1 && view.unvalued[0].instrumentId === "i2");
    check("overall tier incomplete when any holding unvalued", view.completeness.tier === "incomplete");
    check("reason states it is a partial subtotal", /partial subtotal/.test(view.completeness.reason));
    check("byInstrument keeps per-instrument tiers", view.completeness.byInstrument.i1 === "observed" && view.completeness.byInstrument.i2 === "incomplete");
  }

  // ── 12. Reconstruction conflict propagation ───────────────────────────────
  console.log("12. Conflict propagation");
  {
    const c1 = valueInstrumentAsOf(vInput({ instrumentId: "i1", conflicted: true, price: observedPrice(100) }), ASOF, USD);
    const c2 = valueInstrumentAsOf(vInput({ instrumentId: "i2", price: observedPrice(50) }), ASOF, USD);
    const view = valuePortfolioAsOf([c1, c2], ASOF, "USD");
    check("conflict OR'd to the portfolio", view.completeness.conflict === true);
    check("all valued but conflict flagged in reason", /reconstruction conflict/.test(view.completeness.reason));
  }

  // ── 13. Multiple currencies + reconciliation invariant ────────────────────
  console.log("13. Multi-currency + reconciliation");
  {
    // Two fully-observed institutionValue positions on an observation date: the
    // portfolio value reconciles with Σ institutionValue (identity FX).
    const a = valueInstrumentAsOf(vInput({ instrumentId: "i1", institutionValue: 1234.56 }), ASOF, USD);
    const b = valueInstrumentAsOf(vInput({ instrumentId: "i2", institutionValue: 8765.44 }), ASOF, USD);
    const view = valuePortfolioAsOf([a, b], ASOF, "USD");
    check("Σ institutionValue reconciles within epsilon", approx(view.valuedSubtotal, 1234.56 + 8765.44, 1e-6));
    check("fully observed portfolio → tier observed, no unvalued", view.completeness.tier === "observed" && view.unvaluedCount === 0);
  }

  // ── 14. Empty portfolio ───────────────────────────────────────────────────
  console.log("14. Empty portfolio");
  {
    const view = valuePortfolioAsOf([], ASOF, "USD");
    check("empty → zero subtotal, tier unknown", view.valuedSubtotal === 0 && view.completeness.tier === "unknown");
  }

  // ── 15. Binding source guards — no persistence, no N+1 ────────────────────
  console.log("15. Binding source guards (valuation.ts)");
  {
    const src = readFileSync(join(process.cwd(), "lib/investments/valuation.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments
    check("no valuation persistence (no create/upsert/update/createMany writes)",
      !/\.(create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/.test(code));
    check("batched reads use `in:` filters (scope-wide, not per-instrument)",
      /financialAccountId:\s*\{\s*in:/.test(code) && /id:\s*\{\s*in:/.test(code));
    check("price window is a single batched range read (readRange), not per-instrument point reads",
      /priceArchive\.readRange\?\.\(/.test(code) && !/priceArchive\.readLatestOnOrBefore/.test(code));
    check("valuation imports the A4 quantity seam (resolvePositionAsOf), not a reimplementation",
      /resolvePositionAsOf/.test(code));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll valuation-core checks passed.");
  process.exit(0);
}

main();
