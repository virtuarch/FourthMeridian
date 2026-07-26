"use client";

/**
 * components/platform/widgets/OpsJobHealthWidget.tsx  (S4 · ops_job_health)
 *
 * THE JOBS SURFACE — the dominant surface of Platform Operations.
 *
 * The prototype (`prototype-ops-control-plane/Jobs.tsx`) is the UI authority and
 * `GET /api/platform/platform-ops/job-health` is the data authority. What used to
 * be here — three count tiles over a flat name list — is gone; this is the
 * prototype's six-column expandable table, on production tokens, reading exactly
 * one existing route.
 *
 *   JOB · HEALTH · POLICY · SOURCE · LAST RECORDED EXECUTION · NEXT EXPECTED
 *
 * Cadence has no column of its own by design: it is configuration, it does not
 * change between reads, and it rides along as the job's second identity line.
 * Rows are ~56px, separated by hairlines only — no vertical rules, no cell
 * borders, no card per row.
 *
 * ── WHAT THIS FILE IS NOT ALLOWED TO DECIDE ──────────────────────────────────
 * Health. `lib/jobs/health.ts` classified every row before the response was
 * serialised, and `job-health-format.ts` owns the word and the tone for each
 * status. Nothing here re-derives a state, and the headline "Attention" figure
 * is read from the route's OWN `counts` object rather than counted off the rows
 * (`jobs-view.ts` → `attentionCount`). Filtering and search narrow what is on
 * screen and are pure client-side over rows already returned.
 *
 * ── THE POLICY COLUMN ────────────────────────────────────────────────────────
 * There is no job-policy authority in Fourth Meridian, so no cell can carry a
 * chip. The column is kept because the layout is the spec, and every cell states
 * the absence — an empty cell would mean "an operator declared nothing", which
 * is a different and untrue claim. See `jobs-view.ts` for the full reasoning.
 * The prototype's "Has policy" filter pill and its row command menu follow from
 * the same gap and are handled the same way: state the absence, fabricate
 * nothing.
 *
 * ── RESPONSIVE ───────────────────────────────────────────────────────────────
 * The prototype collapses six columns with a `useNarrowViewport` JS read. That
 * hook is deliberately NOT ported (it exists only because a gitignored tree is
 * invisible to Tailwind's content scan). Production collapses by `md:` variant:
 * below `md` a row is identity + health + menu, and the four columns that drop
 * out reappear inside the row's own expansion, so no fact is lost on a phone.
 * The table sits in its own `overflow-x-auto` so the PAGE can never scroll
 * sideways.
 */

import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight, MoreHorizontal, Search, Timer } from "lucide-react";
import { WidgetMessage, useWidgetFetch, type PlatformSection } from "../widget-kit";
import {
  Provenance,
  SectionSurface,
  StatusBadge,
  TwoLine,
  Unavailable,
  NO_AUTHORITY,
  TONE_COLOR,
} from "../platform-surface";
import { fmtDuration, fmtPercent, relTime } from "./job-health-format";
import {
  FILTER_LABELS,
  JOBS_FILTERS,
  NEVER_RAN_REASON,
  NO_COMMANDS_REASON,
  NO_MAINTENANCE_AUTHORITY_REASON,
  NO_SLOT_REASON,
  POLICY_FOOTNOTE,
  POLICY_UNRECORDED_REASON,
  attentionCount,
  cadenceLine,
  filterJobs,
  fmtUtc,
  jobSource,
  lastExecutionCell,
  nextExpectedCell,
  orderJobs,
  type JobsFilter,
} from "./jobs-view";
import { JobDetailPanel } from "./JobDetailPanel";
import type {
  PlatformJobHealthResponse,
  PlatformJobRow,
} from "@/app/api/platform/platform-ops/job-health/route";

/**
 * ONE grid definition, shared by the header row and every data row — this is
 * what makes the columns actually align. The prototype's track list, unchanged.
 */
const COLS = "minmax(0,2.1fr) 6.5rem 7rem 6.5rem minmax(0,1fr) minmax(0,1fr) 1.75rem";

const HEADINGS = [
  "Job",
  "Health",
  "Policy",
  "Source",
  "Last recorded execution",
  "Next expected",
  "",
] as const;

// ── Cells ─────────────────────────────────────────────────────────────────────

