"use client";

/**
 * components/platform/widgets/OpsAlertsWidget.tsx  (OPS-5 S5 · ops_alerts)
 *
 * Alert rules + history, over GET /api/platform/platform-ops/alerts
 * (requirePlatformAccess PLATFORM_OPS READ). One row per rule with its
 * Enabled/Disabled state, Last Triggered, and Destination; dormant rules
 * (awaiting a not-yet-shipped authority) are labelled as such. A short recent
 * firing history follows. Read-only — no PII, only rule ids / states / times.
 */

import { BellRing } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  timeAgo,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { PlatformAlertsResponse } from "@/app/api/platform/platform-ops/alerts/route";

export function OpsAlertsWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformAlertsResponse>("/api/platform/platform-ops/alerts");

  return (
    <PlatformWidgetCard label={section.label} icon={BellRing}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <WidgetStat value={data.rules.filter((r) => r.enabled).length} label="Enabled" />
            <WidgetStat value={data.rules.filter((r) => !r.live).length} label="Dormant" />
            <WidgetStat value={data.history.length} label="Recent fires" />
          </div>

          <ul className="flex flex-col gap-1 mt-1">
            {data.rules.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-[var(--text-primary)] truncate">
                  {r.title}
                  {!r.live ? <span className="text-[var(--text-muted)]"> · dormant</span> : null}
                </span>
                <span className="shrink-0 text-[var(--text-secondary)]">
                  {!r.live ? "Awaiting authority" : r.enabled ? "Enabled" : "Disabled"}
                  {r.lastTriggeredAtISO ? (
                    <span className="text-[var(--text-muted)]"> · {timeAgo(r.lastTriggeredAtISO)}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>

          <p className="text-[11px] text-[var(--text-muted)] mt-1">
            Destination: {data.destination ?? "not configured"}
          </p>

          {data.history.length > 0 ? (
            <div className="mt-1 border-t pt-2" style={{ borderColor: "var(--border-hairline)" }}>
              <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Recent fires</p>
              <ul className="flex flex-col gap-1">
                {data.history.slice(0, 5).map((h, i) => (
                  <li key={`${h.dedupeKey}:${i}`} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-[var(--text-secondary)] truncate">
                      <span
                        style={{ color: h.severity === "critical" ? "var(--danger-400, #f87171)" : "var(--text-muted)" }}
                      >
                        ●
                      </span>{" "}
                      {h.summary}
                    </span>
                    <span className="shrink-0 text-[var(--text-muted)]">{timeAgo(h.deliveredAtISO)}</span>
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
