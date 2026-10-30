"use client";

/**
 * components/platform/ops-visual/UnifiedJobs.tsx  (Platform Ops visual spec §3 + §4 row D)
 *
 * THE Jobs experience — one row per scheduled job, replacing BOTH the former job
 * registry table (OpsJobHealthWidget) and the standalone Manual operations panel
 * (OpsManualOperationsWidget). A row carries the human name, the honest status
 * (ops-visual-model.ts honestJobStatus), cadence, last recorded execution, next
 * EXPECTED execution, a 7-day success/failure sparkline from real runs, and —
 * only for a job the operations registry can run — Dry run / Run now.
 *
 * Selecting a job opens ONE focused detail (DetailDrawer): status, schedule, the
 * execution history chart + compact table, failures, the controls, and a collapsed
 * "Technical" disclosure (ledger id, registry slots, the command's own notes).
 *
 * EXECUTION is the existing POST /api/platform/platform-ops/operations, unchanged:
 *   dry run           WRITE, runs at once (non-mutating preflight)
 *   run (one scope)   WRITE, behind a confirmation
 *   run (fleet)       offered only to an operator with control-plane access
 *                     (otherwise one line says it needs Control access), behind a
 *                     confirmation with a REQUIRED structured reason
 * The route re-checks every one of those server-side; this component only decides
 * what to RENDER. It is the one Operations component that reads `canControl`.
 */

import { useCallback, useState, type ReactNode } from "react";
import { FlaskConical, Loader2, Play, Search } from "lucide-react";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { Surface } from "@/components/atlas/Surface";
import { DetailDrawer } from "../ui/DetailDrawer";
import { LazyDisclosure } from "../leads/lead-kit";
import { TONE_COLOR, type StatusTone } from "../platform-surface";
import { useSharedWidgetFetch, useSharedWidgetPublish } from "../workspace-session";
import { OperatorReasonField, EMPTY_OPERATOR_REASON, reasonPayload, type OperatorReasonValue } from "../widgets/OperatorReasonField";
import { fmtDuration, relTime } from "../widgets/job-health-format";
import type { PlatformJobHealthResponse } from "@/app/api/platform/platform-ops/job-health/route";
import type { SchedulerObservationResponse } from "@/app/api/platform/platform-ops/scheduler/route";
import type { OperationsResponse, OperationActionResponse } from "@/app/api/platform/platform-ops/operations/route";
import type { OperationalHistoryResult } from "@/lib/platform/history/types";
import type { OperationCommand } from "@/lib/platform/operations/registry";
import type { SpaceMountAccess } from "@/lib/space/mount-context";
import { slotWords } from "./job-catalog";
import { DayBars, DayBarsLegend, DAY_BAR_COLORS, Sparkline7 } from "./DayBars";
import {
  executionDays,
  jobRows,
  jobRuns,
  schedulerEvidence,
  type Fetched,
  type JobRowModel,
  type SchedulerEvidence,
} from "./ops-visual-model";

export const JOBS_URL = "/api/platform/platform-ops/job-health";
export const SCHEDULER_URL = "/api/platform/platform-ops/scheduler";
export const HISTORY_URL = "/api/platform/platform-ops/history";
export const OPERATIONS_URL = "/api/platform/platform-ops/operations";

/** Summary mode shows this many rows (the rows past MOBILE_ROWS hide below md). */
export const SUMMARY_ROWS = 5;
export const MOBILE_ROWS = 3;

export const READ_ONLY_LINE = "Read-only — running needs write access";
export const NEEDS_CONTROL_LINE = "Needs Control access";

type Feedback = { job: string; text: string; tone: StatusTone };

export interface JobAccess { canWrite: boolean; canControl: boolean }

/** The descriptive flags this component renders by (fail-safe: absent ⇒ read-only). */
export function jobAccess(access: SpaceMountAccess | undefined): JobAccess {
  return { canWrite: access?.canWrite === true, canControl: access?.canControl === true };
}

/** Is this command a fleet-wide run (it declares a stronger requirement than WRITE)? */
export function isFleetRun(c: OperationCommand): boolean {
  return c.mutates && c.requires.level !== "WRITE";
}

