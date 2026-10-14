"use client";

/**
 * components/platform/widgets/overview/JobsMatrixBlock.tsx  (UX-P1 · Agent 4)
 *
 * The Overview's compact scheduled-jobs matrix over
 * GET /api/platform/platform-ops/job-health: one row per registered job —
 * job · health · last run · next due · consecutive failures — worst first, in
 * the Jobs surface's own row grammar compacted (no toolbar, no expansion, no
 * policy column). The full table, its filters, its detail panel and the
 * scheduler stay in Jobs; this block summarizes and directs.
 *
 * ── WHAT THIS FILE DOES NOT DECIDE ───────────────────────────────────────────
 * Health. `lib/jobs/health.ts` classified every row; `job-health-format.ts`
 * owns the word and the tone; `jobs-view.orderJobs` owns worst-first; the
 * summary line reads the route's OWN counts. Nothing here re-classifies,
 * re-counts, or invents a slot — the dispatcher tick is unobservable and the
 * footnote says so.
 *
 * ── RESPONSIVE ───────────────────────────────────────────────────────────────
 * Five columns at `md` and up. Below `md` a row becomes two lines — identity +
 * health, then the three facts as labelled inline cells — so a phone loses the
 * column alignment and never a fact. Collapse is by `md:` class only.
 */

import type { ReactNode } from "react";
import { ArrowRight, Timer } from "lucide-react";
import { WidgetMessage, useWidgetFetch } from "../../widget-kit";
import { SectionSurface, StatusBadge, TONE_COLOR, TwoLine, Unavailable } from "../../platform-surface";
import { getPlatformWorkspace } from "@/lib/platform/workspaces";
import type { PlatformJobHealthResponse, PlatformJobRow } from "@/app/api/platform/platform-ops/job-health/route";
import { cadenceLine, fmtUtc, orderJobs } from "../jobs-view";
import {
  MATRIX_FOOTNOTE,
  NEVER_RAN_WORD,
  NEXT_NOT_DERIVED_REASON,
  NEXT_WAKE_WORD,
  failuresCell,
  lastRunCell,
  nextDueCell,
  summaryLine,
} from "../jobs-matrix-view";
import type { OverviewBlockProps } from "./block-contract";

/** The workspace this block opens. */
export const JOBS_MATRIX_DOORWAY = "platform-jobs";

/** One grid definition for the header and every row — the alignment key. */
const COLS = "minmax(0,1.7fr) 6.5rem minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)";
const HEADINGS = ["Job", "Health", "Last run", "Next due", "Failures"] as const;

function Doorway({ onOpenWorkspace }: { onOpenWorkspace?: (id: string) => void }) {
  const def = getPlatformWorkspace(JOBS_MATRIX_DOORWAY);
  if (!def || !onOpenWorkspace) return null;
  return (
    <button
      type="button"
      onClick={() => onOpenWorkspace(JOBS_MATRIX_DOORWAY)}
      aria-label={`Open ${def.label}`}
      className="relative flex w-fit items-center gap-1 text-[11px] text-[var(--meridian-400)] transition-colors hover:text-[var(--meridian-300)] before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-full before:min-w-[44px] before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
    >
      {def.label} <ArrowRight size={10} aria-hidden />
    </button>
  );
}

/** A fact cell below `md` carries its own label; at `md` the column header carries it. */
function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 md:block">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-faint)] md:hidden">{label}</span>
      {children}
    </span>
  );
}

function LastRunCell({ job, nowMs }: { job: PlatformJobRow; nowMs?: number }) {
  const cell = lastRunCell(job, nowMs);
  if (!cell) return <span className="text-xs text-[var(--text-muted)]">{NEVER_RAN_WORD}</span>;
  return <TwoLine value={cell.value} qualifier={cell.qualifier} />;
}

function NextDueCell({ job, nowMs }: { job: PlatformJobRow; nowMs?: number }) {
  const cell = nextDueCell(job, nowMs);
  if (cell.kind === "time") return <TwoLine value={cell.value} qualifier={cell.qualifier} />;
  if (cell.kind === "wake") return <span className="text-xs text-[var(--text-secondary)]">{NEXT_WAKE_WORD}</span>;
  return <Unavailable reason={NEXT_NOT_DERIVED_REASON} />;
}

