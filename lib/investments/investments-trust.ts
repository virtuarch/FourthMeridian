/**
 * lib/investments/investments-trust.ts  (PCS-1C)
 *
 * THE canonical Activity + Trust contract for the Investments perspective.
 *
 * WHY THIS EXISTS — the A10 `InvestmentsTimeMachineResult` already carries the
 * canonical trust DATA, but scattered across four raw sub-shapes:
 *   • portfolio.completeness  — valued/unvalued counts, tier, conflict, reason
 *   • per-holding tiers        — quantityTier/priceTier/fxTier/staleDays/conflicted
 *   • flows                    — the four honesty counters + fxEstimated
 *   • reconciliation           — residual, endpointIncomplete
 * Before PCS-1C every panel re-REDUCED those raw fields into its own
 * presentation summary: the Portfolio Header re-derived `partial` /
 * "Valued holdings" / "N of M positions valued"; the shell envelope
 * (lib/perspectives/envelope.ts) independently rebuilt the SAME
 * "N of M positions valued" string; the Activity card re-authored the caveat
 * sentence the flow `reason` already owns; the AI holdings assembler re-derived
 * the "could not be valued / partial subtotal" concept. Four surfaces, four
 * copies of the same trust arithmetic and prose.
 *
 * THE CONTRACT — one reduction. `buildInvestmentsTrustSummary(result)` turns the
 * canonical result into ONE `InvestmentsTrustSummary`: the valuation-completeness
 * intent (partial flag, figure label, valued-of-total label), the activity caveat
 * (single-authored via investment-flows-core's `formatFlowCaveatSentence`), the
 * change-completeness residual, the overall envelope, and a structured,
 * name-free `indicators` list a surface RENDERS rather than authors. Panels stop
 * re-deriving; they read fields off this summary.
 *
 * ACTIVITY half — the numbers are already canonical (`PeriodFlows` +
 * `summarizePeriodFlows`, investment-flows-core.ts; presentation model
 * `buildActivityGroups`, the widget layer). This module re-exports the lib-level
 * activity contract so "Investments Activity & Trust" has one named home, and
 * derives the activity TRUST (`activityCaveat`, `fxEstimated`) from it.
 *
 * PURE — no DB, no clock, no React, no Prisma runtime import (the event type is
 * type-only via flows-core). Fixture-tested with a standalone `tsx` script.
 * Does NOT redesign any UI: every string it emits matches what a panel already
 * rendered, so adopting it is behaviour-preserving.
 */

import type { CompletenessTier } from "@/lib/perspective-engine/types";
import type { InvestmentsTimeMachineResult } from "./investments-time-machine-core";
import {
  formatFlowCaveatSentence,
  type PeriodFlows,
} from "./investment-flows-core";

// Re-export the lib-level canonical Activity contract so consumers can reach the
// whole Activity + Trust surface from one module. (The Activity PRESENTATION
// model, `buildActivityGroups`, lives in the widget layer by design — lib does
// not import components — so it is intentionally NOT re-exported here.)
export type {
  PeriodFlows,
  FlowCategory,
  FlowCategorySummary,
  FlowEvent,
} from "./investment-flows-core";
export { summarizePeriodFlows, classifyEventFlow } from "./investment-flows-core";

/** Figure-label intent: partial subtotals are NEVER presented as the whole. */
export const FIGURE_LABEL_PARTIAL = "Valued holdings";
export const FIGURE_LABEL_WHOLE = "Portfolio value";

/**
 * "N of M positions valued", or null when there are no positions. The ONE author
 * of this evidence string — previously built independently in the Portfolio
 * Header and the shell envelope. Kept byte-identical (always "positions", no
 * singular form) so it is a drop-in for both.
 */
export function valuedOfTotalLabel(valued: number, total: number): string | null {
  return total > 0 ? `${valued} of ${total} positions valued` : null;
}

/**
 * A structured, name-free trust indicator. `count` is the affected item count
 * (null for boolean flags like FX-estimated / conflict). `sentence` is a
 * ready-to-render, deterministic explanation — a surface shows it, never writes
 * its own.
 */
export interface InvestmentsTrustIndicator {
  key:
    | "unvalued"
    | "conflict"
    | "in_kind_transfer"
    | "external_amount_missing"
    | "unclassified"
    | "fx_estimated"
    | "endpoint_incomplete";
  count: number | null;
  sentence: string;
}

/**
 * The canonical Investments trust summary — one reduction of the A10 result's
 * four raw trust sources into the presentation-facing shape every panel, the
 * shell envelope, and the AI assembler can consume. Serialisable.
 */
export interface InvestmentsTrustSummary {
  // ── Overall envelope (result.completeness) ─────────────────────────────────
  tier:     CompletenessTier;
  conflict: boolean;
  /** One-sentence honest summary (the as-of portfolio's own reason). */
  reason:   string;

