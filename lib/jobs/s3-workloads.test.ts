/**
 * lib/jobs/s3-workloads.test.ts  (OPS-4 S3)
 *
 * Pure guards for the S3 scheduled-workload migration. Standalone tsx script
 * (house pattern): npx tsx lib/jobs/s3-workloads.test.ts — exits 0/1.
 *
 * NO LIVE DATABASE: the rate-limit sweep runs against an injected in-memory
 * fake applying the same predicate Prisma would. Covers: sweep behavior
 * (WHERE-guarded cutoff, boundary, idempotency, summary shape) · registry
 * facts (three S3 registrations at 07:30; process-deletions single-purpose)
 * · deferral tripwires (digests and snapshot cadence NOT registered; no S4+
 * infrastructure: no notification-retry consumer, no dead-job detection,
 * no attempts increment anywhere in lib/jobs).
 */

import { readFileSync } from "node:fs";
import { sweepRateLimits, type RateLimitSweepClient } from "@/jobs/sweep-rate-limits";
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

// Environment tolerance (see lib/notifications/create.test.ts): PrismaClient
// engine warm-up floating-rejects on platform-mismatched sandboxes; nothing
// here executes a query (the fake client is injected).
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") {
    return;
  }
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

// ── In-memory fake applying the same predicate Prisma would ──────────────────

function makeFake(windowStarts: Date[]) {
  let rows = windowStarts.map((windowStart, i) => ({ id: `r${i}`, windowStart }));
  const client: RateLimitSweepClient = {
    rateLimit: {
      async deleteMany({ where }) {
        const before = rows.length;
        rows = rows.filter((r) => !(r.windowStart < where.windowStart.lt));
        return { count: before - rows.length };
      },
    },
  };
  return { client, remaining: () => rows.length };
}

const HOUR = 60 * 60 * 1000;

async function main(): Promise<void> {
  console.log("S3 scheduled workloads (OPS-4 S3)");

  // ── 1. Rate-limit sweep behavior ───────────────────────────────────────────
  {
    const now = new Date("2026-07-08T12:00:00Z");
    const { client, remaining } = makeFake([
      new Date(now.getTime() - 25 * HOUR), // expired — swept
      new Date(now.getTime() - 24 * HOUR), // exactly at cutoff — KEPT (strict lt)
      new Date(now.getTime() - 1 * HOUR),  // live window era — kept
      new Date(now.getTime()),             // current — kept
    ]);
    const first = await sweepRateLimits(client, now);
    check("sweeps only rows older than the 24h cutoff", first.deleted === 1 && remaining() === 3);
    check("cutoff boundary is strict (row at exactly -24h survives)", remaining() === 3);
    check("summary is counts + ISO cutoff only (no user content)",
      typeof first.deleted === "number" &&
        first.cutoff === new Date(now.getTime() - 24 * HOUR).toISOString() &&
        Object.keys(first).sort().join() === "cutoff,deleted");

    const second = await sweepRateLimits(client, now);
    check("idempotent: immediate re-run deletes zero", second.deleted === 0 && remaining() === 3);
  }

  // ── 2. Registry facts ─────────────────────────────────────────────────────
  {
    const byName = new Map(SCHEDULED_JOBS.map((j) => [j.name, j]));
    check("purge-trash registered (retention promise finally true)",
      byName.get("purge-trash")?.hourUTC === 7 && byName.get("purge-trash")?.minuteUTC === 30);
    check("notification-cleanup registered as its own job",
      byName.get("notification-cleanup")?.hourUTC === 7 && byName.get("notification-cleanup")?.minuteUTC === 30);
    check("rate-limit-sweep registered",
      byName.get("rate-limit-sweep")?.hourUTC === 7 && byName.get("rate-limit-sweep")?.minuteUTC === 30);

    const registrySrc = readFileSync("lib/jobs/registry.ts", "utf8");
    const processEntry = registrySrc.slice(
      registrySrc.indexOf('"process-deletions"'),
      registrySrc.indexOf('"notification-cleanup"'),
    );
    check("process-deletions registry entry is single-purpose (no cleanup call inside it)",
      processEntry.includes("processDeletions()") && !processEntry.includes("cleanupNotifications"));

    const routeSrc = readFileSync("app/api/jobs/process-deletions/route.ts", "utf8");
    check("process-deletions route no longer calls notification cleanup",
      !routeSrc.includes("cleanupNotifications"));
  }

  // ── 3. Deferrals stay deferred; no S4+ infrastructure ─────────────────────
  {
    check("no digest job registered (deferred: template/preference/marker absent)",
      !SCHEDULED_JOBS.some((j) => /digest/i.test(j.name)));
    check("no snapshot-cadence job registered (deferred: stale-balance semantics unresolved)",
      !SCHEDULED_JOBS.some((j) => /snapshot/i.test(j.name)));

    // Comment-stripped code scan over the jobs layer: no retry consumer, no
    // dead-job detection, no queue/telemetry (S4/S5/PO1 tripwires).
    const code = [
      "lib/jobs/run.ts",
      "lib/jobs/registry.ts",
      "lib/jobs/dispatch.ts",
      "jobs/sweep-rate-limits.ts",
      "jobs/purge-trash.ts",
      "app/api/jobs/dispatch/route.ts",
    ]
      .map((p) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))
      .join("\n");
    check("no notification-retry consumer in the jobs layer",
      !/notificationDelivery|attempts\s*[:+]/i.test(code));
    check("no dead-job detection / alerting in the jobs layer",
      !/expected.*absent|sendEmail|alert/i.test(code));
    check("no queue/telemetry constructs in the jobs layer",
      !/BullMQ|new Queue|SQS|EventBridge|telemetry|setInterval/i.test(code));
  }

  if (failures > 0) {
    console.error(`\nS3 workload tests: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nS3 workload tests: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error("  ✗ test harness error:", err);
  process.exit(1);
});
