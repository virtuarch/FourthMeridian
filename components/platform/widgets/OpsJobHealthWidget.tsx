"use client";

/**
 * components/platform/widgets/OpsJobHealthWidget.tsx  (PO1.2 · OPS-5 S2 · ops_job_health)
 *
 * Rich scheduled-job health, over GET /api/platform/platform-ops/job-health
 * (requirePlatformAccess PLATFORM_OPS READ). Headline health counts + one
 * expandable row per job, worst-first, each collapsing to a status/last-run
 * glance and expanding to the full operational read: cadence, next expected
 * run, last & average runtime, historical success rate, failure streak, manual
 * runs, and the last failure (time + truncated summary).
 *
 * NO FAKE METRICS: every field is a value the JobRun ledger provided; absent
 * metrics render as an em-dash (see job-health-format.ts). No health logic here
 * — the route's checkScheduledJobHealth() is the single authority; this file
 * only presents its output.
 */

import { useState } from "react";
import { Activity, ChevronRight } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import {
  fmtCadence,
  fmtDuration,
  fmtPercent,
  relTime,
  severityRank,
  statusLabel,
  statusTone,
  type StatusTone,
} from "./job-health-format";
import type { PlatformJobHealthResponse, PlatformJobRow } from "@/app/api/platform/platform-ops/job-health/route";

/** Tone → dot/label colour. Falls back through CSS vars with literal defaults. */
const TONE_COLOR: Record<StatusTone, string> = {
  ok:    "var(--success-400, #34d399)",
  info:  "var(--meridian-400, #7da8ff)",
  warn:  "var(--warning-400, #fbbf24)",
  bad:   "var(--danger-400, #f87171)",
  muted: "var(--text-muted)",
};

function StatusBadge({ status }: { status: string }) {
  const color = TONE_COLOR[statusTone(status)];
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0" style={{ color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      <span className="text-xs font-medium">{statusLabel(status)}</span>
    </span>
  );
}

/** One labelled metric cell inside an expanded row. */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</span>
      <span className="text-xs text-[var(--text-primary)] tabular-nums">{value}</span>
    </div>
  );
}

function JobRow({ job }: { job: PlatformJobRow }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b last:border-b-0" style={{ borderColor: "var(--border-hairline)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 py-1.5 text-left"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <ChevronRight
            size={12}
            className="shrink-0 text-[var(--text-muted)] transition-transform"
            style={{ transform: open ? "rotate(90deg)" : "none" }}
          />
          <span className="text-xs text-[var(--text-primary)] truncate">{job.job}</span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-[var(--text-muted)] tabular-nums">{relTime(job.lastStartedAt)}</span>
          <StatusBadge status={job.status} />
        </span>
      </button>
      {open && (
        <div className="pb-2.5 pl-[18px] pr-1">
          <div className="grid grid-cols-3 gap-x-3 gap-y-2">
            <Metric label="Cadence" value={fmtCadence(job.expectedEveryHours)} />
            <Metric label="Last run" value={relTime(job.lastStartedAt)} />
            <Metric label="Next run" value={relTime(job.nextExpectedAt)} />
            <Metric label="Last runtime" value={fmtDuration(job.lastRuntimeMs)} />
            <Metric label="Avg runtime" value={fmtDuration(job.avgRuntimeMs)} />
            <Metric label="Success rate" value={fmtPercent(job.successRate)} />
            <Metric label="Failure streak" value={String(job.consecutiveFailures)} />
            <Metric label="Runs (window)" value={`${job.succeededRuns}/${job.totalRuns}`} />
            <Metric label="Manual runs" value={String(job.manualRuns)} />
          </div>
          {job.lastFailureAt && (
            <div className="mt-2 flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
                Last failure · {relTime(job.lastFailureAt)}
              </span>
              <span className="text-[11px] break-words" style={{ color: "var(--danger-400, #f87171)" }}>
                {job.lastFailureSummary ?? "no summary recorded"}
              </span>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function OpsJobHealthWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformJobHealthResponse>(
    "/api/platform/platform-ops/job-health",
  );

  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={Activity}>
        <WidgetMessage loading={loading} error={error} />
      </PlatformWidgetCard>
    );
  }

  const { counts } = data;
  const attention = counts.dead + counts.failing + counts.overdue;
  const jobs = [...data.jobs].sort(
    (a, b) => severityRank(a.status) - severityRank(b.status) || a.job.localeCompare(b.job),
  );

  return (
    <PlatformWidgetCard label={section.label} icon={Activity}>
      <div className="grid grid-cols-3 gap-3">
        <WidgetStat value={counts.healthy} label="Healthy" />
        <WidgetStat value={attention} label="Attention" />
        <WidgetStat value={data.jobs.length} label="Total" />
      </div>
      {(counts.running > 0 || counts.neverRan > 0) && (
        <p className="text-[11px] text-[var(--text-muted)] -mt-1">
          {counts.running > 0 && <span>{counts.running} running</span>}
          {counts.running > 0 && counts.neverRan > 0 && <span> · </span>}
          {counts.neverRan > 0 && <span>{counts.neverRan} never ran</span>}
        </p>
      )}
      {jobs.length === 0 ? (
        <p className="text-xs text-[var(--text-secondary)] mt-1">No scheduled jobs registered.</p>
      ) : (
        <ul className="flex flex-col mt-1">
          {jobs.map((j) => (
            <JobRow key={j.job} job={j} />
          ))}
        </ul>
      )}
    </PlatformWidgetCard>
  );
}
