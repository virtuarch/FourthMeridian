/**
 * lib/jobs/job-health.test.ts  (OPS-4 S5)
 *
 * Pure guards for the dead-job detector. Standalone tsx script (house
 * pattern): npx tsx lib/jobs/job-health.test.ts — exits 0/1.
 *
 * NO LIVE DATABASE: classifyJobHealth is pure (injected clock + rows);
 * checkScheduledJobHealth runs against an injected fake read-client.
 * Covers: healthy job · overdue (incl. cadence+grace boundary) · never-ran
 * · repeated failures (streak threshold; below-threshold stays healthy;
 * recent in-flight run breaks the streak; stale "running" counts as a
 * crash) · per-job cadence configuration honored · precedence (overdue
 * beats failing) · overall aggregation · dispatcher compatibility (real
 * registry entries classify; dispatcher never reads the cadence field) ·
 * single-detector + read-only + no-alerting source scans · /api/health
 * deliberately unextended (job state stays off the public endpoint).
 */

import { readFileSync } from "node:fs";
import {
  DEAD_CADENCE_MULTIPLE,
  DEFAULT_CADENCE_HOURS,
  FAILURE_STREAK_THRESHOLD,
  GRACE_HOURS,
  STALE_RUNNING_HOURS,
  checkScheduledJobHealth,
  classifyJobHealth,
  nextExpectedRun,
  type JobRunHealthRow,
  type JobRunReadClient,
} from "@/lib/jobs/health";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") {
    return;
  }
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

