/**
 * components/platform/ops-visual/ops-visual-model.ts  (Platform Ops visual spec §2 + §4)
 *
 * PURE data adapters behind the redesigned Operations workspace. No React, no
 * fetch, no clock (callers inject `nowMs`). Every figure is read from an existing
 * READ route; nothing here re-classifies job health or re-ranks alerts — it
 * PRESENTS the routes' facts honestly:
 *
 *   schedulerEvidence   whether this deployment's scheduler is observably waking,
 *                       from the scheduler observation (the 5-minute backstop
 *                       cron leaves a ledger row on EVERY fire) and job health
 *                       (the dispatcher selects a never-run job on EVERY wake)
 *   honestJobStatus     job health's status, worded so "dead" / "never ran" are
 *                       never claimed without evidence that a wake happened
 *   executionDays       executions per UTC day from the history series — real
 *                       points only; a day the series cannot vouch for is a GAP
 *   outcomeComposition  the jobs by their last recorded outcome (sums to the jobs)
 *   groupAttention      attention items grouped by their shared cause
 *   refreshDays         the refresh/daily buckets as stacked days (gaps kept)
 *   healthKpis          the four hero figures
 *   jobRows             the unified Jobs list, worst first
 */

import type { StatusTone } from "../platform-surface";
import type { PlatformJobHealthResponse, PlatformJobRow } from "@/app/api/platform/platform-ops/job-health/route";
import type { SchedulerObservationResponse } from "@/app/api/platform/platform-ops/scheduler/route";
import type { OperationalHistoryResult, OperationalHistoryPoint } from "@/lib/platform/history/types";
import type { AttentionResponse } from "@/lib/platform/ops/attention";
import type { AttentionItem, AttentionSeverity, AttentionEntityKind } from "@/lib/platform/ops/attention-core";
import type { RefreshDailySeries } from "@/lib/platform/refresh/types";
import type { OperationCommand } from "@/lib/platform/operations/registry";
import { SCHEDULED_JOB_NAMES, continuationOf, jobLabel, manualAvailability } from "./job-catalog";

/** A fetched source as the house hooks return it. */
export interface Fetched<T> { data: T | null; loading: boolean; error: string | null }

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const n = (v: number) => v.toLocaleString("en-US");

/** UTC day key (YYYY-MM-DD) of an instant. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function addDays(day: string, k: number): string {
  return utcDay(Date.parse(`${day}T00:00:00.000Z`) + k * DAY_MS);
}

// ── Scheduler evidence ─────────────────────────────────────────────────────────

/**
 * The backstop import cron (vercel.json "*\/5 * * * *"). Restated from
 * lib/jobs/scheduler-signals.ts BACKSTOP_CRON_JOB (server-only module), pinned
 * equal by ops-visual.test.ts. It is NOT a registered job, so the scheduler
 * observation reports its rows under `externalCrons`.
 */
export const BACKSTOP_CRON_JOB = "resume-stale-imports";
/** The scheduler observation's bounded ledger read (observation.ts MAX_RUNS) — a count equal to it is a floor. */
export const SCHEDULER_RUN_CAP = 2_000;
/** The history series' newest-first point cap (lib/platform/history/sources.ts MAX_POINTS). */
export const HISTORY_POINT_CAP = 500;

export type SchedulerState = "active" | "inactive" | "unknown";

export const SCHEDULER_INACTIVE = "No scheduled execution observed — scheduler not active on this deployment";
export const SCHEDULER_UNKNOWN = "Scheduler state unknown";
export const SCHEDULER_ACTIVE = "Scheduler active on this deployment";

export interface SchedulerEvidence {
  state: SchedulerState;
  /** One line, in words. */
  headline: string;
  /** The evidence behind the state (job detail / Technical disclosure). */
  basis: string;
}

/**
 * Is the scheduler observably waking on this deployment?
 *
 *   INACTIVE needs two independent facts, both from the ledger:
 *     (1) the backstop cron — which leaves a JobRun row on every 5-minute fire —
 *         left NO row in the observation window (≥ 1 h), so the cron provider is
 *         not invoking this deployment; and
 *     (2) the dispatcher left no trace a wake would leave: a registered primary
 *         job has NEVER run (decideJobDue: a never-run job is due on every wake),
 *         or no registered job executed in a window longer than some job's
 *         cadence (that job would have been due).
 *   ACTIVE: the backstop left rows in the window (the cron provider reaches this
 *   deployment; job health is then shown as the route reports it).
 *   UNKNOWN: anything else, including a source that did not answer.
 */
