"use client";

/**
 * components/platform/widgets/OpsOverviewWidget.tsx  (PLATFORM OPS OBSERVABILITY · ops_overview)
 *
 * THE operations cockpit, over GET /api/platform/platform-ops/overview. One
 * frame, six domains — refresh pipeline, sources, scheduled jobs, Daily
 * Brief, AI invocations, Plaid — each with a verdict its authority can
 * support, a headline an operator can act on, the facts behind it, and a
 * doorway into the workspace that holds the detail.
 *
 * "Something is wrong" → "this exact execution failed": the newest failed
 * executions are listed here and open the same inspection panel the Pipeline
 * workspace uses, so the operator never hunts.
 *
 * Presentation only: every figure and every state is the server's. This file
 * folds nothing and never turns absence into zero.
 */

import { useState } from "react";
import { Activity, ArrowUpRight } from "lucide-react";
import { PlatformWidgetCard, WidgetMessage, timeAgo, useWidgetFetch, type PlatformSection } from "../widget-kit";
import { GroupLabel, KeyRow, SectionSurface, StatusWord } from "../platform-surface";
import type { OperationsOverview } from "@/lib/platform/ops/overview";
import { FACT_TONE_TOKEN, OVERVIEW_FOOTNOTE, STATE_TOKEN, STATE_WORD, overallWord, policyStrip } from "./ops-overview-view";
import { ExecutionTimelinePanel } from "./ExecutionTimelinePanel";
import { formatDuration, humanizeToken } from "./refresh-format";
import { describeCategory, describeSource, describeTrigger } from "./execution-format";

export function OpsOverviewWidget({
  section,
  onOpenWorkspace,
}: {
  section: PlatformSection;
  onOpenWorkspace?: (workspaceId: string) => void;
}) {
  const { data, loading, error } = useWidgetFetch<OperationsOverview>("/api/platform/platform-ops/overview");
  const [selected, setSelected] = useState<{ id: string; eyebrow: string; title: string } | null>(null);

  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={Activity}>
        <WidgetMessage loading={loading} error={error} />
      </PlatformWidgetCard>
    );
  }

  return (
    <>
      <SectionSurface icon={Activity} title={section.label} footnote={OVERVIEW_FOOTNOTE}>
        {/* The one-line answer, then the policy in force beside it. */}
        <div className="mb-8 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <div className="flex items-baseline gap-3">
            <StatusWord word={STATE_WORD[data.worst]} token={STATE_TOKEN[data.worst]} />
            <span className="text-sm text-[var(--text-secondary)]">{overallWord(data.worst)}</span>
          </div>
          <span className="text-[11px] text-[var(--text-muted)]">
            {policyStrip(data.policies)} · checked {timeAgo(data.checkedAt)} ago
          </span>
        </div>

        <div className="grid gap-x-8 gap-y-10 md:grid-cols-2 xl:grid-cols-3">
          {data.domains.map((d) => (
            <div key={d.key} className="flex min-w-0 flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <GroupLabel hint={`Authority: ${d.basis}`}>{d.title}</GroupLabel>
                {onOpenWorkspace && (
                  <button
                    type="button"
                    onClick={() => onOpenWorkspace(d.workspace)}
                    className="inline-flex items-center gap-1 rounded-[var(--radius-xs)] text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
                  >
                    Open <ArrowUpRight size={11} aria-hidden />
                  </button>
                )}
              </div>
              <StatusWord word={STATE_WORD[d.state]} token={STATE_TOKEN[d.state]} />
              <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{d.headline}</p>
              <div className="flex flex-col gap-1.5">
                {d.facts.map((f) => (
                  <KeyRow
                    key={f.label}
                    label={f.label}
                    value={<span style={f.tone ? { color: FACT_TONE_TOKEN[f.tone] } : undefined}>{f.value}</span>}
                  />
                ))}
              </div>
              <p className="text-[10px] text-[var(--text-faint)]">from {d.basis}</p>
            </div>
          ))}
        </div>

        {data.latestFailures.length > 0 && (
          <div className="mt-10 border-t pt-6" style={{ borderColor: "var(--border-hairline)" }}>
            <GroupLabel hint="The newest failed or partial refresh executions in the pipeline window. Each opens its execution.">
              Latest failed executions
            </GroupLabel>
            <ul className="mt-3 flex flex-col">
              {data.latestFailures.map((row) => {
                const source = describeSource(row);
                return (
                  <li key={row.id} className="border-b last:border-b-0" style={{ borderColor: "var(--border-hairline)" }}>
                    <button
                      type="button"
                      onClick={() =>
                        setSelected({
                          id: row.id,
                          eyebrow: `${source.kind} · ${describeTrigger(row.trigger)} · ${humanizeToken(row.overallStatus)}`,
                          title: source.label,
                        })
                      }
                      className="flex w-full flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
                      aria-label={`Inspect failed execution of ${source.label}`}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="text-xs font-medium text-[var(--text-primary)]">
                          {source.label}
                          <span className="font-normal text-[var(--text-muted)]"> · {describeTrigger(row.trigger)}</span>
                        </span>
                        <span className="text-[11px] text-[var(--text-muted)]">
                          {row.failureStage ? `failed at ${row.failureStage}` : humanizeToken(row.overallStatus)}
                          {row.failureCategory ? ` · ${describeCategory(row.failureCategory) ?? ""}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-secondary)]">
                        {formatDuration(row.durationMs)} · {timeAgo(row.startedAt)} ago
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </SectionSurface>

      <ExecutionTimelinePanel
        executionId={selected?.id ?? null}
        eyebrow={selected?.eyebrow ?? ""}
        title={selected?.title ?? ""}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