const NOW = new Date("2026-07-09T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR);
const run = (h: number, status: string): JobRunHealthRow => ({ startedAt: hoursAgo(h), status });
/** Richer row for the metric tests (duration / trigger / error summary). */
const richRun = (h: number, status: string, extra: Partial<JobRunHealthRow> = {}): JobRunHealthRow => ({
  startedAt: hoursAgo(h),
  status,
  completedAt: status === "running" ? null : hoursAgo(h - 0.01),
  durationMs: status === "running" ? null : 1000,
  trigger: "cron",
  errorSummary: status === "failed" ? "boom" : null,
  ...extra,
});

async function main(): Promise<void> {
  console.log("dead-job detector (OPS-4 S5)");

  // ── 1. Core classifications ────────────────────────────────────────────────
  {
    const j = { name: "t" };
    check("healthy: ran within cadence, succeeded",
      classifyJobHealth(j, [run(5, "succeeded")], NOW).status === "healthy");
    check("never-ran: zero rows",
      classifyJobHealth(j, [], NOW).status === "never-ran");
    check("overdue: newest run older than cadence + grace",
      classifyJobHealth(j, [run(DEFAULT_CADENCE_HOURS + GRACE_HOURS + 1, "succeeded")], NOW).status === "overdue");
    check("boundary: exactly at cadence + grace is still healthy (strict >)",
      classifyJobHealth(j, [run(DEFAULT_CADENCE_HOURS + GRACE_HOURS, "succeeded")], NOW).status === "healthy");
  }

  // ── 2. Repeated failures ───────────────────────────────────────────────────
  {
    const j = { name: "t" };
    const threeFails = [run(1, "failed"), run(25, "failed"), run(49, "failed")];
    const r = classifyJobHealth(j, threeFails, NOW);
    check("failing at the streak threshold",
      r.status === "failing" && r.consecutiveFailures === FAILURE_STREAK_THRESHOLD);
    check("below threshold stays healthy (2 consecutive failures)",
      classifyJobHealth(j, [run(1, "failed"), run(25, "failed"), run(49, "succeeded")], NOW).status === "healthy");
    check("success resets the streak",
      classifyJobHealth(j, [run(1, "succeeded"), ...threeFails], NOW).status === "healthy");
    check("recent in-flight run → running, and breaks the streak (may yet succeed)",
      classifyJobHealth(j, [run(0.5, "running"), run(25, "failed"), run(49, "failed"), run(73, "failed")], NOW).status === "running");
    check("stale running row counts as a crashed run in the streak",
      classifyJobHealth(
        j,
        [run(STALE_RUNNING_HOURS + 1, "running"), run(25, "failed"), run(49, "failed")],
        NOW,
      ).status === "failing");
  }

  // ── 3. Cadence configuration + precedence ──────────────────────────────────
  {
    check("per-job cadence honored (4h job, 7h-old run → overdue)",
      classifyJobHealth({ name: "t", expectedEveryHours: 4 }, [run(4 + GRACE_HOURS + 1, "succeeded")], NOW).status === "overdue");
    check("per-job cadence honored (48h job, 30h-old run → healthy)",
      classifyJobHealth({ name: "t", expectedEveryHours: 48 }, [run(30, "succeeded")], NOW).status === "healthy");
    check("default cadence reported when unset",
      classifyJobHealth({ name: "t" }, [run(1, "succeeded")], NOW).expectedEveryHours === DEFAULT_CADENCE_HOURS);
    check("precedence: overdue beats failing (absence dominates brokenness)",
      classifyJobHealth({ name: "t" }, [run(30, "failed"), run(54, "failed"), run(78, "failed")], NOW).status === "overdue");
  }

  // ── 3b. New states: running + dead (OPS-5 S2) ──────────────────────────────
  {
    const j = { name: "t" };
    check("running: newest run is a fresh in-flight row",
      classifyJobHealth(j, [run(0.5, "running"), run(24, "succeeded")], NOW).status === "running");
    check("stale running is NOT 'running' (crashed run, not in flight)",
      classifyJobHealth(j, [run(STALE_RUNNING_HOURS + 1, "running")], NOW).status !== "running");
    check("dead: newest run older than cadence × DEAD_CADENCE_MULTIPLE",
      classifyJobHealth(j, [run(DEFAULT_CADENCE_HOURS * DEAD_CADENCE_MULTIPLE + 1, "succeeded")], NOW).status === "dead");
    check("precedence: dead beats overdue (many missed cycles, not one)",
      classifyJobHealth(j, [run(DEFAULT_CADENCE_HOURS * DEAD_CADENCE_MULTIPLE + 1, "failed"), run(100, "failed"), run(124, "failed")], NOW).status === "dead");
    check("just under the dead threshold is still overdue, not dead",
      classifyJobHealth(j, [run(DEFAULT_CADENCE_HOURS * DEAD_CADENCE_MULTIPLE - 1, "succeeded")], NOW).status === "overdue");
    check("per-job cadence honored for dead (6h job, 20h-old run → dead)",
      classifyJobHealth({ name: "t", expectedEveryHours: 6 }, [run(20, "succeeded")], NOW).status === "dead");
  }

  // ── 3c. Rich metrics — all derived from the same window ────────────────────
  {
    const j = { name: "t" };
    const rows = [
      richRun(1, "succeeded", { durationMs: 2000 }),
      richRun(25, "failed", { errorSummary: "timeout" }),
      richRun(49, "succeeded", { durationMs: 4000 }),
      richRun(73, "succeeded", { durationMs: 6000, trigger: "manual" }),
    ];
    const r = classifyJobHealth(j, rows, NOW);
    check("totalRuns counts the whole window", r.totalRuns === 4);
    check("succeeded / failed tallied", r.succeededRuns === 3 && r.failedRuns === 1);
    check("successRate = succeeded / completed (3/4)", r.successRate === 0.75);
    check("avgRuntimeMs averages succeeded durations only ((2000+4000+6000)/3)",
      r.avgRuntimeMs === 4000);
    check("lastRuntimeMs is the newest run with a duration", r.lastRuntimeMs === 2000);
    check("lastFailureAt/Summary point at the most recent failed run",
      r.lastFailureAt?.getTime() === hoursAgo(25).getTime() && r.lastFailureSummary === "timeout");
    check("manualRuns counts trigger === 'manual' (honest ledger read)", r.manualRuns === 1);

    const noRuns = classifyJobHealth(j, [], NOW);
    check("never-ran leaves metrics null/zero (no fabrication)",
      noRuns.successRate === null && noRuns.avgRuntimeMs === null && noRuns.lastRuntimeMs === null &&
      noRuns.manualRuns === 0 && noRuns.totalRuns === 0 && noRuns.lastFailureAt === null);

    const running = classifyJobHealth(j, [richRun(0.2, "running"), richRun(24, "succeeded", { durationMs: 3000 })], NOW);
    check("in-flight run: successRate over completed only, lastRuntime from last completed",
      running.successRate === 1 && running.lastRuntimeMs === 3000 && running.status === "running");
  }

  // ── 3d. nextExpectedRun — schedule projection (pure) ───────────────────────
  {
    const AT_0530 = new Date("2026-07-09T05:30:00Z"); // before the 06:00 daily slot
    const daily6 = nextExpectedRun(6, 0, AT_0530);
    check("daily slot: next run is today's 06:00 when now is before it",
      daily6?.toISOString() === "2026-07-09T06:00:00.000Z");
    const AT_0700 = new Date("2026-07-09T07:00:00Z"); // after the 06:00 slot → tomorrow
    const daily6b = nextExpectedRun(6, 0, AT_0700);
    check("daily slot: rolls to tomorrow once today's slot has passed",
      daily6b?.toISOString() === "2026-07-10T06:00:00.000Z");
    const intraday = nextExpectedRun([0, 6, 12, 18], 0, new Date("2026-07-09T07:00:00Z"));
    check("intraday array: picks the next fire hour (12:00)",
      intraday?.toISOString() === "2026-07-09T12:00:00.000Z");
    const wrap = nextExpectedRun([0, 6, 12, 18], 0, new Date("2026-07-09T19:00:00Z"));
    check("intraday array: wraps past the last slot to tomorrow's first",
      wrap?.toISOString() === "2026-07-10T00:00:00.000Z");
    check("half-hour minute honored", nextExpectedRun(6, 30, AT_0530)?.toISOString() === "2026-07-09T06:30:00.000Z");
    check("unknown slot → null (bare job in a unit test)", nextExpectedRun(undefined, undefined, NOW) === null);
    check("real registry jobs all resolve a next expected run",
      SCHEDULED_JOBS.every((jb) => classifyJobHealth(jb, [run(1, "succeeded")], NOW).nextExpectedAt instanceof Date));
  }

  // ── 4. Detector over an injected ledger ────────────────────────────────────
  {
    const byJob: Record<string, JobRunHealthRow[]> = {
      "sync-banks": [run(6, "succeeded")],
      "fetch-fx-rates": [run(40, "succeeded")], // overdue
      "process-deletions": [], // never ran
      "notification-cleanup": [run(1, "failed"), run(25, "failed"), run(49, "failed")], // failing
      "notification-retry": [run(1, "succeeded")],
      "purge-trash": [run(1, "succeeded")],
      "rate-limit-sweep": [run(1, "succeeded")],
    };
    const reads: string[] = [];
    const client: JobRunReadClient = {
      jobRun: {
        async findMany({ where, take }) {
          reads.push(where.jobName);
          return (byJob[where.jobName] ?? []).slice(0, take);
        },
      },
    };
    const health = await checkScheduledJobHealth(client, NOW);
    const status = (name: string) => health.jobs.find((r) => r.job === name)?.status;
    check("detector covers every registered job exactly once",
      reads.sort().join() === SCHEDULED_JOBS.map((j) => j.name).sort().join());
    check("mixed ledger classifies deterministically",
      status("sync-banks") === "healthy" &&
        status("fetch-fx-rates") === "overdue" &&
        status("process-deletions") === "never-ran" &&
        status("notification-cleanup") === "failing");
    check("overall healthy = false when any job is unhealthy", health.healthy === false);

    const allHealthy = await checkScheduledJobHealth(
      { jobRun: { async findMany() { return [run(3, "succeeded")]; } } },
      NOW,
    );
    check("overall healthy = true when every job is healthy", allHealthy.healthy === true);
    check("structured output (job/status/cadence/last/failures + rich metrics per row)",
      health.jobs.every((r) =>
        typeof r.job === "string" &&
        typeof r.expectedEveryHours === "number" &&
        "lastStartedAt" in r && "lastRunStatus" in r && "lastCompletedAt" in r &&
        typeof r.consecutiveFailures === "number" &&
        typeof r.totalRuns === "number" && typeof r.succeededRuns === "number" &&
        typeof r.failedRuns === "number" && typeof r.manualRuns === "number" &&
        "lastRuntimeMs" in r && "avgRuntimeMs" in r && "successRate" in r &&
        "lastFailureAt" in r && "lastFailureSummary" in r && "nextExpectedAt" in r));
  }

  // ── 5. Dispatcher compatibility ────────────────────────────────────────────
  {
    const dispatchSrc = readFileSync("lib/jobs/dispatch.ts", "utf8");
    check("dispatcher unchanged by S5 (never reads cadence or health module)",
      !dispatchSrc.includes("expectedEveryHours") && !dispatchSrc.includes("jobs/health"));
    check("registry entries classify without modification (shape-compatible)",
      SCHEDULED_JOBS.every((j) => classifyJobHealth(j, [run(1, "succeeded")], NOW).status === "healthy"));
  }

  // ── 6. Source scans — scope fences ─────────────────────────────────────────
  {
    const healthSrc = readFileSync("lib/jobs/health.ts", "utf8");
    const code = healthSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("detector is read-only over JobRun (no writes, no second ledger)",
      !/\.create\(|\.update\(|\.updateMany\(|\.delete/i.test(code));
    check("no alerting / notification / email / external service in the detector",
      !/sendEmail|createNotification|slack|pagerduty|webhook|fetch\(/i.test(code));
    check("no queue/telemetry constructs in the detector",
      !/BullMQ|new Queue|SQS|EventBridge|telemetry|setInterval|setTimeout/i.test(code));

    const healthRoute = readFileSync("app/api/health/route.ts", "utf8");
    check("/api/health deliberately unextended (no job state on the public endpoint)",
      !healthRoute.includes("jobRun") && !healthRoute.includes("jobs/health") && !healthRoute.includes("Scheduled"));

    // One detector: classifyJobHealth defined exactly once in the codebase's
    // jobs layer (this module), and no other module queries jobRun for health.
    check("single detector implementation",
      (healthSrc.match(/export function classifyJobHealth/g) ?? []).length === 1);
  }

  if (failures > 0) {
    console.error(`\ndead-job detector tests: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\ndead-job detector tests: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error("  ✗ test harness error:", err);
  process.exit(1);
});
