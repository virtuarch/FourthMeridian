"use client";

/**
 * components/platform/widgets/OpsActivityWidget.tsx  (OPS-6C · growth_activity)
 *
 * User activity intelligence, over GET /api/platform/growth-revenue/activity
 * (GROWTH_REVENUE READ). Presentation-only: sign-ins, new users, activation and
 * Space-open counts arrive precomputed from the activity projection — the
 * widget derives nothing. SEC-PLAT-2: Growth is identity-minimized, so Space
 * opens are counts — no Space name or id is rendered here.
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
          <div className="grid grid-cols-2 gap-3 mt-1">
            <WidgetStat value={data.spaceOpens30.distinctSpaces} label="Spaces opened · 30d" />
            <WidgetStat value={data.spaceOpens30.opens} label="Space opens · 30d" />
          </div>
        </>
      )}
    </PlatformWidgetCard>
  );
}
