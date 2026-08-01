/**
 * components/space/widgets/investments/investments-bridge.ts
 *
 * PURE presentation model for the Change Bridge panel. No DB, no clock, no React
 * — it turns the A10 `InvestmentsReconciliation` (+ the `PeriodFlows` in/out
 * split) into an ordered waterfall of rows whose signed amounts satisfy the
 * reconciliation identity EXACTLY:
 *
 *   opening + moneyIn + moneyOut + residual = closing
 *
 * The four boundary flow categories sum to `netExternalFlows` by construction
 * (investment-flows-core.ts §netExternalFlows), so splitting them into a
 * money-in row (contributions + transfers in, ≥ 0) and a money-out row
 * (withdrawals + transfers out, ≤ 0) keeps the identity row-by-row. Fees, buys,
 * sells and income are NEVER added here — they are internal and already live
 * inside the residual; adding them would double-count. The residual is labelled
 * honestly as "what's inside this number", never asserted as market gains.
 *
 * `buildBridgeRows` asserts the identity in code (dev guard) so a future edit
 * that breaks the arithmetic fails loudly rather than rendering a lie.
 */

import type { InvestmentsReconciliation } from "@/lib/investments/investments-time-machine-core";
import type { PeriodFlows } from "@/lib/investments/investment-flows-core";
import type { PeriodAttribution } from "@/lib/investments/period-attribution.core";

export type BridgeRowKey = "opening" | "money_in" | "money_out" | "residual" | "closing";

export interface BridgeRow {
  key:    BridgeRowKey;
  label:  string;
  /** Signed reporting-currency amount (opening/closing are cumulative levels). */
  amount: number;
  /** True for the two cumulative levels (opening, closing); false for the deltas. */
  isLevel: boolean;
}

export interface BridgeModel {
  /**
   * V26-INVESTMENTS-HISTORY-FIX — `not-attributable` and `partial` are the two
   * states that previously did not exist. The waterfall used to render
   * regardless, with the guard demoted to a caveat line beneath it; a caveat
   * under a number does not stop the number being read.
   */
  state: "no-comparison" | "reconciled" | "partial" | "not-attributable";
  reportingCurrency: string | null;
  rows:  BridgeRow[];
  /** The residual amount, surfaced for the "what's inside" copy. */
  residual: number;
  /** Honest residual explanation (never "gains"). */
  residualReason: string | null;
  /** Set when either endpoint is a partial subtotal or a conflict is present. */
  caveat: string | null;
  /** Present unless the period is fully attributable — why the claim is withheld. */
  headline: string | null;
  reasons:  string[];
}

/** Floating-point identity tolerance (reporting-currency units). */
const EPSILON = 0.01;

/**
 * Build the bridge waterfall. Pure and deterministic. `reconciliation === null`
 * ⇒ no comparison selected. `flows` supplies the in/out split; when it is null
 * (shouldn't happen alongside a reconciliation, but honest either way) the whole
 * net external movement collapses into a single money-in/out row from
 * `netExternalFlows`.
 */
export function buildBridgeRows(
  reconciliation: InvestmentsReconciliation | null,
  flows:          PeriodFlows | null,
  /**
   * The canonical verdict from `assembleInvestmentsTimeMachine`. Optional only
   * so existing callers compile; when absent the previous behaviour is kept,
   * which is why the composition always passes it.
   */
  attribution?:   PeriodAttribution | null,
): BridgeModel {
  if (reconciliation === null) {
    return { state: "no-comparison", reportingCurrency: null, rows: [], residual: 0, residualReason: null, caveat: null, headline: null, reasons: [] };
  }

  // ── The eligibility gate ────────────────────────────────────────────────
  // A period that cannot be attributed renders NO waterfall. Not a greyed one,
  // not one with an asterisk: the rows themselves are the claim, and the claim
  // is unsupported. The closing value survives because it is a fact.
  if (attribution && attribution.kind !== "ATTRIBUTABLE") {
    const rows: BridgeRow[] = [
      { key: "closing", label: "Current value", amount: attribution.closingValue, isLevel: true },
    ];
    if (attribution.moneyIn !== null) {
      rows.unshift({ key: "money_out", label: "Money out", amount: attribution.moneyOut ?? 0, isLevel: false });
      rows.unshift({ key: "money_in",  label: "Money in",  amount: attribution.moneyIn,       isLevel: false });
    }
    return {
      state: attribution.kind === "PARTIALLY_ATTRIBUTABLE" ? "partial" : "not-attributable",
      reportingCurrency: attribution.reportingCurrency,
      rows,
      residual: 0,
      residualReason: null,
      caveat: null,
      headline: attribution.headline,
      reasons: attribution.refusals.map((r) => r.copy),
    };
  }

  const { openingValue, closingValue, netExternalFlows, residualChange, reportingCurrency } = reconciliation;

  // In/out split (each already signed); falls back to the net when flows absent.
  const moneyIn = flows ? flows.contributions + flows.transfersIn : Math.max(netExternalFlows, 0);
  const moneyOut = flows ? flows.withdrawals + flows.transfersOut : Math.min(netExternalFlows, 0);

  const rows: BridgeRow[] = [
    { key: "opening",   label: "Opening value",   amount: openingValue,    isLevel: true },
    { key: "money_in",  label: "Money in",        amount: moneyIn,         isLevel: false },
    { key: "money_out", label: "Money out",       amount: moneyOut,        isLevel: false },
    { key: "residual",  label: "Portfolio change", amount: residualChange, isLevel: false },
    { key: "closing",   label: "Closing value",   amount: closingValue,    isLevel: true },
  ];

  // Dev guard: opening + in + out + residual MUST equal closing. When flows and
  // reconciliation disagree on the split, netExternalFlows (the identity's own
  // term) is authoritative — but the split (in + out) equals it by construction,
  // so any drift beyond FP epsilon is a real bug we refuse to render silently.
  const reconstructed = openingValue + moneyIn + moneyOut + residualChange;
  if (Math.abs(reconstructed - closingValue) > EPSILON) {
    throw new Error(
      `investments-bridge identity violated: opening(${openingValue}) + in(${moneyIn}) + out(${moneyOut}) + residual(${residualChange}) = ${reconstructed} ≠ closing(${closingValue})`,
    );
  }

  const caveat = reconciliation.endpointIncomplete || reconciliation.conflict ? reconciliation.reason : null;

  return {
    state: "reconciled",
    reportingCurrency,
    rows,
    residual: residualChange,
    residualReason: reconciliation.residualReason,
    caveat,
    headline: null,
    reasons: [],
  };
}
