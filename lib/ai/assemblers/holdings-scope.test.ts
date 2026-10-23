/**
 * lib/ai/assemblers/holdings-scope.test.ts
 *
 * A PERCENTAGE WITHOUT ITS POPULATION IS NOT EVIDENCE.
 *
 *     npx tsx lib/ai/assemblers/holdings-scope.test.ts
 *
 * ── The measured failure ────────────────────────────────────────────────────
 * On the real Space the canonical valuation seam could price 4 of 13 positions —
 * every crypto holding and six equities had "no RAW_CLOSE price within 7 days".
 * The holdings payload then reported, entirely correctly about its own inputs:
 *
 *     positionCount          2
 *     analyzedInvestedValue  $11.62
 *     concentration          HIGHLY_CONCENTRATED · topSymbol TTWO · topWeight 0.75
 *     totalPortfolioValue    $4,040.60
 *
 * while the canonical account composition (`composeInvestments`) read $23,982.89,
 * of which $18,977.04 was Bitcoin. Two positions worth eleven dollars — 0.05% of
 * the money — carried an unqualified portfolio-shaped verdict, and a field named
 * `totalPortfolioValue` named a number that was not the portfolio.
 *
 * ⚠️ THE ARITHMETIC WAS NEVER WRONG. `computeConcentration` is the shared
 * authority the Allocation panel runs and it answers exactly the question it is
 * asked. The defect was SEMANTIC SCOPE: nothing in the payload said what the
 * weights were a share OF, so a downstream reader could not tell a within-subset
 * statistic from a portfolio one.
 *
 * ⚠️ EVERY CHECK BELOW IS ABOUT SEMANTICS, NOT ABOUT CHRIS. No test asserts
 * $8.72, TTWO, Robinhood or Bitcoin. They assert that a narrow population
 * declares itself, that exclusions survive as data, and that a subset cannot
 * present as a whole.
 */

import {
  buildHoldingsSummary, describePopulation,
  type AllScopeAggregate, type CanonicalPositionRow,
} from "./holdings-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

function agg(over: Partial<AllScopeAggregate> = {}): AllScopeAggregate {
  return {
    valuedSubtotal: 0, cashValue: 0, anyFxEstimated: false, hasAny: true,
    completeness: { tier: "observed", reason: null, valuedCount: 0, unvaluedCount: 0 },
    ...over,
  };
}
const row = (over: Partial<CanonicalPositionRow>): CanonicalPositionRow =>
  ({ instrumentId: "i", symbol: "AAA", name: "Alpha", reportingValue: 100, isCash: false, ...over });

/**
 * The shape of the real failure, in fixture form: a large holding that could not
 * be priced, beside two tiny ones that could. Values are round numbers chosen to
 * make the ratios obvious — nothing here is a real position.
 */
const MOSTLY_UNPRICED = {
  fullRows: [
    row({ instrumentId: "a", symbol: "AAA", reportingValue: 75,   assetClass: "EQUITY" }),
    row({ instrumentId: "b", symbol: "BBB", reportingValue: 25,   assetClass: "EQUITY" }),
    row({ instrumentId: "c", symbol: "CCC", reportingValue: null, assetClass: "CRYPTO",
      quantity: 0.5, reason: "No RAW_CLOSE price within 7 days of 2026-09-07." }),
    row({ instrumentId: "d", symbol: "DDD", reportingValue: null, assetClass: "ETF",
      quantity: 2,   reason: "No RAW_CLOSE price within 7 days of 2026-09-07." }),
  ] as CanonicalPositionRow[],
  allScope: agg({
    valuedSubtotal: 100, cashValue: 0,
    completeness: {
      tier: "incomplete", valuedCount: 2, unvaluedCount: 2,
      reason: "2 of 4 holdings could not be valued for 2026-09-07; the total shown is a partial subtotal.",
    },
  }),
};