/** LAST RECORDED EXECUTION. Never-run renders the reason, never a time and never a zero. */
function LastExecutionCell({ job, nowMs }: { job: PlatformJobRow; nowMs?: number }) {
  const cell = lastExecutionCell(job, (iso) => relTime(iso, nowMs));
  if (!cell) return <Unavailable reason={NEVER_RAN_REASON} />;
  return <TwoLine value={cell.value} qualifier={cell.qualifier} />;
}

/** NEXT EXPECTED — the health authority's derivation from the registry slot. */
function NextExpectedCell({ job }: { job: PlatformJobRow }) {
  const cell = nextExpectedCell(job);
  if (!cell) return <Unavailable reason={NO_SLOT_REASON} />;
  return <TwoLine value={cell.value} qualifier={cell.qualifier} />;
}

/** SOURCE — proven from the response, or the neutral no-authority chip. */
function SourceCell({ job }: { job: PlatformJobRow }) {
  return <Provenance source={jobSource(job) ?? NO_AUTHORITY} />;
}

/** One labelled metric inside a row expansion. */
function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
        {label}
      </span>
      <span className="text-xs tabular-nums text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

/**
 * The row expansion. Exported so the test can render it directly — a collapsed
 * row's contents are unreachable through `renderToStaticMarkup`, which runs no
 * effects and dispatches no clicks.
 */
export function JobRowDetail({
  job,
  onOpen,
  nowMs,
}: {
  job: PlatformJobRow;
  onOpen: (job: PlatformJobRow) => void;
  /** Injected clock. Omitted in production: the formatter reads the wall clock itself. */
  nowMs?: number;
}) {
  return (
    <div className="grid gap-x-6 gap-y-4 px-6 pb-5 pt-1 sm:grid-cols-2 lg:grid-cols-3">
      <Metric label="Success rate" value={fmtPercent(job.successRate)} />
      <Metric label="Failure streak" value={String(job.consecutiveFailures)} />
      <Metric label="Runs in window" value={`${job.succeededRuns}/${job.totalRuns}`} />
      <Metric label="Last runtime" value={fmtDuration(job.lastRuntimeMs)} />
      <Metric label="Average runtime" value={fmtDuration(job.avgRuntimeMs)} />
      <Metric label="Manual runs" value={String(job.manualRuns)} />

      {/* RESPONSIVE DEVIATION — the four columns that drop below `md` reappear
          here, so a phone loses layout and never loses a fact. */}
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 md:hidden" style={{ gridColumn: "1 / -1" }}>
        <Metric label="Policy" value={<Unavailable reason={POLICY_UNRECORDED_REASON} />} />
        <Metric label="Source" value={<SourceCell job={job} />} />
        <Metric label="Last recorded execution" value={<LastExecutionCell job={job} nowMs={nowMs} />} />
        <Metric label="Next expected" value={<NextExpectedCell job={job} />} />
      </div>

      {job.lastFailureAt && (
        <div className="flex flex-col gap-0.5" style={{ gridColumn: "1 / -1" }}>
          <span className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
            Last failure · {fmtUtc(job.lastFailureAt, true)} · {relTime(job.lastFailureAt, nowMs)}
          </span>
          <span className="text-[11px] leading-relaxed break-words" style={{ color: TONE_COLOR.bad }}>
            {job.lastFailureSummary ?? "no summary recorded"}
          </span>
        </div>
      )}

      <div style={{ gridColumn: "1 / -1" }}>
        <button
          type="button"
          onClick={() => onOpen(job)}
          className="rounded-[var(--radius-xs)] text-[11px] text-[var(--meridian-400)] transition-colors hover:text-[var(--meridian-300)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
        >
          Open job detail →
        </button>
      </div>
    </div>
  );
}

// ── One row ───────────────────────────────────────────────────────────────────

