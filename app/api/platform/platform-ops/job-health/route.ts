/**
 * GET /api/platform/platform-ops/job-health
 *
 * PO1.2 · OPS-5 S2 — rich scheduled-job health for the `ops_job_health` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 *
 * Wraps checkScheduledJobHealth() (lib/jobs/health.ts) — a single read-only
 * pass over the JobRun ledger that yields both the detector status and the rich
 * operational metrics. That detector is deliberately NOT on /api/health (which
 * is unauthenticated and pins its keys); this authorized platform route is the
 * sanctioned read-facing surface for it. Only job names, statuses, timestamps,
 * durations, and truncated error summaries cross the boundary — no user content
 * or monetary values (JobRun.summary is never forwarded).
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { checkScheduledJobHealth, type JobHealthStatus } from "@/lib/jobs/health";

export const runtime = "nodejs";

export interface PlatformJobRow {
  job:                 string;
  status:              JobHealthStatus;
  expectedEveryHours:  number;
  lastStartedAt:       string | null; // ISO
  lastRunStatus:       string | null;
  lastCompletedAt:     string | null; // ISO
  consecutiveFailures: number;
  nextExpectedAt:      string | null; // ISO — from the registry schedule
  lastRuntimeMs:       number | null;
  avgRuntimeMs:        number | null;
  successRate:         number | null; // 0..1 over the examined window
  totalRuns:           number;
  succeededRuns:       number;
  failedRuns:          number;
  manualRuns:          number;
  lastFailureAt:       string | null; // ISO
  lastFailureSummary:  string | null;
}

export interface PlatformJobHealthCounts {
  healthy:  number;
  running:  number;
  overdue:  number;
  failing:  number;
  dead:     number;
  neverRan: number;
}

export interface PlatformJobHealthResponse {
  healthy:   boolean;
  checkedAt: string; // ISO
  counts:    PlatformJobHealthCounts;
  jobs:      PlatformJobRow[];
}

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const health = await checkScheduledJobHealth();

  const counts: PlatformJobHealthCounts = { healthy: 0, running: 0, overdue: 0, failing: 0, dead: 0, neverRan: 0 };
  for (const j of health.jobs) {
    if (j.status === "healthy") counts.healthy++;
    else if (j.status === "running") counts.running++;
    else if (j.status === "overdue") counts.overdue++;
    else if (j.status === "failing") counts.failing++;
    else if (j.status === "dead") counts.dead++;
    else if (j.status === "never-ran") counts.neverRan++;
  }

  const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

  return NextResponse.json({
    healthy:   health.healthy,
    checkedAt: health.checkedAt.toISOString(),
    counts,
    jobs: health.jobs.map((j) => ({
      job:                 j.job,
      status:              j.status,
      expectedEveryHours:  j.expectedEveryHours,
      lastStartedAt:       iso(j.lastStartedAt),
      lastRunStatus:       j.lastRunStatus,
      lastCompletedAt:     iso(j.lastCompletedAt),
      consecutiveFailures: j.consecutiveFailures,
      nextExpectedAt:      iso(j.nextExpectedAt),
      lastRuntimeMs:       j.lastRuntimeMs,
      avgRuntimeMs:        j.avgRuntimeMs,
      successRate:         j.successRate,
      totalRuns:           j.totalRuns,
      succeededRuns:       j.succeededRuns,
      failedRuns:          j.failedRuns,
      manualRuns:          j.manualRuns,
      lastFailureAt:       iso(j.lastFailureAt),
      lastFailureSummary:  j.lastFailureSummary,
    })),
  } satisfies PlatformJobHealthResponse);
}
