/**
 * lib/investments/investments-time-machine-core.ts
 *
 * A10 — PURE assembly of the Investments Time Machine read model. No DB, no
 * clock, no network: it composes ALREADY-COMPUTED inputs (the A8 valuation view
 * at asOf, an optional valuation view at compareTo, an optional period-flow
 * summary, and an instrument display map) into one coherent result. Fixture-
 * tested with no `prisma generate`.
 *
 * It answers the three architecturally-distinct questions with one shape:
 *   - reconstruction (what was owned)  → quantities/tiers carried on each holding
 *   - valuation      (what it was worth) → values/tiers from the A8 view
 *   - flows + change (what changed)     → period flows + the reconciliation
 *
 * It creates NO second replay engine, price lookup, FX interpretation, or
 * valuation arithmetic — every number here is either passed through from the
 * canonical valuation view / flow summary, or a pure subtraction / ratio of
 * those numbers. The reconciliation is deliberately honest-and-partial: it
 * separates only what the repository can defend (net external flows crossing the
 * portfolio boundary) and folds everything else into a clearly-labelled residual
 * — market movement is NEVER fabricated to force the identity to close.
 */

import { propagateCompleteness, worstTier } from "@/lib/perspective-engine/completeness";
import type { Completeness, CompletenessTier } from "@/lib/perspective-engine/types";
import type { InstrumentValuation, InvestmentValuationView, UnvaluedPosition } from "./valuation-core";
import type { PeriodFlows } from "./investment-flows-core";

/** A valued holding enriched with display identity and its composition share. */
export interface ValuedHoldingRow extends InstrumentValuation {
  symbol: string | null;
  name:   string | null;
  /** reportingValue / valuedSubtotal in 0..1; null when unvalued or subtotal ≤ 0. */
  share:  number | null;
}

/** The as-of portfolio view (the A8 shape, re-surfaced verbatim). */
export interface InvestmentsPortfolio {
  reportingCurrency: string;
  valuedSubtotal:    number;
  valuedCount:       number;
  unvaluedCount:     number;
  unvalued:          UnvaluedPosition[];
  completeness: {
    tier:     CompletenessTier;
    conflict: boolean;
    reason:   string;
    byInstrument: Record<string, CompletenessTier>;
  };
}

/**
 * The change reconciliation between the two dates, in the reporting currency:
 *
 *   closingValue = openingValue + netExternalFlows + residualChange
 *
 * `residualChange` bundles market movement, FX, reinvested income, fees, and any
 * incomplete history — everything that is NOT money the user moved across the
 * portfolio boundary. It is a residual by construction, never an asserted
 * "market gain". When either endpoint is a partial subtotal the identity is a
 * partial and `endpointIncomplete` is set.
 */
export interface InvestmentsReconciliation {
  from:              string; // compareTo
  to:                string; // asOf
  reportingCurrency: string;
  openingValue:      number;
  closingValue:      number;
  totalChange:       number;
  netExternalFlows:  number;
  residualChange:    number;
  residualReason:    string;
  completeness:      CompletenessTier;
  conflict:          boolean;
  endpointIncomplete: boolean;
  reason:            string;
}

/** The canonical Investments Time Machine result. Serialisable. */
export interface InvestmentsTimeMachineResult {
  asOf:              string;
  compareTo:         string | null;
  reportingCurrency: string;
  /** As-of (closing) holdings, value-descending then instrumentId-ascending. */
  holdings:          ValuedHoldingRow[];
  /** As-of portfolio subtotal + explicit unvalued remainder. */
  portfolio:         InvestmentsPortfolio;
  /** Period flows over (compareTo, asOf]; null when no compareTo. */
  flows:             PeriodFlows | null;
  /** Change reconciliation; null when no compareTo. */
  reconciliation:    InvestmentsReconciliation | null;
  /** Overall trust envelope (canonical Completeness shape). */
  completeness:      Completeness;
}

const RESIDUAL_REASON =
  "Change not explained by external contributions, withdrawals, or transfers — " +
  "includes market movement, FX, reinvested income, fees, and any incomplete history.";