function FailuresCell({ job }: { job: PlatformJobRow }) {
  const streak = failuresCell(job);
  if (!streak) return <span className="text-xs tabular-nums text-[var(--text-muted)]">0</span>;
  return (
    <span className="text-xs font-medium tabular-nums" style={{ color: TONE_COLOR.bad }}>
      {streak}
    </span>
  );
}

/** The rows, exported so a test can render them over fixed data and a fixed clock. */
export function JobsMatrixRows({ rows, nowMs }: { rows: readonly PlatformJobRow[]; nowMs?: number }) {
  return (
    <div className="overflow-x-auto">
      <div
        className="mb-1 hidden items-center gap-3 border-b px-1 pb-2 md:grid"
        style={{ gridTemplateColumns: COLS, borderColor: "var(--border-hairline)" }}
      >
        {HEADINGS.map((h) => (
          <span key={h} className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">
            {h}
          </span>
        ))}
      </div>
      <ul className="flex flex-col">
        {rows.map((job) => (
          <li
            key={job.job}
            className="flex flex-col gap-1.5 border-b px-1 py-2.5 last:border-b-0 md:grid md:items-center md:gap-3"
            style={{ gridTemplateColumns: COLS, borderColor: "var(--border-hairline)", minHeight: 48 }}
          >
            {/* Identity + health — one line below md; two grid cells at md. */}
            <div className="flex items-center justify-between gap-3 md:contents">
              <TwoLine value={<span className="font-medium">{job.job}</span>} qualifier={cadenceLine(job)} />
              <span className="shrink-0">
                <StatusBadge status={job.status} />
              </span>
            </div>
            {/* The three facts — labelled inline below md; three grid cells at md. */}
            <div className="flex flex-wrap gap-x-5 gap-y-1 md:contents">
              <Labelled label="Last run">
                <LastRunCell job={job} nowMs={nowMs} />
              </Labelled>
              <Labelled label="Next due">
                <NextDueCell job={job} nowMs={nowMs} />
              </Labelled>
              <Labelled label="Failures">
                <FailuresCell job={job} />
              </Labelled>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The surface, given a fetch RESULT rather than performing one, so every state
 * is renderable in a test.
 */
export function JobsMatrixSurface({
  data,
  loading,
  error,
  nowMs,
  onOpenWorkspace,
}: {
  data: PlatformJobHealthResponse | null;
  loading: boolean;
  error: string | null;
  /** Injected clock. Omitted in production: the formatter reads the wall clock itself. */
  nowMs?: number;
  onOpenWorkspace?: (workspaceId: string) => void;
}) {
  const doorway = <Doorway onOpenWorkspace={onOpenWorkspace} />;

  if (loading || error || !data) {
    return (
      <SectionSurface icon={Timer} title="Scheduled jobs" actions={doorway}>
        <WidgetMessage loading={loading} error={error} />
      </SectionSurface>
    );
  }

  const observedAt = fmtUtc(data.checkedAt, true);
  return (
    <SectionSurface
      icon={Timer}
      title="Scheduled jobs"
      count={data.jobs.length}
      actions={doorway}
      footnote={
        <>
          {MATRIX_FOOTNOTE}
          {observedAt ? ` Observed ${observedAt}.` : ""}
        </>
      }
    >
      <p className="mb-4 text-xs tabular-nums text-[var(--text-secondary)]">{summaryLine(data.counts)}</p>
      {data.jobs.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">No scheduled jobs are registered.</p>
      ) : (
        <JobsMatrixRows rows={orderJobs(data.jobs)} nowMs={nowMs} />
      )}
    </SectionSurface>
  );
}

export function JobsMatrixBlock({ onOpenWorkspace }: OverviewBlockProps) {
  const { data, loading, error } = useWidgetFetch<PlatformJobHealthResponse>(
    "/api/platform/platform-ops/job-health",
  );
  return <JobsMatrixSurface data={data} loading={loading} error={error} onOpenWorkspace={onOpenWorkspace} />;
}
