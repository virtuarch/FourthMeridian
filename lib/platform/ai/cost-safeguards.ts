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
 * Display only. Nothing here writes. AI COST CONTROLS (2026-10-15): the
 * thresholds, the two alert-enabled flags, the platform allowance value, the
 * enforcement flag and the kill switch are EDITED through the cost-controls
 * service (`AI_COST_CONTROLS_URL`); this view keeps its shape for the ai-spend
 * route's consumers and now points there. The `ai-spend-high` rule was split
 * into `ai-spend-fleet-high` and `ai-spend-user-high`; `alertRuleIds` names
 * both and `alertRuleId` carries them as one sentence fragment for the legacy
 * caption.
 */

import "server-only";
import {
  BETA_FULL_ACCESS_V1, ENTITLEMENT_DIMENSIONS, FOUNDER_INTERNAL_V1,
} from "@/lib/entitlements/catalogue";
import { loadAiSpendThresholds, type AiSpendThreshold } from "@/lib/platform/ai/spend-thresholds";
import { AI_COST_CONTROLS_URL, AI_SPEND_RULE_IDS } from "@/lib/platform/ai/cost-controls.types";

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
  /** The rules that judge the thresholds (lib/alerts/rules.ts), as one caption fragment: "<fleet> and <user>". */
  alertRuleId: string;
  /** The two rule ids, structured (AI COST CONTROLS split). */
  alertRuleIds: { fleet: string; user: string };
  /** Where a threshold may be changed. Provenance for the operator; the editor lives at `controlsUrl`. */
  thresholdWritePath: string;
  /** The cost-controls route (GET read model / PATCH changes). */
  controlsUrl: string;
  checkedAt: string;
}

export const THRESHOLD_WRITE_PATH = `set in Policies → AI Cost Controls (${AI_COST_CONTROLS_URL}, CONTROL, reason required)`;

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
    alertRuleId: `${AI_SPEND_RULE_IDS.fleet} and ${AI_SPEND_RULE_IDS.user}`,
    alertRuleIds: { fleet: AI_SPEND_RULE_IDS.fleet, user: AI_SPEND_RULE_IDS.user },
    thresholdWritePath: THRESHOLD_WRITE_PATH,
    controlsUrl: AI_COST_CONTROLS_URL,
    checkedAt: now.toISOString(),
  };
}
