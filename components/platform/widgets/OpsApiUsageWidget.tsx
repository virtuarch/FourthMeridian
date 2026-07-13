"use client";

/**
 * components/platform/widgets/OpsApiUsageWidget.tsx  (Wave 2 S7 · ops_api_usage)
 *
 * External-provider API usage, over GET /api/platform/platform-ops/api-usage
 * (requirePlatformAccess PLATFORM_OPS READ). Calls today/7d/30d per provider and
 * tokens per model. A dollar figure appears ONLY when price constants are
 * populated, and is labeled an estimate — the GrowthSignupsWidget honesty idiom.
 */

import { Gauge } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { ApiUsageResponse } from "@/app/api/platform/platform-ops/api-usage/route";

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
}

export function OpsApiUsageWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<ApiUsageResponse>("/api/platform/platform-ops/api-usage");

  return (
    <PlatformWidgetCard label={section.label} icon={Gauge}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : data.providers.length === 0 && data.models.length === 0 ? (
        <p className="text-xs text-[var(--text-secondary)]">No API usage recorded in the last 30 days.</p>
      ) : (
        <>
          {data.providers.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {data.providers.map((p) => (
                <li key={p.provider} className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-[var(--text-primary)]">{p.provider}</span>
                  <span className="text-[var(--text-secondary)] tabular-nums">
                    {fmt(p.callsToday)} today · {fmt(p.calls7d)} · 7d {fmt(p.calls30d)} · 30d calls
                  </span>
                </li>
              ))}
            </ul>
          )}

          {data.models.length > 0 && (
            <div className="mt-1 flex flex-col gap-1">
              {data.models.map((m) => (
                <p key={m.metric} className="text-[11px] text-[var(--text-secondary)] tabular-nums">
                  <span className="text-[var(--text-primary)]">{m.metric.replace(/^chat\.completions:/, "")}</span>
                  {" · "}{fmt(m.promptTokens30d)} in / {fmt(m.completionTokens30d)} out tokens (30d)
                </p>
              ))}
            </div>
          )}

          {data.estimatedSpendUsd !== null ? (
            <WidgetStat value={`~$${data.estimatedSpendUsd.toFixed(2)}`} label="Est. spend · 30d" />
          ) : (
            <p className="text-[10px] text-[var(--text-muted)]">
              Call &amp; token volume only — no billing API to reconcile true cost. Populate price constants to show an estimate.
            </p>
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}
