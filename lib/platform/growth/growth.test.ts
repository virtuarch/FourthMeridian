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
import { buildGrowthFunnel, getGrowthFunnel, getBetaInvitationLifecycle, type GrowthReaders } from "@/lib/platform/growth/growth";

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
const DAY_MS = 86_400_000;

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
      // BETA A5 — two users: one verified with a session and a connection, one bare registration.
      funnelFacts: async () => ({
        users: [
          { id: "u1", createdAt: new Date(NOW.getTime() - 20 * DAY_MS), emailVerifiedAt: new Date(NOW.getTime() - 20 * DAY_MS), acceptedTermsAt: null, deactivatedAt: null },
          { id: "u2", createdAt: new Date(NOW.getTime() - 20 * DAY_MS), emailVerifiedAt: null, acceptedTermsAt: null, deactivatedAt: null },
        ],
        firstSessions: [{ userId: "u1", at: new Date(NOW.getTime() - 19 * DAY_MS) }],
        firstConnections: new Map([["u1", new Date(NOW.getTime() - 18 * DAY_MS)]]),
        firstAiTurns: [], firstBriefViews: [], lastEngagements: [],
      }),
    };
    const f = await getGrowthFunnel({ now: NOW, readers });
    check("funnel assembled from readers", f.beta.requested === 3 && f.beta.redeemed === 2 && f.activation.totalUsers === 5);
    check("BETA A5 — onboarding stages ride beside the two funnels: 2 → 1 → 1 → 1 → 0 → 0 → 0, strict and monotone",
      (f.onboarding ?? []).map((s) => s.count).join() === "2,1,1,1,0,0,0" && f.onboarding?.[0].key === "registered" && f.onboarding?.[6].key === "returned", (f.onboarding ?? []).map((s) => s.count).join());
    check("…u2 registered 20 days ago and never verified ⇒ abandoned at 'registered'; u1 connected 18 days ago and never asked ⇒ abandoned at 'first connection'",
      f.onboarding?.[0].abandoned === 1 && f.onboarding?.[3].abandoned === 1 && f.onboarding?.[1].abandoned === 0);
    check("…rates are conversion from the previous stage (verified 1/2)", f.onboarding?.[1].rate === 0.5 && !("rate" in (f.onboarding?.[0] ?? {})));
    check("buildGrowthFunnel without stages still builds (callers that predate A5)", buildGrowthFunnel({}, 0, { total: 0, verified: 0, activated: 0, returning7: 0 }, NOW.toISOString()).onboarding?.length === 0);
  }

  console.log("doctrine · projection, no writes");
  {
    const src = readFileSync(path.join(process.cwd(), "lib/platform/growth/growth.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("reads BetaAccessRequest + User + UserSession", /betaAccessRequest/.test(src) && /userSession/.test(src));
    check("writes nothing", !/\.(create|update|delete|upsert)\(/.test(src));
    check("BETA A5 — the onboarding stages come from the ONE shared fold and loader; no stage predicate is restated here",
      /buildFunnel\(facts, now\)/.test(src) && /loadFunnelFacts\(systemDb\)/.test(src) && !/BRIEF_VIEWED|surface/.test(src));
    check("no new telemetry emission", !/recordApiUsage|\bemit\(/.test(src));
  }

  console.log("getBetaInvitationLifecycle (PO-3A) · injected readers");
  {
    const lc = await getBetaInvitationLifecycle({
      now: NOW,
      readers: { sent: async () => 12, accepted: async () => 5, expired: async () => 3, revoked: async () => 1 },
    });
    check("sent/accepted/expired/revoked pass through", lc.sent === 12 && lc.accepted === 5 && lc.expired === 3 && lc.revoked === 1);
    check("checkedAt is the injected now", lc.checkedAt === NOW.toISOString());
    check("all four are independent projections (no derived arithmetic)", lc.sent !== lc.accepted + lc.expired + lc.revoked);
  }

  if (failures > 0) { console.error(`\ngrowth.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\ngrowth.test: all passed.");
}

void main();
