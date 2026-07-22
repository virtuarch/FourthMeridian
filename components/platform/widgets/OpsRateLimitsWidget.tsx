"use client";

/**
 * components/platform/widgets/OpsRateLimitsWidget.tsx  (PO1.2 · ops_rate_limits)
 *
 * Current rate-limit pressure, over GET /api/platform/platform-ops/rate-limits
 * (requirePlatformAccess PLATFORM_OPS READ). Total hits this window + the top
 * endpoint buckets by count (subjects aggregated away — never shown).
 */

import { Gauge } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { PlatformRateLimitsResponse } from "@/app/api/platform/platform-ops/rate-limits/route";

export function OpsRateLimitsWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformRateLimitsResponse>("/api/platform/platform-ops/rate-limits");

  return (
    <PlatformWidgetCard label={section.label} icon={Gauge}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <WidgetStat value={data.totalHits} label="Requests this window" />
            <WidgetStat value={data.totalRows} label="Tracked keys" />
          </div>
          {data.topBuckets.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)] mt-1">No rate-limit activity this window.</p>
          ) : (
            <ul className="flex flex-col gap-1 mt-1">
              {data.topBuckets.map((b) => (
                <li key={b.bucket} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-[var(--text-secondary)] truncate font-mono">{b.bucket}</span>
                  <span className="text-[var(--text-primary)] tabular-nums shrink-0">{b.hits}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}
