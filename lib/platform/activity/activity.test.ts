/**
 * lib/platform/activity/activity.test.ts  (OPS-6C)
 *
 * Behavior guards for the user-activity projection. Standalone tsx (house pattern).
 * NO LIVE DATABASE: injected fake readers; the projection + Space ranking are pure.
 * Proves DAU/WAU/MAU project over the LOGIN ledger and most-active-Spaces over
 * SPACE_SWITCH — no new telemetry, no writes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { getUserActivity, countSpaceOpens, type ActivityReaders } from "@/lib/platform/activity/activity";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});

const NOW = new Date("2026-07-17T12:00:00Z");
const DAY = 86_400_000;

async function main() {
  // ── countSpaceOpens (pure; SEC-PLAT-2 — counts only) ───────────────────────────
  console.log("countSpaceOpens");
  {
    const c = countSpaceOpens([{ spaceId: "a" }, { spaceId: "b" }, { spaceId: "a" }, { spaceId: "a" }]);
    check("distinct Spaces and total opens", c.distinctSpaces === 2 && c.opens === 4);
    check("empty ⇒ zero", countSpaceOpens([]).distinctSpaces === 0 && countSpaceOpens([]).opens === 0);
    check("the result carries no id or name", Object.keys(c).sort().join(",") === "distinctSpaces,opens");
  }

  // ── DAU/WAU/MAU project over the LOGIN ledger ───────────────────────────────────
  console.log("DAU/WAU/MAU projection");
  {
    // distinctLoginUsers returns more users for a wider window (monotone).
    let factsSince: Date | null = null;
    const readers: ActivityReaders = {
      now: NOW,
      distinctLoginUsers: async (since) => {
        const days = Math.round((NOW.getTime() - since.getTime()) / DAY);
        return days <= 1 ? 3 : days <= 7 ? 12 : 40; // dau/wau/mau
      },
      totalUsers: async () => 100,
      newUsersSince: async (since) => (Math.round((NOW.getTime() - since.getTime()) / DAY) <= 7 ? 5 : 20),
      activatedEver: async () => 60,
      spaceOpensSince: async () => [
        { spaceId: "s1" }, { spaceId: "s1" }, { spaceId: "s2" },
      ],
      // BETA A3 — day-grain facts: u1 present + engaged today; u2 present
      // (sign-in day) a week ago, never engaged; u3 engaged via chat 20 days
      // ago; a harness row and a cron-like operator row that must count nowhere.
      activityFacts: async (since) => {
        factsSince = since;
        return {
          auditEvents: [
            { userId: "u1", action: "SESSION_ACTIVE_DAY", at: NOW, day: NOW.toISOString().slice(0, 10) },
            { userId: "u1", action: "SPACE_VIEWED", at: NOW, day: NOW.toISOString().slice(0, 10) },
            { userId: "u1", action: "SPACE_VIEWED", at: NOW, day: NOW.toISOString().slice(0, 10) }, // raced double row
            { userId: "u1", action: "OPERATOR_REFRESH_ALL", at: NOW },
            { userId: "u4", action: "SESSION_ACTIVE_DAY", at: new Date(NOW.getTime() - 40 * DAY), day: new Date(NOW.getTime() - 40 * DAY).toISOString().slice(0, 10) },
          ],
          sessionStarts: [{ userId: "u2", at: new Date(NOW.getTime() - 6 * DAY) }],
          aiInvocations: [
            { provider: "OPENAI", model: "gpt-5-mini", occurredAt: new Date(NOW.getTime() - 20 * DAY), promptTokens: 1, cachedPromptTokens: 0, completionTokens: 1, reasoningTokens: 0,
              latencyMs: 1, toolCallCount: 0, environment: "production", correlationId: null, turnIndex: null, surface: "chat", userId: "u3", outcome: "RETURNED" },
            { provider: "OPENAI", model: "gpt-5-mini", occurredAt: NOW, promptTokens: 1, cachedPromptTokens: 0, completionTokens: 1, reasoningTokens: 0,
              latencyMs: 1, toolCallCount: 0, environment: "production", correlationId: null, turnIndex: null, surface: "harness", userId: "u2", outcome: "RETURNED" },
          ],
          logins: [{ userId: "u2", at: new Date(NOW.getTime() - 6 * DAY) }],
        };
      },
    };
    const m = await getUserActivity({ now: NOW, readers });
    check("DAU = 1-day distinct logins", m.dau === 3);
    check("WAU = 7-day distinct logins", m.wau === 12);
    check("MAU = 30-day distinct logins", m.mau === 40);
    check("…and they are labelled as sign-ins, not activity (BETA A3)", m.signInBasis === "LOGIN");
    check("present vs engaged: today 1/1; week 2 present (u2 by sign-in day) / 1 engaged; month 2 present / 2 engaged (u3 by chat)",
      m.active.daily.present === 1 && m.active.daily.engaged === 1
      && m.active.weekly.present === 2 && m.active.weekly.engaged === 1
      && m.active.monthly.present === 2 && m.active.monthly.engaged === 2, JSON.stringify(m.active));
    check("the harness row, the operator row, the double row and the 40-day-old row count nowhere", m.active.monthly.present === 2 && m.active.monthly.engaged === 2);
    check("sign-ins ride beside present/engaged in the same window shape", m.active.weekly.signIns === 1 && m.active.daily.signIns === 0);
    check("facts are asked for from 00:00Z of the oldest of the 30 calendar days ending today",
      (factsSince as Date | null)?.toISOString() === new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() - 29)).toISOString(), String(factsSince));
    check("the basis is stated on the payload", /SESSION_ACTIVE_DAY/.test(m.activeBasis) && /never cron/.test(m.activeBasis));
    check("new users 7d / 30d", m.newUsers7 === 5 && m.newUsers30 === 20);
    check("totalUsers / activatedEver passed through", m.totalUsers === 100 && m.activatedEver === 60);
    check("Space opens from SPACE_SWITCH, as counts only", m.spaceOpens30.distinctSpaces === 2 && m.spaceOpens30.opens === 3);
    check("SEC-PLAT-2 — the payload carries no Space list, name or id", !("topSpaces" in m) && !/spaceName|spaceId/.test(JSON.stringify(m)));
  }

  // ── doctrine: pure projection, no writes ────────────────────────────────────────
  console.log("doctrine · projection, no writes");
  {
    const src = readFileSync(path.join(process.cwd(), "lib/platform/activity/activity.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("reads the AuditLog LOGIN + SPACE_SWITCH ledger", /AuditAction\.LOGIN/.test(src) && /SPACE_SWITCH/.test(src));
    check("SEC-PLAT-2 — SPACE_SWITCH is read as spaceId only (no metadata, so no customer-chosen name)",
      /action: AuditAction\.SPACE_SWITCH[\s\S]{0,200}select: \{ spaceId: true \}/.test(src) && !/spaceName/.test(src));
    check("writes nothing (no create/update/delete)", !/\.(create|update|updateMany|delete|deleteMany|upsert)\(/.test(src));
    check("no new telemetry emission (no recordApiUsage/emit)", !/recordApiUsage|\bemit\(/.test(src));
    check("BETA A3 — present/engaged come from the ONE shared predicate (core fold + shared loader), restated nowhere here",
      /activitySets\(/.test(src) && /loadActivityFacts\(systemDb, since\)/.test(src)
      && !/AuditAction\.(SESSION_ACTIVE_DAY|SPACE_VIEWED|BRIEF_VIEWED|TRANSACTIONS_VIEWED|ACCOUNT_ADD|WALLET_ADD|MANUAL_ASSET_ADD)|surface:/.test(src));
  }

  if (failures > 0) { console.error(`\nactivity.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nactivity.test: all passed.");
}

void main();
