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
    check("registry holds the eight S2+S3+S4 jobs + A8-3 price fetch + CH-3 sync-crypto + OPS-5 S5 alert evaluator",
      SCHEDULED_JOBS.length === 10, `got ${SCHEDULED_JOBS.length}`);
    check("names unique", byName.size === SCHEDULED_JOBS.length);
    check("sync-banks keeps its 06:00 UTC slot",
      byName.get("sync-banks")?.hourUTC === 6 && byName.get("sync-banks")?.minuteUTC === 0);
    check("fetch-fx-rates keeps its 06:30 UTC slot",
      byName.get("fetch-fx-rates")?.hourUTC === 6 && byName.get("fetch-fx-rates")?.minuteUTC === 30);
    check("fetch-security-prices (A8-3) shares the 06:30 external-fetch slot",
      byName.get("fetch-security-prices")?.hourUTC === 6 && byName.get("fetch-security-prices")?.minuteUTC === 30);
    check("process-deletions keeps its 07:00 UTC slot",
      byName.get("process-deletions")?.hourUTC === 7 && byName.get("process-deletions")?.minuteUTC === 0);
    check("S3/S4 maintenance jobs occupy the 07:30 slot (no new cron entry needed)",
      (["notification-cleanup", "notification-retry", "purge-trash", "rate-limit-sweep"] as const).every(
        (name) => byName.get(name)?.hourUTC === 7 && byName.get(name)?.minuteUTC === 30,
      ));
    check("notification-retry sequenced AFTER notification-cleanup (never re-mail aged-out rows)",
      SCHEDULED_JOBS.findIndex((j) => j.name === "notification-retry") >
        SCHEDULED_JOBS.findIndex((j) => j.name === "notification-cleanup"));
    check("OPS-5 S5 evaluate-alerts rides the 07:30 slot (no new cron entry needed)",
      byName.get("evaluate-alerts")?.hourUTC === 7 && byName.get("evaluate-alerts")?.minuteUTC === 30);
    check("evaluate-alerts sequenced LAST (reads the freshest state after the sync/fx jobs)",
      SCHEDULED_JOBS.findIndex((j) => j.name === "evaluate-alerts") === SCHEDULED_JOBS.length - 1);
    check("all slots on half-hour boundaries", SCHEDULED_JOBS.every((j) => j.minuteUTC === 0 || j.minuteUTC === 30));
    check("deferred work stays deferred (no digest / quiet-hours jobs)",
      !SCHEDULED_JOBS.some((j) => /digest|quiet/i.test(j.name)));

    // CH-3 — sync-crypto: the intraday-repeat shape (hourUTC array), 6-hourly.
    const crypto = byName.get("sync-crypto");
    check("sync-crypto fires every 6 hours (00/06/12/18 UTC, :00 slot)",
      Array.isArray(crypto?.hourUTC) &&
        (crypto!.hourUTC as number[]).join() === "0,6,12,18" && crypto?.minuteUTC === 0);
    check("sync-crypto declares expectedEveryHours:6 for the dead-job detector",
      crypto?.expectedEveryHours === 6);
  }

  // ── 2b. Multi-slot (array hourUTC) dispatch — CH-3 ────────────────────────
  {
    const jobs: ScheduledJob[] = [
      { name: "six-hourly", hourUTC: [0, 6, 12, 18], minuteUTC: 0, run: async () => ({ ok: 1 }) },
      { name: "daily", hourUTC: 6, minuteUTC: 0, run: async () => ({ ok: 2 }) },
    ];
    check("array-hour job is due at every listed hour",
      [0, 6, 12, 18].every((h) => dueJobs(utc(h, 0), jobs).some((j) => j.name === "six-hourly")));
    check("array-hour job co-tenants the 06:00 slot with a single-hour job",
      dueJobs(utc(6, 0), jobs).map((j) => j.name).sort().join() === "daily,six-hourly");
    check("array-hour job is NOT due at an unlisted hour", dueJobs(utc(7, 0), jobs).length === 0);
    check("array-hour job honors the minute slot (not due at :30)",
      dueJobs(utc(12, 30), jobs).length === 0);
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
    // PAID-TIER CRON DOCTRINE (CH-3, supersedes the add7c5e Hobby doctrine):
    // the Vercel plan upgrade removed the sub-daily deploy-time restriction, so
    // the dispatcher now runs on a SINGLE multi-slot entry that reaches every
    // registered slot. "0,30 0,6,7,12,18 * * *" fires the 06:00/06:30/07:00/
    // 07:30 paid-tier slots (restoring sync-banks / fetch-fx-rates /
    // fetch-security-prices / process-deletions / the 07:30 maintenance jobs to
    // cron) PLUS CH-3 sync-crypto's 00:00/12:00/18:00 slots. The 00:30/12:30/
    // 18:30 ticks it also fires hold no registered job — cheap no-op ticks. It
    // stays ONE cron entry (one path), so no duplicate-path deploy risk.
    const ACTIVE_SCHEDULE = "0,30 0,6,7,12,18 * * *"; // paid-tier: every registered slot
    const HOBBY_SCHEDULE  = "0 6 * * *";              // retired: the once/day Hobby entry
    const vercel = readFileSync("vercel.json", "utf8");
    const cronPaths = [...vercel.matchAll(/"path":\s*"([^"]+)"/g)].map((m) => m[1]);
    const schedules = [...vercel.matchAll(/"schedule":\s*"([^"]+)"/g)].map((m) => m[1]);
    // The invariant is NO DUPLICATE PATHS (the deploy risk this guard names),
    // and that ALL REGISTRY-DRIVEN work goes through the one dispatcher entry —
    // not that vercel.json may only ever hold a single cron.
    //
    // Relaxed 2026-07-23 for /api/jobs/resume-stale-imports. That job cannot live
    // in the registry: dueJobs() matches a whole half-hour slot, so a dispatcher
    // firing often enough to be a user-facing backstop (every 5 min) would run
    // every daily job six times per slot. And a backstop measured in hours is not
    // a backstop for an import a user is watching — which is exactly what failed
    // that day, a Schwab import stalled behind a closed browser tab with nothing
    // server-side to finish it.
    //
    // So: exactly one DISPATCHER entry, no duplicate paths, and any additional
    // cron must be a distinct non-registry path.
    check("no duplicate cron paths in vercel.json",
      new Set(cronPaths).size === cronPaths.length);
    check("exactly one dispatcher cron entry",
      cronPaths.filter((p) => p === "/api/jobs/dispatch").length === 1);
    const dispatcherIdx = cronPaths.indexOf("/api/jobs/dispatch");
    check("the dispatcher cron is the paid-tier multi-slot schedule (off Hobby)",
      schedules[dispatcherIdx] === ACTIVE_SCHEDULE);
    check("the once/day Hobby schedule is retired from the active config",
      !vercel.includes(HOBBY_SCHEDULE));
    // Every hour any registered entry fires at must appear in the cron's hour
    // field, or that job would silently never run on cron.
    const cronHours = new Set((schedules[dispatcherIdx].split(/\s+/)[1] ?? "").split(",").map(Number));
    const registeredHours = new Set(
      SCHEDULED_JOBS.flatMap((j) => (Array.isArray(j.hourUTC) ? j.hourUTC : [j.hourUTC])),
    );
    check("every registered fire-hour is reached by the active cron",
      [...registeredHours].every((h) => cronHours.has(h)),
      `cron hours {${[...cronHours].sort((a, b) => a - b)}} vs registered {${[...registeredHours].sort((a, b) => a - b)}}`);

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
