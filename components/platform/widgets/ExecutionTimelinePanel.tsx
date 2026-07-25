"use client";

/**
 * components/platform/widgets/ExecutionTimelinePanel.tsx  (OPS-2C-3)
 *
 * The execution INSPECTION surface — an Atlas `RightPanel` over one refresh
 * execution's timeline. Panel = inspect, Modal = decide: inspecting an execution
 * must not lose the list you were reading, so detail docks at the right edge.
 *
 * ── THE INVARIANT THIS FILE IS HELD TO ────────────────────────────────────────
 * The panel is an inspection surface. It COMPOSES and VISUALIZES existing
 * operational facts; it is never an authority and performs NO aggregation. It
 * renders the Execution Timeline projection entry-for-entry, in the order the
 * projection returned. It does not sort, group, total, or count — the ordering
 * (including the equal-timestamp tiebreak) is the projection's, and re-deciding
 * it here would be a second ordering authority for the same story.
 *
 * ── WHY THIS FILE HAS ITS OWN FETCH, AND WHY THAT IS NOT A PARALLEL PATH ──────
 * `useWidgetFetch` is contractually STATIC-URL ONLY — pinned by
 * widget-fetch-static-url.test.ts, which rejects a template literal at the call
 * site outright. That invariant exists because the hook deliberately does not
 * reset loading/error, so a changing url would render the PREVIOUS resource's
 * data as if it were current: stale operator data presented as fact.
 *
 * A per-execution timeline is a genuinely dynamic resource, so the hook does not
 * apply. Bending the guard was the wrong answer; so was widening the shared hook
 * for one caller. Instead this file owns a small keyed reader for exactly the
 * case the hook refuses: the fetching body is REMOUNTED via a React `key` on the
 * execution id, so it never observes a second url in one lifetime — the hazard
 * the guard protects against is structurally impossible here rather than merely
 * avoided. It reuses the same credentials/abort/status semantics, and the same
 * `WidgetMessage` surface, so loading and error look identical to every other
 * platform widget.
 */

import { useEffect, useState } from "react";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { WidgetMessage } from "../widget-kit";
import type { ExecutionTimeline, TimelineEntry } from "@/lib/platform/refresh/types";
import { formatDuration } from "./refresh-format";

/** Entry kind → tone. Presentation only; the kind itself is the projection's. */
const KIND_TONE: Record<TimelineEntry["kind"], string> = {
  "execution-started": "var(--meridian-400, #7da8ff)",
  "stage-started": "var(--text-muted)",
  "provider-call": "var(--brass-300, #d9b25a)",
  "account-coverage": "var(--text-muted)",
  "stage-ended": "var(--text-secondary)",
  "execution-completed": "var(--accent-positive, #34d399)",
};

/** Status → tone, for the entries that carry one. */
const STATUS_TONE: Record<string, string> = {
  SUCCEEDED: "var(--accent-positive, #34d399)",
  COVERED: "var(--accent-positive, #34d399)",
  PARTIAL: "var(--brass-300, #d9b25a)",
  SKIPPED: "var(--text-muted)",
  FAILED: "var(--accent-negative, #f87171)",
  RATE_LIMITED: "var(--accent-negative, #f87171)",
  RUNNING: "var(--meridian-400, #7da8ff)",
};

/** Time-of-day only — the panel header carries the date. */
function clockTime(iso: string): string {
  return iso.slice(11, 19);
}

/**
 * Keyed single-resource reader. SAFE ONLY WHEN REMOUNTED per resource — the
 * caller keys `TimelineBody` on the execution id, so this never sees a second
 * url in one lifetime. Same same-origin credentials, abort-on-unmount and
 * status handling as the shared hook.
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

/**
 * The fetching body. Separate component so the caller can key it on the
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
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-[var(--text-muted)]">
        run {data.runId} ·{" "}
        {data.complete ? (
          <span>complete · {data.tier}</span>
        ) : (
          <span style={{ color: "var(--brass-300, #d9b25a)" }}>
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
                  <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                    {clockTime(entry.at)}
                  </span>
                </span>
                <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[11px] text-[var(--text-muted)]">
                  <span>{entry.kind.replace(/-/g, " ")}</span>
                  {entry.status && (
                    <span style={{ color: STATUS_TONE[entry.status] ?? "var(--text-muted)" }}>
                      {entry.status}
                    </span>
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

export function ExecutionTimelinePanel({
  executionId,
  eyebrow,
  title,
  onClose,
}: ExecutionTimelinePanelProps) {
  return (
    <RightPanel open={executionId != null} onClose={onClose} size="lg">
      <PanelHeader eyebrow={eyebrow} title={title} />
      <PanelContent>
        {/* Keyed on the execution id: selecting another execution REMOUNTS the
            body, which is the sanctioned way to give useWidgetFetch a new url. */}
        {executionId && <TimelineBody key={executionId} executionId={executionId} />}
      </PanelContent>
    </RightPanel>
  );
}
