"use client";

/**
 * components/platform/widgets/ExecutionTimelinePanel.tsx  (OPS-2C-3 · execution inspection)
 *
 * The inspection panel for ONE refresh execution. Panel = inspect, Modal =
 * decide: this never interrupts and never mutates.
 *
 * PLATFORM OPS OBSERVABILITY — the panel now answers the operator's questions
 * in order, from two keyed reads:
 *   1. the INSPECTION (GET /refresh/executions/[id]): what was refreshed,
 *      how it was triggered, how long it took, where it failed and why (the
 *      derived verdict), what happened to canonical state, the same source's
 *      last successful execution, the policy in force and when the source is
 *      eligible again;
 *   2. the TIMELINE (GET /refresh/executions/[id]/timeline): the stages,
 *      provider calls and coverage in the order the projection recorded them.
 *
 * `useWidgetFetch` is contractually STATIC-URL ONLY — pinned by
 * widget-fetch-static-url.test.ts, which rejects a template literal at the call
 * site. The fetching bodies are REMOUNTED via a React `key` on the execution
 * id, so each keyed reader sees exactly one url in its lifetime.
 *
 * Presentation only: no folding, no re-sorting, no filtering of projection
 * entries. Free text shown is the ledger's truncated errorSummary — never a
 * stack, never a provider payload.
 */

import { useEffect, useState } from "react";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { WidgetMessage, timeAgo } from "../widget-kit";
import { KeyRow, PanelSection, TONE_COLOR } from "../platform-surface";
import type { ExecutionTimeline, TimelineEntry } from "@/lib/platform/refresh/types";
import type { ExecutionInspection } from "@/lib/platform/refresh/inspection";
import { formatDuration, humanizeToken } from "./refresh-format";
import { describeCategory, describeOutcome, describeSource } from "./execution-format";

/** Entry kind → tone. Presentation only; the kind itself is the projection's. */
const KIND_TONE: Record<TimelineEntry["kind"], string> = {
  "execution-started": TONE_COLOR.info,
  "stage-started": TONE_COLOR.muted,
  "provider-call": "var(--brass-300)",
  "account-coverage": TONE_COLOR.muted,
  "stage-ended": "var(--text-secondary)",
  "execution-completed": TONE_COLOR.ok,
};

/** Status → tone, for the entries that carry one. */
const STATUS_TONE: Record<string, string> = {
  SUCCEEDED: TONE_COLOR.ok,
  COVERED: TONE_COLOR.ok,
  PARTIAL: TONE_COLOR.warn,
  SKIPPED: TONE_COLOR.muted,
  FAILED: TONE_COLOR.bad,
  RATE_LIMITED: TONE_COLOR.bad,
  RUNNING: TONE_COLOR.info,
};

const TRIGGER_WORD: Record<string, string> = {
  MANUAL: "Manual (owner asked)", CRON: "Scheduled sweep", OPERATOR: "Operator action",
  WEBHOOK: "Provider webhook", RECONNECT: "Reconnect", RESUME: "Import continuation", ADMIN: "Admin script",
};

/** Time-of-day only — the panel header carries the date. */
function clockTime(iso: string): string {
  return iso.slice(11, 19);
}

function utc(iso: string | null): string {
  return iso ? `${iso.slice(0, 19).replace("T", " ")} UTC` : "—";
}

/**
 * Keyed single-resource reader. SAFE ONLY WHEN REMOUNTED per resource — the
 * caller keys each body on the execution id, so this never sees a second url
 * in one lifetime. Same same-origin credentials, abort-on-unmount and status
 * handling as the shared hook.
 */
function useKeyedFetch<T>(url: string): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(url, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(
            r.status === 403 ? "Not authorized" : r.status === 404 ? "Execution not found" : `Request failed (${r.status})`,
          );
        }
        return (await r.json()) as T;
      })
      .then((j) => {
        if (!alive) return;
        setData(j);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Failed to load");
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [url]);

  return { data, loading, error };
}

