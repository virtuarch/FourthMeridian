/**
 * lib/ai/assemblers/holdings-core.test.ts
 *
 * P2-4 — pure shaper for the AI 'holdings_summary' domain. Standalone tsx:
 *
 *     npx tsx lib/ai/assemblers/holdings-core.test.ts
 *
 * Pins the canonical cutover guarantees WITHOUT a DB:
 *   1. FULL detail comes from the canonical current-position rows (fullRows).
 *   2. Non-FULL detail never leaks — hidden value enters only via allScope, and
 *      is disclosed (positionsPartiallyHidden + dataLimits), never as a symbol.
 *   3. Aggregate hidden value is preserved honestly in the totals.
 *   4. Concentration is byte-identical to the Investments Allocation panel
 *      (computeAllocation → same computeConcentration helper) on a spine-only
 *      FULL fixture.
 *   5. Unvalued positions handled honestly; same instrument across accounts
 *      collapses.
 *   6. W5 — crypto has NO side entrance: the shaper takes no crypto input at
 *      all (the legacy-bridge blend is deleted); a spine crypto row behaves
 *      like any instrument, and an empty spine is an empty domain — honest
 *      absence, never a legacy backfill.
 *   7. W5 — stale valuation dating is DISCLOSED (≥ STALE_PRICE_DISCLOSURE_DAYS),
 *      and the normal 0–1 day close lag is not remarked on.
 */

import {
  buildHoldingsSummary,
  STALE_PRICE_DISCLOSURE_DAYS,
  type CanonicalPositionRow,
  type AllScopeAggregate,
} from "./holdings-core";
import { computeAllocation } from "@/lib/investments/investments-allocation-core";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

function agg(over: Partial<AllScopeAggregate> = {}): AllScopeAggregate {
  return {
    valuedSubtotal: 0, cashValue: 0, anyFxEstimated: false, hasAny: true,
    // The seam's completeness verdict. Default: everything in scope was priced.
    completeness: { tier: "observed", reason: null, valuedCount: 0, unvaluedCount: 0 },
    ...over,
  };
}
function row(over: Partial<CanonicalPositionRow>): CanonicalPositionRow {
  return { instrumentId: "i1", symbol: "AAA", name: "Alpha", reportingValue: 1000, isCash: false, ...over };
}

// A ValuedHoldingRow the Allocation panel would consume — only the fields
// computeAllocation reads matter; the rest are structurally-valid filler.
function vhr(over: Partial<ValuedHoldingRow>): ValuedHoldingRow {
  return {
    instrumentId: "i1", accountId: "a1", quantity: 1, nativePrice: null, nativeValue: null,
    reportingValue: 1000, currency: "USD", reportingCurrency: "USD",
    quantityTier: "observed", priceTier: "observed", fxTier: "observed", overallTier: "observed",
    basisUsed: "raw-close", priceDate: null, staleDays: null, reason: "", conflicted: false,
    symbol: "AAA", name: "Alpha", share: null, assetClass: "EQUITY", sector: null, isCash: false,
    ...over,
  } as ValuedHoldingRow;
}

// ── 1. Empty domain ───────────────────────────────────────────────────────────
console.log("1. empty domain");
{
  const out = buildHoldingsSummary({
    scopeHint: "full", fullRows: [], allScope: agg({ hasAny: false }),
  });
  check("no spine observations ⇒ null (domain cleanly empty — W5: crypto included in this honesty)", out === null);
}

// ── 2. FULL detail from canonical rows ──────────────────────────────────────────
console.log("2. FULL detail sourced from canonical current-position rows");
{
  const fullRows = [
    row({ instrumentId: "i1", symbol: "AAA", reportingValue: 6000 }),
    row({ instrumentId: "i2", symbol: "BBB", name: "Beta", reportingValue: 4000 }),
    row({ instrumentId: "iCash", symbol: "CASH", isCash: true, reportingValue: 2000 }),
  ];
  const out = buildHoldingsSummary({
    scopeHint: "full", fullRows,
    allScope: agg({ valuedSubtotal: 12000, cashValue: 2000 }),
  })!;
  const syms = (out.topPositions?.items ?? []).map((p) => p.symbol);
  check("FULL non-cash positions surfaced", syms.includes("AAA") && syms.includes("BBB"));
  check("cash excluded from positions/concentration", !syms.includes("CASH") && out.positionCount === 2);
  check("analyzedInvestedValue = Σ FULL non-cash (6000+4000)", approx(out.analyzedInvestedValue, 10000));
  check("valuedCashTotal from all-scope aggregate", approx(out.valuedCashTotal, 2000));
  check("valuedPositionsTotal = all-scope valued subtotal", approx(out.valuedPositionsTotal, 12000));
  check("valuedNonCashTotal = total − cash", approx(out.valuedNonCashTotal, 10000));
  check("cashPct = 2000/12000", approx(out.cashPct, 2000 / 12000));
  check("not partially hidden when all value is FULL", out.positionsPartiallyHidden === false);
}

