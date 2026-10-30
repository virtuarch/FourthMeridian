"use client";

/**
 * components/platform/widgets/overview/ActivityFeedBlock.tsx  (UX-P1 · Agent 5 · D6)
 *
 * "Recent operator activity" — ONE SectionSurface on the Overview in the
 * timeline grammar: banded rows of when · operator · action · target · result,
 * a tone dot (aria-hidden) beside the result WORD, the reason code, and the
 * evidence the envelope recorded: a refresh execution opens the same
 * ExecutionTimelinePanel the Pipeline uses; a job run is a doorway to Jobs.
 * The depth is stated under the rows; security events are named as living
 * elsewhere. Read over /platform-ops/activity (PLATFORM_OPS READ), the narrow
 * feed owner decision D6 approved. Doorway → Trends.
 */

import { useState } from "react";
import { UserCog } from "lucide-react";
import { WidgetMessage, useWidgetFetch } from "../../widget-kit";
import { SectionSurface, ToneBadge } from "../../platform-surface";
import { ExecutionTimelinePanel } from "../ExecutionTimelinePanel";
import type { OperatorFeedItem, OperatorFeedResponse } from "@/lib/platform/activity/operator-feed-core";
import type { OverviewBlockProps } from "./block-contract";
import { BlockDoorway } from "./block-doorway";
import { FEED_EMPTY_TEXT, reasonLabel, relativeText, resultTone, resultWord, utcStamp } from "./activity-feed-view";
// PLATFORM OPS PHASE 1 UX — Jobs is a view of Operations (formerly "platform-jobs");
// the ONE spelling of that destination lives beside the Jobs block (no lib value import here).
import { JOBS_MATRIX_DOORWAY as JOBS_VIEW } from "./JobsMatrixBlock";

const EVIDENCE_BTN = "rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]";

export interface ActivityFeedSurfaceProps {
  state: { data: OperatorFeedResponse | null; loading: boolean; error: string | null };
  nowMs: number;
  onOpenWorkspace?: (workspaceId: string) => void;
  /** Opens the execution timeline drawer; the block wires it to local state. */
  onInspectExecution?: (item: OperatorFeedItem) => void;
}

function FeedRow({ item, nowMs, onOpenWorkspace, onInspectExecution }: {
  item: OperatorFeedItem; nowMs: number;
  onOpenWorkspace?: (id: string) => void; onInspectExecution?: (item: OperatorFeedItem) => void;
}) {
  const reason = reasonLabel(item.reasonCode);
  return (
    <li className="grid gap-x-4 gap-y-1 py-2.5 text-xs md:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)_7rem_auto] md:items-baseline">
      <span className="flex flex-col text-[var(--text-secondary)]">
        <span className="tabular-nums">{relativeText(item.at, nowMs)}</span>
        <span className="text-[10px] text-[var(--text-faint)]">{utcStamp(item.at)}</span>
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="font-medium text-[var(--text-primary)]">{item.actionLabel}</span>
        <span className="text-[11px] text-[var(--text-muted)]">
          by {item.operator}{reason ? ` · ${reason}` : ""}
        </span>
      </span>
      <span className="break-all font-mono text-[11px] text-[var(--text-secondary)]">{item.target ?? "—"}</span>
      <ToneBadge word={resultWord(item.result)} tone={resultTone(item.result)} />
      <span className="flex flex-wrap items-center gap-1.5">
        {item.evidence.refreshExecutionId && onInspectExecution && (
          <button type="button" className={EVIDENCE_BTN} style={{ borderColor: "var(--border-hairline)" }} onClick={() => onInspectExecution(item)}
            aria-label={`Inspect refresh execution …${item.evidence.refreshExecutionId.slice(-6)}`}>
            Execution …{item.evidence.refreshExecutionId.slice(-6)}
          </button>
        )}
        {item.evidence.jobRunId && onOpenWorkspace && (
          <button type="button" className={EVIDENCE_BTN} style={{ borderColor: "var(--border-hairline)" }} onClick={() => onOpenWorkspace(JOBS_VIEW)}
            aria-label={`Open Jobs for run …${item.evidence.jobRunId.slice(-6)}`}>
            Open Jobs · run …{item.evidence.jobRunId.slice(-6)}
          </button>
        )}
        {!item.evidence.refreshExecutionId && !item.evidence.jobRunId && (
          <span className="text-[10px] text-[var(--text-faint)]">no execution reference</span>
        )}
      </span>
    </li>
  );
}

/** Prop-driven and fetch-free. */
export function ActivityFeedSurface({ state, nowMs, onOpenWorkspace, onInspectExecution }: ActivityFeedSurfaceProps) {
  const data = state.error ? null : state.data;
  return (
    <SectionSurface
      icon={UserCog}
      title="Recent operator activity"
      count={data?.items.length}
      actions={<BlockDoorway label="Jobs" workspaceId={JOBS_VIEW} onOpenWorkspace={onOpenWorkspace} />}
      footnote={data ? data.note : "Last 20 recorded actions on platform objects; security events live in Security Operations."}
    >
      {state.loading || !data ? (
        <WidgetMessage loading={state.loading} error={state.error} />
      ) : data.items.length === 0 ? (
        <WidgetMessage empty={FEED_EMPTY_TEXT} />
      ) : (
        <>
          <div className="hidden gap-x-4 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)] md:grid md:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)_7rem_auto]" aria-hidden>
            <span>When</span><span>Operator · action</span><span>Target</span><span>Result</span><span>Evidence</span>
          </div>
          <ul className="divide-y divide-[var(--border-hairline)]">
            {data.items.map((item) => (
              <FeedRow key={item.id} item={item} nowMs={nowMs} onOpenWorkspace={onOpenWorkspace} onInspectExecution={onInspectExecution} />
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-[var(--text-muted)]">
            Showing {data.depth.returned} of the last {data.depth.requested} recorded actions on platform objects.
          </p>
        </>
      )}
    </SectionSurface>
  );
}

export function ActivityFeedBlock({ onOpenWorkspace }: OverviewBlockProps) {
  const state = useWidgetFetch<OperatorFeedResponse>("/api/platform/platform-ops/activity");
  const [inspecting, setInspecting] = useState<OperatorFeedItem | null>(null);
  // ONE instant for the surface, captured at mount (a clock read during render
  // is impure — the same idiom OpsPlatformHealthWidget uses).
  const [nowMs] = useState(() => Date.now());
  return (
    <>
      <ActivityFeedSurface state={state} nowMs={nowMs} onOpenWorkspace={onOpenWorkspace} onInspectExecution={setInspecting} />
      <ExecutionTimelinePanel
        executionId={inspecting?.evidence.refreshExecutionId ?? null}
        eyebrow={inspecting ? `Operator action · ${inspecting.operator}` : ""}
        title={inspecting?.actionLabel ?? ""}
        onClose={() => setInspecting(null)}
      />
    </>
  );
}
