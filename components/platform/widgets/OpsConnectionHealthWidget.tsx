"use client";

/**
 * components/platform/widgets/OpsConnectionHealthWidget.tsx
 *   (Wave 2 S7 / CH-1 · ops_connection_health)
 *
 * Provider-connection health, over GET /api/platform/platform-ops/connection-health
 * (requirePlatformAccess PLATFORM_OPS READ). Headline healthy/total + the
 * non-healthy connections worst-first, each with its derived state and how long
 * it's been broken ("since …"). No PII — institution/provider labels only.
 */

import { PlugZap } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  timeAgo,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { ConnectionHealthResponse } from "@/app/api/platform/platform-ops/connection-health/route";

const STATE_LABEL: Record<string, string> = {
  REVOKED:      "Revoked",
  ERROR:        "Error",
  NEEDS_REAUTH: "Needs re-auth",
  DEGRADED:     "Degraded",
  STALE:        "Stale",
  HEALTHY:      "Healthy",
};

export function OpsConnectionHealthWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<ConnectionHealthResponse>("/api/platform/platform-ops/connection-health");

  return (
    <PlatformWidgetCard label={section.label} icon={PlugZap}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <WidgetStat value={data.counts.HEALTHY} label="Healthy" />
            <WidgetStat value={data.total - data.counts.HEALTHY} label="Unhealthy" />
            <WidgetStat value={data.total} label="Total" />
          </div>
          {data.unhealthy.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)] mt-1">All provider connections healthy.</p>
          ) : (
            <ul className="flex flex-col gap-1 mt-1">
              {data.unhealthy.map((c) => (
                <li key={`${c.source}:${c.id}`} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-[var(--text-primary)] truncate">
                    {c.label} <span className="text-[var(--text-muted)]">· {c.source}</span>
                  </span>
                  <span className="shrink-0 text-[var(--text-secondary)]">
                    {STATE_LABEL[c.healthState] ?? c.healthState}
                    {c.since ? <span className="text-[var(--text-muted)]"> · {timeAgo(c.since)}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}
