/**
 * components/platform/widgets/cost-safeguards-view.ts  (BETA C7)
 *
 * THE PURE WORDING behind the Policies widget's read-only "Cost safeguards"
 * group: the two spend-alert thresholds (effective value, default, provenance)
 * and the daily-allowance dimension as the catalogue defines it. No React, no
 * clock. Display only — there is no editor; the thresholds are changed through
 * the validated setting path by an operator with control-plane access.
 */

import type { AiSpendThreshold } from "@/lib/platform/ai/spend-thresholds";
import type { AllowanceDimensionView } from "@/lib/platform/ai/cost-safeguards";

export const COST_SAFEGUARDS_SUBJECT = "cost safeguards";

export const COST_SAFEGUARDS_SENTENCE =
  "Estimated USD from the code-owned rate card over the invocation ledger — never a bill. The alert rule ai-spend-high judges the trailing 24 h against the two thresholds; the allowance refuses a customer's next turn at or over their day's estimate. An unpriceable model refuses and is reported, never counted at $0. Display only — no editor here.";

export type ThresholdProvenanceWord = "Platform default" | "Set via admin settings" | "Default in force — stored value is invalid";

export function thresholdProvenance(t: Pick<AiSpendThreshold, "origin" | "updatedAt">, formatDate: (iso: string) => string): string {
  switch (t.origin) {
    case "SETTING": return t.updatedAt ? `Set via admin settings ${formatDate(t.updatedAt)}` : "Set via admin settings";
    case "INVALID_SETTING": return "Default in force — stored value is invalid";
    case "DEFAULT": return "Platform default";
  }
}

/** "$10 / 24 h" */
export function thresholdFigure(t: Pick<AiSpendThreshold, "usd">): string {
  return `$${t.usd} / 24 h`;
}

/** "default $10" */
export function thresholdDefaultText(t: Pick<AiSpendThreshold, "defaultUsd">): string {
  return `default $${t.defaultUsd}`;
}

/** "Beta — full access (v1) $5 · Founder / internal (v1) $20 · ceiling $20 · per UTC day, estimated" */
export function allowanceText(a: AllowanceDimensionView): string {
  return `${a.policy.label} $${a.policy.usd} · ${a.overlay.label} $${a.overlay.usd} · ceiling $${a.ceilingUsd} · per UTC day, estimated`;
}