export function schedulerEvidence(
  jobs: Fetched<PlatformJobHealthResponse>,
  scheduler: Fetched<SchedulerObservationResponse>,
): SchedulerEvidence {
  const j = jobs.data;
  const s = scheduler.data;
  if (!j || !s) {
    return { state: "unknown", headline: SCHEDULER_UNKNOWN, basis: "The scheduler observation or job health could not be read." };
  }
  const windowHours = (Date.parse(s.window.to) - Date.parse(s.window.from)) / HOUR_MS;
  const backstopRows = s.observed.externalCrons.find((c) => c.job === BACKSTOP_CRON_JOB)?.recordedExecutions ?? 0;
  if (backstopRows > 0) {
    return { state: "active", headline: SCHEDULER_ACTIVE, basis: `The 5-minute backstop cron left ${n(backstopRows)} execution rows in the last ${Math.round(windowHours)} h.` };
  }
  if (!Number.isFinite(windowHours) || windowHours < 1) {
    return { state: "unknown", headline: SCHEDULER_UNKNOWN, basis: "The observation window is too short to judge." };
  }
  const neverRanPrimary = j.jobs.filter((r) => r.totalRuns === 0 && continuationOf(r.job) === null);
  const registeredInWindow = registeredExecutions(s);
  const someJobWasDue = j.jobs.some((r) => r.expectedEveryHours > 0 && r.expectedEveryHours < windowHours);
  if (neverRanPrimary.length > 0 || (registeredInWindow === 0 && someJobWasDue)) {
    const why = neverRanPrimary.length > 0
      ? `${n(neverRanPrimary.length)} registered job${neverRanPrimary.length === 1 ? " has" : "s have"} never run, though every wake runs a never-run job`
      : `no registered job executed, though at least one was due`;
    return {
      state: "inactive",
      headline: SCHEDULER_INACTIVE,
      basis: `The 5-minute backstop cron left no execution row in the last ${Math.round(windowHours)} h, and ${why}.`,
    };
  }
  return { state: "unknown", headline: SCHEDULER_UNKNOWN, basis: "No backstop cron row in the window, but registered jobs did execute — the scheduler's state cannot be told from the ledger." };
}

/** Executions recorded in the scheduler window for REGISTERED jobs (the backstop and other external crons excluded). */
export function registeredExecutions(s: SchedulerObservationResponse): number {
  const external = s.observed.externalCrons.reduce((acc, c) => acc + c.recordedExecutions, 0);
  return Math.max(0, s.observed.recordedExecutions - external);
}

// ── Honest job status ──────────────────────────────────────────────────────────

export type HonestKind = "failed" | "late" | "never-ran" | "unknown" | "not-observed" | "running" | "waiting" | "healthy";

export interface HonestStatus {
  kind: HonestKind;
  word: string;
  tone: StatusTone;
  /** One line explaining the word (never a paragraph). */
  reason: string;
}

/** Worst first. */
const KIND_RANK: Record<HonestKind, number> = {
  failed: 0, late: 1, "never-ran": 2, unknown: 3, "not-observed": 4, running: 5, waiting: 6, healthy: 7,
};

/**
 * Job health's status, presented honestly. The route's classification is not
 * changed — only how it is worded when the deployment's scheduler is not waking:
 * overdue / dead / never-ran are then "not observed" (no wake, so no verdict
 * about the job itself), and "Never ran" is said only when the ledger holds no
 * run at all AND a wake is evidenced. A recorded failure is always Failed.
 */
