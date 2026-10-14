/**
 * components/platform/widgets/overview-refresh-jobs.test.ts  (UX-P1 · Agent 4)
 *
 * RENDER-PATH proof for the Overview's Refresh activity and Scheduled jobs
 * blocks (house pattern: standalone tsx + renderToStaticMarkup, DB-free):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/overview-refresh-jobs.test.ts
 *
 * The self-fetching blocks render their FIRST FRAME (server rendering runs no
 * effect), which proves loading is loading; the prop-driven surfaces take fixed
 * data and a fixed clock, which is how error, unobserved and populated states
 * become reachable without a network.
 *
 * Pinned:
 *   1. loading ≠ error ≠ unobserved ≠ zero — four distinct renders, never a
 *      zero on a failed fetch, never "Healthy" on a failure;
 *   2. every strip and bar is word + count (no colour-only segment);
 *   3. a job that never ran is its own word, due "at the next wake", and never
 *      renders a fabricated time;
 *   4. the doorways render NOTHING when the rail is unwired, and open exactly
 *      the workspace ids the blocks declare;
 *   5. no hex colour in either block; the pure view-models read no clock;
 *   6. the view-models' words are the authorities' own (no re-classification).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformJobHealthResponse, PlatformJobRow } from "@/app/api/platform/platform-ops/job-health/route";
import type { RefreshDailySeries, RefreshSummary } from "@/lib/platform/refresh/types";
import { getPlatformWorkspace } from "@/lib/platform/workspaces";
import { JOBS_MATRIX_DOORWAY, JobsMatrixBlock, JobsMatrixSurface } from "./overview/JobsMatrixBlock";
import { REFRESH_ACTIVITY_DOORWAY, RefreshActivityBlock, RefreshActivitySurface } from "./overview/RefreshActivityBlock";
import {
  executionPoints,
  failurePoints,
  refusalNote,
  statusSegments,
  statusTone,
  triggerSegments,
  windowDays,
} from "./refresh-activity-view";
import { NEVER_RAN_WORD, NEXT_WAKE_WORD, nextDueCell, summaryLine } from "./jobs-matrix-view";
import { statusLabel } from "./job-health-format";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-10-14T10:00:00.000Z");

function job(over: Partial<PlatformJobRow> = {}): PlatformJobRow {
  return {
    job: "sync-banks",
    status: "healthy",
    expectedEveryHours: 24,
    source: null,
    lastStartedAt: "2026-10-14T06:00:00.000Z",
    lastRunStatus: "succeeded",
    lastCompletedAt: "2026-10-14T06:00:40.000Z",
    consecutiveFailures: 0,
    nextExpectedAt: "2026-10-15T05:55:00.000Z",
    lastRuntimeMs: 40_000,
    avgRuntimeMs: 38_000,
    successRate: 1,
    totalRuns: 10,
    succeededRuns: 10,
    failedRuns: 0,
    manualRuns: 0,
    lastFailureAt: null,
    lastFailureSummary: null,
    ...over,
  };
}

const JOBS: PlatformJobHealthResponse = {
  healthy: false,
  checkedAt: "2026-10-14T10:00:00.000Z",
  counts: { healthy: 1, running: 0, overdue: 1, failing: 1, dead: 0, neverRan: 1 },
  jobs: [
    job(),
    job({ job: "fetch-fx-rates", status: "failing", consecutiveFailures: 3, lastStartedAt: "2026-10-14T07:00:00.000Z", lastFailureAt: "2026-10-14T07:00:00.000Z", lastFailureSummary: "OXR 503" }),
    job({ job: "sync-crypto", status: "overdue", expectedEveryHours: 6, lastStartedAt: "2026-10-13T06:00:00.000Z", nextExpectedAt: "2026-10-13T11:55:00.000Z" }),
    job({ job: "purge-rate-limits", status: "never-ran", lastStartedAt: null, lastRunStatus: null, lastCompletedAt: null, nextExpectedAt: null, lastRuntimeMs: null, avgRuntimeMs: null, successRate: null, totalRuns: 0, succeededRuns: 0 }),
  ],
};

const SUMMARY: RefreshSummary = {
  window: { from: "2026-09-30", to: "2026-10-14" },
  deterministic: false,
  indeterminacyReason: "window is open — it ends 2026-10-14, which is not before today",
  checkedAt: "2026-10-14T10:00:00.000Z",
  executions: 42,
  byStatus: { FAILED: 3, PARTIAL: 1, SKIPPED: 2, SUCCEEDED: 36 },
  byTrigger: { CRON: 30, MANUAL: 10, OPERATOR: 2 },
  byProfile: { FULL_REFRESH: 42 },
  openExecutions: 0,
  withParentJob: 30,
  meanDurationMs: 1200,
  maxDurationMs: 9000,
  endpoints: [],
  tier: "derived",
};

const UNOBSERVED: RefreshSummary = {
  ...SUMMARY,
  executions: 0,
  byStatus: {},
  byTrigger: {},
  byProfile: {},
  meanDurationMs: null,
  maxDurationMs: null,
  tier: "unknown",
};

function day(d: string, total: number, failed = 0, denied = 0, settled = true): RefreshDailySeries["days"][number] {
  return {
    day: d,
    total,
    byStatus: { SUCCEEDED: total - failed - denied, PARTIAL: 0, FAILED: failed, SKIPPED: denied, RUNNING: 0 },
    bySourceKind: { PLAID_ITEM: total, WALLET: 0 },
    admissionDenied: denied,
    settled,
  };
}

const DAILY: RefreshDailySeries = {
  envelope: {
    window: { from: "2026-10-10", to: "2026-10-14" },
    deterministic: false,
    indeterminacyReason: "window is open — it ends 2026-10-14, which is not before today",
    checkedAt: "2026-10-14T10:00:00.000Z",
  },
  // 2026-10-10 is deliberately MISSING: the fact cap cut it (a gap, not a zero).
  days: [day("2026-10-11", 0), day("2026-10-12", 7, 2, 1), day("2026-10-13", 5), day("2026-10-14", 2, 1, 0, false)],
  windowDays: 4,
  maxWindowDays: 30,
  executions: 14,
  floor: true,
  notes: ["Buckets are UTC days of each execution's startedAt."],
  tier: "observed",
};

const ok = <T,>(data: T) => ({ data, loading: false, error: null });
const ERRORED = { data: null, loading: false, error: "Not authorized" };

function main() {
  console.log("refresh-activity-view · the shared map");
  {
    const segs = statusSegments(SUMMARY.byStatus);
    check("the five statuses always appear, in the vocabulary's order", segs.slice(0, 5).map((s) => s.word).join(",") === "Succeeded,Partial,Failed,Skipped,Running");
    check("a counted zero is kept (Running 0 is a fact)", segs[4].count === 0);
    check("tones are the vocabulary's own", segs[0].tone === "ok" && segs[1].tone === "warn" && segs[2].tone === "bad" && segs[3].tone === "muted" && segs[4].tone === "info");
    check("an unknown status is appended muted, never dropped", statusSegments({ MYSTERY: 1 }).some((s) => s.word === "Mystery" && s.tone === undefined));
    check("statusTone falls back to muted", statusTone("MYSTERY") === "muted" && statusTone("FAILED") === "bad");
    const trig = triggerSegments(SUMMARY.byTrigger);
    check("trigger segments carry NO tone (a trigger is not a verdict)", trig.every((s) => s.tone === undefined));
    check("trigger words are the operator vocabulary", trig.map((s) => s.word).join(",") === "Scheduled,Manual,Operator");
    check("windowDays is inclusive and ascending", windowDays("2026-10-10", "2026-10-14").length === 5);
    const pts = executionPoints(DAILY);
    check("one point per day of the window", pts.length === 5);
    check("a day the cap cut is a GAP (null), not zero", pts[0].key === "2026-10-10" && pts[0].value === null && /not loaded/.test(pts[0].title ?? ""));
    check("a settled empty day is a ZERO", pts[1].value === 0);
    check("today is unsettled and says so", /so far/.test(pts[4].title ?? ""));
    const fp = failurePoints(DAILY);
    check("failure points carry the bad tone and the FAILED count", fp[2].tone === "bad" && fp[2].value === 2);
    check("the refusals note states the recorded count and the unrecorded kind", /1 execution refused/.test(refusalNote(DAILY)) && /cooldown refusals write no row/.test(refusalNote(DAILY)));
  }

  console.log("jobs-matrix-view · the authority's words");
  {
    check("summary line reads the route's counts, worst first", summaryLine(JOBS.counts) === "1 failing · 1 overdue · 1 never ran · 1 healthy");
    check("healthy is always stated, zeros elsewhere omitted", summaryLine({ healthy: 11, running: 0, overdue: 0, failing: 0, dead: 0, neverRan: 0 }) === "11 healthy");
    check("a never-ran job is due at the next wake", nextDueCell(JOBS.jobs[3], NOW).kind === "wake");
    check("a job with a derived instant shows it as due", (() => { const c = nextDueCell(JOBS.jobs[0], NOW); return c.kind === "time" && c.value === "due in 19h" && c.qualifier === "15 Oct 05:55 UTC"; })());
    check("an overdue job reads as due in the past", (() => { const c = nextDueCell(JOBS.jobs[2], NOW); return c.kind === "time" && /ago/.test(c.value); })());
    check("a ran job with no derived instant is unknown, not the next wake", nextDueCell(job({ nextExpectedAt: null }), NOW).kind === "unknown");
  }

  console.log("blocks · first frame is the loading state");
  {
    const jobs = renderToStaticMarkup(createElement(JobsMatrixBlock, {}));
    const refresh = renderToStaticMarkup(createElement(RefreshActivityBlock, {}));
    check("jobs block loads", text(jobs).includes("Loading"));
    check("refresh block loads (both reads)", (text(refresh).match(/Loading/g) ?? []).length === 2);
    check("neither renders a count pill while loading", !/>0</.test(jobs) && !/>0</.test(refresh));
    check("the doorways render NOTHING when the rail is unwired", !jobs.includes('aria-label="Open ') && !refresh.includes('aria-label="Open '));
  }

  console.log("jobs matrix · states");
  {
    const populated = renderToStaticMarkup(createElement(JobsMatrixSurface, { data: JOBS, loading: false, error: null, nowMs: NOW, onOpenWorkspace: () => {} }));
    const errored = renderToStaticMarkup(createElement(JobsMatrixSurface, { ...ERRORED, nowMs: NOW }));
    const empty = renderToStaticMarkup(createElement(JobsMatrixSurface, { data: { ...JOBS, counts: { healthy: 0, running: 0, overdue: 0, failing: 0, dead: 0, neverRan: 0 }, jobs: [] }, loading: false, error: null, nowMs: NOW }));
    const t = text(populated);
    check("the surface title", t.includes("Scheduled jobs"));
    check("the summary line", t.includes("1 failing · 1 overdue · 1 never ran · 1 healthy"));
    check("the five column headers", ["Job", "Health", "Last run", "Next due", "Failures"].every((h) => t.includes(h)));
    check("every job name", JOBS.jobs.every((j) => t.includes(j.job)));
    check("worst first — the failing job precedes the healthy one", t.indexOf("fetch-fx-rates") < t.indexOf("sync-banks"));
    check("status words are the Jobs vocabulary's own", t.includes(statusLabel("failing")) && t.includes(statusLabel("overdue")) && t.includes(statusLabel("never-ran")));
    check("cadence as the second identity line", t.includes("Daily") && t.includes("Every 6h"));
    check("last run — relative then UTC", t.includes("4h ago") && t.includes("14 Oct 06:00 UTC"));
    check("next due — derived instant", t.includes("due in 19h") && t.includes("15 Oct 05:55 UTC"));
    check("never ran is its own word in the last-run cell", t.includes(NEVER_RAN_WORD));
    check("never ran is due at the next wake", t.includes(NEXT_WAKE_WORD));
    {
      // Worst-first puts the never-ran row between sync-crypto and sync-banks.
      const neverRanRow = t.slice(t.indexOf("purge-rate-limits"), t.indexOf("sync-banks"));
      check("the never-ran row fabricates no time", neverRanRow.length > 0 && !/\d\d? Oct \d\d:\d\d/.test(neverRanRow), neverRanRow);
    }
    check("consecutive failures worded when > 0", t.includes("3 consecutive failures"));
    check("a zero streak is a real zero", (t.match(/\b0\b/g) ?? []).length >= 1);
    check("the footnote says observed from the ledger and that the tick is unobservable", t.includes("Observed from the JobRun ledger") && t.includes("unobservable"));
    check("observed-at instant in the footnote", t.includes("Observed 14 Oct 10:00 UTC."));
    check("the doorway opens Jobs", populated.includes(`aria-label="Open ${getPlatformWorkspace(JOBS_MATRIX_DOORWAY)?.label}"`));
    check("below-md fact labels exist and hide at md", populated.includes("md:hidden") && populated.includes("md:contents"));
    check("the status dot is decorative", /aria-hidden="true"[^>]*class="rounded-full"/.test(populated) || /class="rounded-full"[^>]*aria-hidden/.test(populated));
    check("no expansion control, no toolbar", !populated.includes("aria-expanded") && !populated.includes("Search jobs"));
    check("error says what failed and shows no job", text(errored).includes("Not authorized") && !text(errored).includes("sync-banks"));
    check("error never reads as healthy", !text(errored).includes("Healthy") && !text(errored).includes("healthy"));
    check("empty registry says so", text(empty).includes("No scheduled jobs are registered."));
    check("three renders are distinct", new Set([populated, errored, empty]).size === 3);
  }

  console.log("refresh activity · states");
  {
    const populated = renderToStaticMarkup(createElement(RefreshActivitySurface, { summary: ok(SUMMARY), daily: ok(DAILY), onOpenWorkspace: () => {} }));
    const unobserved = renderToStaticMarkup(createElement(RefreshActivitySurface, { summary: ok(UNOBSERVED), daily: ok(DAILY) }));
    const halfFailed = renderToStaticMarkup(createElement(RefreshActivitySurface, { summary: ERRORED, daily: ok(DAILY) }));
    const t = text(populated);
    check("the surface title", t.includes("Refresh activity"));
    check("by-status strip: word + count for every status", ["Succeeded 36", "Partial 1", "Failed 3", "Skipped 2", "Running 0"].every((s) => t.includes(s)));
    check("by-trigger strip: word + count", ["Scheduled 30", "Manual 10", "Operator 2"].every((s) => t.includes(s)));
    check("the strips are accessible images with the composition in words", /aria-label="By status: 36 Succeeded, 1 Partial, 3 Failed, 2 Skipped, 0 Running"/.test(populated));
    check("the composition caption carries window, reason and checkedAt", t.includes("2026-09-30 → 2026-10-14") && t.includes("window is open") && t.includes("checked 14 Oct 10:00 UTC"));
    check("executions figure", t.includes("42 executions"));
    check("the two bar rows", t.includes("Executions per day") && t.includes("Failures per day"));
    check("the bars' summary names buckets, the gap and the peak", /5 buckets, 4 observed, 1 without observation, total 14 executions, peak 7 executions on 2026-10-12/.test(populated));
    check("the gap is titled as not loaded, never as zero", populated.includes("2026-10-10: not loaded"));
    check("the settled empty day is a zero", populated.includes("2026-10-11: 0 executions"));
    check("the series caption states the zero rule and the floor", t.includes("true zero") && t.includes("floor"));
    check("the refusals line", t.includes("1 execution refused by admission policy") && t.includes("cannot appear here"));
    check("the doorway opens Pipeline", populated.includes(`aria-label="Open ${getPlatformWorkspace(REFRESH_ACTIVITY_DOORWAY)?.label}"`));
    check("unobserved summary says so and shows no zeros for it", text(unobserved).includes("not observed") && !text(unobserved).includes("Succeeded 0"));
    check("...while the day series still renders", text(unobserved).includes("Executions per day"));
    check("one read failing does not blank the other", text(halfFailed).includes("Not authorized") && text(halfFailed).includes("Executions per day"));
    check("three renders are distinct", new Set([populated, unobserved, halfFailed]).size === 3);
  }

  console.log("source · grammar and purity");
  {
    const files = [
      "components/platform/widgets/overview/RefreshActivityBlock.tsx",
      "components/platform/widgets/overview/JobsMatrixBlock.tsx",
      "components/platform/widgets/refresh-activity-view.ts",
      "components/platform/widgets/jobs-matrix-view.ts",
    ];
    for (const f of files) {
      const src = strip(f);
      check(`${path.basename(f)}: no hex colour`, !/#[0-9a-fA-F]{3,8}\b/.test(src));
      check(`${path.basename(f)}: no text-gray utility`, !/text-gray-/.test(src));
      check(`${path.basename(f)}: no matchMedia`, !/matchMedia/.test(src));
      check(`${path.basename(f)}: imports no projection, reader, db or server-only module`, !/@\/lib\/platform\/refresh\/projections|@\/lib\/db|server-only|@\/lib\/jobs\/health"/.test(src));
    }
    for (const f of files.slice(2)) {
      const src = strip(f);
      check(`${path.basename(f)}: reads no clock (nowMs is a parameter)`, !/Date\.now\(|new Date\(\)/.test(src));
      check(`${path.basename(f)}: no React`, !/from "react"/.test(src));
    }
    for (const f of files.slice(0, 2)) {
      const src = strip(f);
      check(`${path.basename(f)}: exactly one SectionSurface per render path`, (src.match(/<SectionSurface/g) ?? []).length <= 2);
      check(`${path.basename(f)}: fetches through the static-url hook`, /useWidgetFetch<[^>]+>\(\s*"\/api\/platform\/platform-ops\//.test(src));
      check(`${path.basename(f)}: no raw fetch`, !/[^d]fetch\(/.test(src));
      check(`${path.basename(f)}: no polling`, !/setInterval/.test(src));
      check(`${path.basename(f)}: navigates only through onOpenWorkspace`, !/next\/link|useRouter|<a /.test(src));
      check(`${path.basename(f)}: is a client component`, /^"use client";/.test(readFileSync(path.join(ROOT, f), "utf8")));
    }
    const jobsBlock = strip("components/platform/widgets/overview/JobsMatrixBlock.tsx");
    check("jobs block never re-classifies — no status literal compared", !/status\s*===\s*"/.test(jobsBlock));
    check("jobs block orders through the Jobs authority's orderJobs", /orderJobs\(/.test(jobsBlock));
    const refreshBlock = strip("components/platform/widgets/overview/RefreshActivityBlock.tsx");
    check("refresh block folds nothing", !/\.reduce\(|\+=|\.sort\(/.test(refreshBlock));
    const summaryWidget = strip("components/platform/widgets/OpsRefreshSummaryWidget.tsx");
    check("the Pipeline summary shares the SAME view map", /refresh-activity-view/.test(summaryWidget) && /statusSegments\(/.test(summaryWidget));
  }

  if (failures > 0) {
    console.error(`\noverview-refresh-jobs.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\noverview-refresh-jobs.test: all passed.");
}

main();
