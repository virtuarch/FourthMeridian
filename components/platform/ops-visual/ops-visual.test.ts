/**
 * components/platform/ops-visual/ops-visual.test.ts  (Platform Ops visual spec §2–§4)
 *
 * The redesigned Operations workspace, pinned:
 *   1. the job catalog matches the operations registry (labels, availability)
 *      and the restated constants match their server sources;
 *   2. scheduler evidence + honest job status (never "dead" / "never ran"
 *      without evidence of a wake; a recorded failure is always Failed);
 *   3. attention grouped by shared cause;
 *   4. execution / refresh day series keep gaps (real points only), the
 *      outcome composition sums to the jobs, the KPIs read the right figures;
 *   5. MANUAL-ACTION REACHABILITY — every OPERATION_TARGETS command id renders
 *      a reachable control on the unified Jobs rows / detail;
 *   6. fleet-run gating (Control access), reason + confirmation, request body;
 *   7. the default screen: ≤ 3–5 items per section, no paragraphs, one caption
 *      per card, nothing hosted mounted until a drawer opens.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/ops-visual/ops-visual.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { BACKSTOP_CRON_JOB as SERVER_BACKSTOP } from "@/lib/jobs/scheduler-signals";
import { EXCLUDED_TARGETS, OPERATION_TARGETS, listOperationCommands } from "@/lib/platform/operations/registry";
import type { PlatformJobRow } from "@/app/api/platform/platform-ops/job-health/route";
import { JOB_LABELS, JOB_MANUAL, NOT_AVAILABLE_FOR_MANUAL_RUN, SCHEDULED_JOB_NAMES } from "./job-catalog";
import {
  BACKSTOP_CRON_JOB,
  HISTORY_POINT_CAP,
  SCHEDULER_INACTIVE,
  SCHEDULER_RUN_CAP,
  SCHEDULER_UNKNOWN,
  executionDays,
  groupAttention,
  healthKpis,
  honestJobStatus,
  jobRows,
  outcomeComposition,
  refreshDays,
  schedulerEvidence,
  successRate7d,
  utcDay,
} from "./ops-visual-model";
import { JobDetail, NEEDS_CONTROL_LINE, READ_ONLY_LINE, UnifiedJobsSurface, controlPlan, feedbackFor, isFleetRun, operationBody } from "./UnifiedJobs";
import { OperationsLead, OperationsLeadSurface, ATTENTION_ROWS, RECENT_ROWS } from "../leads/OperationsLead";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const ok = <T,>(data: T) => ({ data, loading: false, error: null });
const failed = (error: string) => ({ data: null, loading: false, error });
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const AGO_H = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

// ── Fixtures ─────────────────────────────────────────────────────────────────

function job(name: string, over: Partial<PlatformJobRow> = {}): PlatformJobRow {
  return {
    job: name, status: "never-ran", expectedEveryHours: 24, source: null, lastStartedAt: null, lastRunStatus: null, lastCompletedAt: null,
    consecutiveFailures: 0, nextExpectedAt: null, lastRuntimeMs: null, avgRuntimeMs: null, successRate: null, totalRuns: 0,
    succeededRuns: 0, failedRuns: 0, manualRuns: 0, lastFailureAt: null, lastFailureSummary: null, ...over,
  };
}
/** The Preview shape (spec §2): 12 never-ran, evaluate-alerts dead since 10-07, sol-history-backfill dead (manual 10-28). */
const previewJobs = {
  healthy: false, checkedAt: AGO_H(0),
  counts: { healthy: 0, running: 0, overdue: 0, failing: 0, dead: 2, neverRan: 12 },
  jobs: SCHEDULED_JOB_NAMES.map((name) =>
    name === "evaluate-alerts" ? job(name, { status: "dead", expectedEveryHours: 6, lastStartedAt: "2026-10-07T07:30:00.000Z", lastRunStatus: "succeeded", totalRuns: 3, succeededRuns: 3 })
    : name === "sol-history-backfill" ? job(name, { status: "dead", expectedEveryHours: 1, lastStartedAt: "2026-10-28T09:00:00.000Z", lastRunStatus: "succeeded", totalRuns: 1, succeededRuns: 1, manualRuns: 1 })
    : job(name, { expectedEveryHours: name === "sync-crypto" ? 6 : 24 })),
};
const scheduler = (external: { job: string; recordedExecutions: number }[], recorded: number) => ({
  observed: { lastRecordedExecutionAt: AGO_H(2), recordedExecutions: recorded, overdue: [], externalCrons: external.map((e) => ({ ...e, lastRecordedExecutionAt: AGO_H(0.1), registered: false as const })) },
  expected: { nextSlotAt: null, jobsInNextSlot: [], registeredJobs: 14 }, notes: [], window: { from: AGO_H(24), to: AGO_H(0) }, checkedAt: AGO_H(0),
});
const previewScheduler = scheduler([], 1);
const prodScheduler = scheduler([{ job: BACKSTOP_CRON_JOB, recordedExecutions: 288 }], 288 + 96);

