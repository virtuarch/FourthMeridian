"use client";

/**
 * components/platform/widgets/OpsRefreshExecutionsWidget.tsx  (OPS-2C-2 · ops_refresh_executions)
 *
 * The most recent refresh executions, over
 * GET /api/platform/platform-ops/refresh/executions — the EXECUTION QUERY SEAM's
 * read surface (requirePlatformAccess PLATFORM_OPS READ).
 *
 * This is the ROW surface, so it renders rows and nothing else: no totals, no
 * rates, no health verdict. A count here would be an aggregation the seam
 * deliberately does not perform, and computing one client-side would be exactly
 * the "widget computes truth" defect the read boundary exists to prevent.
 *
 * OPS-2C-3: a row now OPENS an inspection panel (Panel = inspect, Modal =
 * decide), carrying only the id + the header context the operator clicked. The
 * panel fetches the timeline projection itself; this widget passes no data down,
 * so there is exactly one consumer path per surface.
 *
 * OPS-2C-4 — DEPLOYMENT IS EVIDENCE ON AN EXECUTION, NEVER A SUBJECT:
 *
 *     Execution → deploymentSha        ✅ one observed attribute of the object
 *     Deployment → execution summary   ❌ the inversion this must never become
 *
 * So the list stays FLAT and TIME-ORDERED. It is never grouped or bucketed by
 * deployment; there is no deployment heading that owns rows, no per-deployment
 * count, and no deployment section. A change of deployment between two adjacent
 * rows renders as an inline RULE — an annotation on the sequence, not a group.
 *
 * ONLY OBSERVED EVIDENCE IS DISPLAYED. Each row shows the deployment recorded on
 * THAT execution, or "unknown" when none was observed. Nothing here claims
 * "current", "earlier", or "served by": the client bundle inlines only
 * NEXT_PUBLIC_ vars, so a client-derived notion of the running deployment would
 * read `unknown` whenever only the non-public var is set — a comparison basis
 * that is silently absent is worse than no comparison. Such a marker returns only
 * if a canonical SERVER-side contract ever exposes current runtime deployment
 * identity.
 */

import { useState } from "react";
import { ListOrdered } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  timeAgo,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { ExecutionPageDTO } from "@/lib/platform/refresh/execution-query-core";
import { ExecutionTimelinePanel } from "./ExecutionTimelinePanel";
import { formatDuration, isDeploymentBoundary, shortSha } from "./refresh-format";

/** Status → tone. Presentation only; the status itself is the ledger's own value. */
const STATUS_TONE: Record<string, string> = {
  SUCCEEDED: "var(--accent-positive, #34d399)",
  PARTIAL: "var(--brass-300, #d9b25a)",
  FAILED: "var(--accent-negative, #f87171)",
  SKIPPED: "var(--text-muted)",
  RUNNING: "var(--meridian-400, #7da8ff)",
};

export function OpsRefreshExecutionsWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<ExecutionPageDTO>(
    "/api/platform/platform-ops/refresh/executions?limit=20",
  );
  // The inspected execution. Only the id + its header context are held here —
  // the panel fetches its own timeline, so no execution data is threaded down.
  const [selected, setSelected] = useState<{ id: string; eyebrow: string; title: string } | null>(null);

  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={ListOrdered}>
        <WidgetMessage loading={loading} error={error} />
      </PlatformWidgetCard>
    );
  }

  return (
    <>
      <PlatformWidgetCard label={section.label} icon={ListOrdered}>
      {data.scopeDenied ? (
        <p className="text-xs text-[var(--text-muted)]">
          No connections in scope — this read was refused rather than widened.
        </p>
      ) : data.rows.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          No refresh executions recorded — <em>not observed</em>. The ledger holds no rows
          for this view; that is not the same as a successful quiet period.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-1">
            {data.rows.map((row, i) => (
              <li key={row.id}>
              {/* An inline RULE between two time-ordered rows — never a heading
                  that owns the rows beneath it. The list is never grouped by
                  deployment; this only marks where the attribute changed. */}
              {isDeploymentBoundary(data.rows, i) && (
                <div className="my-1 flex items-center gap-2" aria-hidden>
                  <span className="h-px flex-1 bg-[var(--border-subtle,rgba(255,255,255,0.08))]" />
                  <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                    deployment changed · {shortSha(row.deploymentSha)}
                  </span>
                  <span className="h-px flex-1 bg-[var(--border-subtle,rgba(255,255,255,0.08))]" />
                </div>
              )}
              <button
                type="button"
                onClick={() =>
                  setSelected({
                    id: row.id,
                    eyebrow: `${row.trigger} · ${row.profile} · deploy ${shortSha(row.deploymentSha)}`,
                    title: new Date(row.startedAt).toLocaleString(),
                  })
                }
                className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-0.5 text-left text-xs transition-colors hover:bg-[var(--surface-hover,rgba(255,255,255,0.04))] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--meridian-400,#7da8ff)]"
                title={`run ${row.runId} · item ${row.plaidItemId}`}
                aria-label={`Inspect ${row.trigger} execution from ${row.startedAt}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block size-1.5 shrink-0 rounded-full"
                    style={{ background: STATUS_TONE[row.overallStatus] ?? "var(--text-muted)" }}
                  />
                  <span className="truncate text-[var(--text-primary)]">{row.trigger}</span>
                  <span className="shrink-0 text-[var(--text-muted)]">{row.overallStatus}</span>
                  <span
                    className="shrink-0 text-[10px] text-[var(--text-muted)]"
                    title={`deployment ${row.deploymentSha ?? "not observed"}`}
                  >
                    {shortSha(row.deploymentSha)}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                  {formatDuration(row.durationMs)}
                  <span className="text-[var(--text-muted)]"> · {timeAgo(row.startedAt)}</span>
                  {row.hasError && (
                    <span style={{ color: "var(--accent-negative, #f87171)" }} title={row.errorSummary ?? undefined}>
                      {" "}
                      · error
                    </span>
                  )}
                </span>
              </button>
              </li>
            ))}
          </ul>
          {data.nextCursor && (
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">
              Older executions exist beyond this page.
            </p>
          )}
        </>
        )}
      </PlatformWidgetCard>

      <ExecutionTimelinePanel
        executionId={selected?.id ?? null}
        eyebrow={selected?.eyebrow ?? ""}
        title={selected?.title ?? ""}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