function JobRow({
  job,
  onOpen,
  nowMs,
}: {
  job: PlatformJobRow;
  onOpen: (job: PlatformJobRow) => void;
  nowMs?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li
      className="relative border-b transition-colors last:border-b-0 hover:bg-[var(--surface-hover)]"
      style={{ borderColor: "var(--border-hairline)" }}
    >
      <div
        className="flex items-center gap-3 px-1 md:grid"
        style={{ gridTemplateColumns: COLS, minHeight: 56 }}
      >
        {/* Job — name over cadence. The second line is the reason there is no
            Schedule column: an operator needs the cadence, not a column for it. */}
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-xs)] py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
        >
          <ChevronRight
            size={12}
            aria-hidden
            className="shrink-0 text-[var(--text-faint)] transition-transform"
            style={{ transform: expanded ? "rotate(90deg)" : "none" }}
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
              {job.job}
            </span>
            <span className="truncate text-[11px] text-[var(--text-muted)]">{cadenceLine(job)}</span>
          </span>
        </button>

        {/* Health — observed, and the only coloured thing in the row. Word and
            dot always travel together (StatusBadge makes that structural). */}
        <span className="shrink-0">
          <StatusBadge status={job.status} />
        </span>

        {/* Policy — declared by nobody. The absence is the content. */}
        <span className="hidden md:block">
          <Unavailable reason={POLICY_UNRECORDED_REASON} />
        </span>

        {/* Source — the system of record for this job's schedule. */}
        <span className="hidden md:block">
          <SourceCell job={job} />
        </span>

        <span className="hidden md:block">
          <LastExecutionCell job={job} nowMs={nowMs} />
        </span>

        <span className="hidden md:block">
          <NextExpectedCell job={job} />
        </span>

        {/* The row command menu. Every command it would carry (run now, pause,
            skip, disable) is a write against an authority that does not exist,
            so it is inert and says so in its accessible name. */}
        <button
          type="button"
          disabled
          aria-label={`Commands for ${job.job} — unavailable: ${NO_COMMANDS_REASON}`}
          title={NO_COMMANDS_REASON}
          className="shrink-0 self-center rounded-[var(--radius-sm)] p-1.5 text-[var(--text-faint)] opacity-40"
        >
          <MoreHorizontal size={14} aria-hidden />
        </button>
      </div>

      {expanded && <JobRowDetail job={job} onOpen={onOpen} nowMs={nowMs} />}
    </li>
  );
}

// ── Table ─────────────────────────────────────────────────────────────────────

/**
 * The aligned column grid and its rows. Exported for the test — and separate
 * from the toolbar so filtering can be proven as a pure selection
 * (`jobs-view.filterJobs`) AND as a rendered list of exactly those rows.
 */
export function JobsTable({
  rows,
  onOpen,
  nowMs,
  emptyMessage = "No jobs match.",
}: {
  rows: readonly PlatformJobRow[];
  onOpen: (job: PlatformJobRow) => void;
  /** Injected clock. Omitted in production: the formatter reads the wall clock itself. */
  nowMs?: number;
  emptyMessage?: string;
}) {
  return (
    /* The table owns its own horizontal scroll so the PAGE never scrolls
       sideways on a phone. Below `md` the row is a flex line that always fits,
       so this container has nothing to scroll — it is the guarantee, not the
       layout. */
    <div className="overflow-x-auto">
      {/* Column header — the alignment key. Suppressed below `md`, where the
          six columns collapse and a header row would only take space. */}
      <div
        className="mb-1 hidden items-center gap-3 border-b px-1 pb-2 md:grid"
        style={{ gridTemplateColumns: COLS, borderColor: "var(--border-hairline)" }}
      >
        {HEADINGS.map((h, i) => (
          <span
            key={i}
            className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]"
          >
            {h}
          </span>
        ))}
      </div>

      <ul className="flex flex-col">
        {rows.length === 0 ? (
          <li className="py-6 text-center text-xs text-[var(--text-muted)]">{emptyMessage}</li>
        ) : (
          rows.map((job) => (
            <JobRow key={job.job} job={job} onOpen={onOpen} nowMs={nowMs} />
          ))
        )}
      </ul>
    </div>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function Toolbar({
  filter,
  onFilter,
  query,
  onQuery,
  counts,
}: {
  filter: JobsFilter;
  onFilter: (f: JobsFilter) => void;
  query: string;
  onQuery: (q: string) => void;
  counts: Record<JobsFilter, number>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        className="flex items-center rounded-[var(--radius-sm)] border p-0.5"
        style={{ borderColor: "var(--border-hairline)" }}
      >
        {JOBS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => onFilter(f)}
            aria-pressed={filter === f}
            className="rounded-[var(--radius-xs)] px-2.5 text-[11px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--meridian-400)]"
            style={{
              paddingBlock: 3,
              background: filter === f ? "var(--surface-hover-strong)" : "transparent",
              color: filter === f ? "var(--text-primary)" : "var(--text-muted)",
            }}
          >
            {FILTER_LABELS[f]}{" "}
            <span className="tabular-nums text-[var(--text-faint)]">{counts[f]}</span>
          </button>
        ))}
      </div>

      <label
        className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-2.5"
        style={{ borderColor: "var(--border-hairline)", paddingBlock: 5 }}
      >
        <Search size={12} aria-hidden className="shrink-0 text-[var(--text-faint)]" />
        <span className="sr-only">Search jobs</span>
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search jobs"
          className="min-w-0 bg-transparent text-[11px] text-[var(--text-primary)] focus:outline-none"
          style={{ width: 96 }}
        />
      </label>

      {/* Maintenance mode holds every scheduled job at once. It is the single
          largest write on this surface and there is no authority behind it, so
          it ships inert with the reason in its accessible name — removing it
          would hide the gap; wiring it would invent one. */}
      <button
        type="button"
        disabled
        aria-label={NO_MAINTENANCE_AUTHORITY_REASON}
        title={NO_MAINTENANCE_AUTHORITY_REASON}
        className="rounded-[var(--radius-sm)] border px-2.5 text-[11px] font-medium opacity-50"
        style={{
          paddingBlock: 4,
          background: "color-mix(in srgb, var(--coral-500) 7%, transparent)",
          color: "var(--coral-400)",
          borderColor: "color-mix(in srgb, var(--coral-500) 26%, transparent)",
        }}
      >
        Maintenance mode
      </button>
    </div>
  );
}