/** What a job's controls render as for this operator — the pure decision, pinned by the tests. */
export interface ControlPlan {
  dry: OperationCommand | null;
  run: OperationCommand | null;
  /** One line shown instead of (some of) the buttons, or null. */
  note: string | null;
}
export function controlPlan(row: Pick<JobRowModel, "controls">, a: JobAccess): ControlPlan {
  const c = row.controls;
  if (c.unavailable) return { dry: null, run: null, note: c.unavailable };
  if (!a.canWrite) return { dry: null, run: null, note: READ_ONLY_LINE };
  const runAllowed = c.run && (!isFleetRun(c.run) || a.canControl) ? c.run : null;
  return { dry: c.dry, run: runAllowed, note: c.run && !runAllowed ? NEEDS_CONTROL_LINE : null };
}

// ── Pieces ────────────────────────────────────────────────────────────────────

export function StatusWord({ word, tone, className = "" }: { word: string; tone: StatusTone; className?: string }) {
  const color = TONE_COLOR[tone];
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate text-xs font-medium" style={{ color: tone === "muted" ? "var(--text-secondary)" : color }}>{word}</span>
    </span>
  );
}

const BTN =
  "inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-sm)] border px-2.5 text-[11px] font-medium transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] sm:min-h-8";

function ControlButtons({ plan, busy, onDry, onRun, compact = false }: {
  plan: ControlPlan;
  busy: boolean;
  onDry: (c: OperationCommand) => void;
  onRun: (c: OperationCommand) => void;
  compact?: boolean;
}) {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {plan.dry && (
        <button type="button" disabled={busy} onClick={() => onDry(plan.dry!)} className={BTN}
          style={{ borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }} aria-label={`Dry run ${plan.dry.targetLabel}`}>
          <FlaskConical size={12} aria-hidden />{compact ? <span className="max-sm:sr-only">Dry run</span> : "Dry run"}
        </button>
      )}
      {plan.run && (
        <button type="button" disabled={busy} onClick={() => onRun(plan.run!)} aria-haspopup="dialog" className={BTN}
          style={{ borderColor: "color-mix(in srgb, var(--meridian-400) 40%, transparent)", color: "var(--meridian-400)" }} aria-label={`Run ${plan.run.targetLabel} now`}>
          {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Play size={12} aria-hidden />}Run now
        </button>
      )}
      {plan.note && <span className="text-[11px] text-[var(--text-muted)]" data-job-control-note>{plan.note}</span>}
    </span>
  );
}

const COLS = "lg:grid lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_84px_84px_96px_76px_minmax(0,1.1fr)] lg:items-center lg:gap-x-4";
/** The row's select button spans the six read columns on a subgrid (a real, focusable button — never display:contents). */
const SELECT_SPAN = "lg:col-span-6 lg:grid lg:grid-cols-subgrid lg:items-center";