/** The inspection body — the verdict, the context, the policy. Keyed per execution. */
function InspectionBody({ executionId }: { executionId: string }) {
  const { data, loading, error } = useKeyedFetch<ExecutionInspection>(
    `/api/platform/platform-ops/refresh/executions/${executionId}`,
  );
  if (loading || error || !data) return <WidgetMessage loading={loading} error={error} />;

  const e = data.detail.execution;
  const source = describeSource(e);
  const statusToken = STATUS_TONE[e.overallStatus] ?? TONE_COLOR.muted;
  const category = describeCategory(e.failureCategory);
  const last = data.context.lastSucceeded;
  const policy = data.context.policy;
  const failed = e.overallStatus === "FAILED" || e.overallStatus === "PARTIAL";

  return (
    <div className="flex flex-col gap-5">
      <PanelSection title="Execution">
        <div className="flex flex-col gap-1.5">
          <KeyRow label="Source" value={`${source.label} (${source.kind})`} />
          {e.network && <KeyRow label="Network" value={e.network} />}
          <KeyRow label="Trigger" value={TRIGGER_WORD[e.trigger] ?? humanizeToken(e.trigger)} />
          <KeyRow label="Status" value={<span style={{ color: statusToken }}>{humanizeToken(e.overallStatus)}</span>} />
          <KeyRow label="Started" value={utc(e.startedAt)} />
          <KeyRow label="Completed" value={e.completedAt ? utc(e.completedAt) : "not completed"} />
          <KeyRow label="Duration" value={formatDuration(e.durationMs)} />
          <KeyRow label="Profile" value={humanizeToken(e.profile)} />
        </div>
      </PanelSection>

      <PanelSection title={failed ? "Failure" : "Outcome"}>
        <div className="flex flex-col gap-1.5">
          {failed && <KeyRow label="Failed at stage" value={e.failureStage ?? "not recorded"} />}
          {failed && <KeyRow label="Category" value={category ?? "not classified"} />}
          {e.hasError && (
            <KeyRow
              label="Error"
              value={<span className="break-words text-left" style={{ color: TONE_COLOR.bad }}>{e.errorSummary ?? "recorded, redacted for this audience"}</span>}
            />
          )}
          <KeyRow label="Canonical state" value={describeOutcome(e.outcome, e.overallStatus)} />
        </div>
      </PanelSection>

      <PanelSection title="Context">
        <div className="flex flex-col gap-1.5">
          <KeyRow
            label="Last successful refresh"
            value={last ? `${timeAgo(last.startedAt)} ago · ${formatDuration(last.durationMs)} · ${TRIGGER_WORD[last.trigger] ?? humanizeToken(last.trigger)}` : "none recorded before this run"}
          />
          <KeyRow label="Policy in force" value={`${policy.sourceKind === "WALLET" ? "Wallets" : "Banks"} every ${policy.cadence} (${policy.origin.toLowerCase()})`} />
          <KeyRow label="Considered overdue after" value={`${policy.overdueAfterHours} h`} />
          <KeyRow
            label="Eligible again"
            value={data.context.nextEligibleAt ? `${utc(data.context.nextEligibleAt)}${data.context.overdueAgainstPolicy ? " · overdue now" : ""}` : "not derivable (no prior success)"}
          />
          {e.parentJobRunId && <KeyRow label="Ran under job" value={`…${e.parentJobRunId.slice(-8)}`} />}
          <KeyRow label="Run id" value={<span className="font-mono text-[11px]">{e.runId}</span>} />
        </div>
      </PanelSection>

      {data.detail.endpoints.length > 0 && (
        <PanelSection title="Stages">
          <ul className="flex flex-col gap-1.5">
            {data.detail.endpoints.map((s, i) => (
              <li key={`${s.endpoint}-${i}`} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-[var(--text-primary)]">
                  {humanizeToken(s.endpoint)} <span className="text-[var(--text-muted)]">· {s.stageKind.toLowerCase()}</span>
                </span>
                <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                  <span style={{ color: STATUS_TONE[s.status] ?? TONE_COLOR.muted }}>{humanizeToken(s.status)}</span>
                  {s.skipReason ? ` (${humanizeToken(s.skipReason)})` : ""} · {formatDuration(s.durationMs)}
                  {s.recordsWritten != null ? ` · ${s.recordsWritten} written` : ""}
                </span>
              </li>
            ))}
          </ul>
        </PanelSection>
      )}
    </div>
  );
}

/**
 * The timeline body. Separate component so the caller can key it on the
 * execution id (see the module header).
 */
function TimelineBody({ executionId }: { executionId: string }) {
  const { data, loading, error } = useKeyedFetch<ExecutionTimeline>(
    `/api/platform/platform-ops/refresh/executions/${executionId}/timeline`,
  );

  if (loading || error || !data) {
    return <WidgetMessage loading={loading} error={error} />;
  }

  return (
    <PanelSection title="Timeline">
      <div className="flex flex-col gap-3">
        <p className="text-[11px] text-[var(--text-muted)]">
          {data.complete ? (
            <span>complete · {data.tier}</span>
          ) : (
            <span style={{ color: "var(--brass-300)" }}>
              still running — this timeline is incomplete ({data.tier})
            </span>
          )}
        </p>

        {data.entries.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">
            This execution recorded no timeline entries — <em>not observed</em>.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {data.entries.map((entry, i) => (
              <li key={`${entry.at}-${entry.kind}-${i}`} className="flex gap-3 text-xs">
                <span
                  aria-hidden
                  className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full"
                  style={{ background: KIND_TONE[entry.kind] ?? "var(--text-muted)" }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[var(--text-primary)]">{entry.label}</span>
                    <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{clockTime(entry.at)}</span>
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[11px] text-[var(--text-muted)]">
                    <span>{entry.kind.replace(/-/g, " ")}</span>
                    {entry.status && (
                      <span style={{ color: STATUS_TONE[entry.status] ?? "var(--text-muted)" }}>{entry.status}</span>
                    )}
                    {entry.durationMs != null && <span>{formatDuration(entry.durationMs)}</span>}
                    {entry.detail && <span className="text-[var(--text-secondary)]">{entry.detail}</span>}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </PanelSection>
  );
}

export interface ExecutionTimelinePanelProps {
  /** The execution being inspected, or null when the panel is closed. */
  executionId: string | null;
  /** Header context, carried from the row the operator clicked. */
  eyebrow: string;
  title: string;
  onClose: () => void;
}

export function ExecutionTimelinePanel({ executionId, eyebrow, title, onClose }: ExecutionTimelinePanelProps) {
  return (
    <RightPanel open={executionId != null} onClose={onClose} size="lg">
      <PanelHeader eyebrow={eyebrow} title={title} />
      <PanelContent>
        {/* Keyed on the execution id: selecting another execution REMOUNTS the
            bodies, which is the sanctioned way to give useWidgetFetch a new url. */}
        {executionId && (
          <div className="flex flex-col gap-6">
            <InspectionBody key={`inspection-${executionId}`} executionId={executionId} />
            <TimelineBody key={executionId} executionId={executionId} />
          </div>
        )}
      </PanelContent>
    </RightPanel>
  );
}
