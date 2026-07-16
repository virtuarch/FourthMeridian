"use client";

/**
 * components/platform/widgets/OpsConvergenceWidget.tsx  (OPS-5 S9 · ops_convergence)
 *
 * Off-ledger Convergence, over GET /api/platform/platform-ops/convergence
 * (requirePlatformAccess PLATFORM_OPS READ). Presentation-only: the episodes and
 * their narratives arrive precomputed from the convergence authority — the widget
 * derives nothing. Each episode is one operational story across ledgers.
 */

import { GitMerge } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  timeAgo,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { ConvergenceResult } from "@/lib/platform/convergence/types";

export function OpsConvergenceWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<ConvergenceResult>("/api/platform/platform-ops/convergence");

  return (
    <PlatformWidgetCard label={section.label} icon={GitMerge}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <WidgetStat value={data.episodes.length} label="Episodes" />
            <WidgetStat value={data.eventCount} label="Events" />
            <WidgetStat value={data.participants.length} label="Ledgers" />
          </div>

          {data.episodes.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)] mt-1">No correlated operational episodes in the window.</p>
          ) : (
            <ul className="flex flex-col gap-2 mt-1">
              {data.episodes.slice(0, 5).map((ep) => (
                <li key={ep.id} className="text-xs border-t pt-2" style={{ borderColor: "var(--border-hairline)" }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--text-primary)] font-semibold truncate">{ep.title}</span>
                    <span className="shrink-0 text-[var(--text-muted)]">{timeAgo(ep.to)}</span>
                  </div>
                  <p className="text-[var(--text-secondary)] leading-relaxed mt-0.5">{ep.narrative.happened}</p>
                  {ep.narrative.recovered ? (
                    <p className="text-[var(--text-muted)] mt-0.5">recovered: {ep.narrative.recovered}</p>
                  ) : null}
                  <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{ep.participants.join(" · ")}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}
