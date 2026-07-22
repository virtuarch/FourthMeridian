"use client";

/**
 * components/platform/widgets/OpsGrowthWidget.tsx  (OPS-6F · growth_funnel)
 *
 * Growth funnel, over GET /api/platform/growth-revenue/growth (GROWTH_REVENUE
 * READ). Presentation-only: the beta conversion + activation funnels arrive
 * precomputed with honest ratios (null → "—"). The widget derives nothing.
 */

import { Filter } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { GrowthFunnel } from "@/lib/platform/growth/growth";

function pct(r: number | null): string {
  return r == null ? "—" : `${Math.round(r * 100)}%`;
}
function Stage({ label, value, rate }: { label: string; value: number; rate?: number | null }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span className="shrink-0 text-[var(--text-primary)] tabular-nums">
        {value}{rate !== undefined ? <span className="text-[var(--text-muted)]"> · {pct(rate)}</span> : null}
      </span>
    </div>
  );
}

export function OpsGrowthWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<GrowthFunnel>("/api/platform/growth-revenue/growth");

  return (
    <PlatformWidgetCard label={section.label} icon={Filter}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Beta funnel</p>
          <div className="flex flex-col gap-1">
            <Stage label="Requested" value={data.beta.requested} />
            <Stage label="Approved" value={data.beta.approved} rate={data.beta.approveRate} />
            <Stage label="Redeemed" value={data.beta.redeemed} rate={data.beta.redeemRate} />
            <Stage label="Redeemed & active" value={data.beta.redeemedActivated} />
          </div>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mt-1 border-t pt-2" style={{ borderColor: "var(--border-hairline)" }}>Activation</p>
          <div className="flex flex-col gap-1">
            <Stage label="Users" value={data.activation.totalUsers} />
            <Stage label="Verified" value={data.activation.verified} rate={data.activation.verifyRate} />
            <Stage label="Activated" value={data.activation.activated} rate={data.activation.activationRate} />
            <Stage label="Returning (7d)" value={data.activation.returning7} />
          </div>
        </>
      )}
    </PlatformWidgetCard>
  );
}
