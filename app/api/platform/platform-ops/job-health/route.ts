/**
 * GET /api/platform/platform-ops/job-health
 *
 * PO1.2 — scheduled-job health for the `ops_job_health` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("PLATFORM_OPS", "READ").
 *
 * Wraps checkScheduledJobHealth() (lib/jobs/health.ts, OPS-4 S5) — a read-only
 * pass over the JobRun ledger. That detector is deliberately NOT on /api/health
 * (which is unauthenticated and pins its keys); this authorized platform route
 * is the sanctioned read-facing surface for it. No values beyond job names,
 * statuses, and timestamps cross the boundary.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { checkScheduledJobHealth, type JobHealthStatus } from "@/lib/jobs/health";

export const runtime = "nodejs";

export interface PlatformJobRow {
  job:                 string;
  status:              JobHealthStatus;
  lastStartedAt:       string | null; // ISO
  lastRunStatus:       string | null;
  consecutiveFailures: number;
  expectedEveryHours:  number;
}

export interface PlatformJobHealthResponse {
  healthy:   boolean;
  checkedAt: string; // ISO
  counts:    { healthy: number; overdue: number; failing: number; neverRan: number };
  jobs:      PlatformJobRow[];
}

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;

  const health = await checkScheduledJobHealth();

  const counts = { healthy: 0, overdue: 0, failing: 0, neverRan: 0 };
  for (const j of health.jobs) {
    if (j.status === "healthy") counts.healthy++;
    else if (j.status === "overdue") counts.overdue++;
    else if (j.status === "failing") counts.failing++;
    else if (j.status === "never-ran") counts.neverRan++;
  }

  return NextResponse.json({
    healthy:   health.healthy,
    checkedAt: health.checkedAt.toISOString(),
    counts,
    jobs: health.jobs.map((j) => ({
      job:                 j.job,
      status:              j.status,
      lastStartedAt:       j.lastStartedAt ? j.lastStartedAt.toISOString() : null,
      lastRunStatus:       j.lastRunStatus,
      consecutiveFailures: j.consecutiveFailures,
      expectedEveryHours:  j.expectedEveryHours,
    })),
  } satisfies PlatformJobHealthResponse);
}
