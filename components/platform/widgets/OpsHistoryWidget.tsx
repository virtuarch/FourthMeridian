"use client";

/**
 * components/platform/widgets/OpsHistoryWidget.tsx  (OPS-5 S7 · ops_history)
 *
 * Operational History, over GET /api/platform/platform-ops/history
 * (requirePlatformAccess PLATFORM_OPS READ). Presentation-only: every state,
 * verdict, and trust tier arrives precomputed from the canonical history
 * authority — the widget derives nothing. Shows each subsystem's state as-of and
 * how many observed points its trend carries, with the honest trust tier.
 */

import { History } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { OperationalHistoryResult } from "@/lib/platform/history/types";

const TIER_TONE: Record<string, string> = {
  observed:   "var(--accent-positive, #34d399)",
  derived:    "var(--meridian-400, #7da8ff)",
  estimated:  "var(--brass-300, #d9b25a)",
  incomplete: "var(--brass-300, #d9b25a)",
  unknown:    "var(--text-muted)",
};

export function OpsHistoryWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<OperationalHistoryResult>("/api/platform/platform-ops/history");

  return (
    <PlatformWidgetCard label={section.label} icon={History}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <WidgetStat value={data.states.length} label="Subsystems" />
            <WidgetStat value={data.series.reduce((n, s) => n + s.points.length, 0)} label="History pts" />
            <WidgetStat value={data.completeness.tier} label="Trust" />
          </div>

          <p className="text-[11px] text-[var(--text-muted)] mt-1">
            As of {data.asOf}{data.compareTo ? ` · vs ${data.compareTo}` : ""}
          </p>

          <ul className="flex flex-col gap-1 mt-1">
            {data.states.map((s) => (
              <li key={s.sourceId} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-[var(--text-primary)] truncate">{s.label}</span>
                <span className="shrink-0 text-[var(--text-secondary)]">
                  {s.status}
                  <span style={{ color: TIER_TONE[s.tier] ?? "var(--text-muted)" }}> · {s.tier}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </PlatformWidgetCard>
  );
}
