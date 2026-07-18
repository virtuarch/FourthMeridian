/**
 * lib/investments/investments-trust.test.ts  (PCS-1C)
 *
 * Pure tests for the canonical Activity + Trust contract. Standalone tsx script:
 *
 *     npx tsx lib/investments/investments-trust.test.ts
 *
 * Pins:
 *   1. The valuation-completeness intent — partial flag, figure label, and the
 *      "N of M positions valued" evidence string (the regression pin that keeps
 *      the Portfolio Header badge and the shell envelope chip identical).
 *   2. The activity caveat is SINGLE-authored — buildInvestmentsTrustSummary's
 *      `activityCaveat` is byte-identical to investment-flows-core's
 *      `formatFlowCaveatSentence`, and null when there is no comparison window.
 *   3. The structured `indicators` list surfaces every active concern
 *      (unvalued, conflict, the four flow counters, endpoint-incomplete) and is
 *      empty on a fully clean result.
 *   4. Null-safety when flows / reconciliation are absent (current-only view).
 */

import { formatFlowCaveatSentence, type PeriodFlows } from "./investment-flows-core";
import type {
  InvestmentsTimeMachineResult,
  InvestmentsReconciliation,
  PortfolioValuationCoverage,
} from "./investments-time-machine-core";
import {
  buildInvestmentsTrustSummary,
  valuedOfTotalLabel,
  FIGURE_LABEL_PARTIAL,
  FIGURE_LABEL_WHOLE,
} from "./investments-trust";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const CUR = "USD";

/** A PeriodFlows fixture — only the fields the Trust summary reads need be real. */
function flows(over: Partial<PeriodFlows> = {}): PeriodFlows {
  return {
    from: "2026-01-01", to: "2026-03-31", reportingCurrency: CUR,
    eventCount: 3,
    contributions: 0, withdrawals: 0, transfersIn: 0, transfersOut: 0,
    buys: 0, sells: 0, income: 0, fees: 0,
    netExternalFlows: 0,
    byCategory: [],
    inKindTransferCount: 0, unclassifiedCount: 0, externalAmountMissingCount: 0,
    fxEstimated: false,
    completeness: "observed",
    reason: "3 events in the period.",
    ...over,
  };
}

/** A fully-observed coverage fixture (valuedValue, valuedCount, unavailableCount). */
function cov(valuedValue: number, valuedCount: number, unavailableCount = 0): PortfolioValuationCoverage {
  const held = valuedCount + unavailableCount;
  return {
    valuedValue, observedValue: valuedValue, estimatedValue: 0,
    valuedCount, unavailableCount, unavailableValue: null,
    coverageByCount: held === 0 ? 1 : valuedCount / held,
    fullyObserved: unavailableCount === 0,
  };
}

function reconciliation(over: Partial<InvestmentsReconciliation> = {}): InvestmentsReconciliation {
  return {
    from: "2026-01-01", to: "2026-03-31", reportingCurrency: CUR,
    openingValue: 1000, closingValue: 1200, totalChange: 200,
    netExternalFlows: 50, residualChange: 150,
    residualReason: "residual reason text",
    completeness: "observed", conflict: false, endpointIncomplete: false,
    openingCoverage: cov(1000, 1), closingCoverage: cov(1200, 1), coverageConsistent: true,
    hasExternalFlows: true, changeInterpretation: "value-change",
    reason: "reconciled",
    ...over,
  };
}

/** An InvestmentsTimeMachineResult fixture; portfolio/completeness are what Trust reads. */
function result(over: {
  valuedCount?: number;
  unvaluedCount?: number;
  tier?: InvestmentsTimeMachineResult["completeness"]["tier"];
  conflict?: boolean;
  reason?: string;
  flows?: PeriodFlows | null;
  reconciliation?: InvestmentsReconciliation | null;
} = {}): InvestmentsTimeMachineResult {
  const valuedCount = over.valuedCount ?? 3;
  const unvaluedCount = over.unvaluedCount ?? 0;
  const tier = over.tier ?? "observed";
  const conflict = over.conflict ?? false;
  const reason = over.reason ?? "All 3 holdings valued for 2026-03-31.";
  return {
    asOf: "2026-03-31",
    compareTo: over.flows ? "2026-01-01" : null,
    reportingCurrency: CUR,
    holdings: [],
    portfolio: {
      reportingCurrency: CUR,
      valuedSubtotal: 1200,
      valuedCount,
      unvaluedCount,
      unvalued: [],
      coverage: cov(1200, valuedCount, unvaluedCount),
      completeness: { tier, conflict, reason, byInstrument: {} },
    },
    flows: over.flows ?? null,
    reconciliation: over.reconciliation ?? null,
    completeness: { tier, conflict, reason, byComponent: {} },
  };
}