// ── 3. Non-FULL detail never leaks; hidden aggregate value preserved ────────────
console.log("3. hidden value preserved without leaking detail");
{
  // FULL detail is 10000 invested; all-scope invested is 15000 → 5000 hidden.
  const fullRows = [
    row({ instrumentId: "i1", symbol: "AAA", reportingValue: 6000 }),
    row({ instrumentId: "i2", symbol: "BBB", reportingValue: 4000 }),
  ];
  const out = buildHoldingsSummary({
    scopeHint: "full", fullRows,
    allScope: agg({ valuedSubtotal: 15000, cashValue: 0 }),
  })!;
  check("aggregate includes hidden value (total 15000)", approx(out.valuedPositionsTotal, 15000));
  check("hidden invested value preserved in valuedNonCashTotal", approx(out.valuedNonCashTotal, 15000));
  check("concentration only sees FULL detail (analyzed = 10000)", approx(out.analyzedInvestedValue, 10000));
  check("partial-visibility flagged", out.positionsPartiallyHidden === true);
  check("dataLimits discloses partial visibility",
    out.dataLimits.some((d) => /shared below full visibility/.test(d)));
  const syms = (out.topPositions?.items ?? []).map((p) => p.symbol);
  check("no hidden symbol leaks into positions", syms.length === 2 && !syms.includes("CASH"));
}

// ── 4. Concentration parity with the Investments Allocation panel ───────────────
console.log("4. concentration parity — same helper + per-instrument aggregation as computeAllocation");
{
  // Same instrument (i1 = NVDA) held in TWO FULL accounts + two more names.
  const canonical: CanonicalPositionRow[] = [
    { instrumentId: "i1", symbol: "NVDA", name: "Nvidia", reportingValue: 5000, isCash: false },
    { instrumentId: "i1", symbol: "NVDA", name: "Nvidia", reportingValue: 3000, isCash: false }, // second account
    { instrumentId: "i2", symbol: "VTI",  name: "Vanguard Total", reportingValue: 4000, isCash: false },
    { instrumentId: "i3", symbol: "BND",  name: "Bonds", reportingValue: 2000, isCash: false },
    { instrumentId: "iCash", symbol: "CASH", name: "Cash", reportingValue: 1000, isCash: true }, // excluded
  ];
  const allocRows: ValuedHoldingRow[] = [
    vhr({ instrumentId: "i1", accountId: "a1", symbol: "NVDA", reportingValue: 5000 }),
    vhr({ instrumentId: "i1", accountId: "a2", symbol: "NVDA", reportingValue: 3000 }),
    vhr({ instrumentId: "i2", accountId: "a1", symbol: "VTI",  reportingValue: 4000 }),
    vhr({ instrumentId: "i3", accountId: "a1", symbol: "BND",  reportingValue: 2000 }),
    vhr({ instrumentId: "iCash", accountId: "a1", symbol: "CASH", reportingValue: 1000, isCash: true }),
  ];

  const uiConcentration = computeAllocation(allocRows).concentration;
  const out = buildHoldingsSummary({
    scopeHint: "full", fullRows: canonical,
    allScope: agg({ valuedSubtotal: 15000, cashValue: 1000 }),
  })!;

  // The parity claim is about the METRICS, and it is unchanged: the AI payload
  // runs the same helper over the same per-instrument aggregation, so every
  // number matches the Allocation panel exactly. What the AI object additionally
  // carries is `population` — the denominator the panel does not need because its
  // reader can see the chart. Comparing the whole objects would now fail for the
  // act of adding scope, so the comparison is over the shared metric keys and the
  // superset relationship is asserted separately.
  const { population, ...aiMetrics } = out.concentration;
  check("AI concentration metrics === Allocation-panel concentration (byte-identical)",
    JSON.stringify(aiMetrics) === JSON.stringify(uiConcentration),
    `ai=${JSON.stringify(aiMetrics)} ui=${JSON.stringify(uiConcentration)}`);
  check("…and the AI object additionally states its population",
    population !== undefined && population.value === out.analyzedInvestedValue
      && population.positionCount === out.positionCount);
  check("same-instrument-across-accounts collapses (NVDA = 8000, top)",
    out.concentration.topSymbol === "NVDA" && approx(out.concentration.topWeight!, 8000 / 14000));
  check("positionCount is distinct instruments, not rows (NVDA once)", out.positionCount === 3);
}

// ── 5. Unvalued handled honestly ────────────────────────────────────────────────
console.log("5. unvalued positions honest");
{
  const fullRows = [
    row({ instrumentId: "i1", symbol: "AAA", reportingValue: 5000 }),
    row({ instrumentId: "i2", symbol: "MISS", reportingValue: null }), // unvalued FULL row
  ];
  const out = buildHoldingsSummary({
    scopeHint: "full", fullRows,
    allScope: agg({ valuedSubtotal: 5000, cashValue: 0 }),
  })!;
  const syms = (out.topPositions?.items ?? []).map((p) => p.symbol);
  check("unvalued row excluded from concentration/positions", !syms.includes("MISS") && out.positionCount === 1);
  check("unvalued disclosed in dataLimits", out.dataLimits.some((d) => /could not be valued/.test(d)));
}