// ══ 1. A concentration statistic declares its population ═════════════════════
console.log("1. concentration carries its denominator");
{
  const out = buildHoldingsSummary({ scopeHint: "full", ...MOSTLY_UNPRICED })!;
  const p = out.concentration.population;

  check("population is present and is not optional",
    p !== undefined && typeof p.label === "string" && p.label.length > 0);
  check("population.value IS the denominator the weights were computed against",
    approx(p.value, out.analyzedInvestedValue) && approx(p.value, 100));
  check("population.positionCount matches the analysed set",
    p.positionCount === 2 && p.positionCount === out.positionCount);
  check("topWeight reconciles against population.value, not against any other total",
    approx(out.concentration.topWeight!, 75 / p.value));

  // The structural half: the scope cannot be dropped while keeping the verdict,
  // because they are the same object.
  const serialized = JSON.parse(JSON.stringify(out.concentration));
  check("classification cannot be serialized without its population",
    "classification" in serialized && "population" in serialized);
}

// ══ 2. A subset cannot present as the whole ══════════════════════════════════
console.log("2. a narrow population says it is narrow");
{
  const out = buildHoldingsSummary({ scopeHint: "full", ...MOSTLY_UNPRICED })!;
  const p = out.concentration.population;

  check("unvaluedCount is stated on the population, not only in prose",
    p.unvaluedCount === 2);
  check("isComplete is FALSE when anything in scope could not be priced",
    p.isComplete === false);
  check("shareOfValuedTotal is present so a reader can see the population's size",
    p.shareOfValuedTotal !== null);

  // The whole-portfolio case, same code path.
  const whole = buildHoldingsSummary({
    scopeHint: "full",
    fullRows: [row({ instrumentId: "a", reportingValue: 60 }), row({ instrumentId: "b", symbol: "BBB", reportingValue: 40 })],
    allScope: agg({ valuedSubtotal: 100, completeness: { tier: "observed", reason: null, valuedCount: 2, unvaluedCount: 0 } }),
  })!;
  check("isComplete is TRUE only when nothing was excluded for price or visibility",
    whole.concentration.population.isComplete === true
      && whole.concentration.population.unvaluedCount === 0
      && whole.concentration.population.hiddenValue === 0);
  check("a complete population still declares itself — scope is never conditional",
    whole.concentration.population.value === whole.analyzedInvestedValue);
}

// ══ 3. Withheld value is separated from unpriced value ═══════════════════════
console.log("3. two different exclusions, kept apart");
{
  // FULL rows total 100; the spine's non-cash value is 900 — 800 is withheld by
  // visibility and must never appear as a position, only as excluded value.
  const out = buildHoldingsSummary({
    scopeHint: "full",
    fullRows: [row({ instrumentId: "a", reportingValue: 100 })],
    allScope: agg({ valuedSubtotal: 900, cashValue: 0,
      completeness: { tier: "observed", reason: null, valuedCount: 5, unvaluedCount: 0 } }),
  })!;
  const p = out.concentration.population;
  check("hiddenValue carries visibility-withheld non-cash value", approx(p.hiddenValue, 800));
  check("hidden value does NOT count as unpriced", p.unvaluedCount === 0);
  check("a withheld population is not complete", p.isComplete === false);
  check("positionsPartiallyHidden still set (unchanged contract)", out.positionsPartiallyHidden === true);
  check("no hidden symbol leaks into the ranked list",
    (out.topPositions?.items ?? []).length === 1);
}

// ══ 4. Exclusions survive as DATA, not as a sentence ═════════════════════════
console.log("4. unpriced positions are named");
{
  const out = buildHoldingsSummary({ scopeHint: "full", ...MOSTLY_UNPRICED })!;

  check("unvaluedPositions lists every unpriced row", out.unvaluedPositions.length === 2);
  check("each carries a symbol so it can be named", out.unvaluedPositions.every((u) => !!u.symbol));
  check("each carries its assetClass so a whole CLASS going missing is visible",
    out.unvaluedPositions.some((u) => u.assetClass === "CRYPTO"));
  check("each carries the seam's own reason, not a paraphrase",
    out.unvaluedPositions.every((u) => (u.reason ?? "").includes("RAW_CLOSE")));
  check("quantity is preserved — the quantity is known, only the price is not",
    out.unvaluedPositions.every((u) => u.quantity !== null));

  // The one thing that must never happen.
  const anyValue = JSON.stringify(out.unvaluedPositions).match(/"reportingValue"|"value"/);
  check("no price is invented for an unpriced position", anyValue === null);
}