export function honestJobStatus(row: PlatformJobRow, evidence: SchedulerEvidence): HonestStatus {
  if (row.status === "running") return { kind: "running", word: "Running", tone: "info", reason: "A run is in progress" };
  if (row.status === "failing") {
    return { kind: "failed", word: "Failing", tone: "bad", reason: `Last ${row.consecutiveFailures} runs failed` };
  }
  if (row.lastRunStatus === "failed") return { kind: "failed", word: "Failed", tone: "bad", reason: "Last run failed" };
  if (row.status === "healthy") return { kind: "healthy", word: "Healthy", tone: "ok", reason: "Ran on schedule" };

  // never-ran · overdue · dead — what they MEAN depends on whether a wake happened.
  if (evidence.state === "inactive") return { kind: "not-observed", word: "Not observed", tone: "muted", reason: SCHEDULER_INACTIVE };
  if (evidence.state === "unknown") return { kind: "unknown", word: "Unknown", tone: "muted", reason: SCHEDULER_UNKNOWN };

  if (row.status === "never-ran") {
    const primary = continuationOf(row.job);
    if (primary) return { kind: "waiting", word: "No execution recorded", tone: "muted", reason: `Runs only when ${jobLabel(primary)} defers work` };
    return row.totalRuns === 0
      ? { kind: "never-ran", word: "Never ran", tone: "warn", reason: "No run in the ledger, though the scheduler is waking" }
      : { kind: "unknown", word: "No execution recorded", tone: "muted", reason: "No run in the examined window" };
  }
  return row.status === "dead"
    ? { kind: "late", word: "Overdue", tone: "bad", reason: `No run for several ${cadenceWords(row.expectedEveryHours)} cycles` }
    : { kind: "late", word: "Overdue", tone: "warn", reason: `Expected ${cadenceWords(row.expectedEveryHours)}` };
}

