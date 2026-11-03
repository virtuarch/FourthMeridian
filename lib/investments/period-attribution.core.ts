/**
 * lib/investments/period-attribution.core.ts
 *
 * V26-INVESTMENTS-HISTORY-FIX — the eligibility authority for period claims.
 * PURE: no Prisma, no network, no clock.
 *
 * ── What went wrong, stated precisely ───────────────────────────────────────
 *
 * The Investments page showed, for YTD:
 *
 *     Opening value      $516.43
 *     Money in         +$1,050.00
 *     Money out           −$50.00
 *     Portfolio change +$18,918.98
 *     Closing value    $20,435.42        ↑ $19,919 · 3857.0% vs 2026-01-01
 *
 * The arithmetic is exact. The semantics are not. `$516.43` is not a portfolio
 * value: it is $2,879.94 of long positions minus $2,363.51 of SHORT positions
 * that the reconstruction produced from a known dual-sign-convention defect,
 * with the two largest real holdings (BTC and a cash account) unvalued for want
 * of a price, every quantity projected backward from July observations, and not
 * one of them observed. `$18,918.98` is then whatever is left after subtracting
 * flows from the difference between that number and a fully observed closing
 * value — an estimated-to-observed basis transition, labelled as performance.
 *
 * ── The part that is easy to miss ───────────────────────────────────────────
 *
 * The system ALREADY KNEW. `buildReconciliation` computes `endpointIncomplete`,
 * `coverageConsistent` and `changeInterpretation: "incomparable"` and gets all
 * three right for this period. The hero then computes `totalChange /
 * openingValue` without consulting any of them, and the bridge renders the
 * waterfall with the guard demoted to a `caveat` string underneath it.
 *
 * So this module adds no new evidence. It makes the evidence BINDING: a claim
 * is either supported, or it is not made.
 */

import type { CompletenessTier } from "@/lib/perspective-engine/types";

/** Why a causal decomposition may not be shown. Declaration order = report order. */
export const ATTRIBUTION_REFUSALS = [
  "OPENING_ENDPOINT_INCOMPLETE",
  "CLOSING_ENDPOINT_INCOMPLETE",
  "OPENING_NOT_OBSERVED",
  "BASIS_CHANGED_ACROSS_PERIOD",
  "OPENING_CONTAINS_RECONSTRUCTED_SHORTS",
  "HOLDING_UNIVERSE_CHANGED",
  "FLOW_COVERAGE_INCOMPLETE",
  "RECONSTRUCTION_CONFLICT",
  // PB-11 M4 — set only by the DISPLAY conversion (display-conversion.ts), never
  // by `assessPeriodAttribution`: the period's figures cannot be expressed in the
  // display currency, so none of them is shown rather than one shown unconverted.
  "DISPLAY_RATE_UNAVAILABLE",
] as const;
export type AttributionRefusal = (typeof ATTRIBUTION_REFUSALS)[number];

export const REFUSAL_COPY: Record<AttributionRefusal, string> = {
  OPENING_ENDPOINT_INCOMPLETE:
    "Some holdings could not be valued at the start of this period, so the opening value is a partial subtotal.",
  CLOSING_ENDPOINT_INCOMPLETE:
    "Some holdings could not be valued at the end of this period, so the closing value is a partial subtotal.",
  OPENING_NOT_OBSERVED:
    "Holdings at the start of this period were reconstructed from later evidence, not observed.",
  BASIS_CHANGED_ACROSS_PERIOD:
    "The start and end of this period are measured on different bases, so the difference between them is not portfolio performance.",
  OPENING_CONTAINS_RECONSTRUCTED_SHORTS:
    "Reconstructed holdings at the start of this period include negative positions, which offset real holdings and understate the opening value.",
  HOLDING_UNIVERSE_CHANGED:
    "The set of holdings changed across this period, so the start and end are not the same portfolio.",
  FLOW_COVERAGE_INCOMPLETE:
    "Deposits and withdrawals for this period are not fully imported, so money in and out cannot be stated as complete.",
  RECONSTRUCTION_CONFLICT:
    "A holding carries a reconstruction conflict across this period.",
  DISPLAY_RATE_UNAVAILABLE:
    "No conversion rate to the display currency is available for this period, so its change can't be shown in it.",
};

/** Everything the assessment needs. Deliberately plain data — no view objects. */
export interface AttributionEvidence {
  fromISO:            string;
  toISO:              string;
  reportingCurrency:  string;
  openingValue:       number;
  closingValue:       number;
  moneyIn:            number;
  moneyOut:           number;
  netExternalFlows:   number;
  /** closing − opening − netExternalFlows. The number under scrutiny. */
  residualChange:     number;
  openingUnvaluedCount: number;
  closingUnvaluedCount: number;
  /** Per-endpoint worst tier over the holdings that WERE valued. */
  openingTier:        CompletenessTier;
  closingTier:        CompletenessTier;
  /** Signed reporting values at the opening endpoint, for the shorts test. */
  openingComponentValues: readonly number[];
  /** Instrument ids held (valued or not) at each endpoint. */
  openingInstrumentIds: readonly string[];
  closingInstrumentIds: readonly string[];
  /** Completeness of the flow evidence, when the flow layer states one. */
  flowCompleteness:   CompletenessTier | null;
  conflict:           boolean;
}

