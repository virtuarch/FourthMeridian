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

/**
 * Instrument display + allocation identity, keyed by instrumentId. `symbol`/`name`
 * are the row identity every consumer reads; `assetClass`/`sector`/`isCash` are the
 * additive allocation-grouping fields (Allocation panel). `assetClass` is the raw
 * AssetClass enum VALUE as a plain string, matching this module's Prisma-free
 * convention (no @prisma/client import).
 */
export interface InstrumentDisplay {
  symbol:     string | null;
  name:       string | null;
  assetClass: string;
  sector:     string | null;
  isCash:     boolean;
}

/** A valued holding enriched with display identity and its composition share. */
export interface ValuedHoldingRow extends InstrumentValuation {
  symbol: string | null;
  name:   string | null;
  /** reportingValue / valuedSubtotal in 0..1; null when unvalued or subtotal ≤ 0. */
  share:  number | null;
  /** Allocation-grouping identity (additive) — see InstrumentDisplay. */
  assetClass: string;
  sector:     string | null;
  isCash:     boolean;
}

/**
 * Position-valuation COVERAGE for one endpoint — the machine-readable answer to
 * "how much of what was held did we actually value, and how confidently?", so a
 * consumer NEVER mistakes a coverage-gated `valuedValue` for the whole portfolio.
 *
 * This is the "Position valuation truth" face of the two-truths split (see
 * docs/doctrine/financial-semantics.md §6): a bottom-up subtotal that is honest
 * about what it left out. It exposes coverage, it does not fabricate a total.
 *
 * Honesty model (mirrors the tier vocabulary — estimated ≠ observed, unavailable
 * ≠ zero, missing ≠ ignored):
 *   - `valuedValue`      = the confident floor (Σ valued positions == valuedSubtotal).
 *   - `observedValue`    = the part of `valuedValue` a provider/you stated (observed tier).
 *   - `estimatedValue`   = the reconstructed part (held-constant quantities, walked-back
 *                          price/FX) — a real magnitude, but disclosed as not-observed.
 *   - `unavailableCount` = positions held (a quantity is known) with NO defensible value.
 *   - `unavailableValue` = the magnitude of that remainder, or `null` when it cannot be
 *                          estimated without fabricating a price. NEVER 0-as-known.
 *   - `coverageByCount`  = valued / (valued + unavailable) in 0..1 (1 when nothing held).
 *   - `fullyObserved`    = every held position valued AND every valued one observed.
 */
export interface PortfolioValuationCoverage {
  valuedValue:      number;
  observedValue:    number;
  estimatedValue:   number;
  valuedCount:      number;
  unavailableCount: number;
  unavailableValue: number | null;
  coverageByCount:  number;
  fullyObserved:    boolean;
}

