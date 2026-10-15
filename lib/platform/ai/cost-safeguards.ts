/**
 * lib/platform/ai/cost-safeguards.ts  (BETA C7 — the safeguards, as an operator reads them)
 *
 * ONE small read model of the cost safeguards in force, for the Policies
 * widget's read-only "Cost safeguards" group and the ai-spend route:
 *
 *   · the two spend-alert thresholds (effective value, default, provenance);
 *   · the `aiDailyUsdAllowance` entitlement dimension as the catalogue defines
 *     it (the ceiling, the BETA policy value, the FOUNDER overlay value);
 *   · the alert rule that consumes the thresholds, by id.
 *
 * Display only. The thresholds are changed through the validated setting path
 * (an operator with control-plane access, via the admin settings); the
 * allowance values are code-owned catalogue definitions. Nothing here writes.
 */

import "server-only";
import {
  BETA_FULL_ACCESS_V1, ENTITLEMENT_DIMENSIONS, FOUNDER_INTERNAL_V1,
} from "@/lib/entitlements/catalogue";
import { loadAiSpendThresholds, type AiSpendThreshold } from "@/lib/platform/ai/spend-thresholds";

export interface AllowanceDimensionView {
  key: "aiDailyUsdAllowance";
  label: string;
  description: string;
  /** Whole USD, estimated, per UTC day. */
  ceilingUsd: number;
  policy: { key: string; label: string; usd: number };
  overlay: { key: string; label: string; usd: number };
}

export interface CostSafeguards {
  thresholds: { fleet: AiSpendThreshold; user: AiSpendThreshold };
  allowance: AllowanceDimensionView;
  /** The rule that judges the thresholds (lib/alerts/rules.ts). */
  alertRuleId: "ai-spend-high";
  /** Where a threshold may be changed. Provenance for the operator, not a control. */
  thresholdWritePath: string;
  checkedAt: string;
}

export const THRESHOLD_WRITE_PATH = "set via admin settings (validated setting path)";

/** PURE — the allowance dimension as the catalogue declares it. */
export function allowanceDimensionView(): AllowanceDimensionView {
  const dim = ENTITLEMENT_DIMENSIONS.aiDailyUsdAllowance;
  return {
    key: "aiDailyUsdAllowance",
    label: dim.label,
    description: dim.description,
    ceilingUsd: dim.ceiling,
    policy: { key: BETA_FULL_ACCESS_V1.key, label: BETA_FULL_ACCESS_V1.label, usd: BETA_FULL_ACCESS_V1.values.aiDailyUsdAllowance },
    overlay: { key: FOUNDER_INTERNAL_V1.key, label: FOUNDER_INTERNAL_V1.label, usd: FOUNDER_INTERNAL_V1.values.aiDailyUsdAllowance ?? dim.ceiling },
  };
}

export interface CostSafeguardsDeps {
  now?: Date;
  thresholds?: () => Promise<{ fleet: AiSpendThreshold; user: AiSpendThreshold }>;
}

export async function getCostSafeguards(deps: CostSafeguardsDeps = {}): Promise<CostSafeguards> {
  const now = deps.now ?? new Date();
  const t = await (deps.thresholds ?? loadAiSpendThresholds)();
  return {
    thresholds: { fleet: t.fleet, user: t.user },
    allowance: allowanceDimensionView(),
    alertRuleId: "ai-spend-high",
    thresholdWritePath: THRESHOLD_WRITE_PATH,
    checkedAt: now.toISOString(),
  };
}