/** Deterministic sort: valued (reportingValue desc) first, then unvalued; ties by instrumentId. */
function holdingSort(a: ValuedHoldingRow, b: ValuedHoldingRow): number {
  const av = a.reportingValue;
  const bv = b.reportingValue;
  if (av == null && bv != null) return 1;
  if (av != null && bv == null) return -1;
  if (av != null && bv != null && av !== bv) return bv - av;
  return a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0;
}

/** Compose the canonical result. Pure and deterministic. */
export function assembleInvestmentsTimeMachine(args: {
  asOf:        string;
  compareTo:   string | null;
  view:        InvestmentValuationView;
  compareView: InvestmentValuationView | null;
  flows:       PeriodFlows | null;
  display:     Record<string, { symbol: string | null; name: string | null }>;
}): InvestmentsTimeMachineResult {
  const { asOf, compareTo, view, compareView, flows, display } = args;
  const reportingCurrency = view.reportingCurrency;
  const subtotal = view.valuedSubtotal;

  const holdings: ValuedHoldingRow[] = view.components
    .map((c) => {
      const d = display[c.instrumentId];
      const share = c.reportingValue != null && subtotal > 0 ? c.reportingValue / subtotal : null;
      return { ...c, symbol: d?.symbol ?? null, name: d?.name ?? null, share };
    })
    .sort(holdingSort);

  const portfolio: InvestmentsPortfolio = {
    reportingCurrency,
    valuedSubtotal: view.valuedSubtotal,
    valuedCount:    view.valuedCount,
    unvaluedCount:  view.unvaluedCount,
    unvalued:       view.unvalued,
    completeness:   view.completeness,
  };

  const reconciliation = compareView
    ? buildReconciliation(asOf, compareTo!, reportingCurrency, view, compareView, flows)
    : null;

  const completeness = buildEnvelope(view, compareView, flows);

  return { asOf, compareTo, reportingCurrency, holdings, portfolio, flows, reconciliation, completeness };
}

function buildReconciliation(
  asOf: string,
  from: string,
  reportingCurrency: string,
  view: InvestmentValuationView,
  compareView: InvestmentValuationView,
  flows: PeriodFlows | null,
): InvestmentsReconciliation {
  const openingValue = compareView.valuedSubtotal;
  const closingValue = view.valuedSubtotal;
  const totalChange = closingValue - openingValue;
  const netExternalFlows = flows?.netExternalFlows ?? 0;
  const residualChange = totalChange - netExternalFlows;
  const endpointIncomplete = view.unvaluedCount > 0 || compareView.unvaluedCount > 0;

  const tier = worstTier([
    view.completeness.tier,
    compareView.completeness.tier,
    flows?.completeness ?? "observed",
  ]);
  const conflict = view.completeness.conflict || compareView.completeness.conflict;

  const reason = endpointIncomplete
    ? "Opening or closing value is a partial subtotal (some holdings could not be valued), so this reconciliation is partial."
    : conflict
      ? "Values reconcile, but a position carries a reconstruction conflict — review before trusting the change."
      : `Closing value = opening value + net external flows + residual, over ${from} to ${asOf}.`;

  return {
    from, to: asOf, reportingCurrency,
    openingValue, closingValue, totalChange, netExternalFlows,
    residualChange, residualReason: RESIDUAL_REASON,
    completeness: tier, conflict, endpointIncomplete, reason,
  };
}

function buildEnvelope(
  view: InvestmentValuationView,
  compareView: InvestmentValuationView | null,
  flows: PeriodFlows | null,
): Completeness {
  const parts: Array<{ tier: CompletenessTier; conflict?: boolean }> = [
    { tier: view.completeness.tier, conflict: view.completeness.conflict },
  ];
  const byComponent: Record<string, CompletenessTier> = { asOf: view.completeness.tier };
  if (compareView) {
    parts.push({ tier: compareView.completeness.tier, conflict: compareView.completeness.conflict });
    byComponent.compareTo = compareView.completeness.tier;
  }
  if (flows) {
    parts.push({ tier: flows.completeness });
    byComponent.flows = flows.completeness;
  }

  const { tier, conflict } = propagateCompleteness(parts);
  // The as-of portfolio's own reason is the honest one-sentence summary; the
  // reconciliation carries its own period reason separately.
  return { tier, conflict, reason: view.completeness.reason, byComponent };
}