/** "every 24 h" / "every 6 h" / "every 7 d". */
export function cadenceWords(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "on demand";
  if (hours >= 48 && hours % 24 === 0) return `every ${hours / 24} d`;
  return `every ${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

// ── Execution days (history series) ────────────────────────────────────────────

export interface DayBar {
  /** YYYY-MM-DD, UTC. */
  day: string;
  succeeded: number;
  failed: number;
  /** Running or any other recorded status. */
  other: number;
  /** False when the source cannot vouch for this day (outside its window, or older than a capped read). */
  observed: boolean;
}

/** The job-execution points of the history response, newest first as the source returns them; null when absent. */
function executionSeries(h: OperationalHistoryResult): readonly OperationalHistoryPoint[] | null {
  return h.series.find((s) => s.sourceId === "jobs" && s.metric === "execution")?.points ?? null;
}

/**
 * The first UTC day the history series fully covers. The series is the NEWEST
 * HISTORY_POINT_CAP rows of the window: when the cap is hit, the oldest returned
 * day is partial and every earlier day is unknown, so coverage starts the day after.
 */
export function historyCoverageFrom(h: OperationalHistoryResult): string | null {
  const pts = executionSeries(h);
  if (!pts) return null;
  if (pts.length < HISTORY_POINT_CAP) return h.window.from;
  const oldest = pts.reduce((m, p) => Math.min(m, Date.parse(p.at)), Infinity);
  if (!Number.isFinite(oldest)) return h.window.from;
  const after = addDays(utcDay(oldest), 1);
  return after > h.window.from ? after : h.window.from;
}

/** `jobName:status` → its parts (job names never contain ':'; a status might). */
function splitLabel(label: string): { job: string; status: string } {
  const i = label.indexOf(":");
  return i < 0 ? { job: label, status: "" } : { job: label.slice(0, i), status: label.slice(i + 1) };
}

/**
 * Executions per UTC day over the `days` days ending today, for `jobs` (default:
 * every registered job — the backstop cron and other external crons are not
 * scheduled jobs). Real points only: a day the series cannot vouch for is a gap
 * (`observed: false`), never a zero.
 */
export function executionDays(
  history: OperationalHistoryResult | null,
  nowMs: number,
  days: number,
  jobs: readonly string[] = SCHEDULED_JOB_NAMES,
): DayBar[] {
  const today = utcDay(nowMs);
  const keys = Array.from({ length: days }, (_, i) => addDays(today, i - (days - 1)));
  const pts = history ? executionSeries(history) : null;
  const from = history ? historyCoverageFrom(history) : null;
  if (!history || !pts || !from) return keys.map((day) => ({ day, succeeded: 0, failed: 0, other: 0, observed: false }));
  const to = history.window.to;
  const want = new Set(jobs);
  const byDay = new Map<string, { succeeded: number; failed: number; other: number }>();
  for (const p of pts) {
    const { job, status } = splitLabel(p.label);
    if (!want.has(job)) continue;
    const d = utcDay(Date.parse(p.at));
    const b = byDay.get(d) ?? { succeeded: 0, failed: 0, other: 0 };
    if (status === "succeeded") b.succeeded++;
    else if (status === "failed") b.failed++;
    else b.other++;
    byDay.set(d, b);
  }
  return keys.map((day) => {
    const observed = day >= from && day <= to;
    const b = observed ? byDay.get(day) : undefined;
    return { day, succeeded: b?.succeeded ?? 0, failed: b?.failed ?? 0, other: b?.other ?? 0, observed };
  });
}

/** One job's recorded runs from the history series, newest first (only inside its coverage). */
export interface JobRunPoint { at: string; status: string; durationMs: number | null }
export function jobRuns(history: OperationalHistoryResult | null, job: string, limit = 10): JobRunPoint[] {
  const pts = history ? executionSeries(history) : null;
  if (!pts) return [];
  return pts
    .map((p) => ({ p, parts: splitLabel(p.label) }))
    .filter(({ parts }) => parts.job === job)
    .sort((a, b) => Date.parse(b.p.at) - Date.parse(a.p.at))
    .slice(0, limit)
    .map(({ p, parts }) => ({ at: p.at, status: parts.status, durationMs: p.value }));
}

// ── Outcome composition (job health) ──────────────────────────────────────────

export interface CompositionItem { id: string; label: string; value: number; color: string }

export const OUTCOME_COLORS = {
  succeeded: "var(--emerald-400)",
  failed: "var(--coral-400)",
  running: "var(--meridian-400)",
  none: "var(--text-faint)",
  other: "var(--accent-warning)",
} as const;

/** The jobs by their LAST recorded outcome. Σ value = the number of jobs reported. Zero slices are dropped. */
export function outcomeComposition(jobs: PlatformJobHealthResponse): CompositionItem[] {
  const c = { succeeded: 0, failed: 0, running: 0, none: 0, other: 0 };
  for (const r of jobs.jobs) {
    if (r.lastRunStatus === null) c.none++;
    else if (r.lastRunStatus === "succeeded") c.succeeded++;
    else if (r.lastRunStatus === "failed") c.failed++;
    else if (r.lastRunStatus === "running") c.running++;
    else c.other++;
  }
  const items: CompositionItem[] = [
    { id: "succeeded", label: "Last run succeeded", value: c.succeeded, color: OUTCOME_COLORS.succeeded },
    { id: "failed", label: "Last run failed", value: c.failed, color: OUTCOME_COLORS.failed },
    { id: "running", label: "Running", value: c.running, color: OUTCOME_COLORS.running },
    { id: "other", label: "Other outcome", value: c.other, color: OUTCOME_COLORS.other },
    { id: "none", label: "No execution recorded", value: c.none, color: OUTCOME_COLORS.none },
  ];
  return items.filter((i) => i.value > 0);
}

// ── Needs attention, grouped by cause ─────────────────────────────────────────

const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, error: 1, warning: 2, info: 3 };
const SEVERITY_TONE: Record<AttentionSeverity, StatusTone> = { critical: "bad", error: "bad", warning: "warn", info: "info" };
const KIND_PLURAL: Record<AttentionEntityKind, string> = {
  connection: "connections", job: "jobs", provider: "providers", resource: "resources",
  "alert-rule": "alert rules", incident: "incidents", customer: "customers",
};

export type AttentionGroupAction =
  /** One job: open its detail in the unified Jobs list. */
  | { kind: "job"; job: string }
  /** Several jobs sharing a cause: the full Jobs list. */
  | { kind: "jobs" }
  /** Everything else: the full attention list (with its resync / reauth actions). */
  | { kind: "attention"; workspace: string };

export interface AttentionGroup {
  key: string;
  severity: AttentionSeverity;
  tone: StatusTone;
  title: string;
  /** One line. */
  line: string;
  /** Items (or jobs) the group stands for. */
  count: number;
  action: AttentionGroupAction;
}

/** The problem's cause, without its particulars ("Overdue — expected every 6 h, …" → "Overdue"). */
function causeLead(problem: string): string {
  return problem.split(/ — |\. |\(/)[0].replace(/\d[\d,.]*/g, "#").trim();
}

/**
 * The attention items, grouped by SHARED CAUSE, in the server's order (a group
 * takes the position of its first item). When the scheduler is not waking on this deployment,
 * every job item that is not a recorded failure — and every job the scheduler has
 * never woken — is ONE group naming that cause, not one row per job.
 */
export function groupAttention(
  attention: AttentionResponse,
  evidence: SchedulerEvidence,
  jobs: PlatformJobHealthResponse | null,
): AttentionGroup[] {
  const groups = new Map<string, AttentionGroup & { order: number }>();
  const failedJobs = new Set((jobs?.jobs ?? []).filter((r) => honestJobStatus(r, evidence).kind === "failed").map((r) => r.job));
  const notObserved = (jobs?.jobs ?? []).filter((r) => honestJobStatus(r, evidence).kind === "not-observed").length;

  attention.items.forEach((it: AttentionItem, order) => {
    const schedulerCause = it.entity.kind === "job" && evidence.state === "inactive" && !failedJobs.has(it.entity.label);
    const key = schedulerCause ? "scheduler-inactive" : `${it.entity.kind}|${it.severity}|${causeLead(it.problem)}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      if (SEVERITY_RANK[it.severity] < SEVERITY_RANK[g.severity]) { g.severity = it.severity; g.tone = SEVERITY_TONE[it.severity]; }
      if (!schedulerCause) {
        g.title = `${n(g.count)} ${KIND_PLURAL[it.entity.kind]}`;
        g.line = causeLead(it.problem).replace(/#/g, "").replace(/\s+/g, " ").trim() || it.problem;
        g.action = it.entity.kind === "job" ? { kind: "jobs" } : g.action;
      }
      return;
    }
    groups.set(key, schedulerCause
      ? { key, order, severity: it.severity, tone: SEVERITY_TONE[it.severity], count: 1,
          title: "Scheduler not active on this deployment", line: "", action: { kind: "jobs" } }
      : { key, order, severity: it.severity, tone: SEVERITY_TONE[it.severity], count: 1,
          title: it.entity.kind === "job" ? jobLabel(it.entity.label) : it.entity.label, line: it.problem,
          action: it.entity.kind === "job" ? { kind: "job", job: it.entity.label } : { kind: "attention", workspace: it.evidence.workspace } });
  });

  const sched = groups.get("scheduler-inactive");
  if (sched) {
    sched.count = Math.max(sched.count, notObserved);
    sched.line = `No scheduled execution observed · ${n(sched.count)} job${sched.count === 1 ? "" : "s"}`;
  }

  // The SERVER's order (attention is already severity-ranked there — the one
  // ordering authority): a group sits where its first item sat. Map insertion
  // order is that order, so nothing is re-sorted here.
  return [...groups.values()].map(({ order: _order, ...g }) => g);
}

