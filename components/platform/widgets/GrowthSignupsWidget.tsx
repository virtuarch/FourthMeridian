"use client";

/**
 * components/platform/widgets/GrowthSignupsWidget.tsx  (PO1.3 · growth_signups)
 *
 * Signup & activation summary, over GET /api/platform/growth-revenue/signups
 * (requirePlatformAccess GROWTH_REVENUE READ). Signups this week/month, verified
 * rate, and activation — NO revenue figure (there is no data source for one).
 */

import { UserPlus } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { PlatformSignupsResponse } from "@/app/api/platform/growth-revenue/signups/route";

function pct(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

export function GrowthSignupsWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformSignupsResponse>("/api/platform/growth-revenue/signups");

  return (
    <PlatformWidgetCard label={section.label} icon={UserPlus}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <WidgetStat value={data.signups7} label="Signups · 7d" />
            <WidgetStat value={data.signups30} label="Signups · 30d" />
            <WidgetStat value={pct(data.verified, data.totalUsers)} label="Email verified" />
            <WidgetStat value={pct(data.activatedEver, data.totalUsers)} label="Activated" />
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            {data.active7} active this week · {data.totalUsers} total users
          </p>
          <p className="text-[10px] text-[var(--text-muted)]">Signups &amp; activation only — no revenue data source until billing (v3.0).</p>
        </>
      )}
    </PlatformWidgetCard>
  );
}
