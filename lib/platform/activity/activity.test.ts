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
import { getUserActivity, rankSpaces, type ActivityReaders } from "@/lib/platform/activity/activity";

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
  // ── rankSpaces (pure) ──────────────────────────────────────────────────────────
  console.log("rankSpaces");
  {
    const ranked = rankSpaces([
      { spaceId: "a", spaceName: "Alpha" }, { spaceId: "b", spaceName: "Beta" },
      { spaceId: "a", spaceName: "Alpha" }, { spaceId: "a", spaceName: "Alpha" },
    ]);
    check("aggregates opens per Space", ranked.length === 2 && ranked[0].spaceId === "a" && ranked[0].opens === 3);
    check("sorted most-active first", ranked[0].opens >= ranked[1].opens);
    check("empty ⇒ no spaces", rankSpaces([]).length === 0);
  }

  // ── DAU/WAU/MAU project over the LOGIN ledger ───────────────────────────────────
  console.log("DAU/WAU/MAU projection");
  {
    // distinctLoginUsers returns more users for a wider window (monotone).
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
        { spaceId: "s1", spaceName: "Personal" }, { spaceId: "s1", spaceName: "Personal" }, { spaceId: "s2", spaceName: "Household" },
      ],
    };
    const m = await getUserActivity({ now: NOW, readers });
    check("DAU = 1-day distinct logins", m.dau === 3);
    check("WAU = 7-day distinct logins", m.wau === 12);
    check("MAU = 30-day distinct logins", m.mau === 40);
    check("new users 7d / 30d", m.newUsers7 === 5 && m.newUsers30 === 20);
    check("totalUsers / activatedEver passed through", m.totalUsers === 100 && m.activatedEver === 60);
    check("most-active Space from SPACE_SWITCH", m.topSpaces[0].spaceId === "s1" && m.topSpaces[0].opens === 2);
  }

  // ── doctrine: pure projection, no writes ────────────────────────────────────────
  console.log("doctrine · projection, no writes");
  {
    const src = readFileSync(path.join(process.cwd(), "lib/platform/activity/activity.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("reads the AuditLog LOGIN + SPACE_SWITCH ledger", /AuditAction\.LOGIN/.test(src) && /SPACE_SWITCH/.test(src));
    check("writes nothing (no create/update/delete)", !/\.(create|update|updateMany|delete|deleteMany|upsert)\(/.test(src));
    check("no new telemetry emission (no recordApiUsage/emit)", !/recordApiUsage|\bemit\(/.test(src));
  }

  if (failures > 0) { console.error(`\nactivity.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nactivity.test: all passed.");
}

void main();