function main(): void {
  // ── 1. valuation-completeness intent ────────────────────────────────────────
  console.log("1. valuation completeness (partial / figure label / evidence string)");
  {
    const clean = buildInvestmentsTrustSummary(result({ valuedCount: 4, unvaluedCount: 0 }));
    check("clean ⇒ not partial", clean.partial === false);
    check("clean ⇒ figure label 'Portfolio value'", clean.figureLabel === FIGURE_LABEL_WHOLE);
    check("clean ⇒ '4 of 4 positions valued'", clean.valuedOfTotalLabel === "4 of 4 positions valued");
    check("clean ⇒ totalPositions 4", clean.totalPositions === 4);

    const partial = buildInvestmentsTrustSummary(result({ valuedCount: 3, unvaluedCount: 2, tier: "incomplete" }));
    check("partial ⇒ partial true", partial.partial === true);
    check("partial ⇒ figure label 'Valued holdings'", partial.figureLabel === FIGURE_LABEL_PARTIAL);
    check("partial ⇒ '3 of 5 positions valued'", partial.valuedOfTotalLabel === "3 of 5 positions valued");

    // The exact string both the header badge and the shell envelope render.
    check("valuedOfTotalLabel is the canonical string author",
      valuedOfTotalLabel(3, 5) === "3 of 5 positions valued");
    check("valuedOfTotalLabel null when no positions", valuedOfTotalLabel(0, 0) === null);
    const none = buildInvestmentsTrustSummary(result({ valuedCount: 0, unvaluedCount: 0 }));
    check("no positions ⇒ evidence label null", none.valuedOfTotalLabel === null);
  }

  // ── 2. activity caveat is single-authored ───────────────────────────────────
  console.log("2. activity caveat single-authoring");
  {
    const noWindow = buildInvestmentsTrustSummary(result({ flows: null }));
    check("no comparison ⇒ activityCaveat null", noWindow.activityCaveat === null);
    check("no comparison ⇒ fxEstimated false", noWindow.fxEstimated === false);

    const f = flows({ inKindTransferCount: 1, unclassifiedCount: 2, fxEstimated: true });
    const s = buildInvestmentsTrustSummary(result({ flows: f, valuedCount: 2 }));
    check("caveat === formatFlowCaveatSentence(flows)",
      s.activityCaveat === formatFlowCaveatSentence(f),
      `got ${JSON.stringify(s.activityCaveat)}`);
    check("caveat mentions in-kind transfer", /in-kind transfer/.test(s.activityCaveat ?? ""));
    check("caveat mentions uncategorised", /could not be categorised/.test(s.activityCaveat ?? ""));
    check("caveat mentions estimated rate", /estimated rate/.test(s.activityCaveat ?? ""));
    check("caveat is capitalised + terminated",
      (s.activityCaveat ?? "").charAt(0) === (s.activityCaveat ?? "").charAt(0).toUpperCase()
        && (s.activityCaveat ?? "").endsWith("."));
    check("fxEstimated surfaced", s.fxEstimated === true);

    const clean = buildInvestmentsTrustSummary(result({ flows: flows() }));
    check("clean flows ⇒ activityCaveat null", clean.activityCaveat === null);
  }

  // ── 3. structured indicators ────────────────────────────────────────────────
  console.log("3. indicators list");
  {
    const cleanAll = buildInvestmentsTrustSummary(result({ valuedCount: 3, unvaluedCount: 0, flows: flows() }));
    check("fully clean ⇒ no indicators", cleanAll.indicators.length === 0, JSON.stringify(cleanAll.indicators));

    const messy = buildInvestmentsTrustSummary(result({
      valuedCount: 2, unvaluedCount: 1, conflict: true, tier: "incomplete",
      flows: flows({ inKindTransferCount: 1, externalAmountMissingCount: 1, unclassifiedCount: 1, fxEstimated: true }),
      reconciliation: reconciliation({ endpointIncomplete: true }),
    }));
    const keys = new Set(messy.indicators.map((i) => i.key));
    for (const k of ["unvalued", "conflict", "in_kind_transfer", "external_amount_missing", "unclassified", "fx_estimated", "endpoint_incomplete"] as const) {
      check(`indicator present: ${k}`, keys.has(k));
    }
    const unvalued = messy.indicators.find((i) => i.key === "unvalued");
    check("unvalued indicator carries its count", unvalued?.count === 1);
    check("unvalued singular grammar", /1 position could not be valued and is excluded/.test(unvalued?.sentence ?? ""));
    check("every indicator sentence ends with a period", messy.indicators.every((i) => i.sentence.endsWith(".")));

    // Plural grammar on the unvalued indicator.
    const plural = buildInvestmentsTrustSummary(result({ valuedCount: 1, unvaluedCount: 3, tier: "incomplete" }));
    const pu = plural.indicators.find((i) => i.key === "unvalued");
    check("unvalued plural grammar", /3 positions could not be valued and are excluded/.test(pu?.sentence ?? ""));
  }

  // ── 4. envelope passthrough + null-safety ───────────────────────────────────
  console.log("4. envelope + reconciliation passthrough");
  {
    const s = buildInvestmentsTrustSummary(result({
      tier: "estimated", conflict: true, reason: "custom reason",
      reconciliation: reconciliation({ residualChange: 42, residualReason: "why 42", endpointIncomplete: true }),
    }));
    check("tier passthrough", s.tier === "estimated");
    check("conflict passthrough", s.conflict === true);
    check("reason passthrough", s.reason === "custom reason");
    check("residual passthrough", s.residual === 42);
    check("residualReason passthrough", s.residualReason === "why 42");
    check("endpointIncomplete passthrough", s.endpointIncomplete === true);

    const noRec = buildInvestmentsTrustSummary(result({ reconciliation: null }));
    check("no reconciliation ⇒ residual null", noRec.residual === null);
    check("no reconciliation ⇒ residualReason null", noRec.residualReason === null);
    check("no reconciliation ⇒ endpointIncomplete false", noRec.endpointIncomplete === false);
  }

  if (failures > 0) {
    console.error(`\ninvestments-trust: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\ninvestments-trust: all checks passed");
}

main();
