"use client";

/**
 * components/platform/widgets/OpsAiTrendWidget.tsx  (OPS-6D · ops_ai_trend)
 *
 * AI usage trend, over GET /api/platform/platform-ops/ai-usage-trend
 * (PLATFORM_OPS READ). Presentation-only: totals, models, and per-day series
 * arrive precomputed. Spend renders "—" when no pricing is configured (never a
 * fabricated 0). Aggregate-only — no per-user/per-workspace claim.
 */

import { Sparkles } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { AiUsageTrend } from "@/lib/platform/ai/ai-usage";

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

export function OpsAiTrendWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<AiUsageTrend>("/api/platform/platform-ops/ai-usage-trend");

  return (
    <PlatformWidgetCard label={section.label} icon={Sparkles}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <WidgetStat value={data.totals.calls} label="Calls 30d" />
            <WidgetStat value={fmtTokens(data.totals.promptTokens + data.totals.completionTokens)} label="Tokens 30d" />
            <WidgetStat value={data.totals.estimatedSpendUsd != null ? `$${data.totals.estimatedSpendUsd.toFixed(2)}` : "—"} label="Est. spend" />
          </div>
          <p className="text-[11px] text-[var(--text-muted)] mt-1">
            {data.models.length} model(s) · since {data.since} · {data.days.length} active day(s)
            {!data.pricingConfigured ? " · spend unknown (no pricing configured)" : ""}
          </p>
          {data.days.length > 0 ? (
            <ul className="flex flex-col gap-1 mt-1">
              {data.days.slice(-5).reverse().map((d) => (
                <li key={d.day} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-[var(--text-secondary)]">{d.day}</span>
                  <span className="shrink-0 text-[var(--text-muted)] tabular-nums">
                    {d.calls} calls · {fmtTokens(d.promptTokens + d.completionTokens)} tok
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </PlatformWidgetCard>
  );
}
