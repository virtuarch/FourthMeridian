/**
 * lib/jobs/dispatch.test.ts  (OPS-4 S2)
 *
 * Pure guards for the dispatcher. Standalone tsx script (house pattern):
 * npx tsx lib/jobs/dispatch.test.ts — exits 0/1.
 *
 * NO LIVE DATABASE: dispatchDueJobs takes an injected jobs list + runner, so
 * no real job body (and no Prisma) ever executes here. Covers: slot matching
 * (exact minute, late-fire tolerance within the half-hour, slot boundaries,
 * empty slots) · registry integrity (S2 jobs at their pre-S2 slots, S3
 * maintenance jobs at 07:30, unique names, half-hour minutes) · execution through the runner
 * (= runJob in production) with trigger "cron" · sequencing (registry
 * order) · isolation (a failing job never blocks a sibling; dispatch never
 * throws) · no-op ticks · source scans (single vercel.json cron on the
 * dispatcher · per-job fallback routes retained with CRON_SECRET ·
 * jobs/scheduler.ts retired · no queue/retry/telemetry infrastructure).
 */

import { existsSync, readFileSync } from "node:fs";
import { dispatchDueJobs, dueJobs } from "@/lib/jobs/dispatch";
import { SCHEDULED_JOBS, type ScheduledJob } from "@/lib/jobs/registry";

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
// here executes a job body, so no Prisma runs.
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") {
    return;
  }
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

const utc = (h: number, m: number) => new Date(Date.UTC(2026, 6, 8, h, m, 0));

function fakeJobs(): ScheduledJob[] {
  return [
    { name: "a", hourUTC: 6, minuteUTC: 0, run: async () => ({ ok: 1 }) },
    { name: "b", hourUTC: 6, minuteUTC: 0, run: async () => ({ ok: 2 }) },
    { name: "c", hourUTC: 6, minuteUTC: 30, run: async () => ({ ok: 3 }) },
  ];
}

function muteConsole<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  return fn().finally(() => {
    console.log = origLog;
    console.error = origErr;
  });
}

