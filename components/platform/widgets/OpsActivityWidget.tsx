"use client";

/**
 * components/platform/widgets/OpsActivityWidget.tsx  (OPS-6C · growth_activity)
 *
 * User activity intelligence, over GET /api/platform/growth-revenue/activity
 * (GROWTH_REVENUE READ). Presentation-only: DAU/WAU/MAU, new users, activation,
 * and most-active Spaces arrive precomputed from the activity projection — the
 * widget derives nothing.
 */

import { LineChart } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { UserActivityMetrics } from "@/lib/platform/activity/activity";

export function OpsActivityWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<UserActivityMetrics>("/api/platform/growth-revenue/activity");

  return (
    <PlatformWidgetCard label={section.label} icon={LineChart}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <WidgetStat value={data.dau} label="DAU" />
            <WidgetStat value={data.wau} label="WAU" />
            <WidgetStat value={data.mau} label="MAU" />
          </div>
          <div className="grid grid-cols-3 gap-3 mt-1">
            <WidgetStat value={data.newUsers7} label="New · 7d" />
            <WidgetStat value={data.activatedEver} label="Activated" />
            <WidgetStat value={data.totalUsers} label="Total" />
          </div>
          {data.topSpaces.length > 0 ? (
            <div className="mt-1 border-t pt-2" style={{ borderColor: "var(--border-hairline)" }}>
              <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Most active Spaces (30d)</p>
              <ul className="flex flex-col gap-1">
                {data.topSpaces.slice(0, 5).map((s) => (
                  <li key={s.spaceId} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-[var(--text-primary)] truncate">{s.spaceName || s.spaceId}</span>
                    <span className="shrink-0 text-[var(--text-secondary)] tabular-nums">{s.opens} opens</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </PlatformWidgetCard>
  );
}