// ══ 5. The seam's completeness verdict is carried, not re-derived ════════════
console.log("5. completeness comes from the valuation authority");
{
  const out = buildHoldingsSummary({ scopeHint: "full", ...MOSTLY_UNPRICED })!;
  check("valuationCompleteness carries the seam's tier",
    out.valuationCompleteness.tier === "incomplete");
  check("…its counts", out.valuationCompleteness.valuedCount === 2
    && out.valuationCompleteness.unvaluedCount === 2);
  check("…and its sentence, verbatim, in dataLimits",
    out.dataLimits.some((d) => d === MOSTLY_UNPRICED.allScope.completeness.reason));
  check("the count of held positions is the seam's, not the FULL-row count",
    out.valuationCompleteness.valuedCount + out.valuationCompleteness.unvaluedCount === 4);
}

// ══ 6. The totals name their own scope ═══════════════════════════════════════
console.log("6. no field claims to be the portfolio");
{
  const out = buildHoldingsSummary({ scopeHint: "full", ...MOSTLY_UNPRICED })!;
  const keys = Object.keys(out);
  check("no field is named `totalPortfolioValue`", !keys.includes("totalPortfolioValue"));
  check("no field is named `investedValue`", !keys.includes("investedValue"));
  check("valuedPositionsTotal counts only what could be priced",
    approx(out.valuedPositionsTotal, 100));
  check("valuedNonCashTotal = priced total − priced cash",
    approx(out.valuedNonCashTotal, out.valuedPositionsTotal - out.valuedCashTotal));

  // Cash is a component of the priced total and never a security position.
  const withCash = buildHoldingsSummary({
    scopeHint: "full",
    fullRows: [
      row({ instrumentId: "a", reportingValue: 40 }),
      row({ instrumentId: "cash", symbol: "CUR:USD", reportingValue: 60, isCash: true, assetClass: "CASH" }),
    ],
    allScope: agg({ valuedSubtotal: 100, cashValue: 60,
      completeness: { tier: "observed", reason: null, valuedCount: 2, unvaluedCount: 0 } }),
  })!;
  check("uninvested cash is not a position", withCash.positionCount === 1);
  check("…is not in the concentration denominator", approx(withCash.analyzedInvestedValue, 40));
  check("…and is still reported as value", approx(withCash.valuedCashTotal, 60));
  check("cashPct is a share of the PRICED total", approx(withCash.cashPct, 0.6));
}

// ══ 7. The population label is generic ═══════════════════════════════════════
console.log("7. the label describes shape, never identity");
{
  const label = describePopulation(2, 13, 9, true);
  check("names the analysed count and the held count", /2 of 13/.test(label));
  check("names the unpriced exclusion", /9/.test(label) && /priced/.test(label));
  check("names the visibility exclusion", /withheld/.test(label));
  check("says what the weights are a share of", /share of this population/.test(label));
  check("mentions no instrument, provider or asset class",
    !/TTWO|BTC|robinhood|crypto|equity|bitcoin/i.test(label));

  check("refuses a fraction it cannot support (held unknown)",
    !/of 0/.test(describePopulation(3, 0, 0, false)));
  check("an empty population says so", describePopulation(0, 5, 5, false) === "no positions could be analysed");
}

// ══ 8. Nothing in scope ⇒ nothing claimed ════════════════════════════════════
console.log("8. an empty spine stays empty");
{
  const none = buildHoldingsSummary({ scopeHint: "full", fullRows: [], allScope: agg({ hasAny: false }) });
  check("no observations ⇒ null domain (unchanged honest absence)", none === null);

  const allUnpriced = buildHoldingsSummary({
    scopeHint: "full",
    fullRows: [row({ instrumentId: "a", reportingValue: null, quantity: 1, reason: "no price" })],
    allScope: agg({ valuedSubtotal: 0, hasAny: true,
      completeness: { tier: "incomplete", reason: "1 of 1 holdings could not be valued.", valuedCount: 0, unvaluedCount: 1 } }),
  })!;
  check("everything unpriced ⇒ INSUFFICIENT_DATA, never a verdict",
    allUnpriced.concentration.classification === "INSUFFICIENT_DATA");
  check("…with a population that still states the denominator is zero",
    allUnpriced.concentration.population.value === 0
      && allUnpriced.concentration.population.isComplete === false);
  check("…and the unpriced position is still named",
    allUnpriced.unvaluedPositions.length === 1);
}

console.log(failures === 0 ? "\nAll holdings-scope checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures ? 1 : 0);
