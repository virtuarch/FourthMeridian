/**
 * lib/platform/growth/growth.test.ts  (OPS-6F)
 *
 * Behavior guards for the growth-funnel projection. Standalone tsx (house pattern).
 * NO LIVE DATABASE: pure funnel build + injected readers. Proves the beta funnel
 * (requested→approved→redeemed→activated) and activation funnel project over
 * existing rows with honest ratios (null when the denominator is 0), no writes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildGrowthFunnel, getGrowthFunnel, type GrowthReaders } from "@/lib/platform/growth/growth";

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

async function main() {
  console.log("buildGrowthFunnel");
  {
    // 10 requested = 2 pending + 1 denied + 3 approved-only + 4 redeemed. approved-ever = 7.
    const f = buildGrowthFunnel(
      { PENDING: 2, DENIED: 1, APPROVED: 3, REDEEMED: 4 },
      3, // 3 of the 4 redeemed users have signed in
      { total: 20, verified: 15, activated: 12, returning7: 5 },
      NOW.toISOString(),
    );
    check("requested = all statuses", f.beta.requested === 10);
    check("approved-ever = APPROVED + REDEEMED", f.beta.approved === 7);
    check("redeemed count", f.beta.redeemed === 4);
    check("approveRate = approved/requested", Math.abs((f.beta.approveRate ?? 0) - 0.7) < 1e-9);
    check("redeemRate = redeemed/approved", Math.abs((f.beta.redeemRate ?? 0) - 4 / 7) < 1e-9);
    check("redeemedActivated passed through", f.beta.redeemedActivated === 3);
    check("activation rates", Math.abs((f.activation.activationRate ?? 0) - 0.6) < 1e-9 && Math.abs((f.activation.verifyRate ?? 0) - 0.75) < 1e-9);
    check("returning7 passed through", f.activation.returning7 === 5);
  }

  console.log("honest ratios (no divide-by-zero)");
  {
    const f = buildGrowthFunnel({}, 0, { total: 0, verified: 0, activated: 0, returning7: 0 }, NOW.toISOString());
    check("no requests ⇒ approveRate null (not NaN/0)", f.beta.approveRate === null);
    check("no users ⇒ activationRate null", f.activation.activationRate === null);
  }

  console.log("authority · injected readers");
  {
    const readers: GrowthReaders = {
      now: NOW,
      betaByStatus: async () => ({ PENDING: 1, REDEEMED: 2 }),
      redeemedActivated: async () => 2,
      totalUsers: async () => 5, verifiedUsers: async () => 4, activatedUsers: async () => 3,
      returningUsers: async () => 1,
    };
    const f = await getGrowthFunnel({ now: NOW, readers });
    check("funnel assembled from readers", f.beta.requested === 3 && f.beta.redeemed === 2 && f.activation.totalUsers === 5);
  }

  console.log("doctrine · projection, no writes");
  {
    const src = readFileSync(path.join(process.cwd(), "lib/platform/growth/growth.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("reads BetaAccessRequest + User + UserSession", /betaAccessRequest/.test(src) && /userSession/.test(src));
    check("writes nothing", !/\.(create|update|delete|upsert)\(/.test(src));
    check("no new telemetry emission", !/recordApiUsage|\bemit\(/.test(src));
  }

  if (failures > 0) { console.error(`\ngrowth.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\ngrowth.test: all passed.");
}

void main();