/** A production-like job-health response: all healthy, one failing, one overdue, one never-ran continuation. */
const prodJobs = {
  healthy: false, checkedAt: AGO_H(0), counts: { healthy: 11, running: 0, overdue: 1, failing: 1, dead: 0, neverRan: 1 },
  jobs: SCHEDULED_JOB_NAMES.map((name) =>
    name === "sync-banks" ? job(name, { status: "failing", lastRunStatus: "failed", consecutiveFailures: 3, lastStartedAt: AGO_H(3), totalRuns: 50, succeededRuns: 40, failedRuns: 10, lastFailureAt: AGO_H(3), lastFailureSummary: "Plaid 500" })
    : name === "purge-trash" ? job(name, { status: "overdue", lastRunStatus: "succeeded", lastStartedAt: AGO_H(27), totalRuns: 20, succeededRuns: 20 })
    : name === "sync-crypto-continuation" ? job(name)
    : job(name, { status: "healthy", expectedEveryHours: name === "sync-crypto" ? 6 : 24, lastRunStatus: "succeeded", lastStartedAt: AGO_H(2), nextExpectedAt: AGO_H(-4), totalRuns: 50, succeededRuns: 50 })),
};

const evInactive = schedulerEvidence(ok(previewJobs), ok(previewScheduler));
const evActive = schedulerEvidence(ok(prodJobs), ok(prodScheduler));

// ── 1. Catalog ↔ registry ────────────────────────────────────────────────────

