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

import { valueInstrumentAsOf, valuePortfolioAsOf, resolveHeldQuantity } from "./valuation-core";
import type { CompletenessTier } from "@/lib/perspective-engine/types";
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

  // ── V26-QUANTITY-1A — unknown vs OBSERVED-zero ────────────────────────────
  console.log("QUANTITY-1A: resolveHeldQuantity — unknown vs observed closure");
  {
    type R = { date: string; quantity: number };
    const held = (q: number | null, rows: R[], hold: boolean, tier: CompletenessTier = "observed") =>
      resolveHeldQuantity({ quantity: q, date: q === null ? null : "2026-01-01", tier }, rows, hold);

    // 1. SOLD POSITION, LATER DATE — the defect this slice exists to fix.
    const sold: R[] = [
      { date: "2026-07-19", quantity: 1 },
      { date: "2026-07-22", quantity: 1 },
      { date: "2026-07-27", quantity: 0 },
      { date: "2026-07-31", quantity: 0 },
    ];
    const afterSale = held(0, sold, true);
    check("Q1A: an observed zero is NEVER resurrected under holdConstant",
      afterSale.quantity === 0 && afterSale.heldConstant === false);
    check("Q1A: …and no earlier row is substituted", afterSale.sourceRow === null);

    // 9. TSLA REGRESSION — the exact shape measured in the investigation.
    // Sold 2026-07-27; previously valued at quantity 1 on 2026-07-29.
    const tsla = resolveHeldQuantity(
      { quantity: 0, date: "2026-07-27", tier: "observed" }, sold, true);
    check("Q1A: TSLA on 2026-07-29 resolves to 0, not 1 (regression)",
      tsla.quantity === 0 && tsla.heldConstant === false);

    // 2. GENUINELY UNCOVERED EARLY DATE — existing behaviour must not change.
    const openRows: R[] = [{ date: "2026-06-01", quantity: 2 }, { date: "2026-07-01", quantity: 2 }];
    const uncovered = held(null, openRows, true);
    check("Q1A: an uncovered date still holds the earliest quantity constant",
      uncovered.quantity === 2 && uncovered.heldConstant === true);
    check("Q1A: …carried from the EARLIEST row, tier degraded to estimated",
      uncovered.date === "2026-06-01" && uncovered.tier === "estimated" &&
      uncovered.sourceRow?.date === "2026-06-01");

    // 3. ZERO AS THE EARLIEST OBSERVATION — never projects a later position back.
    const zeroOpen: R[] = [{ date: "2026-01-01", quantity: 0 }, { date: "2026-06-01", quantity: 5 }];
    const beforeZeroOpen = held(null, zeroOpen, true);
    check("Q1A: a zero opening observation is not carried backward",
      beforeZeroOpen.quantity === null && beforeZeroOpen.heldConstant === false);
    check("Q1A: …and the later positive row is NOT reached back for",
      beforeZeroOpen.sourceRow === null);

    // 4. RE-ENTRY — no special logic needed; nearest-on-or-before does it.
    const reentry: R[] = [
      { date: "2026-01-01", quantity: 5 },
      { date: "2026-03-01", quantity: 0 },
      { date: "2026-06-01", quantity: 3 },
    ];
    check("Q1A: inside the closed interval the position is closed",
      held(0, reentry, true).quantity === 0);
    check("Q1A: after re-entry the LATER quantity is used, not the original",
      held(3, reentry, true).quantity === 3 && held(3, reentry, true).heldConstant === false);

    // 5. TERMINAL ZERO stays excluded however far forward.
    check("Q1A: a terminal zero remains zero on every later date",
      held(0, sold, true).quantity === 0);

    // 6. Per-pair responsibility: a closed pair and an open pair resolve
    // independently. (Summing across accounts sits above this helper and is
    // covered by the integration/dry-run path — the helper is not broadened.)
    check("Q1A: a closed pair resolves to zero", held(0, sold, true).quantity === 0);
    check("Q1A: an open pair resolves positive", held(2, openRows, true).quantity === 2);

    // 7. holdConstant=false — unchanged in every case.
    check("Q1A: holdConstant=false leaves an uncovered date unresolved",
      held(null, openRows, false).quantity === null);
    check("Q1A: holdConstant=false leaves an observed zero at zero",
      held(0, sold, false).quantity === 0);

    // 8. Ordinary resolution passes straight through, including NEGATIVES —
    // NVDA holds -0.0028 locally and is valued today; that must not change.
    const positive = held(7, openRows, true);
    check("Q1A: a positive resolved quantity passes through untouched",
      positive.quantity === 7 && positive.heldConstant === false && positive.tier === "observed");
    const negative = held(-0.0028, openRows, true);
    check("Q1A: a NEGATIVE quantity is preserved, never treated as a gap",
      negative.quantity === -0.0028 && negative.heldConstant === false);

    // 10. Determinism — input order cannot change the earliest row chosen.
    const shuffled = [...openRows].reverse();
    check("Q1A: shuffled input order resolves identically",
      JSON.stringify(held(null, shuffled, true)) === JSON.stringify(held(null, openRows, true)));
    check("Q1A: repeat invocation is byte-identical",
      JSON.stringify(held(null, openRows, true)) === JSON.stringify(held(null, openRows, true)));

    // Invariants.
    check("Q1A: heldConstant is true ONLY when the resolved quantity was null",
      [held(0, sold, true), held(5, openRows, true), held(-1, openRows, true)]
        .every((h) => h.heldConstant === false));
    check("Q1A: an empty row set never fabricates a quantity",
      held(null, [], true).quantity === null);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll valuation-core checks passed.");
  process.exit(0);
}

main();
