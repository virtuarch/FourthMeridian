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
  DEFAULT_CADENCE_HOURS,
  FAILURE_STREAK_THRESHOLD,
  GRACE_HOURS,
  STALE_RUNNING_HOURS,
  checkScheduledJobHealth,
  classifyJobHealth,
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
    check("recent in-flight run breaks the streak (may yet succeed)",
      classifyJobHealth(j, [run(0.5, "running"), run(25, "failed"), run(49, "failed"), run(73, "failed")], NOW).status === "healthy");
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
    check("structured output (job/status/cadence/last/failures per row)",
      health.jobs.every((r) =>
        typeof r.job === "string" &&
        typeof r.expectedEveryHours === "number" &&
        "lastStartedAt" in r && "lastRunStatus" in r &&
        typeof r.consecutiveFailures === "number"));
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
