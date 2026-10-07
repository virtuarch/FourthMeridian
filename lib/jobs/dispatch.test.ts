/**
 * lib/jobs/dispatch.test.ts  (OPS-4 S2 · P1 scheduling control)
 *
 * Pure guards for the ledger-driven dispatcher. Standalone tsx script:
 * npx tsx lib/jobs/dispatch.test.ts — exits 0/1.
 *
 * NO LIVE DATABASE: selectDueJobs is pure over injected facts + policies, and
 * dispatchDueJobs takes an injected jobs list, facts, policies and runner, so no
 * real job body (and no Prisma) ever executes here. Covers: due-ness from the
 * ledger (never ran · cadence elapsed · tolerance · not yet due) · the overlap
 * guard (a live `running` row is never re-dispatched; a stale one is) ·
 * continuations (only after deferred work, after the delay, once per primary
 * run) · registry integrity · execution through the runner with trigger "cron"
 * · sequencing · isolation · no-op wakes · source scans (one dispatcher cron at
 * the 15-minute wake · fallback routes · no queue/retry infrastructure).
 */

import { existsSync, readFileSync } from "node:fs";
import { dispatchDueJobs, selectDueJobs, type JobLedgerFacts } from "@/lib/jobs/dispatch";
import { SCHEDULED_JOBS, type ScheduledJob } from "@/lib/jobs/registry";
import { defaultJobCadencePolicies } from "@/lib/jobs/cadence-policy";
import {
  CONTINUATION_DELAY_MS, DUE_TOLERANCE_MS, IN_FLIGHT_WINDOW_MS, WAKE_EVERY_MINUTES, resolveJobCadences,
  type JobCadencePolicy,
} from "@/lib/jobs/cadence-policy.core";
import { defaultRefreshPolicies } from "@/lib/platform/refresh-policy.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

const NOW = new Date(Date.UTC(2026, 9, 8, 6, 7, 0));
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const HOUR_MS = 3_600_000;

function fakeJobs(): ScheduledJob[] {
  return [
    { name: "a", hourUTC: 6, minuteUTC: 0, cadence: { minHours: 6, maxHours: 168 }, run: async () => ({ ok: 1 }) },
    { name: "b", hourUTC: [0, 6, 12, 18], minuteUTC: 0, cadence: { minHours: 1, maxHours: 168 }, run: async () => ({ ok: 2 }) },
    { name: "c", hourUTC: 7, minuteUTC: 30, run: async () => ({ ok: 3 }) }, // FIXED daily
  ];
}
const policiesFor = (jobs: readonly ScheduledJob[]) => resolveJobCadences(jobs, new Map(), defaultRefreshPolicies());
const facts = (m: Record<string, { at: Date | null; status?: string; summary?: unknown }>): JobLedgerFacts =>
  new Map(Object.entries(m).map(([k, v]) => [k, { lastStartedAt: v.at, lastStatus: v.status ?? (v.at ? "succeeded" : null), lastSummary: v.summary }]));

function muteConsole<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log; const origErr = console.error;
  console.log = () => {}; console.error = () => {};
  return fn().finally(() => { console.log = origLog; console.error = origErr; });
}