/** Total attention items (the server's own counts). */
export function attentionTotal(a: AttentionResponse): number {
  return Object.values(a.counts).reduce<number>((x, y) => x + (y ?? 0), 0);
}

// ── Refresh activity (refresh/daily) ──────────────────────────────────────────

/** The last `days` buckets of the refresh day series. A day the projection omitted (fact cap) is a gap. */
export function refreshDays(series: RefreshDailySeries, nowMs: number, days: number): DayBar[] {
  const by = new Map(series.days.map((d) => [d.day, d] as const));
  const end = series.envelope.window.to && series.envelope.window.to < utcDay(nowMs) ? series.envelope.window.to : utcDay(nowMs);
  const from = series.envelope.window.from;
  return Array.from({ length: days }, (_, i) => addDays(end, i - (days - 1))).map((day) => {
    const d = by.get(day);
    if (!d || day < from) return { day, succeeded: 0, failed: 0, other: 0, observed: false };
    const failed = d.byStatus.FAILED ?? 0;
    const succeeded = d.byStatus.SUCCEEDED ?? 0;
    return { day, succeeded, failed, other: Math.max(0, d.total - failed - succeeded), observed: true };
  });
}

// ── Health hero ───────────────────────────────────────────────────────────────

export interface Kpi {
  key: string;
  label: string;
  /** Formatted figure, or "—" when the source did not answer. */
  value: string;
  /** One short qualifier (window / basis), never a sentence. */
  sub: string;
  tone?: StatusTone;
}

/** Success rate over the last 7 FULLY covered UTC days; null when the series does not cover them. */
export function successRate7d(days7: readonly DayBar[]): number | null {
  if (days7.length < 7 || days7.some((d) => !d.observed)) return null;
  const s = days7.reduce((a, d) => a + d.succeeded, 0);
  const f = days7.reduce((a, d) => a + d.failed, 0);
  return s + f === 0 ? null : s / (s + f);
}

