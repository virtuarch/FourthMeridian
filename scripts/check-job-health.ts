/**
 * scripts/check-job-health.ts  (OPS-4 S5)
 *
 * Operator CLI over the dead-job detector (lib/jobs/health.ts): prints one
 * line per registered job and exits nonzero if any job is unhealthy — usable
 * by hand or from any external check that can run a script.
 *
 *   npx tsx scripts/check-job-health.ts
 *
 * Read-only (queries the JobRun ledger; writes nothing). Requires
 * DATABASE_URL. Deliberately NOT a cron/dispatcher job and NOT an alerting
 * system — S5 detects; the operator (and later PO1) decides.
 */

import { checkScheduledJobHealth } from "@/lib/jobs/health";

async function main(): Promise<void> {
  const health = await checkScheduledJobHealth();

  console.log(`scheduled-job health @ ${health.checkedAt.toISOString()}\n`);
  for (const j of health.jobs) {
    const last = j.lastStartedAt
      ? `last ${j.lastStartedAt.toISOString()} (${j.lastRunStatus})`
      : "no runs recorded";
    const streak = j.consecutiveFailures > 0 ? ` · ${j.consecutiveFailures} consecutive failure(s)` : "";
    const mark = j.status === "healthy" ? "✓" : "✗";
    console.log(`  ${mark} ${j.job.padEnd(22)} ${j.status.padEnd(10)} every ${j.expectedEveryHours}h · ${last}${streak}`);
  }

  if (!health.healthy) {
    console.error("\nUNHEALTHY — see rows above (JobRun ledger has the details).");
    process.exit(1);
  }
  console.log("\nall jobs healthy");
  process.exit(0);
}

main().catch((err) => {
  console.error("[check-job-health] failed:", err);
  process.exit(1);
});
