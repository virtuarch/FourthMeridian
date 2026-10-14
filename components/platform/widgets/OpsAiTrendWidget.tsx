"use client";

/**
 * components/platform/widgets/OpsAiTrendWidget.tsx  (OPS-6D · ops_ai_trend · UX-P1 grain)
 *
 * AI usage trend, over GET /api/platform/platform-ops/ai-usage-trend
 * (PLATFORM_OPS READ), composed in the AI and the Economics workspaces. UX-P1:
 * the daily series renders as MiniBars (calls per UTC day; estimated spend per
 * UTC day when a rate was in force) instead of a five-row tail, on the
 * SectionSurface grain its neighbours use. A UTC day with no counter row is a
 * GAP, never zero. Spend is an ESTIMATE from the code-owned rate card and says
 * so; when a rate covers only part of the window the qualifier says how much it
 * does not cover — a partial figure presented as a whole one is the same defect
 * as a fabricated one. Aggregate-only — no per-user / per-workspace claim.
 * Presentation only: bucketing and wording live in overview/ai-economics-view.ts.
 */

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { PlatformWidgetCard, WidgetMessage, useWidgetFetch, type PlatformSection } from "../widget-kit";
import { BigStat, MiniBars, SectionSurface, Unavailable } from "../platform-surface";
import type { AiUsageTrend } from "@/lib/platform/ai/ai-usage";
import {
  AGGREGATE_NOTE, AI_WINDOW_DAYS, ESTIMATE_CAPTION, aiSpendReading, callsPerDay, fmtCount, fmtTokens, fmtUsd, spendPerDay,
} from "./overview/ai-economics-view";

const FOOTNOTE =
  `${AGGREGATE_NOTE} Calls and tokens are observed counts from the usage counter at UTC-day grain; a day without a counter row is a gap, not zero. ` +
  `Spend is an ${ESTIMATE_CAPTION}: the code-owned rate card over observed tokens, unknown on days with no rate in force.`;

/** Prop-driven and fetch-free. */
export function AiTrendSurface({ section, data, nowMs }: { section: PlatformSection; data: AiUsageTrend; nowMs: number }) {
  const spend = aiSpendReading(data);
  return (
    <SectionSurface icon={Sparkles} title={section.label} footnote={FOOTNOTE}>
      <div className="flex flex-col gap-8">
        <div className="grid gap-6 sm:grid-cols-3">
          <BigStat label={`Calls · ${AI_WINDOW_DAYS} days`} value={fmtCount(data.totals.calls)} qualifier={`${data.days.length} of ${AI_WINDOW_DAYS} UTC days observed · since ${data.since}`} />
          <BigStat label={`Tokens · ${AI_WINDOW_DAYS} days`} value={fmtTokens(data.totals.promptTokens + data.totals.completionTokens)} qualifier={`${fmtTokens(data.totals.promptTokens)} prompt · ${fmtTokens(data.totals.completionTokens)} completion · ${data.models.length} model${data.models.length === 1 ? "" : "s"}`} />
          <BigStat
            label={`Estimated spend · ${AI_WINDOW_DAYS} days`}
            value={spend.kind === "figure" ? spend.value : <Unavailable reason={spend.reason} />}
            qualifier={spend.kind === "figure" ? spend.qualifier : ESTIMATE_CAPTION}
          />
        </div>
        <MiniBars
          label={`Calls per UTC day · last ${AI_WINDOW_DAYS}`}
          points={callsPerDay(data, nowMs)}
          format={(v) => `${fmtCount(v)} calls`}
          caption="Observed counts · UTC days · a dashed mark is a day with no counter row"
        />
        {data.pricingConfigured && (
          <MiniBars
            label={`Estimated AI spend per UTC day · last ${AI_WINDOW_DAYS}`}
            points={spendPerDay(data, nowMs)}
            format={fmtUsd}
            caption={`${ESTIMATE_CAPTION} · a day with no counter row or no rate in force is a gap, never $0`}
          />
        )}
      </div>
    </SectionSurface>
  );
}

export function OpsAiTrendWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<AiUsageTrend>("/api/platform/platform-ops/ai-usage-trend");
  // ONE instant for the surface, captured at mount (a clock read during render
  // is impure — the same idiom OpsPlatformHealthWidget uses).
  const [nowMs] = useState(() => Date.now());
  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={Sparkles}>
        <WidgetMessage loading={loading} error={error} />
      </PlatformWidgetCard>
    );
  }
  return <AiTrendSurface section={section} data={data} nowMs={nowMs} />;
}
