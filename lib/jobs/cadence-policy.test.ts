/**
 * lib/jobs/cadence-policy.test.ts  (P1) — the pure cadence resolver and due rule.
 * Run: npx tsx lib/jobs/cadence-policy.test.ts
 */
import { SCHEDULED_JOB_FACTS } from "@/lib/jobs/registry.core";
import {
  CONTINUATION_DELAY_MS, DUE_TOLERANCE_MS, IN_FLIGHT_WINDOW_MS, decideJobDue, jobCadenceSettingKey, nextDueAt,
  parseCadenceHours, resolveJobCadence, resolveJobCadences,
} from "./cadence-policy.core";
import { defaultRefreshPolicies, resolveRefreshPolicy } from "@/lib/platform/refresh-policy.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const NOW = new Date("2026-10-08T06:07:00.000Z");
const by = (n: string) => SCHEDULED_JOB_FACTS.find((j) => j.name === n)!;
const defaults = defaultRefreshPolicies();

console.log("setting keys");
check("fx has its own key", jobCadenceSettingKey(by("fetch-fx-rates")) === "job_cadence_hours_fetch-fx-rates");
check("a refresh job has none (its knob is the refresh policy)", jobCadenceSettingKey(by("sync-banks")) === null);
check("a continuation has none", jobCadenceSettingKey(by("sync-crypto-continuation")) === null);
check("a fixed job has none", jobCadenceSettingKey(by("process-deletions")) === null);

console.log("resolver");
{
  const fx = resolveJobCadence(by("fetch-fx-rates"), null, defaults);
  check("DEFAULT: fx every 24h, editable 6–168", fx.origin === "DEFAULT" && fx.hours === 24 && fx.editable && fx.minHours === 6 && fx.maxHours === 168);
  const fxSet = resolveJobCadence(by("fetch-fx-rates"), { value: "12", updatedAt: NOW }, defaults);
  check("SETTING: a row within bounds is the cadence; version carries the row clock", fxSet.origin === "SETTING" && fxSet.hours === 12 && fxSet.version.includes(NOW.toISOString()));
  const fxBad = resolveJobCadence(by("fetch-fx-rates"), { value: "2", updatedAt: NOW }, defaults);
  check("INVALID_SETTING: a row below the floor is NOT honoured — the default is in force and the note says so", fxBad.origin === "INVALID_SETTING" && fxBad.hours === 24 && /unreadable or out of bounds/.test(fxBad.note));
  const banks = resolveJobCadence(by("sync-banks"), null, defaults);
  check("REFRESH_POLICY: sync-banks is the BANK policy (24h), not editable here, pointing at the refresh key", banks.origin === "REFRESH_POLICY" && banks.hours === 24 && !banks.editable && banks.settingKey === "refresh_cadence_bank");
  const twelve = { ...defaults, WALLET: resolveRefreshPolicy({ sourceKind: "WALLET" }, { value: "12h", updatedAt: NOW }) };
  const crypto = resolveJobCadence(by("sync-crypto"), null, twelve);
  check("REFRESH_POLICY follows a wallet override (12h)", crypto.hours === 12 && crypto.version.includes("12h"));
  const all = resolveJobCadences(SCHEDULED_JOB_FACTS, new Map(), twelve);
  check("FOLLOWS_PRIMARY: the continuation takes its primary's hours", all.get("sync-crypto-continuation")?.origin === "FOLLOWS_PRIMARY" && all.get("sync-crypto-continuation")?.hours === 12);
  check("FIXED: process-deletions daily, not editable", all.get("process-deletions")?.origin === "FIXED" && all.get("process-deletions")?.hours === 24 && !all.get("process-deletions")?.editable);
  check("every registered job resolves", SCHEDULED_JOB_FACTS.every((j) => all.has(j.name)));
  check("parseCadenceHours bounds and rejects garbage", parseCadenceHours("6", 6, 168) === 6 && parseCadenceHours("5", 6, 168) === null && parseCadenceHours("169", 6, 168) === null && parseCadenceHours("1.5", 1, 168) === null && parseCadenceHours(6, 1, 168) === null);
}