export function healthKpis(args: {
  jobs: Fetched<PlatformJobHealthResponse>;
  scheduler: Fetched<SchedulerObservationResponse>;
  attention: Fetched<AttentionResponse>;
  groups: readonly AttentionGroup[];
  days7: readonly DayBar[];
}): Kpi[] {
  const { jobs, scheduler, attention, groups, days7 } = args;
  const out: Kpi[] = [];
  const j = jobs.data;
  out.push(j
    ? { key: "healthy", label: "Jobs healthy", value: `${j.counts.healthy}/${j.jobs.length}`, sub: "by job health", tone: j.counts.healthy === j.jobs.length ? "ok" : undefined }
    : { key: "healthy", label: "Jobs healthy", value: "—", sub: jobs.loading ? "reading" : "unavailable", tone: "muted" });
  out.push(attention.data
    ? { key: "attention", label: "Needs attention", value: n(groups.length), sub: `${n(attentionTotal(attention.data))} signals`, tone: groups.length > 0 ? "warn" : undefined }
    : { key: "attention", label: "Needs attention", value: "—", sub: attention.loading ? "reading" : "unavailable", tone: "muted" });
  const s = scheduler.data;
  if (s) {
    const runs = registeredExecutions(s);
    out.push({ key: "runs", label: "Executions · 24 h", value: s.observed.recordedExecutions >= SCHEDULER_RUN_CAP ? `≥${n(runs)}` : n(runs), sub: "scheduled jobs" });
  } else out.push({ key: "runs", label: "Executions · 24 h", value: "—", sub: scheduler.loading ? "reading" : "unavailable", tone: "muted" });
  const rate7 = successRate7d(days7);
  if (rate7 !== null) out.push({ key: "success", label: "Success rate", value: `${Math.round(rate7 * 100)}%`, sub: "7 d", tone: rate7 < 0.9 ? "warn" : undefined });
  else if (j) {
    const s2 = j.jobs.reduce((a, r) => a + r.succeededRuns, 0);
    const f2 = j.jobs.reduce((a, r) => a + r.failedRuns, 0);
    out.push(s2 + f2 > 0
      ? { key: "success", label: "Success rate", value: `${Math.round((s2 / (s2 + f2)) * 100)}%`, sub: "recent runs", tone: s2 / (s2 + f2) < 0.9 ? "warn" : undefined }
      : { key: "success", label: "Success rate", value: "—", sub: "no completed runs", tone: "muted" });
  } else out.push({ key: "success", label: "Success rate", value: "—", sub: jobs.loading ? "reading" : "unavailable", tone: "muted" });
  return out;
}

// ── Unified Jobs list ─────────────────────────────────────────────────────────

export interface JobControls {
  /** The dry-run command, when the operations registry has one for this job. */
  dry: OperationCommand | null;
  /** The run command, when registered. */
  run: OperationCommand | null;
  /** Why there is no control at all (automatic-only / not mapped), else null. */
  unavailable: string | null;
}

/** The job's manual commands from the operations response (the authority), worded when absent. */
export function jobControls(job: string, commands: readonly OperationCommand[] | null): JobControls {
  const mine = (commands ?? []).filter((c) => c.targetJob === job);
  const dry = mine.find((c) => !c.mutates) ?? null;
  const run = mine.find((c) => c.mutates) ?? null;
  if (dry || run) return { dry, run, unavailable: null };
  const a = manualAvailability(job);
  return { dry: null, run: null, unavailable: commands === null ? "Manual operations unavailable" : a.kind === "manual" ? "Not offered on this deployment" : a.reason };
}

export interface JobRowModel {
  job: string;
  label: string;
  status: HonestStatus;
  cadence: string;
  lastRunAt: string | null;
  nextExpectedAt: string | null;
  days7: DayBar[];
  controls: JobControls;
  row: PlatformJobRow;
}

/** One row per scheduled job, worst first (then registry order). */
export function jobRows(args: {
  jobs: PlatformJobHealthResponse;
  evidence: SchedulerEvidence;
  history: OperationalHistoryResult | null;
  commands: readonly OperationCommand[] | null;
  nowMs: number;
}): JobRowModel[] {
  const order = new Map(SCHEDULED_JOB_NAMES.map((name, i) => [name, i] as const));
  return args.jobs.jobs
    .map((row) => ({
      job: row.job,
      label: jobLabel(row.job),
      status: honestJobStatus(row, args.evidence),
      cadence: cadenceWords(row.expectedEveryHours),
      lastRunAt: row.lastStartedAt,
      nextExpectedAt: row.nextExpectedAt,
      days7: executionDays(args.history, args.nowMs, 7, [row.job]),
      controls: jobControls(row.job, args.commands),
      row,
    }))
    .sort((a, b) => KIND_RANK[a.status.kind] - KIND_RANK[b.status.kind] || (order.get(a.job) ?? 99) - (order.get(b.job) ?? 99));
}