  // ── Valuation completeness (result.portfolio) ──────────────────────────────
  valuedCount:    number;
  unvaluedCount:  number;
  totalPositions: number;
  /** unvaluedCount > 0 — the subtotal is a partial, never the whole portfolio. */
  partial:        boolean;
  /** "Valued holdings" when partial, else "Portfolio value". */
  figureLabel:    string;
  /** "N of M positions valued"; null when there are no positions. */
  valuedOfTotalLabel: string | null;

  // ── Activity completeness (result.flows) — null-safe when no comparison ─────
  /** Any summed period amount used an estimated FX rate. */
  fxEstimated:    boolean;
  /** One caveat sentence from the flow honesty counters; null when clean/no window. */
  activityCaveat: string | null;

  // ── Change completeness (result.reconciliation) — null when no comparison ───
  residual:           number | null;
  residualReason:     string | null;
  endpointIncomplete: boolean;

  /** Every active trust concern as a structured, renderable row. Empty ⇒ clean. */
  indicators: InvestmentsTrustIndicator[];
}

/** The period-flow honesty counters as structured indicators. Pure. */
function flowIndicators(flows: PeriodFlows): InvestmentsTrustIndicator[] {
  const rows: InvestmentsTrustIndicator[] = [];
  if (flows.inKindTransferCount > 0) {
    rows.push({
      key: "in_kind_transfer",
      count: flows.inKindTransferCount,
      sentence: `${flows.inKindTransferCount} in-kind transfer${flows.inKindTransferCount === 1 ? "" : "s"} moved holdings without a cash value.`,
    });
  }
  if (flows.externalAmountMissingCount > 0) {
    rows.push({
      key: "external_amount_missing",
      count: flows.externalAmountMissingCount,
      sentence: `${flows.externalAmountMissingCount} external movement${flows.externalAmountMissingCount === 1 ? "" : "s"} had no amount.`,
    });
  }
  if (flows.unclassifiedCount > 0) {
    rows.push({
      key: "unclassified",
      count: flows.unclassifiedCount,
      sentence: `${flows.unclassifiedCount} event${flows.unclassifiedCount === 1 ? "" : "s"} could not be categorised.`,
    });
  }
  if (flows.fxEstimated) {
    rows.push({ key: "fx_estimated", count: null, sentence: "Some amounts were converted at an estimated rate." });
  }
  return rows;
}

/**
 * Reduce the canonical Investments Time Machine result into the one Trust
 * summary. Pure and deterministic. Reads only fields already on the result — it
 * computes no new valuation, FX, or flow arithmetic.
 */
export function buildInvestmentsTrustSummary(
  result: InvestmentsTimeMachineResult,
): InvestmentsTrustSummary {
  const { portfolio, flows, reconciliation, completeness } = result;

  const valuedCount = portfolio.valuedCount;
  const unvaluedCount = portfolio.unvaluedCount;
  const totalPositions = valuedCount + unvaluedCount;
  const partial = unvaluedCount > 0;

  const indicators: InvestmentsTrustIndicator[] = [];
  if (unvaluedCount > 0) {
    indicators.push({
      key: "unvalued",
      count: unvaluedCount,
      sentence: `${unvaluedCount} position${unvaluedCount === 1 ? "" : "s"} could not be valued and ${unvaluedCount === 1 ? "is" : "are"} excluded from the subtotal.`,
    });
  }
  if (completeness.conflict) {
    indicators.push({
      key: "conflict",
      count: null,
      sentence: "At least one position has a reconstruction conflict — review before trusting the totals.",
    });
  }
  if (flows) indicators.push(...flowIndicators(flows));
  if (reconciliation?.endpointIncomplete) {
    indicators.push({
      key: "endpoint_incomplete",
      count: null,
      sentence: "Opening or closing value is a partial subtotal, so the change over this period is partial.",
    });
  }

  return {
    tier:     completeness.tier,
    conflict: completeness.conflict,
    reason:   completeness.reason,

    valuedCount,
    unvaluedCount,
    totalPositions,
    partial,
    figureLabel: partial ? FIGURE_LABEL_PARTIAL : FIGURE_LABEL_WHOLE,
    valuedOfTotalLabel: valuedOfTotalLabel(valuedCount, totalPositions),

    fxEstimated:    flows?.fxEstimated ?? false,
    activityCaveat: flows ? formatFlowCaveatSentence(flows) : null,

    residual:           reconciliation?.residualChange ?? null,
    residualReason:     reconciliation?.residualReason ?? null,
    endpointIncomplete: reconciliation?.endpointIncomplete ?? false,

    indicators,
  };
}
