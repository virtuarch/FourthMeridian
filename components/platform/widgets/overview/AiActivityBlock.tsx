"use client";

/**
 * components/platform/widgets/overview/AiActivityBlock.tsx  (UX-P1 · Agent 5)
 *
 * "AI activity" — ONE SectionSurface on the Overview: calls per UTC day over
 * the last 30 days (MiniBars, gaps are gaps), the window's provider-call
 * OUTCOMES as a composition (the invocation ledger groups failures by outcome,
 * not by day — so a per-day failure series would be invented, and is not
 * drawn), the totals line, and the ESTIMATED 30-day spend only when pricing is
 * configured. Aggregate only; no per-user attribution exists on this surface.
 *
 * Two reads, both PLATFORM_OPS READ: the usage trend is shared with the
 * Economics block (same workspace session entry); the invocation window is a
 * static literal. Presentation derives nothing — bucketing and wording are in
 * ai-economics-view.ts. Doorway → the AI workspace.
 */

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { WidgetMessage, useWidgetFetch } from "../../widget-kit";
import { useSharedWidgetFetch } from "../../workspace-session";
import { BigStat, DistributionBar, MiniBars, SectionSurface, Unavailable } from "../../platform-surface";
import type { AiUsageTrend } from "@/lib/platform/ai/ai-usage";
import type { AiOperations } from "@/lib/platform/ai/invocations";
import type { OverviewBlockProps } from "./block-contract";
import { BlockDoorway } from "./block-doorway";
import {
  AGGREGATE_NOTE, AI_WINDOW_DAYS, ESTIMATE_CAPTION, aiOutcomeSegments, aiSpendReading, aiTotalsText, callsPerDay, fmtCount,
} from "./ai-economics-view";

export interface AiActivitySurfaceProps {
  trend: { data: AiUsageTrend | null; loading: boolean; error: string | null };
  ops: { data: AiOperations | null; loading: boolean; error: string | null };
  nowMs: number;
  onOpenWorkspace?: (workspaceId: string) => void;
}

/** Prop-driven and fetch-free, so every state is provable by handing it data. */
export function AiActivitySurface({ trend, ops, nowMs, onOpenWorkspace }: AiActivitySurfaceProps) {
  const t = trend.error ? null : trend.data;
  const spend = t ? aiSpendReading(t) : null;
  return (
    <SectionSurface
      icon={Sparkles}
      title="AI activity"
      actions={<BlockDoorway label="AI" workspaceId="platform-ai" onOpenWorkspace={onOpenWorkspace} />}
      footnote={`${AGGREGATE_NOTE} Calls and tokens are observed counts from the usage counter at UTC-day grain; a day without a counter row is a gap, not zero. Spend is an ${ESTIMATE_CAPTION}: the code-owned rate card over observed tokens, null on days with no rate in force.`}
    >
      {trend.loading || !t ? (
        <WidgetMessage loading={trend.loading} error={trend.error} />
      ) : (
        <div className="flex flex-col gap-6">
          <MiniBars
            label={`Calls per UTC day · last ${AI_WINDOW_DAYS}`}
            points={callsPerDay(t, nowMs)}
            format={(v) => `${fmtCount(v)} calls`}
            caption={aiTotalsText(t)}
          />
          <div className="grid gap-6 md:grid-cols-2">
            {ops.loading || !ops.data || ops.error ? (
              <div className="flex flex-col gap-2">
                <WidgetMessage loading={ops.loading} error={ops.error} empty="Outcomes not available." />
              </div>
            ) : (
              <DistributionBar
                label="Provider-call outcomes · 30 days"
                segments={aiOutcomeSegments(ops.data.totals.invocations, ops.data.failures)}
                caption="From the invocation ledger: returned = billed round-trips; failures are zero-token rows recorded since 2026-10-07. Outcomes are counted per window, not per day — no daily failure series is drawn."
                emptyText="no provider calls recorded in the window"
              />
            )}
            <BigStat
              label="Estimated spend · 30 days"
              value={spend?.kind === "figure" ? spend.value : <Unavailable reason={spend?.reason ?? "no reading"} />}
              qualifier={spend?.kind === "figure" ? spend.qualifier : ESTIMATE_CAPTION}
            />
          </div>
        </div>
      )}
    </SectionSurface>
  );
}

export function AiActivityBlock({ onOpenWorkspace }: OverviewBlockProps) {
  const trend = useSharedWidgetFetch<AiUsageTrend>("/api/platform/platform-ops/ai-usage-trend");
  const ops = useWidgetFetch<AiOperations>("/api/platform/platform-ops/ai-invocations?window=30d");
  // ONE instant for the surface, captured at mount (a clock read during render
  // is impure — the same idiom OpsPlatformHealthWidget uses).
  const [nowMs] = useState(() => Date.now());
  return <AiActivitySurface trend={trend} ops={ops} nowMs={nowMs} onOpenWorkspace={onOpenWorkspace} />;
}