// ── 6. W5 — crypto through the ONE spine, honest absence, no side entrance ────
console.log("6. W5 crypto: spine-only, honest absence");
{
  // A spine BTC row is just another instrument: totals/concentration/positions
  // treat it identically to an equity row — no special-cased blend key exists.
  const out = buildHoldingsSummary({
    scopeHint: "full",
    fullRows: [
      row({ instrumentId: "iAAA", symbol: "AAA", reportingValue: 10000 }),
      row({ instrumentId: "iBTC", symbol: "BTC", name: "Bitcoin", reportingValue: 30000 }),
    ],
    allScope: agg({ valuedSubtotal: 40000, cashValue: 0 }),
  })!;
  const syms = (out.topPositions?.items ?? []).map((p) => p.symbol);
  check("spine BTC surfaces like any instrument", syms.includes("BTC") && syms.includes("AAA"));
  check("BTC participates in totals (40000)", approx(out.valuedPositionsTotal, 40000));
  check("BTC participates in concentration (30000/40000)",
    out.concentration.topSymbol === "BTC" && approx(out.concentration.topWeight!, 30000 / 40000));
  check("no wallet-balance provenance caveat remains (crypto is ON the spine now)",
    !out.dataLimits.some((d) => /wallet balances/.test(d)));

  // HONEST ABSENCE — a Space whose only wallet has NO spine observation is an
  // EMPTY domain: there is no input through which a legacy Holding value could
  // ride in, structurally (the shaper takes no crypto argument at all).
  const absent = buildHoldingsSummary({
    scopeHint: "full", fullRows: [], allScope: agg({ hasAny: false }),
  });
  check("wallet without observations ⇒ null domain (honest absence, never legacy backfill)",
    absent === null);
}

// ── 7. brief scopeHint omits topPositions ───────────────────────────────────────
console.log("7. scopeHint='brief' omits topPositions");
{
  const out = buildHoldingsSummary({
    scopeHint: "brief",
    fullRows: [row({ instrumentId: "i1", symbol: "AAA", reportingValue: 5000 })],
    allScope: agg({ valuedSubtotal: 5000 }),
  })!;
  check("topPositions omitted for brief", out.topPositions === undefined);
  check("concentration still computed for brief", out.concentration.topSymbol === "AAA");
}

// ── 8. W5 — stale valuation dating is disclosed, never presented as current ────
console.log("8. W5 staleness disclosure");
{
  // A BTC row valued at a 7-day-old archive price (the live-corpus class): the
  // value stays in the totals, and its age is DISCLOSED.
  const out = buildHoldingsSummary({
    scopeHint: "full",
    fullRows: [
      row({ instrumentId: "iAAA", symbol: "AAA", reportingValue: 10000, priceDate: "2026-08-21", staleDays: 1 }),
      row({ instrumentId: "iBTC", symbol: "BTC", reportingValue: 15176.17, priceDate: "2026-08-15", staleDays: 7 }),
    ],
    allScope: agg({ valuedSubtotal: 25176.17, cashValue: 0 }),
  })!;
  check("stale-priced value stays in the totals (disclosure, not exclusion)",
    approx(out.valuedPositionsTotal, 25176.17));
  const staleNote = out.dataLimits.find((d) => /day\(s\) old/.test(d));
  check("staleness disclosed in dataLimits", staleNote !== undefined);
  check("disclosure names the max age and its price date",
    !!staleNote && /7 day\(s\) old/.test(staleNote) && /2026-08-15/.test(staleNote));

  // The normal close lag (0–1 days) is NOT remarked on.
  const fresh = buildHoldingsSummary({
    scopeHint: "full",
    fullRows: [row({ instrumentId: "i1", symbol: "AAA", reportingValue: 5000, priceDate: "2026-08-21", staleDays: 1 })],
    allScope: agg({ valuedSubtotal: 5000 }),
  })!;
  check("0–1 day close lag not disclosed (threshold = STALE_PRICE_DISCLOSURE_DAYS)",
    STALE_PRICE_DISCLOSURE_DAYS === 2 && !fresh.dataLimits.some((d) => /day\(s\) old/.test(d)));

  // Dating absent (fixtures/unvalued) ⇒ no disclosure, no crash.
  const undated = buildHoldingsSummary({
    scopeHint: "full",
    fullRows: [row({ instrumentId: "i1", symbol: "AAA", reportingValue: 5000 })],
    allScope: agg({ valuedSubtotal: 5000 }),
  })!;
  check("rows without dating fields are fine (optional, no disclosure)",
    !undated.dataLimits.some((d) => /day\(s\) old/.test(d)));
}

// ── Exit ────────────────────────────────────────────────────────────────────
if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll holdings-core checks passed.");
