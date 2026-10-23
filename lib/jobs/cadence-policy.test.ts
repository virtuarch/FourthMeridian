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

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
