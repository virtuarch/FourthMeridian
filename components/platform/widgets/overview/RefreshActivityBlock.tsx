"use client";

/**
 * components/platform/widgets/overview/RefreshActivityBlock.tsx  (UX-P1 · Agent 4)
 *
 * The Overview's "what ran" block: refresh execution composition by status and
 * by trigger (GET /platform-ops/refresh/summary) and executions per UTC day
 * with failures per day (GET /platform-ops/refresh/daily). ONE SectionSurface,
 * one doorway into Pipeline, nothing the Pipeline table shows is repeated here.
 *
 * Presentation only: every count arrives from the two projections; the words
 * and tones come through `refresh-activity-view.ts`, the same map the Pipeline
 * summary uses. Two reads, two independent fetch states — one failing never
 * blanks or falsely reassures the other.
 *
 * HONESTY: `tier: "unknown"` on the summary renders as "not observed", never
 * as zeros; an unsettled window shows the projection's own reason; a day the
 * fact cap cut is a gap, a settled empty day is a zero; the refusals line
 * states what the ledger records (admission denials) and what it cannot
 * (customer cooldown refusals write no row).
 */

import { ArrowRight, RefreshCw } from "lucide-react";
import { WidgetMessage, useWidgetFetch } from "../../widget-kit";
import { DistributionBar, MiniBars, SectionSurface } from "../../platform-surface";
import { platformViewTarget, resolvePlatformDestination } from "@/lib/platform/workspaces";
import type { RefreshDailySeries, RefreshSummary } from "@/lib/platform/refresh/types";
import { isUnobserved } from "../refresh-format";
import {
  SUMMARY_UNOBSERVED,
  envelopeCaption,
  executionPoints,
  failurePoints,
  refusalNote,
  seriesCaption,
  statusSegments,
  triggerSegments,
} from "../refresh-activity-view";
import type { OverviewBlockProps } from "./block-contract";

/** The workspace this block opens. */
// PLATFORM OPS PHASE 1 UX — Pipeline is a view of Operations (formerly "platform-refresh").
export const REFRESH_ACTIVITY_DOORWAY = platformViewTarget("platform-overview", "pipeline");

export const REFRESH_ACTIVITY_FOOTNOTE =
  "Composition and the day series are read from the refresh execution ledger through its projections; nothing here is re-derived. Open Pipeline for the execution rows, filters and the timeline of any run.";

/** One fetch result, as the widget-kit hook returns it. */
export interface Fetched<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** The doorway renders nothing when the host has not wired the rail (block contract). */
function Doorway({ onOpenWorkspace }: { onOpenWorkspace?: (id: string) => void }) {
  const def = resolvePlatformDestination(REFRESH_ACTIVITY_DOORWAY);
  if (!def || !onOpenWorkspace) return null;
  return (
    <button
      type="button"
      onClick={() => onOpenWorkspace(REFRESH_ACTIVITY_DOORWAY)}
      aria-label={`Open ${def.label}`}
      className="relative flex w-fit items-center gap-1 text-[11px] text-[var(--meridian-400)] transition-colors hover:text-[var(--meridian-300)] before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-full before:min-w-[44px] before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
    >
      {def.label} <ArrowRight size={10} aria-hidden />
    </button>
  );
}

const formatCount = (n: number) => `${n} execution${n === 1 ? "" : "s"}`;
const formatFailures = (n: number) => `${n} failed`;

/**
 * The surface, given two fetch RESULTS rather than performing them — so loading,
 * error, unobserved and populated states are all renderable in a test
 * (`renderToStaticMarkup` runs no effects).
 */
export function RefreshActivitySurface({
  summary,
  daily,
  onOpenWorkspace,
}: {
  summary: Fetched<RefreshSummary>;
  daily: Fetched<RefreshDailySeries>;
  onOpenWorkspace?: (workspaceId: string) => void;
}) {
  return (
    <SectionSurface
      icon={RefreshCw}
      title="Refresh activity"
      actions={<Doorway onOpenWorkspace={onOpenWorkspace} />}
      footnote={REFRESH_ACTIVITY_FOOTNOTE}
    >
      <div className="flex flex-col gap-8">
        {/* Composition — the two strips share one window and one caption. */}
        {summary.loading || summary.error || !summary.data ? (
          <WidgetMessage loading={summary.loading} error={summary.error} />
        ) : isUnobserved(summary.data.tier) ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-[var(--text-muted)]">{SUMMARY_UNOBSERVED}</p>
            <span className="text-[10px] leading-relaxed text-[var(--text-faint)]">{envelopeCaption(summary.data)}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-6 md:grid-cols-2">
              <DistributionBar label="By status" segments={statusSegments(summary.data.byStatus)} />
              <DistributionBar label="By trigger" segments={triggerSegments(summary.data.byTrigger)} />
            </div>
            <span className="text-[10px] leading-relaxed text-[var(--text-faint)]">
              {summary.data.executions} executions · {envelopeCaption(summary.data)}
            </span>
          </div>
        )}

        {/* The day series — two bar rows over the same UTC-day axis. */}
        {daily.loading || daily.error || !daily.data ? (
          <WidgetMessage loading={daily.loading} error={daily.error} />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-6 md:grid-cols-2">
              <MiniBars label="Executions per day" points={executionPoints(daily.data)} format={formatCount} />
              <MiniBars label="Failures per day" points={failurePoints(daily.data)} format={formatFailures} />
            </div>
            <span className="text-[10px] leading-relaxed text-[var(--text-faint)]">
              {seriesCaption(daily.data)} · {envelopeCaption(daily.data.envelope)}
            </span>
            <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{refusalNote(daily.data)}</p>
          </div>
        )}
      </div>
    </SectionSurface>
  );
}

export function RefreshActivityBlock({ onOpenWorkspace }: OverviewBlockProps) {
  const summary = useWidgetFetch<RefreshSummary>("/api/platform/platform-ops/refresh/summary");
  const daily = useWidgetFetch<RefreshDailySeries>("/api/platform/platform-ops/refresh/daily");
  return <RefreshActivitySurface summary={summary} daily={daily} onOpenWorkspace={onOpenWorkspace} />;
}
