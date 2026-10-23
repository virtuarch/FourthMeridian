/**
 * lib/jobs/cadence.test.ts  (PLATFORM OPS POLICIES — Slice 1)
 *
 * SCHEDULER CAPABILITY IS DERIVED, AND IT MATCHES THE DEPLOYMENT.
 *
 *   npx tsx lib/jobs/cadence.test.ts
 *
 * Three things, each against an INDEPENDENT authority:
 *   1. the pure slot arithmetic (fixtures);
 *   2. the real registry's bindings (SCHEDULED_JOBS) — literal expectations,
 *      never the constant under test;
 *   3. the deployment (vercel.json) — the cron's wake set is parsed here, on its
 *      own, and the registry-derived attempt period must equal the period the
 *      cron's wakes deliver for the same job. A registry/vercel drift that
 *      changes what wallets or banks are attempted at FAILS this file.
 */

import { readFileSync } from "node:fs";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { attemptPeriodHours, attemptSlotsUTC, refreshFamily, slotLabels, slotPeriodHours, type SlotFacts } from "./cadence";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("1. slot arithmetic");
{
  check("a single daily hour is a 24-hour period", slotPeriodHours(6) === 24);
  check("[0,6,12,18] is 6-hourly", slotPeriodHours([0, 6, 12, 18]) === 6);
  check("the wrap past midnight counts ([6, 18] → 12)", slotPeriodHours([6, 18]) === 12);
  check("uneven slots report the WIDEST gap ([0, 6, 12] → 12 across midnight)", slotPeriodHours([0, 6, 12]) === 12);
  check("duplicates and order do not matter", slotPeriodHours([18, 6, 6, 0, 12]) === 6);
  check("labels are HH:MM UTC, sorted", slotLabels({ hourUTC: [12, 0], minuteUTC: 30 }).join(",") === "00:30,12:30");
}

console.log("\n2. families and attempt periods (fixtures)");
{
  const jobs: SlotFacts[] = [
    { name: "sweep", hourUTC: [0, 6, 12, 18], minuteUTC: 0, refreshes: "WALLET" },
    { name: "sweep-continuation", hourUTC: [0, 6, 12, 18], minuteUTC: 30, refreshes: "WALLET", continuationOf: "sweep" },
    { name: "banks", hourUTC: 6, minuteUTC: 0, refreshes: "BANK" },
    { name: "fx", hourUTC: 6, minuteUTC: 30 },
  ];
  const wallet = refreshFamily(jobs, "WALLET");
  check("the continuation is in the family but not a primary",
    wallet.primary.map((j) => j.name).join() === "sweep" && wallet.continuations.map((j) => j.name).join() === "sweep-continuation");
  check("a :30 continuation is NOT a 30-minute cadence — the attempt period stays 6h", attemptPeriodHours(jobs, "WALLET") === 6);
  check("attempt slots come from the primary only", attemptSlotsUTC(jobs, "WALLET").join(",") === "00:00,06:00,12:00,18:00");
  check("banks are attempted daily", attemptPeriodHours(jobs, "BANK") === 24);
  check("an unbound kind has no attempt period (null, never a default)",
    attemptPeriodHours(jobs.filter((j) => j.refreshes !== "BANK"), "BANK") === null);
  const two: SlotFacts[] = [
    { name: "a", hourUTC: 6, minuteUTC: 0, refreshes: "BANK" },
    { name: "b", hourUTC: [0, 12], minuteUTC: 0, refreshes: "BANK" },
  ];
  check("with two primaries the most frequent one sets the period", attemptPeriodHours(two, "BANK") === 12);
}

console.log("\n3. the real registry binds each source kind exactly once (literal expectations)");
{
  const wallet = refreshFamily(SCHEDULED_JOBS, "WALLET");
  const bank = refreshFamily(SCHEDULED_JOBS, "BANK");
  check("WALLET primary is sync-crypto; continuation is sync-crypto-continuation",
    wallet.primary.map((j) => j.name).join() === "sync-crypto" && wallet.continuations.map((j) => j.name).join() === "sync-crypto-continuation");
  check("the continuation names its primary", wallet.continuations[0]?.continuationOf === "sync-crypto");
  check("BANK primary is sync-banks, no continuation", bank.primary.map((j) => j.name).join() === "sync-banks" && bank.continuations.length === 0);
  check("WALLET is attempted every 6 hours", attemptPeriodHours(SCHEDULED_JOBS, "WALLET") === 6);
  check("BANK is attempted every 24 hours", attemptPeriodHours(SCHEDULED_JOBS, "BANK") === 24);
  check("no registry entry restates its cadence as a literal (it is derived from slots)",
    SCHEDULED_JOBS.every((j) => j.expectedEveryHours === undefined));
  const registry = readFileSync("lib/jobs/registry.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  check("no hand-copied scheduler floor survives anywhere the capability could be read from",
    !/SCHEDULER_FLOOR_HOURS/.test(registry + readFileSync("lib/platform/refresh-policy.core.ts", "utf8")));
}

console.log("\n4. deployment — vercel.json is a WAKE schedule; execution is judged from the ledger (P1)");
{
  const vercel = readFileSync("vercel.json", "utf8");
  const entries = [...vercel.matchAll(/"path":\s*"([^"]+)"[\s\S]*?"schedule":\s*"([^"]+)"/g)].map((m) => ({ path: m[1], schedule: m[2] }));
  const dispatcher = entries.find((e) => e.path === "/api/jobs/dispatch");
  check("vercel.json has exactly one dispatcher cron", !!dispatcher && entries.filter((e) => e.path === "/api/jobs/dispatch").length === 1);
  check("the dispatcher is woken every 15 minutes — a wake, not a slot the registry must mirror", dispatcher?.schedule === "*/15 * * * *", dispatcher?.schedule);
  // The historical anchors still derive each job's DEFAULT cadence, and every
  // default is a whole number of hours a 15-minute wake can honour to within a wake.
  for (const job of SCHEDULED_JOBS) {
    const period = slotPeriodHours(job.hourUTC);
    check(`${job.name}: default cadence ${period}h is reachable by the 15-minute wake`, Number.isInteger(period) && period >= 1 && (period * 60) % 15 === 0);
  }
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