function JobRow({ r, nowMs, plan, busy, feedback, onSelect, onDry, onRun, className = "" }: {
  r: JobRowModel;
  nowMs: number;
  plan: ControlPlan;
  busy: boolean;
  feedback: Feedback | null;
  onSelect: () => void;
  onDry: (c: OperationCommand) => void;
  onRun: (c: OperationCommand) => void;
  className?: string;
}) {
  return (
    <li className={`border-t border-[var(--border-hairline)] first:border-t-0 ${className}`} data-job-row={r.job}>
      <div className={`flex flex-col gap-1.5 py-2.5 ${COLS}`}>
        <button type="button" onClick={onSelect} aria-haspopup="dialog" aria-label={`${r.label} — ${r.status.word}`}
          className={`flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-[var(--radius-xs)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] ${SELECT_SPAN}`}>
          <span className="min-w-0 truncate text-sm font-medium text-[var(--text-primary)]">{r.label}</span>
          <StatusWord word={r.status.word} tone={r.status.tone} className="shrink-0 lg:shrink" />
          <span className="hidden text-xs tabular-nums text-[var(--text-secondary)] lg:inline">{r.cadence}</span>
          <span className="hidden text-xs tabular-nums text-[var(--text-secondary)] lg:inline" title={r.lastRunAt ?? undefined}>{r.lastRunAt ? relTime(r.lastRunAt, nowMs) : "—"}</span>
          <span className="hidden text-xs tabular-nums text-[var(--text-secondary)] lg:inline" title={r.nextExpectedAt ?? undefined}>
            {r.nextExpectedAt ? <>{relTime(r.nextExpectedAt, nowMs)} <span className="text-[var(--text-faint)]">expected</span></> : "—"}
          </span>
          <span className="hidden lg:inline-flex"><Sparkline7 days={r.days7} label={`${r.label}, last 7 days`} /></span>
        </button>
        <div className="flex min-w-0 items-center justify-between gap-2 lg:justify-end">
          <span className="truncate text-[11px] tabular-nums text-[var(--text-muted)] lg:hidden">
            {r.cadence} · last {r.lastRunAt ? relTime(r.lastRunAt, nowMs) : "—"}
          </span>
          <ControlButtons plan={plan} busy={busy} onDry={onDry} onRun={onRun} compact />
        </div>
      </div>
      {feedback && feedback.job === r.job && (
        <p className="pb-2 text-[11px]" style={{ color: TONE_COLOR[feedback.tone] }} role="status">{feedback.text}</p>
      )}
    </li>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--border-hairline)] bg-[var(--surface-inset)] px-3 py-2.5">
      <p className="truncate text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{label}</p>
      <p className="mt-1 truncate text-[13px] font-semibold tabular-nums text-[var(--text-primary)]">{value}</p>
      {sub && <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">{sub}</p>}
    </div>
  );
}

