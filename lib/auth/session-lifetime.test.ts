/**
 * lib/auth/session-lifetime.test.ts — SEC-010: a session row past its idle
 * (30 d since lastActiveAt) or absolute (90 d since createdAt) lifetime proves
 * nothing, whatever the 30-day rolling JWT says.
 *
 * Fixed clocks throughout — no test depends on the wall clock.
 *
 *     npx tsx lib/auth/session-lifetime.test.ts
 */

import {
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_ROW_SELECT,
  factsFromRow,
  judgeSessionLifetime,
} from "./session-proof";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const at  = (daysAgo: number) => new Date(NOW - daysAgo * DAY);
const clock = { now: () => NOW };
const never = async (): Promise<boolean> => false;
const row = (createdDaysAgo: number, activeDaysAgo: number) => ({
  userId: "u1", revokedAt: null, createdAt: at(createdDaysAgo), lastActiveAt: at(activeDaysAgo),
  user: { id: "u1", role: "USER", totpEnabled: true },
});

async function main() {
  console.log("session lifetime (SEC-010)\n\nA. the defaults");
  check("idle timeout is 30 days", SESSION_IDLE_TIMEOUT_MS === 30 * DAY);
  check("absolute lifetime is 90 days", SESSION_ABSOLUTE_LIFETIME_MS === 90 * DAY);
  check("the session lookup selects both timestamps (no schema change: the columns exist)",
    SESSION_ROW_SELECT.createdAt === true && SESSION_ROW_SELECT.lastActiveAt === true);

  console.log("\nB. judgeSessionLifetime (fixed clock)");
  check("fresh session → LIVE", judgeSessionLifetime(row(1, 0), clock) === "LIVE");
  check("used 29.9 days ago → LIVE", judgeSessionLifetime({ createdAt: at(40), lastActiveAt: new Date(NOW - 30 * DAY + 60_000) }, clock) === "LIVE");
  check("exactly 30 days idle → LIVE (boundary is strict >)", judgeSessionLifetime({ createdAt: at(40), lastActiveAt: at(30) }, clock) === "LIVE");
  check("30 days + 1 minute idle → IDLE_EXPIRED",
    judgeSessionLifetime({ createdAt: at(40), lastActiveAt: new Date(NOW - 30 * DAY - 60_000) }, clock) === "IDLE_EXPIRED");
  check("active today but created 91 days ago → ABSOLUTE_EXPIRED (activity never extends it)",
    judgeSessionLifetime(row(91, 0), clock) === "ABSOLUTE_EXPIRED");
  check("exactly 90 days old → LIVE", judgeSessionLifetime(row(90, 0), clock) === "LIVE");
  check("both exceeded → ABSOLUTE_EXPIRED (absolute judged first)", judgeSessionLifetime(row(200, 100), clock) === "ABSOLUTE_EXPIRED");
  check("missing createdAt → MALFORMED", judgeSessionLifetime({ lastActiveAt: at(0) }, clock) === "MALFORMED");
  check("missing lastActiveAt → MALFORMED", judgeSessionLifetime({ createdAt: at(0) }, clock) === "MALFORMED");
  check("invalid date → MALFORMED", judgeSessionLifetime({ createdAt: new Date("nope"), lastActiveAt: at(0) }, clock) === "MALFORMED");
  check("ISO strings are accepted (raw / JSON rows)",
    judgeSessionLifetime({ createdAt: at(1).toISOString(), lastActiveAt: at(0).toISOString() }, clock) === "LIVE");
  check("limits are injectable (a 1-hour idle policy)",
    judgeSessionLifetime({ createdAt: at(0), lastActiveAt: new Date(NOW - 2 * 60 * 60 * 1000) }, { ...clock, idleTimeoutMs: 60 * 60 * 1000 }) === "IDLE_EXPIRED");

  console.log("\nC. factsFromRow refuses an expired row");
  const live = await factsFromRow(row(10, 1), never, clock);
  check("control: a live row yields facts", live?.userId === "u1" && live?.role === "USER", JSON.stringify(live));
  check("idle row (31 days) → null", (await factsFromRow(row(60, 31), never, clock)) === null);
  check("old row (100 days, active today) → null", (await factsFromRow(row(100, 0), never, clock)) === null);
  check("row without timestamps → null (malformed is a refusal)",
    (await factsFromRow({ userId: "u1", revokedAt: null, user: { id: "u1", role: "USER", totpEnabled: true } }, never, clock)) === null);
  let settingRead = false;
  await factsFromRow({ ...row(100, 0), user: { id: "u1", role: "USER", totpEnabled: false } }, async () => { settingRead = true; return false; }, clock);
  check("an expired row is refused before the TOTP setting is read", settingRead === false);

  if (failures > 0) { console.error(`\nsession-lifetime: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\nsession-lifetime: all checks passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