async function main(): Promise<void> {
  console.log("dispatcher (OPS-4 S2)");

  // ── 1. Slot matching ─────────────────────────────────────────────────────
  {
    const jobs = fakeJobs();
    check("exact minute matches its slot", dueJobs(utc(6, 0), jobs).map((j) => j.name).join() === "a,b");
    check("late fire within the half-hour still matches (Vercel delay tolerance)",
      dueJobs(utc(6, 7), jobs).map((j) => j.name).join() === "a,b");
    check("last minute of the slot still matches", dueJobs(utc(6, 29), jobs).map((j) => j.name).join() === "a,b");
    check(":30 slot is a different slot", dueJobs(utc(6, 30), jobs).map((j) => j.name).join() === "c");
    check("empty slot matches nothing", dueJobs(utc(7, 30), jobs).length === 0);
    check("wrong hour matches nothing", dueJobs(utc(5, 59), jobs).length === 0);
  }

  // ── 2. Registry integrity — pre-S2 jobs at their slots + S3 maintenance ───
  {
    const byName = new Map(SCHEDULED_JOBS.map((j) => [j.name, j]));
    check("registry holds exactly the seven S2+S3+S4 jobs (S5 not started)",
      SCHEDULED_JOBS.length === 7, `got ${SCHEDULED_JOBS.length}`);
    check("names unique", byName.size === SCHEDULED_JOBS.length);
    check("sync-banks keeps its 06:00 UTC slot",
      byName.get("sync-banks")?.hourUTC === 6 && byName.get("sync-banks")?.minuteUTC === 0);
    check("fetch-fx-rates keeps its 06:30 UTC slot",
      byName.get("fetch-fx-rates")?.hourUTC === 6 && byName.get("fetch-fx-rates")?.minuteUTC === 30);
    check("process-deletions keeps its 07:00 UTC slot",
      byName.get("process-deletions")?.hourUTC === 7 && byName.get("process-deletions")?.minuteUTC === 0);
    check("S3/S4 maintenance jobs occupy the 07:30 slot (no new cron entry needed)",
      (["notification-cleanup", "notification-retry", "purge-trash", "rate-limit-sweep"] as const).every(
        (name) => byName.get(name)?.hourUTC === 7 && byName.get(name)?.minuteUTC === 30,
      ));
    check("notification-retry sequenced AFTER notification-cleanup (never re-mail aged-out rows)",
      SCHEDULED_JOBS.findIndex((j) => j.name === "notification-retry") >
        SCHEDULED_JOBS.findIndex((j) => j.name === "notification-cleanup"));
    check("all slots on half-hour boundaries", SCHEDULED_JOBS.every((j) => j.minuteUTC === 0 || j.minuteUTC === 30));
    check("deferred work stays deferred (no digest / snapshot / quiet-hours jobs)",
      !SCHEDULED_JOBS.some((j) => /digest|snapshot|quiet/i.test(j.name)));
  }

  // ── 3. Execution through the runner, in registry order, trigger "cron" ────
  {
    const ran: string[] = [];
    const triggers: string[] = [];
    const result = await muteConsole(() =>
      dispatchDueJobs(utc(6, 0), {
        jobs: fakeJobs(),
        runner: async (name, fn, options) => {
          ran.push(name);
          triggers.push(options.trigger);
          return fn();
        },
      }),
    );
    check("every due job executes through the runner (runJob seam)", ran.join() === "a,b");
    check("sequencing follows registry order", ran[0] === "a" && ran[1] === "b");
    check("trigger is \"cron\"", triggers.every((t) => t === "cron"));
    check("outcome reports each job ok", result.dispatched.every((d) => d.ok) && result.failures === 0);
    check("slot label rendered", result.slot === "06:00 UTC");
  }

  // ── 4. Isolation — a failing job never blocks a sibling ───────────────────
  {
    const ran: string[] = [];
    const jobs = fakeJobs();
    jobs[0].run = async () => { throw new Error("first job exploded"); };
    const result = await muteConsole(() =>
      dispatchDueJobs(utc(6, 3), {
        jobs,
        runner: async (name, fn) => { ran.push(name); return fn(); },
      }),
    );
    check("sibling still runs after a failure", ran.join() === "a,b");
    check("dispatch never throws; failure recorded in outcome",
      result.failures === 1 &&
        result.dispatched[0].ok === false &&
        result.dispatched[0].error === "first job exploded" &&
        result.dispatched[1].ok === true);
  }

  // ── 5. No-op tick ──────────────────────────────────────────────────────────
  {
    const result = await muteConsole(() =>
      dispatchDueJobs(utc(7, 30), { jobs: fakeJobs(), runner: async () => { throw new Error("must not run"); } }),
    );
    check("empty slot is a clean no-op", result.dispatched.length === 0 && result.failures === 0);
  }

  // ── 6. Source scans — S2 structure ────────────────────────────────────────
  {
    // FREE-TIER CRON DOCTRINE (add7c5e): the deployment target is the Vercel
    // Hobby (free) plan, which REJECTS any sub-daily cron at deploy time. The
    // dispatcher therefore runs on a SINGLE once-per-day entry. The richer
    // paid-tier schedule — "0,30 6-7 * * *", one tick per registered half-hour
    // slot — is preserved as documentation only (below) and must NOT be the
    // active vercel.json invariant while on Hobby. The per-slot jobs that this
    // daily tick does not reach stay callable through the per-job fallback
    // routes (CRON_SECRET-guarded) and, for FX, the opportunistic
    // stale-while-revalidate refresh (lib/money/fx-freshness.ts).
    const FREE_TIER_SCHEDULE = "0 6 * * *";       // active: once/day (Hobby-legal)
    const PAID_TIER_SCHEDULE = "0,30 6-7 * * *";  // documentation: restore off Hobby
    const vercel = readFileSync("vercel.json", "utf8");
    const cronPaths = [...vercel.matchAll(/"path":\s*"([^"]+)"/g)].map((m) => m[1]);
    const schedules = [...vercel.matchAll(/"schedule":\s*"([^"]+)"/g)].map((m) => m[1]);
    check("vercel.json has exactly ONE cron — the dispatcher",
      cronPaths.length === 1 && cronPaths[0] === "/api/jobs/dispatch");
    check("the single cron runs at most once per day (Vercel Hobby free-tier limit)",
      schedules.length === 1 && schedules[0] === FREE_TIER_SCHEDULE);
    check("the sub-daily paid-tier schedule is retired from the active config",
      !vercel.includes(PAID_TIER_SCHEDULE));

    const dispatchRoute = readFileSync("app/api/jobs/dispatch/route.ts", "utf8");
    check("dispatcher route keeps CRON_SECRET protection",
      dispatchRoute.includes("CRON_SECRET") && dispatchRoute.includes("401"));

    check("per-job fallback routes retained (individual revertibility)",
      ["sync-banks", "fetch-fx-rates", "process-deletions"].every((name) =>
        existsSync(`app/api/jobs/${name}/route.ts`)));

    check("jobs/scheduler.ts is retired (deleted)", !existsSync("jobs/scheduler.ts"));

    // Strip comments (doctrine text legitimately NAMES the forbidden things).
    const code = ["lib/jobs/dispatch.ts", "lib/jobs/registry.ts", "app/api/jobs/dispatch/route.ts"]
      .map((p) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))
      .join("\n");
    // (Since S4 the registry legitimately calls retryNotifications() — the
    // registered consumer body; framework-style retry constructs remain
    // banned and are scanned in lib/jobs/notification-retry.test.ts.)
    check("no queue/telemetry/scheduler infrastructure in dispatcher code",
      !/setInterval|setTimeout|node-cron|BullMQ|new Queue|SQS|EventBridge|startScheduler/i.test(code) &&
        !/\b(withRetry|pRetry|retryWrapper|backoff)\w*\(/i.test(code) &&
        !/telemetry/i.test(code));
  }

  if (failures > 0) {
    console.error(`\ndispatcher tests: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\ndispatcher tests: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error("  ✗ test harness error:", err);
  process.exit(1);
});