/** The ONE focused job detail. */
export function JobDetail({ r, nowMs, history, evidence, plan, busy, feedback, onDry, onRun }: {
  r: JobRowModel;
  nowMs: number;
  history: OperationalHistoryResult | null;
  evidence: SchedulerEvidence;
  plan: ControlPlan;
  busy: boolean;
  feedback: Feedback | null;
  onDry: (c: OperationCommand) => void;
  onRun: (c: OperationCommand) => void;
}) {
  const days14 = executionDays(history, nowMs, 14, [r.job]);
  const runs = jobRuns(history, r.job, 8);
  const row = r.row;
  const rate = row.succeededRuns + row.failedRuns > 0 ? Math.round((row.succeededRuns / (row.succeededRuns + row.failedRuns)) * 100) : null;
  const command = r.controls.run ?? r.controls.dry;
  return (
    <div className="flex min-w-0 flex-col gap-6" data-job-detail={r.job}>
      <div className="flex flex-col gap-1">
        <StatusWord word={r.status.word} tone={r.status.tone} />
        <p className="text-[11px] text-[var(--text-muted)]">{r.status.reason}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Cadence" value={r.cadence} />
        <Stat label="Last run" value={r.lastRunAt ? relTime(r.lastRunAt, nowMs) : "—"} sub={row.lastRunStatus ?? "no run recorded"} />
        <Stat label="Next" value={r.nextExpectedAt ? relTime(r.nextExpectedAt, nowMs) : "—"} sub="expected" />
        <Stat label="Success" value={rate === null ? "—" : `${rate}%`} sub={`last ${row.totalRuns} runs`} />
      </div>

      <section aria-label="Executions" className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Executions · 14 d</h3>
          <DayBarsLegend items={[{ label: "Succeeded", color: DAY_BAR_COLORS.succeeded }, { label: "Failed", color: DAY_BAR_COLORS.failed }]} />
        </div>
        <DayBars days={days14} ariaLabel={`${r.label} executions per day`} height={140} noun="run" />
        {runs.length > 0 ? (
          <ul aria-label="Recent runs" className="flex flex-col">
            {runs.map((x) => (
              <li key={x.at} className="flex items-center justify-between gap-3 border-t border-[var(--border-hairline)] py-1.5 text-xs first:border-t-0">
                <span className="tabular-nums text-[var(--text-secondary)]" title={x.at}>{relTime(x.at, nowMs)}</span>
                <StatusWord word={x.status || "recorded"} tone={x.status === "succeeded" ? "ok" : x.status === "failed" ? "bad" : "info"} />
                <span className="tabular-nums text-[var(--text-muted)]">{fmtDuration(x.durationMs)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-[var(--text-muted)]">No run recorded in the history window.</p>
        )}
      </section>

      {row.lastFailureAt && (
        <section aria-label="Failures" className="flex flex-col gap-1">
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Last failure · {relTime(row.lastFailureAt, nowMs)}</h3>
          <p className="truncate text-xs text-[var(--text-secondary)]" title={row.lastFailureSummary ?? undefined}>{row.lastFailureSummary ?? "No summary recorded"}</p>
        </section>
      )}

      <section aria-label="Controls" className="flex flex-col gap-2">
        <h3 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Run</h3>
        <div className="flex justify-start"><ControlButtons plan={plan} busy={busy} onDry={onDry} onRun={onRun} /></div>
        {feedback && feedback.job === r.job && <p className="text-[11px]" style={{ color: TONE_COLOR[feedback.tone] }} role="status">{feedback.text}</p>}
      </section>

      <LazyDisclosure title="Technical" hint="Ledger id, schedule, scheduler evidence">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[11px]">
          <dt className="text-[var(--text-muted)]">Ledger id</dt><dd className="font-mono text-[var(--text-secondary)]">{r.job}</dd>
          <dt className="text-[var(--text-muted)]">Registry slots</dt><dd className="text-[var(--text-secondary)]">{slotWords(r.job) ?? "—"}</dd>
          <dt className="text-[var(--text-muted)]">Health status</dt><dd className="text-[var(--text-secondary)]">{row.status}</dd>
          <dt className="text-[var(--text-muted)]">Runs examined</dt><dd className="tabular-nums text-[var(--text-secondary)]">{row.totalRuns} ({row.manualRuns} manual · {row.failedRuns} failed)</dd>
          <dt className="text-[var(--text-muted)]">Runtime</dt><dd className="tabular-nums text-[var(--text-secondary)]">last {fmtDuration(row.lastRuntimeMs)} · avg {fmtDuration(row.avgRuntimeMs)}</dd>
          {row.source && (<><dt className="text-[var(--text-muted)]">Source policy</dt><dd className="text-[var(--text-secondary)]">{row.source.sourceKind} · every {row.source.policyExpectedEveryHours} h</dd></>)}
          <dt className="text-[var(--text-muted)]">Scheduler</dt><dd className="text-[var(--text-secondary)]">{evidence.basis}</dd>
          {command && (<><dt className="text-[var(--text-muted)]">Manual run</dt><dd className="text-[var(--text-secondary)]">{command.description}</dd></>)}
          {command && (<><dt className="text-[var(--text-muted)]">Commands</dt><dd className="font-mono text-[var(--text-secondary)]">{[r.controls.dry?.id, r.controls.run?.id].filter(Boolean).join(" · ")}</dd></>)}
        </dl>
      </LazyDisclosure>
    </div>
  );
}

// ── The surface (prop-driven, fetch-free — every state renders in a test) ────

export interface UnifiedJobsSurfaceProps {
  mode: "summary" | "full";
  jobs: Fetched<PlatformJobHealthResponse>;
  scheduler: Fetched<SchedulerObservationResponse>;
  history: Fetched<OperationalHistoryResult>;
  operations: Fetched<OperationsResponse>;
  access?: SpaceMountAccess;
  nowMs: number;
  selected: string | null;
  onSelect: (job: string | null) => void;
  acting: string | null;
  feedback: Feedback | null;
  onDry: (c: OperationCommand) => void;
  onRun: (c: OperationCommand) => void;
}

export function UnifiedJobsSurface(p: UnifiedJobsSurfaceProps) {
  const [query, setQuery] = useState("");
  const a = jobAccess(p.access);
  const evidence = schedulerEvidence(p.jobs, p.scheduler);
  const rows = p.jobs.data
    ? jobRows({ jobs: p.jobs.data, evidence, history: p.history.data, commands: p.operations.data?.commands ?? (p.operations.loading ? [] : null), nowMs: p.nowMs })
    : [];
  const q = query.trim().toLowerCase();
  const shown = p.mode === "summary" ? rows.slice(0, SUMMARY_ROWS) : rows.filter((r) => !q || r.label.toLowerCase().includes(q) || r.job.includes(q) || r.status.word.toLowerCase().includes(q));
  const current = p.selected ? rows.find((r) => r.job === p.selected) ?? null : null;

  let body: ReactNode;
  if (!p.jobs.data) {
    body = <p className="py-3 text-xs text-[var(--text-muted)]">{p.jobs.loading ? "Reading job health…" : `Job health unavailable${p.jobs.error ? ` — ${p.jobs.error}` : ""}`}</p>;
  } else if (shown.length === 0) {
    body = <p className="py-3 text-xs text-[var(--text-muted)]">{q ? "No job matches." : "No scheduled jobs reported."}</p>;
  } else {
    body = (
      <>
        <div aria-hidden className={`hidden pb-2 text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)] ${COLS}`}>
          <span>Job</span><span>Status</span><span>Cadence</span><span>Last run</span><span>Next</span><span>7 days</span><span className="text-right">Run</span>
        </div>
        <ul aria-label="Scheduled jobs" className="flex flex-col">
          {shown.map((r, i) => (
            <JobRow key={r.job} r={r} nowMs={p.nowMs} plan={controlPlan(r, a)} busy={p.acting !== null} feedback={p.feedback}
              onSelect={() => p.onSelect(r.job)} onDry={p.onDry} onRun={p.onRun}
              className={p.mode === "summary" && i >= MOBILE_ROWS ? "max-md:hidden" : ""} />
          ))}
        </ul>
      </>
    );
  }

  return (
    <>
      <div className="min-w-0" data-unified-jobs={p.mode}>
      <Surface className="min-w-0 px-4 py-2 sm:px-5">
        {p.mode === "full" && (
          <label className="flex min-h-11 items-center gap-2 border-b border-[var(--border-hairline)] py-2">
            <Search size={14} aria-hidden className="text-[var(--text-muted)]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search jobs" aria-label="Search jobs"
              className="min-w-0 flex-1 bg-transparent text-base text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none sm:text-sm" />
          </label>
        )}
        {p.mode === "full" && p.jobs.data && evidence.state !== "active" && (
          <p className="truncate border-t border-[var(--border-hairline)] py-2 text-[11px] text-[var(--text-muted)]" title={evidence.basis} data-scheduler-evidence={evidence.state}>
            {evidence.headline}
          </p>
        )}
        {body}
      </Surface>
      </div>
      <DetailDrawer open={current !== null} onClose={() => p.onSelect(null)} eyebrow="Job" title={current?.label ?? ""} size="lg">
        {current && (
          <JobDetail r={current} nowMs={p.nowMs} history={p.history.data} evidence={evidence} plan={controlPlan(current, a)}
            busy={p.acting !== null} feedback={p.feedback} onDry={p.onDry} onRun={p.onRun} />
        )}
      </DetailDrawer>
    </>
  );
}

// ── The container: shared reads + the operations POST ─────────────────────────

/** Feedback words for an operations response (the route's own outcome). */
export function feedbackFor(status: number, res: Partial<OperationActionResponse> & { error?: string }): { text: string; tone: StatusTone } {
  if (status === 409) return { text: "A run is already in progress — try again shortly.", tone: "warn" };
  if (status < 200 || status >= 300) return { text: res.error ?? `Action failed (${status})`, tone: "bad" };
  if (res.outcome === "planned") return { text: res.plan?.inFlight ? "Dry run: a run is in progress right now." : "Dry run: ready — a run would start immediately.", tone: "ok" };
  if (res.outcome === "executed") return { text: "Ran — recorded as a manual run.", tone: "ok" };
  if (res.outcome === "failed") return { text: `Run failed${res.error ? `: ${res.error}` : ""}.`, tone: "bad" };
  return { text: "Done.", tone: "ok" };
}

/** The request body the existing route expects: the command id, plus the reason a fleet run requires. */
export function operationBody(c: OperationCommand, why: OperatorReasonValue | null): { commandId: string; reason?: { code: string; note?: string } } {
  const reason = c.requires.reason && why ? reasonPayload(why) : null;
  return reason ? { commandId: c.id, reason } : { commandId: c.id };
}

export function UnifiedJobs({ mode, access, nowMs, selected: selectedProp, onSelect: onSelectProp }: {
  mode: "summary" | "full";
  access?: SpaceMountAccess;
  nowMs: number;
  /** Controlled selection (the dashboard opens a job from Needs attention); uncontrolled when absent. */
  selected?: string | null;
  onSelect?: (job: string | null) => void;
}) {
  const jobs = useSharedWidgetFetch<PlatformJobHealthResponse>(JOBS_URL);
  const scheduler = useSharedWidgetFetch<SchedulerObservationResponse>(SCHEDULER_URL);
  const history = useSharedWidgetFetch<OperationalHistoryResult>(HISTORY_URL);
  const operations = useSharedWidgetFetch<OperationsResponse>(OPERATIONS_URL);
  const publishJobs = useSharedWidgetPublish<PlatformJobHealthResponse>(JOBS_URL);
  const publishOps = useSharedWidgetPublish<OperationsResponse>(OPERATIONS_URL);

  const [own, setOwn] = useState<string | null>(null);
  const selected = selectedProp !== undefined ? selectedProp : own;
  const onSelect = onSelectProp ?? setOwn;
  const [acting, setActing] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirming, setConfirming] = useState<OperationCommand | null>(null);
  const [reason, setReason] = useState<OperatorReasonValue>(EMPTY_OPERATOR_REASON);

  const refresh = useCallback(async () => {
    // After an action, re-read job health and the manual-run list into the shared
    // session so every card shows the same, new moment.
    const read = async <T,>(url: string, publish: (d: T) => void) => {
      try { const r = await fetch(url, { credentials: "same-origin" }); if (r.ok) publish((await r.json()) as T); } catch { /* the previous answer stays */ }
    };
    await Promise.all([read(JOBS_URL, publishJobs), read(OPERATIONS_URL, publishOps)]);
  }, [publishJobs, publishOps]);

  const invoke = useCallback(async (c: OperationCommand, why: OperatorReasonValue | null) => {
    setActing(c.id);
    setFeedback(null);
    try {
      const r = await fetch(OPERATIONS_URL, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(operationBody(c, why)),
      });
      const res = (await r.json().catch(() => ({}))) as Partial<OperationActionResponse> & { error?: string };
      setFeedback({ job: c.targetJob, ...feedbackFor(r.status, res) });
      await refresh();
    } catch (e) {
      setFeedback({ job: c.targetJob, text: e instanceof Error ? e.message : "Action failed", tone: "bad" });
    } finally {
      setActing(null);
    }
  }, [refresh]);

  const onDry = (c: OperationCommand) => { void invoke(c, null); };
  const onRun = (c: OperationCommand) => { setReason(EMPTY_OPERATOR_REASON); setConfirming(c); };
  const fleet = confirming ? isFleetRun(confirming) : false;

  return (
    <>
      <UnifiedJobsSurface mode={mode} jobs={jobs} scheduler={scheduler} history={history} operations={operations} access={access}
        nowMs={nowMs} selected={selected} onSelect={onSelect} acting={acting} feedback={feedback} onDry={onDry} onRun={onRun} />
      {confirming && (
        <ConfirmDialog
          open
          icon={Play}
          title={`Run ${confirming.targetLabel} now`}
          message={fleet ? (
            <>
              <span>{confirming.confirm} This runs across every customer connection it covers.</span>
              <OperatorReasonField value={reason} onChange={setReason} disabled={acting !== null} label="Fleet-wide run — a reason is recorded with it" />
            </>
          ) : confirming.confirm}
          confirmDisabled={confirming.requires.reason && reasonPayload(reason) === null}
          confirmLabel="Run now"
          confirmTone={confirming.destructive ? "danger" : "meridian"}
          busy={acting === confirming.id}
          onClose={() => { if (acting === null) setConfirming(null); }}
          onConfirm={async () => {
            const c = confirming;
            await invoke(c, c.requires.reason ? reason : null);
            setConfirming(null);
          }}
        />
      )}
    </>
  );
}
