"use client";

/**
 * components/platform/widgets/OpsResourceFreshnessWidget.tsx
 *   (OPS-5 S1 · ops_resource_freshness)
 *
 * Resource freshness — the content-aware answer to "is the underlying resource
 * actually fresh?", over GET /api/platform/platform-ops/resource-freshness
 * (requirePlatformAccess PLATFORM_OPS READ). One row per refreshable resource
 * with the brief's columns: Archive Fresh To · Age · Expected cadence · Status ·
 * Completeness · Trust. This is the surface that would have caught the FX
 * incident — freshness derives from the data, not from a green JobRun.
 */

import { DatabaseZap } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { ResourceFreshnessResponse } from "@/app/api/platform/platform-ops/resource-freshness/route";
import type { FreshnessHealthState, FreshnessTrustLevel } from "@/lib/platform/resource-freshness";

const STATE_LABEL: Record<FreshnessHealthState, string> = {
  fresh: "Fresh",
  stale: "Stale",
  empty: "Empty",
  idle: "Idle",
};

/** Colour of the status pill — green fresh, amber idle, red for the problems. */
function stateColor(state: FreshnessHealthState): string {
  if (state === "fresh") return "var(--success-400, #4ade80)";
  if (state === "idle") return "var(--text-muted)";
  return "var(--danger-400, #f87171)";
}

const TRUST_LABEL: Record<FreshnessTrustLevel, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unknown",
};

/** Compact age like "30h" / "3d" from whole-hour/day counts; "—" when null. */
function ageLabel(ageHours: number | null, ageDays: number | null): string {
  if (ageHours == null) return "—";
  if (ageDays != null && ageDays >= 1) return `${ageDays}d`;
  return `${Math.round(ageHours)}h`;
}

function completenessLabel(c: ResourceFreshnessResponse["resources"][number]["completeness"]): string {
  if (!c) return "—";
  return `${c.observed}/${c.expected}`;
}

export function OpsResourceFreshnessWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<ResourceFreshnessResponse>(
    "/api/platform/platform-ops/resource-freshness",
  );

  return (
    <PlatformWidgetCard label={section.label} icon={DatabaseZap}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <WidgetStat value={data.counts.fresh} label="Fresh" />
            <WidgetStat value={data.counts.stale + data.counts.empty} label="Not fresh" />
            <WidgetStat value={data.resources.length} label="Resources" />
          </div>
          {data.resources.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)] mt-1">No refreshable resources registered.</p>
          ) : (
            <ul className="flex flex-col gap-2 mt-1">
              {data.resources.map((r) => (
                <li key={r.resource} className="flex flex-col gap-0.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--text-primary)] font-medium truncate">{r.label}</span>
                    <span className="shrink-0 font-semibold" style={{ color: stateColor(r.healthState) }}>
                      {STATE_LABEL[r.healthState]}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[var(--text-secondary)]">
                    <span className="truncate">
                      Fresh to {r.newestObservedDate ?? "—"}
                      <span className="text-[var(--text-muted)]"> · {ageLabel(r.ageHours, r.ageDays)} · {r.cadenceLabel}</span>
                    </span>
                    <span className="shrink-0 text-[var(--text-muted)]">
                      {completenessLabel(r.completeness)} · trust {TRUST_LABEL[r.trust.level]}
                    </span>
                  </div>
                  {r.trust.caveats.length > 0 ? (
                    <span className="text-[var(--text-muted)] truncate" title={r.trust.caveats.join(" · ")}>
                      {r.trust.caveats[0]}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}