// ── The surface ───────────────────────────────────────────────────────────────

/**
 * The whole surface, given a fetch RESULT rather than performing one.
 *
 * Split from the widget so all four states — loading, error, empty and populated
 * — are renderable in a test. `useWidgetFetch` resolves inside an effect, and
 * `renderToStaticMarkup` runs no effects, so a component that fetches for itself
 * can only ever be proven in its loading state.
 */
export function JobsSurface({
  title,
  data,
  loading,
  error,
  nowMs,
}: {
  title: string;
  data: PlatformJobHealthResponse | null;
  loading: boolean;
  error: string | null;
  /** Injected clock. Omitted in production: the formatter reads the wall clock itself. */
  nowMs?: number;
}) {
  const [filter, setFilter] = useState<JobsFilter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PlatformJobRow | null>(null);

  const shown = useMemo(
    () => (data ? filterJobs(orderJobs(data.jobs), filter, query) : []),
    [data, filter, query],
  );

  /* loading ≠ empty ≠ error. A failed fetch renders the failure INSIDE the
     surface frame — never a count pill, never an empty table, never a zero. */
  if (loading || error || !data) {
    return (
      <SectionSurface icon={Timer} title={title}>
        <WidgetMessage loading={loading} error={error} />
      </SectionSurface>
    );
  }

  const observedAt = fmtUtc(data.checkedAt, true);

  return (
    <>
      <SectionSurface
        icon={Timer}
        title={title}
        count={data.jobs.length}
        actions={
          <Toolbar
            filter={filter}
            onFilter={setFilter}
            query={query}
            onQuery={setQuery}
            counts={{ all: data.jobs.length, attention: attentionCount(data.counts) }}
          />
        }
        footnote={
          <>
            Health is observed, from the JobRun ledger. {POLICY_FOOTNOTE} Source is the system of
            record for the schedule.{observedAt ? ` Observed ${observedAt}.` : ""}
          </>
        }
      >
        <JobsTable
          rows={shown}
          onOpen={setSelected}
          nowMs={nowMs}
          emptyMessage={
            data.jobs.length === 0 ? "No scheduled jobs are registered." : "No jobs match."
          }
        />
      </SectionSurface>

      <JobDetailPanel job={selected} onClose={() => setSelected(null)} />
    </>
  );
}

/**
 * The registry entry point. Fetches once, over the one existing route, and hands
 * the RESULT to the surface above — the host still passes `section`, and the
 * heading is still the operator-configured section label.
 */
export function OpsJobHealthWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformJobHealthResponse>(
    "/api/platform/platform-ops/job-health",
  );
  return <JobsSurface title={section.label} data={data} loading={loading} error={error} />;
}