console.log("due rule");
{
  const fx = { name: "fetch-fx-rates" };
  const p = { hours: 24 };
  check("never ran ⇒ due", decideJobDue(fx, p, null, NOW).due);
  const d = decideJobDue(fx, p, { lastStartedAt: new Date(NOW.getTime() - 25 * 3_600_000), lastStatus: "succeeded" }, NOW);
  check("25h ago on a daily cadence ⇒ CADENCE_ELAPSED", d.due && d.reason === "CADENCE_ELAPSED");
  const nd = decideJobDue(fx, p, { lastStartedAt: new Date(NOW.getTime() - 3 * 3_600_000), lastStatus: "succeeded" }, NOW);
  check("3h ago ⇒ NOT_YET_DUE with nextDueAt = last + 24h − tolerance", !nd.due && nd.reason === "NOT_YET_DUE" && nd.nextDueAt?.getTime() === NOW.getTime() - 3 * 3_600_000 + 24 * 3_600_000 - DUE_TOLERANCE_MS);
  const inflight = decideJobDue(fx, p, { lastStartedAt: new Date(NOW.getTime() - 60_000), lastStatus: "running" }, NOW);
  check("a live running row ⇒ IN_FLIGHT", !inflight.due && inflight.reason === "IN_FLIGHT");
  const crashed = decideJobDue(fx, p, { lastStartedAt: new Date(NOW.getTime() - IN_FLIGHT_WINDOW_MS - 30 * 3_600_000), lastStatus: "running" }, NOW);
  check("a stale running row is judged by age (due)", crashed.due);
  check("nextDueAt(null) is null", nextDueAt(null, p) === null);
  const cont = { name: "c", continuationOf: "p" };
  const primary = { lastStartedAt: new Date(NOW.getTime() - CONTINUATION_DELAY_MS - 60_000), lastStatus: "succeeded", lastSummary: { deferred: 2 } };
  check("continuation due after deferred work + delay", decideJobDue(cont, { hours: 6 }, null, NOW, primary).due);
  check("continuation not due without deferred work", !decideJobDue(cont, { hours: 6 }, null, NOW, { ...primary, lastSummary: { deferred: 0 } }).due);
}

console.log("prompt start — sol-history-backfill (2026-10-28)");
{
  const sol = by("sol-history-backfill");
  const pol = resolveJobCadence(sol, null, defaults);
  check("DEFAULT: hourly, editable 1–24 h through its own key", pol.origin === "DEFAULT" && pol.hours === 1 && pol.editable
    && pol.minHours === 1 && pol.maxHours === 24 && jobCadenceSettingKey(sol) === "job_cadence_hours_sol-history-backfill");
  check("an operator override within bounds is honoured (6 h)", resolveJobCadence(sol, { value: "6", updatedAt: NOW }, defaults).hours === 6);
  check("a row past the ceiling is NOT honoured (48 h ⇒ hourly default)", resolveJobCadence(sol, { value: "48", updatedAt: NOW }, defaults).origin === "INVALID_SETTING");
  const ago = (min: number, summary?: unknown) => ({ lastStartedAt: new Date(NOW.getTime() - min * 60_000), lastStatus: "succeeded", lastSummary: summary });
  const idle = { deferred: 0, stoppedBecause: "NO_WORK" };
  // A wallet added right after a no-work run waits at most one hour (− tolerance), not a 6-hour slot.
  const d61 = decideJobDue(sol, pol, ago(61, idle), NOW);
  check("no-work run 61 min ago ⇒ CADENCE_ELAPSED (a new wallet starts within the hour)", d61.due && d61.reason === "CADENCE_ELAPSED");
  const d56 = decideJobDue(sol, pol, ago(56, idle), NOW);
  check("…56 min ago is inside the 5-min tolerance ⇒ due", d56.due);
  const d30 = decideJobDue(sol, pol, ago(30, idle), NOW);
  check("no-work run 30 min ago ⇒ NOT_YET_DUE, next at last + 55 min", !d30.due && d30.reason === "NOT_YET_DUE"
    && d30.nextDueAt?.getTime() === NOW.getTime() - 30 * 60_000 + 3_600_000 - DUE_TOLERANCE_MS);
  const c16 = decideJobDue(sol, pol, ago(16, { deferred: 3 }), NOW);
  check("deferred work ⇒ SELF_CONTINUATION ~15 min later (unchanged by the hourly cadence)", c16.due && c16.reason === "SELF_CONTINUATION");
  const c10 = decideJobDue(sol, pol, ago(10, { deferred: 3 }), NOW);
  check("…but not before the continuation delay", !c10.due);
  check("…and NOT_YET_DUE then reports the CONTINUATION time (+15 min), not the cadence (+55 min)",
    !c10.due && c10.reason === "NOT_YET_DUE" && c10.nextDueAt?.getTime() === NOW.getTime() - 10 * 60_000 + 15 * 60_000, c10.due ? "" : String(c10.nextDueAt?.toISOString()));
  const c10idle = decideJobDue(sol, pol, ago(10, idle), NOW);
  check("…while a run without deferred work still reports the cadence time",
    !c10idle.due && c10idle.nextDueAt?.getTime() === NOW.getTime() - 10 * 60_000 + 3_600_000 - DUE_TOLERANCE_MS);
  const failed = decideJobDue(sol, pol, { ...ago(61), lastStatus: "failed" }, NOW);
  check("a failed run is retried on the hourly cadence", failed.due && failed.reason === "CADENCE_ELAPSED");
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
