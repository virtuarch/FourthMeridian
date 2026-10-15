"use client";

/**
 * components/platform/widgets/OpsAiBudgetWidget.tsx  (AI COST CONTROLS — budget utilization · ops_ai_budget)
 *
 * COORDINATOR STUB. Agent B replaces the body with the Economics presentation of
 * `AiBudgetUtilization` (lib/platform/ai/cost-controls.types.ts) over
 * GET /api/platform/platform-ops/ai-budget (PLATFORM_OPS READ). Until then the
 * section renders an honest placeholder — never a fabricated figure.
 */

import { Gauge } from "lucide-react";
import { PlatformWidgetCard, useWidgetFetch, WidgetMessage, type PlatformSection } from "../widget-kit";
import { AI_BUDGET_URL, type AiBudgetUtilization } from "@/lib/platform/ai/cost-controls.types";

export function OpsAiBudgetWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<AiBudgetUtilization>(AI_BUDGET_URL);
  return (
    <PlatformWidgetCard label={section.label} icon={Gauge}>
      {loading || error || !data
        ? <WidgetMessage loading={loading} error={error} />
        : <p className="text-xs text-[var(--text-secondary)]">{data.estimateNote}</p>}
    </PlatformWidgetCard>
  );
}
