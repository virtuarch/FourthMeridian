/**
 * lib/entitlements/consume.test.ts — the product-route seam: one loader, a
 * plain 403 when a surface is off, counts a rate limiter can take, and the
 * hourly Conversations ceiling that no assignment can lift.
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/entitlements/consume.test.ts
 */
import { OVERLAYS, POLICY_GROUPS } from "./catalogue";
import { resolveEffectiveEntitlements } from "./resolve";
import { countLimit, entitlementsForUser, refuseIfDisabled, whyEntitlement } from "./consume";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const now = new Date("2026-10-08T00:00:00Z");

(async () => {
  console.log("loader seam");
  const loaded = await entitlementsForUser("u1", async (uid) => resolveEffectiveEntitlements({ policyGroup: "BETA_FULL_ACCESS_V1", overlay: null, assignedAt: now, assignedById: uid }));
  check("injected loader is used verbatim", loaded.assignedById === "u1");

  console.log("refusal");
  const on = resolveEffectiveEntitlements(null);
  check("an enabled surface is not refused", refuseIfDisabled(on, "conversations", "Conversations") === null);
  const off = { ...on, dimensions: { ...on.dimensions, conversations: { ...on.dimensions.conversations, value: false } } };
  const res = refuseIfDisabled(off, "conversations", "Conversations");
  check("a disabled surface is a 403", res !== null && res.status === 403);
  const body = res ? await res.json() : null;
  check("the body names the surface and the dimension, nothing else", body?.error === "Conversations isn’t available on your plan." && body?.entitlement === "conversations" && Object.keys(body).length === 2);
  check("a count dimension is never refused by refuseIfDisabled", refuseIfDisabled(on, "exportsPerDay", "Export") === null);

  console.log("counts");
  check("exports/day for the default is 3", countLimit(on, "exportsPerDay") === 3);
  check("turns/minute for the default is 10", countLimit(on, "aiTurnsPerMinute") === 10);
  let threw = false; try { countLimit(on, "conversations"); } catch { threw = true; }
  check("countLimit refuses a boolean dimension", threw);
  check("why() is a sentence naming the source", /default policy group/.test(whyEntitlement(on, "exportsPerDay")));

  console.log("the hourly Conversations ceiling holds for EVERY group × overlay");
  let maxHour = 0;
  for (const g of Object.keys(POLICY_GROUPS)) for (const o of [null, ...Object.keys(OVERLAYS)]) {
    const e = resolveEffectiveEntitlements({ policyGroup: g, overlay: o, assignedAt: now, assignedById: null });
    maxHour = Math.max(maxHour, countLimit(e, "aiTurnsPerHour"));
  }
  check("no assignment yields more than 60 turns/hour", maxHour <= 60, String(maxHour));
  const founder = resolveEffectiveEntitlements({ policyGroup: "BETA_FULL_ACCESS_V1", overlay: "FOUNDER_INTERNAL_V1", assignedAt: now, assignedById: null });
  check("the founder overlay raises the minute pacing to 30 and exports to 10", countLimit(founder, "aiTurnsPerMinute") === 30 && countLimit(founder, "exportsPerDay") === 10);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
})();