export type AttributionKind = "ATTRIBUTABLE" | "PARTIALLY_ATTRIBUTABLE" | "NOT_ATTRIBUTABLE";

export interface AttributionRefusalDetail {
  code:   AttributionRefusal;
  copy:   string;
  detail: string;
}

export interface PeriodAttribution {
  kind:    AttributionKind;
  fromISO: string;
  toISO:   string;
  reportingCurrency: string;
  /** Always available — the closing value is the one number never in doubt here. */
  closingValue: number;
  /** Null whenever the opening endpoint is not defensible. */
  openingValue: number | null;
  /** Stated only when flow coverage is complete. */
  moneyIn:  number | null;
  moneyOut: number | null;
  /**
   * The residual. Named for what it IS — the part of the change no evidence
   * attributes — and populated ONLY when the decomposition is attributable, so
   * a partial period cannot render it as performance under any label.
   */
  portfolioChange: number | null;
  /** The same number when the period is NOT attributable: change we cannot explain. */
  unattributedChange: number | null;
  /** May the UI show a return percentage against `openingValue`? */
  mayShowReturnPercentage: boolean;
  refusals: AttributionRefusalDetail[];
  /** One-line summary for the surface that has room for only one. */
  headline: string;
}

const OBSERVED_TIERS: ReadonlySet<CompletenessTier> = new Set<CompletenessTier>(["observed"]);

/**
 * Assess a period.
 *
 * Deterministic and total. Refusals are emitted in declaration order, and any
 * refusal at all denies `ATTRIBUTABLE` — this is a conjunction, not a score.
 * Nothing here averages away a failure or trades one kind of evidence against
 * another, because a decomposition that is 80% supported is not 80% true.
 */
export function assessPeriodAttribution(e: AttributionEvidence): PeriodAttribution {
  const refusals: AttributionRefusalDetail[] = [];
  const refuse = (code: AttributionRefusal, detail: string) =>
    refusals.push({ code, copy: REFUSAL_COPY[code], detail });

  if (e.openingUnvaluedCount > 0) {
    refuse("OPENING_ENDPOINT_INCOMPLETE",
      `${e.openingUnvaluedCount} holding(s) unvalued at ${e.fromISO}`);
  }
  if (e.closingUnvaluedCount > 0) {
    refuse("CLOSING_ENDPOINT_INCOMPLETE",
      `${e.closingUnvaluedCount} holding(s) unvalued at ${e.toISO}`);
  }
  if (!OBSERVED_TIERS.has(e.openingTier)) {
    refuse("OPENING_NOT_OBSERVED", `opening completeness is "${e.openingTier}"`);
  }
  if (e.openingTier !== e.closingTier) {
    refuse("BASIS_CHANGED_ACROSS_PERIOD",
      `opening "${e.openingTier}" vs closing "${e.closingTier}" — the difference includes the change of basis`);
  }

  // The shorts test. A reconstructed opening whose longs and shorts offset does
  // not merely carry uncertainty — it is SMALLER than the real portfolio, which
  // inflates every downstream percentage. This is checked on signed values
  // rather than quantities so a legitimately short position priced at zero
  // cannot slip through.
  const shorts = e.openingComponentValues.filter((v) => v < 0);
  if (shorts.length > 0 && !OBSERVED_TIERS.has(e.openingTier)) {
    const shortTotal = shorts.reduce((n, v) => n + v, 0);
    refuse("OPENING_CONTAINS_RECONSTRUCTED_SHORTS",
      `${shorts.length} negative position(s) totalling ${shortTotal.toFixed(2)} offset the opening value`);
  }

  const opening = new Set(e.openingInstrumentIds);
  const closing = new Set(e.closingInstrumentIds);
  const onlyOpening = [...opening].filter((i) => !closing.has(i));
  const onlyClosing = [...closing].filter((i) => !opening.has(i));
  if (onlyOpening.length > 0 || onlyClosing.length > 0) {
    refuse("HOLDING_UNIVERSE_CHANGED",
      `${onlyOpening.length} holding(s) present only at the start, ${onlyClosing.length} only at the end`);
  }

  if (e.flowCompleteness !== null && !OBSERVED_TIERS.has(e.flowCompleteness)) {
    refuse("FLOW_COVERAGE_INCOMPLETE", `flow completeness is "${e.flowCompleteness}"`);
  }
  if (e.conflict) refuse("RECONSTRUCTION_CONFLICT", "a position carries a reconstruction conflict");

  // ── Grade ───────────────────────────────────────────────────────────────
  // ATTRIBUTABLE requires every claim to hold. Between that and nothing sits
  // PARTIALLY_ATTRIBUTABLE: the closing value and the flows may still be real
  // even when the opening endpoint is not, and suppressing them would hide
  // facts rather than protect the user.
  const openingDefensible = !refusals.some((r) =>
    r.code === "OPENING_ENDPOINT_INCOMPLETE" || r.code === "OPENING_NOT_OBSERVED" ||
    r.code === "OPENING_CONTAINS_RECONSTRUCTED_SHORTS" || r.code === "BASIS_CHANGED_ACROSS_PERIOD");
  const flowsDefensible = !refusals.some((r) => r.code === "FLOW_COVERAGE_INCOMPLETE");

  const kind: AttributionKind =
    refusals.length === 0 ? "ATTRIBUTABLE"
    : openingDefensible   ? "PARTIALLY_ATTRIBUTABLE"
    :                       "NOT_ATTRIBUTABLE";

  const attributable = kind === "ATTRIBUTABLE";

  return {
    kind, fromISO: e.fromISO, toISO: e.toISO, reportingCurrency: e.reportingCurrency,
    closingValue: e.closingValue,
    openingValue: openingDefensible ? e.openingValue : null,
    moneyIn:  flowsDefensible ? e.moneyIn  : null,
    moneyOut: flowsDefensible ? e.moneyOut : null,
    portfolioChange: attributable ? e.residualChange : null,
    unattributedChange: attributable ? null
      : openingDefensible ? e.residualChange : null,
    // A percentage is a ratio against the opening value. If the opening value is
    // not defensible the ratio is not either, however true the numerator is.
    mayShowReturnPercentage: attributable && e.openingValue !== 0,
    refusals,
    headline:
      kind === "ATTRIBUTABLE" ? "This period is fully attributable."
      : kind === "PARTIALLY_ATTRIBUTABLE" ? "This period is only partly attributable."
      : "This period cannot be attributed.",
  };
}

