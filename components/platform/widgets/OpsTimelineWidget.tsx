"use client";

/**
 * components/platform/widgets/OpsTimelineWidget.tsx  (OPS-6E · ops_timeline)
 *
 * The operational timeline — the flat, chronological event feed from the S9
 * convergence authority (GET /api/platform/platform-ops/convergence, its `events`
 * field). NOT a new event system: the SAME projected ledger events the episodes
 * cluster, shown un-clustered. Presentation-only.
 */

import { Rss } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  timeAgo,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { ConvergenceResult } from "@/lib/platform/convergence/types";

const OUTCOME_TONE: Record<string, string> = {
  failure:  "var(--danger-400, #f87171)",
  degraded: "var(--brass-300, #d9b25a)",
  recovery: "var(--accent-positive, #34d399)",
  action:   "var(--meridian-400, #7da8ff)",
  info:     "var(--text-muted)",
};

export function OpsTimelineWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<ConvergenceResult>("/api/platform/platform-ops/convergence");

  return (
    <PlatformWidgetCard label={section.label} icon={Rss}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : data.events.length === 0 ? (
        <p className="text-xs text-[var(--text-secondary)]">No operational events in the window.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {data.events.slice(0, 20).map((e, i) => (
            <li key={`${e.at}:${i}`} className="flex items-start justify-between gap-2 text-xs">
              <span className="text-[var(--text-secondary)] min-w-0 flex-1">
                <span style={{ color: OUTCOME_TONE[e.outcome] ?? "var(--text-muted)" }}>●</span>{" "}
                <span className="text-[var(--text-muted)]">[{e.ledger}]</span> {e.detail}
              </span>
              <span className="shrink-0 text-[var(--text-muted)]">{timeAgo(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </PlatformWidgetCard>
  );
}