/** The as-of portfolio view (the A8 shape, re-surfaced verbatim). */
export interface InvestmentsPortfolio {
  reportingCurrency: string;
  valuedSubtotal:    number;
  valuedCount:       number;
  unvaluedCount:     number;
  unvalued:          UnvaluedPosition[];
  /** Coverage of this as-of subtotal (PortfolioValuationCoverage). Consumers read
   *  THIS — not `valuedSubtotal` alone — before treating the figure as a total. */
  coverage:          PortfolioValuationCoverage;
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
 *
 * COVERAGE (the two-truths guard): `openingValue`/`closingValue` are each a
 * position-valuation subtotal, and the two endpoints can cover DIFFERENT position
 * sets (a position first observed after `from` is absent from the opening). A
 * change divided by a partial opening is the "fake return" failure this contract
 * exists to prevent. `openingCoverage`/`closingCoverage` expose each endpoint's
 * coverage, and `coverageConsistent` is the single machine-readable verdict a
 * consumer reads before rendering a percentage: it is true ONLY when both
 * endpoints valued every held position (no unavailable remainder either side), so
 * the change compares like-for-like. When false, `totalChange / openingValue` does
 * not represent a whole-portfolio return and must not be shown as one.
 */
/**
 * What `totalChange` actually represents — the gate a consumer reads BEFORE it
 * shows a percentage, so a value change can never be presented as a return.
 * `(closing − opening) / opening` equals a genuine holding-period return only when
 * no external capital crossed the portfolio boundary in the window; long ranges
 * (YTD / 1Y / All Time) routinely violate that, which is why a confident "+550%"
 * over a year of contributions is a value change, not a gain.
 *
 *   "return"       — coverageConsistent AND no external flows ⇒ Δ/opening IS a
 *                    holding-period return; a percentage is valid.
 *   "value-change" — coverageConsistent but external flows occurred ⇒ Δ folds in
 *                    contributions/withdrawals; present the $ value change, never a
 *                    return %. A true return needs TWR/IRR (a separate methodology).
 *   "incomparable" — endpoints cover different universes (coverageConsistent false)
 *                    ⇒ not even a clean value change; show $ with a caveat, no %.
 */
export type ChangeInterpretation = "return" | "value-change" | "incomparable";

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
  /** Coverage of each endpoint subtotal — so a consumer can rebase or suppress a
   *  percentage rather than divide by a partial opening. */
  openingCoverage:   PortfolioValuationCoverage;
  closingCoverage:   PortfolioValuationCoverage;
  /** True ONLY when BOTH endpoints valued every held position (like-for-like change).
   *  When false, `totalChange / openingValue` is NOT a whole-portfolio return. */
  coverageConsistent: boolean;
  /** Did external capital cross the portfolio boundary in the window (or move
   *  unmeasured)? When true, `totalChange` folds in contributions/withdrawals, so a
   *  simple percentage is a value change — never a return. */
  hasExternalFlows:   boolean;
  /** The verdict a consumer reads before rendering a percentage (see ChangeInterpretation).
   *  A return only when the change is coverage-consistent AND flow-free. */
  changeInterpretation: ChangeInterpretation;
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

/**
 * Enrich a valuation view's components into display-carrying, share-weighted,
 * deterministically-sorted holding rows. PURE. This is the single definition of
 * "a valuation view → ValuedHoldingRow[]", reused by both the Time Machine
 * assembler and the current-position seam (getCurrentPositions), so the two
 * surfaces present holdings identically — parity by shared code, not convention.
 */
export function toValuedHoldingRows(
  view: InvestmentValuationView,
  display: Record<string, InstrumentDisplay>,
): ValuedHoldingRow[] {
  const subtotal = view.valuedSubtotal;
  return view.components
    .map((c) => {
      const d = display[c.instrumentId];
      const share = c.reportingValue != null && subtotal > 0 ? c.reportingValue / subtotal : null;
      return {
        ...c,
        symbol:     d?.symbol ?? null,
        name:       d?.name ?? null,
        share,
        // Absent display (instrument row not found) ⇒ honest UNKNOWN class, no
        // sector, non-cash — the allocation core buckets these as "Unknown".
        assetClass: d?.assetClass ?? "UNKNOWN",
        sector:     d?.sector ?? null,
        isCash:     d?.isCash ?? false,
      };
    })
    .sort(holdingSort);
}

/**
 * Derive the machine-readable coverage of a valuation view. PURE — reads only the
 * view's own valued subtotal, counts, and per-component tiers; adds NO valuation
 * math and reaches for no price/FX. The observed/estimated split partitions the
 * ALREADY-computed `valuedSubtotal` by each valued component's `overallTier`, so
 * `observedValue + estimatedValue === valuedSubtotal` by construction.
 *
 * `unavailableValue` is left `null`: a position with no defensible value has no
 * honest magnitude, and inventing one (e.g. from the closing price, or a stale
 * quote) would be the very fabrication the honesty model forbids. The unavailable
 * remainder is exposed as a COUNT (+ the view's `unvalued[]` detail) instead.
 */
export function buildValuationCoverage(view: InvestmentValuationView): PortfolioValuationCoverage {
  let observedValue = 0;
  let estimatedValue = 0;
  for (const c of view.components) {
    if (c.reportingValue == null) continue; // unvalued → the remainder, not a value
    if (c.overallTier === "observed") observedValue += c.reportingValue;
    else estimatedValue += c.reportingValue; // derived / estimated / any non-observed
  }
  const unavailableCount = view.unvaluedCount;
  const held = view.valuedCount + unavailableCount;
  return {
    valuedValue:      view.valuedSubtotal,
    observedValue,
    estimatedValue,
    valuedCount:      view.valuedCount,
    unavailableCount,
    unavailableValue: null,
    coverageByCount:  held === 0 ? 1 : view.valuedCount / held,
    fullyObserved:    unavailableCount === 0 && estimatedValue === 0,
  };
}

/** Re-surface a valuation view as the portfolio subtotal + unvalued remainder. PURE. */
export function toInvestmentsPortfolio(view: InvestmentValuationView): InvestmentsPortfolio {
  return {
    reportingCurrency: view.reportingCurrency,
    valuedSubtotal:    view.valuedSubtotal,
    valuedCount:       view.valuedCount,
    unvaluedCount:     view.unvaluedCount,
    unvalued:          view.unvalued,
    coverage:          buildValuationCoverage(view),
    completeness:      view.completeness,
  };
}

/** Compose the canonical result. Pure and deterministic. */
export function assembleInvestmentsTimeMachine(args: {
  asOf:        string;
  compareTo:   string | null;
  view:        InvestmentValuationView;
  compareView: InvestmentValuationView | null;
  flows:       PeriodFlows | null;
  display:     Record<string, InstrumentDisplay>;
}): InvestmentsTimeMachineResult {
  const { asOf, compareTo, view, compareView, flows, display } = args;
  const reportingCurrency = view.reportingCurrency;

  const holdings = toValuedHoldingRows(view, display);
  const portfolio = toInvestmentsPortfolio(view);

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

  // Per-endpoint coverage + the like-for-like verdict. The change compares
  // like-for-like ONLY when neither endpoint dropped a held position; a partial
  // opening divided into the delta is the "fake return" this guards against.
  const openingCoverage = buildValuationCoverage(compareView);
  const closingCoverage = buildValuationCoverage(view);
  const coverageConsistent =
    openingCoverage.unavailableCount === 0 && closingCoverage.unavailableCount === 0;

  // Return integrity: (closing − opening)/opening is a genuine holding-period
  // return ONLY when no external capital crossed the boundary AND the universe is
  // comparable. GROSS external activity (not net — offsetting flows still break the
  // simple return) OR value that moved unmeasured makes the change a value change.
  const hasExternalFlows = flowsCrossedBoundary(flows);
  const changeInterpretation: ChangeInterpretation =
    !coverageConsistent ? "incomparable"
    : hasExternalFlows   ? "value-change"
    :                      "return";

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
    completeness: tier, conflict, endpointIncomplete,
    openingCoverage, closingCoverage, coverageConsistent,
    hasExternalFlows, changeInterpretation, reason,
  };
}

/**
 * Did external capital cross the portfolio boundary in the window, or did value
 * move that we could not measure as a flow? Uses GROSS legs — a +$1000
 * contribution and a −$1000 withdrawal net to zero but still break the simple
 * return — plus the unmeasured-external counters. Null flows ⇒ conservatively
 * treated as "unknown activity" (not a clean return). PURE.
 */
function flowsCrossedBoundary(flows: PeriodFlows | null): boolean {
  if (!flows) return true; // no flow evidence ⇒ cannot assert a flow-free return
  return (
    flows.contributions !== 0 || flows.withdrawals !== 0 ||
    flows.transfersIn !== 0 || flows.transfersOut !== 0 ||
    flows.externalAmountMissingCount > 0 || flows.inKindTransferCount > 0
  );
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