/**
 * The hero's change figure and percentage, gated by the same assessment the card
 * uses. Exported so the two surfaces cannot drift: there is one rule, and both
 * read it.
 */
export function heroComparison(a: PeriodAttribution): {
  showChange: boolean;
  changeAmount: number | null;
  showPercentage: boolean;
  percentage: number | null;
  suppressedReason: string | null;
} {
  if (a.openingValue === null) {
    return {
      showChange: false, changeAmount: null, showPercentage: false, percentage: null,
      suppressedReason: a.refusals[0]?.copy ?? "The start of this period is not defensible.",
    };
  }
  const change = a.closingValue - a.openingValue;
  const pct = a.mayShowReturnPercentage && a.openingValue !== 0
    ? (change / a.openingValue) * 100 : null;
  return {
    showChange: true, changeAmount: change,
    showPercentage: pct !== null, percentage: pct,
    suppressedReason: pct === null ? (a.refusals[0]?.copy ?? null) : null,
  };
}

/**
 * PB-11 M5 — the hero's comparison when a payload carries NO period verdict
 * (`attribution` absent) but does carry the reconciliation. Not a second rule:
 * it reads the evidence the reconciliation authority (buildReconciliation)
 * already decided — `endpointIncomplete`, `coverageConsistent`,
 * `changeInterpretation`, `completeness` — and applies the SAME refusal copy
 * the verdict uses, in PB-8b's three states:
 *   withheld   an endpoint is partial / unpriced → no change, the reason said;
 *   estimated  the basis is not fully observed → the value change, labelled
 *              estimated, never a percentage;
 *   comparable a like-for-like, flow-free, observed period → change + return %.
 * A value change with external flows keeps its amount but never a percentage.
 */
export function reconciliationComparison(r: {
  openingValue: number; closingValue: number; totalChange: number;
  endpointIncomplete: boolean; coverageConsistent: boolean;
  changeInterpretation: "return" | "value-change" | "incomparable";
  completeness: CompletenessTier; conflict: boolean;
  openingCoverage: { unavailableCount: number };
}): ReturnType<typeof heroComparison> & { estimated: boolean } {
  if (r.endpointIncomplete || !r.coverageConsistent || r.changeInterpretation === "incomparable") {
    return {
      showChange: false, changeAmount: null, showPercentage: false, percentage: null, estimated: false,
      suppressedReason: r.openingCoverage.unavailableCount > 0
        ? REFUSAL_COPY.OPENING_ENDPOINT_INCOMPLETE : REFUSAL_COPY.CLOSING_ENDPOINT_INCOMPLETE,
    };
  }
  const estimated = !OBSERVED_TIERS.has(r.completeness);
  const mayShowPct = !estimated && !r.conflict && r.changeInterpretation === "return" && r.openingValue !== 0;
  return {
    showChange: true, changeAmount: r.totalChange,
    showPercentage: mayShowPct, percentage: mayShowPct ? (r.totalChange / r.openingValue) * 100 : null,
    estimated,
    suppressedReason: mayShowPct ? null
      : estimated ? REFUSAL_COPY.OPENING_NOT_OBSERVED
      : r.conflict ? REFUSAL_COPY.RECONSTRUCTION_CONFLICT
      : "Money moved in or out during this period, so this is a value change, not a return.",
  };
}