console.log("1. Job catalog matches the registries");
{
  const registered = SCHEDULED_JOBS.map((j) => j.name).sort();
  check("a human label for every scheduled job (14), and no extra", Object.keys(JOB_LABELS).sort().join() === registered.join() && registered.length === 14);
  check("labels are human words, never the raw ledger id", Object.entries(JOB_LABELS).every(([id, label]) => label !== id && !/^[a-z0-9-]+$/.test(label)));
  const targets = new Set(OPERATION_TARGETS.map((t) => t.targetJob));
  check("JOB_MANUAL 'manual' ⇔ OPERATION_TARGETS", Object.entries(JOB_MANUAL).every(([j, a]) => (a.kind === "manual") === targets.has(j)));
  check("JOB_MANUAL 'automatic' ⇔ EXCLUDED_TARGETS (a recorded reason)", Object.entries(JOB_MANUAL).every(([j, a]) => (a.kind === "automatic") === (j in EXCLUDED_TARGETS)));
  check("process-deletions reads 'Automatic only — destructive'", JOB_MANUAL["process-deletions"].kind === "automatic" && (JOB_MANUAL["process-deletions"] as { reason: string }).reason === "Automatic only — destructive");
  check("unmapped jobs (no handler, no recorded reason) read 'Not available for manual run'",
    ["plaid-removal-retry", "product-event-retention", "sync-crypto-continuation"].every((j) => (JOB_MANUAL as Record<string, { kind: string; reason?: string }>)[j].reason === NOT_AVAILABLE_FOR_MANUAL_RUN));
  check("BACKSTOP_CRON_JOB equals the server's", BACKSTOP_CRON_JOB === SERVER_BACKSTOP);
  check("SCHEDULER_RUN_CAP equals observation.ts MAX_RUNS", new RegExp(`const MAX_RUNS = ${SCHEDULER_RUN_CAP.toLocaleString("en-US").replace(",", "_")};`).test(code("lib/platform/scheduler/observation.ts")));
  check("HISTORY_POINT_CAP equals history sources MAX_POINTS", new RegExp(`const MAX_POINTS = ${HISTORY_POINT_CAP};`).test(code("lib/platform/history/sources.ts")));
  check("the backstop cron is still a vercel.json cron (its rows are the evidence)", /"\/api\/jobs\/resume-stale-imports"/.test(code("vercel.json")));
  check("…and still writes a ledger row on every fire", /runJob\("resume-stale-imports"/.test(code("app/api/jobs/resume-stale-imports/route.ts")));
  check("the dispatcher still treats a never-run job as due on every wake (the inactive inference)", /if \(!fact\?\.lastStartedAt\) return \{ due: true, reason: "NEVER_RAN"/.test(code("lib/jobs/cadence-policy.core.ts")));
}

// ── 2. Scheduler evidence + honest status ────────────────────────────────────

console.log("2. Scheduler evidence and honest job status");
{
  check("Preview shape (no backstop rows, 12 never-run primaries) ⇒ inactive", evInactive.state === "inactive" && evInactive.headline === SCHEDULER_INACTIVE);
  check("backstop rows in the window ⇒ active", evActive.state === "active");
  check("a source that did not answer ⇒ unknown", schedulerEvidence(failed("500"), ok(previewScheduler)).state === "unknown");
  const ranNoBackstop = { ...prodJobs, jobs: prodJobs.jobs.filter((r) => r.totalRuns > 0) };
  check("no backstop rows but registered jobs executed and none never-ran ⇒ unknown (insufficient evidence)",
    schedulerEvidence(ok(ranNoBackstop), ok(scheduler([], 40))).state === "unknown" && schedulerEvidence(ok(ranNoBackstop), ok(scheduler([], 40))).headline === SCHEDULER_UNKNOWN);
  check("no backstop rows and NO registered execution in 24 h while a 6 h job was due ⇒ inactive",
    schedulerEvidence(ok(ranNoBackstop), ok(scheduler([], 0))).state === "inactive");

  const words = previewJobs.jobs.map((r) => honestJobStatus(r, evInactive));
  check("inactive scheduler: no job is called dead / never ran / overdue", words.every((w) => !/dead|never ran|overdue/i.test(`${w.word} ${w.reason}`.replace(SCHEDULER_INACTIVE, ""))));
  check("inactive scheduler: never-ran + dead jobs read 'Not observed' with the deployment cause", words.every((w) => w.kind === "not-observed" && w.reason === SCHEDULER_INACTIVE));
  check("a recorded failure stays Failed even when the scheduler is inactive",
    honestJobStatus(job("fetch-fx-rates", { status: "dead", lastRunStatus: "failed", totalRuns: 1, failedRuns: 1 }), evInactive).word === "Failed");
  check("unknown evidence ⇒ 'Unknown' (Scheduler state unknown), never Never ran",
    honestJobStatus(job("fetch-fx-rates"), { state: "unknown", headline: SCHEDULER_UNKNOWN, basis: "" }).reason === SCHEDULER_UNKNOWN);
  check("active scheduler + zero runs over full history ⇒ 'Never ran'", honestJobStatus(job("fetch-fx-rates"), evActive).word === "Never ran");
  check("active scheduler + a continuation with no runs ⇒ 'No execution recorded' (runs only on deferral)",
    honestJobStatus(job("sync-crypto-continuation"), evActive).word === "No execution recorded" && /Wallet sync defers work/.test(honestJobStatus(job("sync-crypto-continuation"), evActive).reason));
  check("active scheduler: dead ⇒ 'Overdue' (bad), never the word dead", (() => { const s = honestJobStatus(job("x", { status: "dead", totalRuns: 4, lastRunStatus: "succeeded" }), evActive); return s.word === "Overdue" && s.tone === "bad" && !/dead/i.test(s.reason); })());
  check("failing ⇒ 'Failing' with the streak", honestJobStatus(prodJobs.jobs[0], evActive).word === "Failing" && /3 runs failed/.test(honestJobStatus(prodJobs.jobs[0], evActive).reason));
}

// ── 3. Attention grouped by cause ─────────────────────────────────────────────

console.log("3. Needs attention, grouped by shared cause");
const attItem = (id: string, kind: string, label: string, severity: string, problem: string) => ({
  id, severity, entity: { kind, label }, problem, since: AGO_H(5),
  evidence: { kind: kind === "job" ? "job" : "connection", workspace: kind === "job" ? "platform-jobs" : "platform-providers" },
  actions: kind === "job" ? [{ kind: "run-now", job: label }] : [{ kind: "resync", connectionId: id, source: "PLAID" }], basis: "b",
});
const previewAttention = {
  checkedAt: AGO_H(0),
  items: [
    attItem("job:evaluate-alerts", "job", "evaluate-alerts", "critical", "Dead — no run recorded for several times its 6 h cadence (last started 23d ago)."),
    attItem("job:sol-history-backfill", "job", "sol-history-backfill", "critical", "Dead — no run recorded for several times its 1 h cadence (last started 2d ago)."),
    attItem("c4", "connection", "Schwab", "error", "Needs reauthorization — the customer must reconnect."),
    attItem("c1", "connection", "Chase", "warning", "Stale — last success 3 days ago."),
    attItem("c2", "connection", "Amex", "warning", "Stale — last success 4 days ago."),
    attItem("c3", "connection", "Citi", "warning", "Stale — last success 5 days ago."),
  ],
  counts: { critical: 2, error: 1, warning: 3, info: 0 }, authoritiesChecked: { count: 7, names: [] }, authoritiesFailed: [], floors: [],
  recentFirings: { runs: 0, newestEvaluatedAt: null, oldestEvaluatedAt: null, count: 0, items: [] }, userImpact: {},
} as never;
{
  const g = groupAttention(previewAttention, evInactive, previewJobs);
  check("the two dead jobs fold into ONE scheduler group naming the cause", g.filter((x) => x.key === "scheduler-inactive").length === 1 && g[0].title === "Scheduler not active on this deployment");
  check("…counting every job the scheduler has not woken (14), not one row per job", g[0].count === 14 && /No scheduled execution observed · 14 jobs/.test(g[0].line), `${g[0].count} ${g[0].line}`);
  check("three stale connections are ONE group ('3 connections · Stale')", g.some((x) => x.title === "3 connections" && x.line === "Stale" && x.count === 3));
  check("a lone reauth connection stays its own row", g.some((x) => x.title === "Schwab" && x.count === 1));
  check("groups keep the server's (severity-ranked) order — no second ordering authority", g.map((x) => x.severity).join() === "critical,error,warning");
  const gActive = groupAttention(previewAttention, evActive, prodJobs);
  check("with an ACTIVE scheduler, job items are NOT folded into a scheduler group", !gActive.some((x) => x.key === "scheduler-inactive") && gActive.some((x) => x.title === "2 jobs" && x.action.kind === "jobs"));
}

// ── 4. Series + composition + KPIs ───────────────────────────────────────────

console.log("4. Day series, composition and KPIs");
{
  const pt = (at: string, label: string) => ({ at, tier: "observed", label, value: 1200 });
  const hist = (points: ReturnType<typeof pt>[], from = "2026-09-30") => ({
    asOf: "2026-10-30", compareTo: null, window: { from, to: "2026-10-30" }, states: [], compareStates: null, completeness: { tier: "observed", reason: "" }, checkedAt: AGO_H(0),
    series: [{ sourceId: "jobs", label: "Executions", metric: "execution", unit: "count", points, trust: "observed", coverageFrom: from }],
  }) as never;
  const small = hist([
    pt("2026-10-30T06:00:00.000Z", "sync-banks:succeeded"), pt("2026-10-30T06:30:00.000Z", "fetch-fx-rates:failed"),
    pt("2026-10-29T06:00:00.000Z", "sync-banks:succeeded"), pt("2026-10-29T06:05:00.000Z", "resume-stale-imports:succeeded"),
  ], "2026-10-25");
  const d = executionDays(small, NOW, 14);
  check("14 UTC days ending today", d.length === 14 && d[13].day === "2026-10-30" && d[0].day === "2026-10-17");
  check("days before the history window are gaps (observed:false), never zeros", d.filter((x) => !x.observed).map((x) => x.day).join() === ["17", "18", "19", "20", "21", "22", "23", "24"].map((x) => `2026-10-${x}`).join());
  check("an observed day with no runs is a real zero", d.find((x) => x.day === "2026-10-26")!.observed && d.find((x) => x.day === "2026-10-26")!.succeeded === 0);
  check("counts split succeeded / failed; the backstop cron is not a scheduled job", d[13].succeeded === 1 && d[13].failed === 1 && d[12].succeeded === 1 && d[12].other === 0);
  // A capped read: the oldest returned day is partial ⇒ a gap.
  const many = Array.from({ length: HISTORY_POINT_CAP }, (_, i) => pt(new Date(NOW - i * 4 * 60_000).toISOString(), "evaluate-alerts:succeeded"));
  const capped = executionDays(hist(many), NOW, 3);
  const oldestDay = utcDay(NOW - (HISTORY_POINT_CAP - 1) * 4 * 60_000);
  check("a capped (500-point) series: the oldest, partial day is a gap", capped.find((x) => x.day === oldestDay)?.observed === false && capped[2].observed, JSON.stringify(capped.map((x) => [x.day, x.observed])));
  check("no history ⇒ every day a gap (no fake series)", executionDays(null, NOW, 7).every((x) => !x.observed));
  check("7-day success rate only when all 7 days are covered", successRate7d(d.slice(-7)) === null && successRate7d(executionDays(small, NOW, 5)) === null);

  const comp = outcomeComposition(prodJobs);
  check("outcome composition sums to the jobs reported", comp.reduce((a, c) => a + c.value, 0) === prodJobs.jobs.length);
  check("…succeeded / failed / no execution recorded, zero slices dropped", comp.map((c) => `${c.id}=${c.value}`).join() === "succeeded=12,failed=1,none=1");
  check("Preview composition: 12 with no execution recorded", outcomeComposition(previewJobs).find((c) => c.id === "none")?.value === 12);

  const daily = {
    envelope: { window: { from: "2026-10-20", to: "2026-10-30" } }, windowDays: 11, maxWindowDays: 90, executions: 30, floor: false, notes: [], tier: "observed",
    days: [{ day: "2026-10-29", total: 10, byStatus: { SUCCEEDED: 7, PARTIAL: 1, FAILED: 2, SKIPPED: 0, RUNNING: 0 }, bySourceKind: {}, admissionDenied: 0, settled: true }],
  } as never;
  const r = refreshDays(daily, NOW, 14);
  check("refresh days: a day outside the window or omitted by the cap is a gap", !r[0].observed && !r.find((x) => x.day === "2026-10-28")!.observed);
  check("refresh days: failed and other (partial) kept apart", (() => { const x = r.find((y) => y.day === "2026-10-29")!; return x.succeeded === 7 && x.failed === 2 && x.other === 1; })());

  const k = healthKpis({ jobs: ok(prodJobs), scheduler: ok(prodScheduler), attention: ok(previewAttention), groups: groupAttention(previewAttention, evActive, prodJobs), days7: executionDays(null, NOW, 7) });
  check("KPI: jobs healthy x/total from job health", k[0].value === "11/14");
  check("KPI: executions 24 h exclude the backstop / external crons", k[2].value === "96");
  check("KPI: success rate falls back to recent runs when 7 days are not covered (labelled so)", k[3].sub === "recent runs");
  const kDown = healthKpis({ jobs: failed("500"), scheduler: failed("500"), attention: failed("500"), groups: [], days7: [] });
  check("KPIs: an unread source is '—', never 0", kDown.every((x) => x.value === "—"));
}

// ── 5. Manual-action reachability ────────────────────────────────────────────

console.log("5. Every manual operation is reachable from the unified Jobs rows / detail");
const commands = listOperationCommands();
const operations = ok({ kinds: [], commands, recent: [] }) as never;
const emptyHistory = ok({ asOf: "2026-10-30", compareTo: null, window: { from: "2026-09-30", to: "2026-10-30" }, states: [], compareStates: null, series: [], completeness: { tier: "observed", reason: "" }, checkedAt: AGO_H(0) }) as never;
const surface = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(UnifiedJobsSurface, {
  mode: "full", jobs: ok(prodJobs), scheduler: ok(prodScheduler), history: emptyHistory, operations, access: { canRead: true, canWrite: true, canControl: true, level: "READ" },
  nowMs: NOW, selected: null, onSelect: () => {}, acting: null, feedback: null, onDry: () => {}, onRun: () => {}, ...over,
} as never));
{
  const html = surface();
  check("one row per scheduled job (14), no second list", (html.match(/data-job-row="/g) ?? []).length === 14 && (html.match(/aria-label="Scheduled jobs"/g) ?? []).length === 1);
  for (const c of commands) {
    const control = c.mutates ? `aria-label="Run ${c.targetLabel} now"` : `aria-label="Dry run ${c.targetLabel}"`;
    check(`${c.id} → a reachable control on its job's row`, html.includes(control) && new RegExp(`data-job-row="${c.targetJob}"[\\s\\S]*?${control.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(html));
  }
  check("every OPERATION_TARGETS command id is covered (no target without a command)", OPERATION_TARGETS.every((t) => t.kinds.every((k) => commands.some((c) => c.id === `${k}:${t.targetJob}`))));
  const rowHtml = (j: string) => html.slice(html.indexOf(`data-job-row="${j}"`), html.indexOf("</li>", html.indexOf(`data-job-row="${j}"`)));
  check("an excluded job shows its recorded reason, no control", /Automatic only — destructive/.test(rowHtml("process-deletions")) && !/Run |Dry run/.test(rowHtml("process-deletions")));
  check("an unmapped job reads 'Not available for manual run'", /Not available for manual run/.test(rowHtml("plaid-removal-retry")) && !/aria-label="Run /.test(rowHtml("plaid-removal-retry")));
  check("rows carry human names; the raw ledger id is not printed on the list", />Bank sync</.test(html) && !/>sync-banks</.test(html));
  check("next execution is labelled 'expected'", /expected<\/span>/.test(html));
  check("the full list has a search", /aria-label="Search jobs"/.test(html));

  // The ONE focused detail: status, schedule, executions chart + table, failures, controls; Technical collapsed.
  const rows = jobRows({ jobs: prodJobs, evidence: evActive, history: null, commands, nowMs: NOW });
  const banks = rows.find((r) => r.job === "sync-banks")!;
  const d = renderToStaticMarkup(createElement(JobDetail, {
    r: banks, nowMs: NOW, history: null, evidence: evActive, plan: controlPlan(banks, { canWrite: true, canControl: true }),
    busy: false, feedback: null, onDry: () => {}, onRun: () => {},
  }));
  const dt = text(d);
  check("detail: status + schedule (cadence, last run, next expected, success)", /Failing/.test(dt) && /Cadence/.test(dt) && /Next/.test(dt) && /expected/.test(dt) && /Success 80%/.test(dt));
  check("detail: execution history chart + an honest empty table", /data-day-bars/.test(d) && /Executions · 14 d/.test(dt) && /No run recorded in the history window/.test(dt));
  check("detail: the last failure in one line", /Last failure/.test(dt) && /Plaid 500/.test(dt));
  check("detail: the same Dry run / Run now controls as the row", d.includes(`aria-label="Dry run Bank Connections"`) && d.includes(`aria-label="Run Bank Connections now"`));
  check("detail: Technical is a collapsed disclosure — the ledger id and command notes are not on screen until opened",
    /aria-expanded="false"[^>]*>[\s\S]*?Technical/.test(d) && !/>sync-banks</.test(d) && !/per-item sync lock/.test(d));
  check("worst first: the failing job leads the list", rows[0].job === "sync-banks" && rows[1].job === "purge-trash");
}

// ── 6. Fleet gating, reason, confirmation ────────────────────────────────────

console.log("6. Fleet runs: Control access + reason + confirmation");
{
  const fleetTargets = OPERATION_TARGETS.filter((t) => t.fleet).map((t) => t.targetJob).sort();
  check("the fleet targets are sync-banks, sync-crypto, sol-history-backfill", fleetTargets.join() === "sol-history-backfill,sync-banks,sync-crypto");
  check("isFleetRun ⇔ the registry's CONTROL requirement on a mutating command", commands.every((c) => isFleetRun(c) === (c.mutates && c.requires.level !== "WRITE")));
  const write = surface({ access: { canRead: true, canWrite: true, canControl: false, level: "WRITE" } });
  for (const t of OPERATION_TARGETS) {
    const runLabel = `aria-label="Run ${t.label} now"`;
    const dryLabel = `aria-label="Dry run ${t.label}"`;
    if (t.fleet) check(`WRITE-only: ${t.targetJob} offers Dry run, NOT Run, and says it needs Control access`, write.includes(dryLabel) && !write.includes(runLabel));
    else check(`WRITE-only: ${t.targetJob} (single scope) offers Dry run and Run now`, write.includes(dryLabel) && write.includes(runLabel));
  }
  check("…the Control line appears once per fleet job", (write.match(new RegExp(NEEDS_CONTROL_LINE, "g")) ?? []).length === fleetTargets.length);
  const read = surface({ access: { canRead: true, canWrite: false, canControl: false, level: "READ" } });
  check("READ: no Run / Dry run anywhere, the read-only line instead", !/aria-label="(Run|Dry run) /.test(read) && read.includes(READ_ONLY_LINE));
  check("absent access fails safe to read-only", !/aria-label="(Run|Dry run) /.test(surface({ access: undefined })));

  const fleetRun = commands.find((c) => c.id === "run-now:sync-banks")!;
  const fxRun = commands.find((c) => c.id === "run-now:fetch-fx-rates")!;
  const fxDry = commands.find((c) => c.id === "dry-run:fetch-fx-rates")!;
  check("controlPlan: a fleet run without Control access is replaced by the line", (() => { const p = controlPlan({ controls: { dry: null, run: fleetRun, unavailable: null } }, { canWrite: true, canControl: false }); return p.run === null && p.note === NEEDS_CONTROL_LINE; })());
  check("request body: a fleet run carries the structured reason", JSON.stringify(operationBody(fleetRun, { code: "INCIDENT", note: " stuck items " })) === JSON.stringify({ commandId: "run-now:sync-banks", reason: { code: "INCIDENT", note: "stuck items" } }));
  check("request body: no reason chosen ⇒ none sent (the route then refuses 400)", JSON.stringify(operationBody(fleetRun, { code: "", note: "" })) === JSON.stringify({ commandId: "run-now:sync-banks" }));
  check("request body: single-scope run and dry run never carry a reason", JSON.stringify(operationBody(fxRun, { code: "INCIDENT", note: "" })) === `{"commandId":"run-now:fetch-fx-rates"}` && JSON.stringify(operationBody(fxDry, null)) === `{"commandId":"dry-run:fetch-fx-rates"}`);
  const src = code("components/platform/ops-visual/UnifiedJobs.tsx");
  check("every Run opens the confirmation (never fires directly); a dry run fires at once",
    /const onRun = \(c: OperationCommand\) => \{ setReason\(EMPTY_OPERATOR_REASON\); setConfirming\(c\); \};/.test(src) && /const onDry = \(c: OperationCommand\) => \{ void invoke\(c, null\); \};/.test(src));
  check("the confirmation requires the reason for a fleet run", /confirmDisabled=\{confirming\.requires\.reason && reasonPayload\(reason\) === null\}/.test(src) && /<OperatorReasonField /.test(src));
  check("execution goes through the existing operations route (POST, same body)", /fetch\(OPERATIONS_URL, \{\s*method: "POST"/.test(src) && /OPERATIONS_URL = "\/api\/platform\/platform-ops\/operations"/.test(src));
  check("feedback: 409 ⇒ in progress; failed outcome ⇒ bad", feedbackFor(409, {}).tone === "warn" && feedbackFor(200, { outcome: "failed", error: "x" }).tone === "bad" && feedbackFor(200, { outcome: "planned" }).text.startsWith("Dry run"));
  check("no literal CONTROL in the ops-visual .tsx files (ratchet)", ["UnifiedJobs.tsx", "HealthHero.tsx", "DayBars.tsx", "OpsJobsWidget.tsx"].every((f) => !/\bCONTROL\b/.test(code(`components/platform/ops-visual/${f}`))));
}

// ── 7. Default screen ────────────────────────────────────────────────────────

console.log("7. The default Operations screen");
const overviewData = {
  checkedAt: "2026-10-30T05:31:00.000Z", worst: "FAILED", domains: [], policies: {}, windows: { pipeline: "", ai: "", brief: "" }, latestFailures: [], nextSlotAt: null, posture: [],
} as never;
const execRow = (i: number) => ({ id: `x${i}`, runId: `r${i}`, plaidItemId: `item_${i}abcdef`, sourceKind: "PLAID_ITEM", sourceRef: null, network: null, trigger: "CRON", profile: "p", startedAt: AGO_H(i), completedAt: AGO_H(i), durationMs: 4200, overallStatus: "SUCCEEDED", parentJobRunId: null, hasError: false, deploymentSha: null, errorSummary: null, admissionReason: null, failureStage: null, failureCategory: null, outcome: null });
const HOSTED = new Set(["ops_overview", "ops_platform_health", "ops_convergence", "ops_timeline", "ops_job_health"]);
const dash = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(OperationsLeadSurface, {
  overview: ok(overviewData), attention: ok(previewAttention), jobs: ok(previewJobs), scheduler: ok(previewScheduler), history: emptyHistory,
  daily: ok({ envelope: { window: { from: "2026-10-17", to: "2026-10-30" } }, days: [], windowDays: 14, maxWindowDays: 90, executions: 0, floor: false, notes: [], tier: "observed" }),
  executions: ok({ rows: Array.from({ length: 5 }, (_, i) => execRow(i + 1)), nextCursor: null, audience: "operator", scopeDenied: false }),
  nowMs: NOW, hasHosted: (k: string) => HOSTED.has(k), jobsSlot: createElement("div", { "data-jobs-slot": "" }),
  onOpenDrawer: () => {}, onOpenWorkspace: () => {}, onSelectExecution: () => {}, onSelectJob: () => {}, ...over,
} as never));
{
  const html = dash();
  const t = text(html);
  check("hero: verdict word + checked time + the four KPIs", /Failed/.test(t) && /Checked 05:31 UTC/.test(t) && ["Jobs healthy", "Needs attention", "Executions · 24 h", "Success rate"].every((w) => t.includes(w)));
  check("hero (Preview): 0/14 healthy, the scheduler cause in the caption", /0\/14/.test(t) && /scheduler not active on this deployment/i.test(t));
  check("hero reuses the Personal CompactHeroCard + CompactKpiStrip (2×2)", /data-compact-hero/.test(html) && (html.match(/data-compact-kpi-strip/g) ?? []).length === 2);
  check("charts: execution trend (DayBars) + outcome donut (BreakdownWidget) + refresh bars", (html.match(/data-day-bars/g) ?? []).length === 2 && /<svg width="180" height="180"/.test(html));
  check("composition donut + refresh activity are desktop-only (one chart card on mobile)",
    /id="ops-composition" class="[^"]*max-lg:hidden/.test(html) && /id="ops-refresh" class="[^"]*max-lg:hidden/.test(html) && !/id="ops-trend" class="[^"]*max-lg:hidden/.test(html));
  const attn = /<ul aria-label="Needs attention"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
  check(`needs attention: ≤ ${ATTENTION_ROWS} grouped rows, scheduler cause first`, (attn.match(/<li/g) ?? []).length === ATTENTION_ROWS && /Scheduler not active on this deployment/.test(attn));
  check("'View all (6)' opens the full attention list", /View all \(6\)/.test(t));
  const recent = /<ul aria-label="Recent activity"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
  check(`recent activity: ${RECENT_ROWS} rows of 5 returned`, (recent.match(/<li/g) ?? []).length === RECENT_ROWS);
  check("the unified jobs card renders in the Jobs block with 'See all 14'", /data-jobs-slot/.test(html) && /See all 14/.test(t));
  check("no paragraph on the default screen: every text line ≤ 90 characters", (html.match(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g) ?? []).every((p) => text(p).length <= 90),
    (html.match(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g) ?? []).map(text).filter((x) => x.length > 90).join(" | "));
  check("at most one caption per chart card", (html.match(/class="mt-3 truncate text-\[11px\]/g) ?? []).length <= 2);
  check("no 'dead' / 'never ran' word on the Preview dashboard", !/\bdead\b|never ran/i.test(t.replace(/Dead — no run recorded[^.]*\./g, "")));
  check("no run control on the dashboard surface itself (it lives on job rows)", !/aria-label="Run .* now"/.test(html));
  check("without the hosted jobs row, the Jobs card is not rendered", !/data-jobs-slot/.test(dash({ hasHosted: (k: string) => k !== "ops_job_health" })));
  check("without ops_overview hosted, 'View all' and the status-board doorway disappear",
    (() => { const h = text(dash({ hasHosted: (k: string) => k !== "ops_overview" })); return !/View all/.test(h) && !/Status board/.test(h); })());
  const down = text(dash({ overview: failed("Request failed (500)"), jobs: failed("Request failed (500)"), scheduler: failed("x"), history: failed("x") }));
  check("unread sources: Unknown verdict, '—' KPIs, an honest unavailable line — never Healthy", /Unknown/.test(down) && !/Healthy/.test(down) && /Execution history unavailable/.test(down));

  const calls: string[] = [];
  renderToStaticMarkup(createElement(OperationsLead, { renderHosted: (k: string) => { calls.push(k); return null; }, hasHosted: () => true, onOpenWorkspace: () => {} } as never));
  check("the lead mounts NO hosted widget on the default screen (drawers closed)", calls.length === 0, calls.join());
  const lead = code("components/platform/leads/OperationsLead.tsx");
  check("the lead reuses Personal components (Block/Surface, BreakdownWidget) and adds no raw fetch", /from "@\/components\/atlas\/Surface"/.test(lead) && /from "@\/components\/space\/widgets\/BreakdownWidget"/.test(lead) && !/\bfetch\(/.test(lead));
}

if (failures > 0) {
  console.error(`\nops-visual: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nops-visual: all checks passed.");