async function main(): Promise<void> {
  console.log("dispatcher (P1 — ledger-driven)");

  // ── 1. Due-ness from the ledger ───────────────────────────────────────────
  {
    const jobs = fakeJobs(); const pol = policiesFor(jobs);
    const names = (f: JobLedgerFacts) => selectDueJobs(NOW, jobs, f, pol).due.map((j) => j.name).join();
    check("a job that never ran is due at the first wake", names(facts({})) === "a,b,c");
    check("cadence elapsed (24h daily job, 25h ago) ⇒ due", names(facts({ a: { at: hoursAgo(25) }, b: { at: hoursAgo(1) }, c: { at: hoursAgo(1) } })) === "a");
    check("not yet due (daily job, 3h ago) ⇒ skipped with NOT_YET_DUE and a next-due instant",
      (() => { const r = selectDueJobs(NOW, jobs, facts({ a: { at: hoursAgo(3) }, b: { at: hoursAgo(1) }, c: { at: hoursAgo(1) } }), pol);
        const sk = r.skipped.find((x) => x.job === "a"); return r.due.length === 0 && sk?.reason === "NOT_YET_DUE" && sk.nextDueAt === new Date(hoursAgo(3).getTime() + 24 * HOUR_MS - DUE_TOLERANCE_MS).toISOString(); })());
    check("tolerance: a 6-hourly job 5h55m ago is due (a wake 5 minutes early does not cost a whole wake)",
      names(facts({ a: { at: hoursAgo(1) }, b: { at: new Date(NOW.getTime() - 6 * HOUR_MS + 5 * 60_000 - 1) }, c: { at: hoursAgo(1) } })) === "b");
    check("…but 5h50m ago is not", names(facts({ a: { at: hoursAgo(1) }, b: { at: new Date(NOW.getTime() - 6 * HOUR_MS + 10 * 60_000) }, c: { at: hoursAgo(1) } })) === "");
    check("the FIXED daily job follows the same rule", names(facts({ a: { at: hoursAgo(1) }, b: { at: hoursAgo(1) }, c: { at: hoursAgo(26) } })) === "c");
  }

  // ── 2. Overlap guard ──────────────────────────────────────────────────────
  {
    const jobs = fakeJobs(); const pol = policiesFor(jobs);
    const live = facts({ a: { at: new Date(NOW.getTime() - 2 * 60_000), status: "running" }, b: { at: hoursAgo(1) }, c: { at: hoursAgo(1) } });
    const r = selectDueJobs(NOW, jobs, live, pol);
    check("a live `running` row (2 min old) is IN_FLIGHT — never dispatched twice", r.due.length === 0 && r.skipped.find((x) => x.job === "a")?.reason === "IN_FLIGHT");
    const stale = facts({ a: { at: new Date(NOW.getTime() - IN_FLIGHT_WINDOW_MS - 1), status: "running" }, b: { at: hoursAgo(1) }, c: { at: hoursAgo(1) } });
    check("a stale `running` row (older than the in-flight window) is a crashed run, not a lock — judged by age like any run",
      selectDueJobs(NOW, jobs, stale, pol).skipped.find((x) => x.job === "a")?.reason === "NOT_YET_DUE");
    const crashedLongAgo = facts({ a: { at: hoursAgo(30), status: "running" }, b: { at: hoursAgo(1) }, c: { at: hoursAgo(1) } });
    check("a crashed run 30h ago leaves the daily job due", selectDueJobs(NOW, jobs, crashedLongAgo, pol).due.map((j) => j.name).join() === "a");
  }

  // ── 3. Continuations ──────────────────────────────────────────────────────
  {
    const jobs: ScheduledJob[] = [
      { name: "sweep", hourUTC: [0, 6, 12, 18], minuteUTC: 0, refreshes: "WALLET", run: async () => ({}) },
      { name: "sweep-continuation", hourUTC: [0, 6, 12, 18], minuteUTC: 30, refreshes: "WALLET", continuationOf: "sweep", run: async () => ({}) },
    ];
    const pol = policiesFor(jobs);
    const cont = (f: JobLedgerFacts) => selectDueJobs(NOW, jobs, f, pol);
    const twentyMinAgo = new Date(NOW.getTime() - 20 * 60_000);
    check("primary never ran ⇒ continuation PRIMARY_NOT_RUN", cont(facts({})).skipped.find((x) => x.job === "sweep-continuation")?.reason === "PRIMARY_NOT_RUN");
    check("primary finished with nothing deferred ⇒ NO_DEFERRED_WORK",
      cont(facts({ sweep: { at: twentyMinAgo, summary: { deferred: 0 } } })).skipped.find((x) => x.job === "sweep-continuation")?.reason === "NO_DEFERRED_WORK");
    check("deferred work but too soon ⇒ CONTINUATION_TOO_SOON with the earliest instant",
      (() => { const r = cont(facts({ sweep: { at: new Date(NOW.getTime() - 5 * 60_000), summary: { deferred: 3 } } })).skipped.find((x) => x.job === "sweep-continuation");
        return r?.reason === "CONTINUATION_TOO_SOON" && r.nextDueAt === new Date(NOW.getTime() - 5 * 60_000 + CONTINUATION_DELAY_MS).toISOString(); })());
    check("deferred work, delay passed, not yet continued ⇒ due",
      cont(facts({ sweep: { at: twentyMinAgo, summary: { deferred: 3 } } })).due.map((j) => j.name).join() === "sweep-continuation");
    check("already continued since that primary run ⇒ ALREADY_CONTINUED",
      cont(facts({ sweep: { at: twentyMinAgo, summary: { deferred: 3 } }, "sweep-continuation": { at: new Date(NOW.getTime() - 60_000) } }))
        .skipped.find((x) => x.job === "sweep-continuation")?.reason === "ALREADY_CONTINUED");
    check("the primary itself (6h wallet cadence, 20 min ago) is not due", cont(facts({ sweep: { at: twentyMinAgo, summary: { deferred: 3 } } })).skipped.find((x) => x.job === "sweep")?.reason === "NOT_YET_DUE");
  }

  // ── 4. Registry integrity ─────────────────────────────────────────────────
  {
    const byName = new Map(SCHEDULED_JOBS.map((j) => [j.name, j]));
    const pol = defaultJobCadencePolicies(SCHEDULED_JOBS);
    const hours = (n: string) => pol.get(n)?.hours;
    const origin = (n: string) => pol.get(n)?.origin;
    check("registry holds eleven jobs", SCHEDULED_JOBS.length === 11, `got ${SCHEDULED_JOBS.length}`);
    check("names unique", byName.size === SCHEDULED_JOBS.length);
    check("sync-banks runs on the BANK refresh policy (24h default)", hours("sync-banks") === 24 && origin("sync-banks") === "REFRESH_POLICY");
    check("sync-crypto runs on the WALLET refresh policy (6h default)", hours("sync-crypto") === 6 && origin("sync-crypto") === "REFRESH_POLICY");
    check("sync-crypto-continuation follows its primary", origin("sync-crypto-continuation") === "FOLLOWS_PRIMARY" && hours("sync-crypto-continuation") === 6);
    check("fetch-fx-rates / fetch-security-prices default daily, editable 6–168h",
      (["fetch-fx-rates", "fetch-security-prices"] as const).every((n) => hours(n) === 24 && origin(n) === "DEFAULT" && pol.get(n)?.editable && pol.get(n)?.minHours === 6 && pol.get(n)?.maxHours === 168));
    check("evaluate-alerts defaults to 6h, editable down to hourly", hours("evaluate-alerts") === 6 && origin("evaluate-alerts") === "DEFAULT" && pol.get("evaluate-alerts")?.minHours === 1);
    check("process-deletions and the maintenance jobs are FIXED daily (legal/retention semantics, not operator preference)",
      (["process-deletions", "notification-cleanup", "notification-retry", "purge-trash", "rate-limit-sweep"] as const).every((n) => origin(n) === "FIXED" && hours(n) === 24 && !pol.get(n)?.editable));
    check("notification-retry sequenced AFTER notification-cleanup (never re-mail aged-out rows)",
      SCHEDULED_JOBS.findIndex((j) => j.name === "notification-retry") > SCHEDULED_JOBS.findIndex((j) => j.name === "notification-cleanup"));
    check("evaluate-alerts sequenced LAST (reads the freshest state in a wake)", SCHEDULED_JOBS.findIndex((j) => j.name === "evaluate-alerts") === SCHEDULED_JOBS.length - 1);
    check("deferred work stays deferred (no digest / quiet-hours jobs)", !SCHEDULED_JOBS.some((j) => /digest|quiet/i.test(j.name)));
    check("sync-banks refreshes BANK; no other job binds a source kind",
      byName.get("sync-banks")?.refreshes === "BANK"
        && SCHEDULED_JOBS.filter((j) => j.refreshes).map((j) => j.name).sort().join() === "sync-banks,sync-crypto,sync-crypto-continuation");
    const editable = SCHEDULED_JOBS.filter((j) => j.cadence).map((j) => j.name).sort().join();
    check("exactly three jobs carry an editable cadence of their own", editable === "evaluate-alerts,fetch-fx-rates,fetch-security-prices", editable);
  }

  // ── 5. Execution through the runner, in registry order, trigger "cron" ────
  {
    const ran: string[] = []; const triggers: string[] = [];
    const jobs = fakeJobs();
    const result = await muteConsole(() => dispatchDueJobs(NOW, {
      jobs, facts: facts({}), policies: policiesFor(jobs),
      runner: async (name, fn, options) => { ran.push(name); triggers.push(options.trigger); return fn(); },
    }));
    check("every due job executes through the runner (runJob seam)", ran.join() === "a,b,c");
    check("sequencing follows registry order", ran[0] === "a" && ran[1] === "b" && ran[2] === "c");
    check("trigger is \"cron\"", triggers.every((t) => t === "cron"));
    check("outcome reports each job ok and nothing skipped", result.dispatched.every((d) => d.ok) && result.failures === 0 && result.skipped.length === 0);
    check("wake label rendered", result.slot === "06:07 UTC");
  }

  // ── 6. Isolation ──────────────────────────────────────────────────────────
  {
    const ran: string[] = [];
    const jobs = fakeJobs();
    jobs[0].run = async () => { throw new Error("first job exploded"); };
    const result = await muteConsole(() => dispatchDueJobs(NOW, {
      jobs, facts: facts({}), policies: policiesFor(jobs),
      runner: async (name, fn) => { ran.push(name); return fn(); },
    }));
    check("siblings still run after a failure", ran.join() === "a,b,c");
    check("dispatch never throws; failure recorded in outcome",
      result.failures === 1 && result.dispatched[0].ok === false && result.dispatched[0].error === "first job exploded" && result.dispatched[1].ok === true);
  }

  // ── 7. No-op wake ─────────────────────────────────────────────────────────
  {
    const jobs = fakeJobs();
    const result = await muteConsole(() => dispatchDueJobs(NOW, {
      jobs, facts: facts({ a: { at: hoursAgo(1) }, b: { at: hoursAgo(1) }, c: { at: hoursAgo(1) } }), policies: policiesFor(jobs),
      runner: async () => { throw new Error("must not run"); },
    }));
    check("a wake with nothing due is a clean no-op that still reports what it considered",
      result.dispatched.length === 0 && result.failures === 0 && result.skipped.length === 3 && result.skipped.every((s) => s.reason === "NOT_YET_DUE"));
  }

  // ── 8. Source scans — wake vs execution ───────────────────────────────────
  {
    const vercel = readFileSync("vercel.json", "utf8");
    const cronPaths = [...vercel.matchAll(/"path":\s*"([^"]+)"/g)].map((m) => m[1]);
    const schedules = [...vercel.matchAll(/"schedule":\s*"([^"]+)"/g)].map((m) => m[1]);
    check("no duplicate cron paths in vercel.json", new Set(cronPaths).size === cronPaths.length);
    check("exactly one dispatcher cron entry", cronPaths.filter((p) => p === "/api/jobs/dispatch").length === 1);
    const dispatcherIdx = cronPaths.indexOf("/api/jobs/dispatch");
    check(`the dispatcher is WOKEN every ${WAKE_EVERY_MINUTES} minutes (vercel.json is infrastructure cadence, not execution policy)`,
      schedules[dispatcherIdx] === `*/${WAKE_EVERY_MINUTES} * * * *`, schedules[dispatcherIdx]);
    check("the retired slot schedules are gone from the active config", !/0,30 0,6,7,12,18/.test(vercel) && !vercel.includes("0 6 * * *"));

    const dispatchRoute = readFileSync("app/api/jobs/dispatch/route.ts", "utf8");
    check("dispatcher route keeps CRON_SECRET protection", dispatchRoute.includes("CRON_SECRET") && dispatchRoute.includes("401"));
    check("per-job fallback routes retained (individual revertibility)",
      ["sync-banks", "fetch-fx-rates", "process-deletions"].every((name) => existsSync(`app/api/jobs/${name}/route.ts`)));
    check("jobs/scheduler.ts is retired (deleted)", !existsSync("jobs/scheduler.ts"));

    const code = ["lib/jobs/dispatch.ts", "lib/jobs/registry.ts", "lib/jobs/cadence-policy.core.ts", "app/api/jobs/dispatch/route.ts"]
      .map((p) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))
      .join("\n");
    check("no queue/telemetry/scheduler infrastructure in dispatcher code",
      !/setInterval|setTimeout|node-cron|BullMQ|new Queue|SQS|EventBridge|startScheduler/i.test(code)
        && !/\b(withRetry|pRetry|retryWrapper|backoff)\w*\(/i.test(code) && !/telemetry/i.test(code));
    const dispatchSrc = readFileSync("lib/jobs/dispatch.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("the dispatcher no longer matches slots (no getUTCHours-based selection)", !/firesAtHour|slotMinute|minuteUTC ===/.test(dispatchSrc));
    check("the dispatcher reads the ledger through the system role, not the migration principal", /systemDb/.test(dispatchSrc) && !/import \{ db \}/.test(dispatchSrc));
  }

  if (failures > 0) { console.error(`\ndispatcher tests: ${failures} FAILED`); process.exit(1); }
  console.log("\ndispatcher tests: all passed");
  process.exit(0);
}

main().catch((err) => { console.error("  ✗ test harness error:", err); process.exit(1); });
export type { JobCadencePolicy };
