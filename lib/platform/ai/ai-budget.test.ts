/**
 * lib/platform/ai/ai-budget.test.ts  (AI COST CONTROLS — the Economics budget utilization)
 *
 * Fleet = customer surfaces only (harness is overhead), top customers by
 * rolling-24 h spend with today's spend against THEIR effective allowance
 * through the ONE precedence function, opaque refs, the controls summary and
 * the estimate sentence. Injected readers; no database.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ai/ai-budget.test.ts
 */

import { BUDGET_CUSTOMERS_CAP, loadAiBudgetUtilization, sumPerUser, surfacesOf } from "./ai-budget";
import { ESTIMATE_NOT_BILLING } from "./cost-controls.types";
import type { UserSpendGroup } from "./spend-health";
import type { CostControlsReadClient } from "./cost-controls";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});
const NOW = new Date("2026-10-15T18:00:00.000Z");
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// gpt-5.1: $1.25 / M input. 1M prompt tokens = $1.25.
const g = (userId: string | null, surface: string, promptM: number, day = "2026-10-15", model = "gpt-5.1"): UserSpendGroup =>
  ({ userId, provider: "OPENAI", model, surface, day, invocations: 1, promptTokens: promptM * 1_000_000, cachedPromptTokens: 0, completionTokens: 0 });

const controls = (rows: { key: string; value: string }[] = []): CostControlsReadClient => ({
  platformSetting: { findMany: async () => rows.map((r) => ({ ...r, updatedAt: NOW, updatedById: null })) },
  user: { findMany: async () => [] },
  jobRun: { findMany: async () => [{ summary: { evaluatedAtISO: NOW.toISOString(), destination: null, deliveryStatus: "sent", counts: { evaluated: 8, live: 7, enabled: 7, firing: 1, delivered: 1, suppressed: 0 }, rules: [],
    fired: [{ ruleId: "ai-spend-user-high", kind: "ai-spend-user", dedupeKey: "ai-spend-user-high:user:2026-10-15:aaa111", severity: "warning", summary: "s", deliveredAtISO: "2026-10-15T12:30:00.000Z" },
            { ruleId: "ai-spend-fleet-high", kind: "ai-spend-fleet", dedupeKey: "ai-spend-fleet-high:fleet:2026-10-15", severity: "critical", summary: "s", deliveredAtISO: "2026-10-15T12:31:00.000Z" },
            { ruleId: "job-failing", kind: "job-failing", dedupeKey: "job-failing:x", severity: "critical", summary: "s", deliveredAtISO: "2026-10-15T12:32:00.000Z" }] } }] },
  customerPolicyAssignment: { findMany: async () => [], count: async () => 0 },
});

async function main() {
  console.log("1. pure folds");
  {
    const per = sumPerUser([g("a", "chat", 2), g("a", "brief", 1), g("b", "chat", 0.5), g("b", "harness", 9), g(null, "chat", 3), g("c", "chat", 1, "2026-10-15", "gpt-99-x")]);
    check("per-user sums customer surfaces only; harness, null users and unpriced groups never count", close(per.get("a")!, 3.75) && close(per.get("b")!, 0.625) && !per.has("c") && per.size === 2);
    const s = surfacesOf([g("a", "chat", 2), g("b", "harness", 9), g("c", "chat", 1, "2026-10-15", "gpt-99-x"), g("d", "other-thing", 1)]);
    check("by surface: chat / brief customer, harness / other overhead, unpriced counted", s.find((x) => x.surface === "chat")!.customer && close(s.find((x) => x.surface === "chat")!.estimatedUsd!, 2.5) && s.find((x) => x.surface === "chat")!.unpricedInvocations === 1
      && !s.find((x) => x.surface === "harness")!.customer && close(s.find((x) => x.surface === "harness")!.estimatedUsd!, 11.25) && s.find((x) => x.surface === "other")!.invocations === 1 && s.find((x) => x.surface === "brief")!.estimatedUsd === null);
  }

  console.log("\n2. the read model");
  {
    const windowGroups = [g("usr_aaa111", "chat", 4, "2026-10-14"), g("usr_aaa111", "chat", 2), g("usr_bbb222", "brief", 1), g("usr_ccc333", "chat", 0.4), g(null, "harness", 20), g("usr_ddd444", "chat", 0.1, "2026-10-15", "gpt-99-x")];
    const todayGroups = [g("usr_aaa111", "chat", 2), g("usr_bbb222", "brief", 1), g("usr_ccc333", "chat", 0.4)];
    const m = await loadAiBudgetUtilization({
      now: NOW,
      groups: async (since) => (since.toISOString() === "2026-10-15T00:00:00.000Z" ? todayGroups : windowGroups),
      controls: controls([{ key: "ai_daily_allowance_usd", value: "8" }, { key: "ai_spend_alert_fleet_usd_24h", value: "10" }, { key: "ai_paid_requests_paused", value: "true" }]),
      assignments: { customerPolicyAssignment: { findMany: async () => [
        { userId: "usr_aaa111", policyGroup: "BETA_FULL_ACCESS_V1", overlay: null, assignedAt: NOW, assignedById: null, aiDailyUsdAllowanceOverride: 15 },
        { userId: "usr_bbb222", policyGroup: "BETA_FULL_ACCESS_V1", overlay: "FOUNDER_INTERNAL_V1", assignedAt: NOW, assignedById: null, aiDailyUsdAllowanceOverride: null },
      ] } },
    });
    check("window 24 h, checkedAt", m.windowHours === 24 && m.checkedAt === NOW.toISOString());
    // fleet: 4+2+1+0.4 = 7.4M prompt × 1.25 = $9.25; harness excluded; unpriced counted
    check("fleet = customer surfaces only ($9.25 of a $10 threshold = 92.5 %), harness is overhead ($25)", close(m.fleet.estimatedUsd!, 9.25) && m.fleet.thresholdUsd === 10 && m.fleet.utilizationPct === 92.5 && m.fleet.alertEnabled && close(m.overhead.estimatedUsd!, 25) && m.overhead.invocations === 1);
    check("customers / invocations counted on customer surfaces (unpriced row counted as an invocation, not a customer)", m.fleet.customers === 3 && m.fleet.invocations === 5);
    check("unpriced: 1 invocation, the model named", m.unpriced.invocations === 1 && m.unpriced.models.join() === "OPENAI:gpt-99-x");
    const [a, b, c] = m.customers;
    check("top customers by rolling-24 h, opaque refs, no full id", a.ref === "user …aaa111" && close(a.rolling24hUsd, 7.5) && b.ref === "user …bbb222" && c.ref === "user …ccc333" && !JSON.stringify(m).includes("usr_aaa111"));
    check("a: today $2.50 against the USER_OVERRIDE 15 ⇒ 16.7 %; alert 7.5 / 3 = 250 %", close(a.todayUsd, 2.5) && a.allowanceUsd === 15 && a.allowanceSource === "USER_OVERRIDE" && a.allowanceUtilizationPct === 16.7 && a.alertUtilizationPct === 250);
    check("b: the founder OVERLAY 20 beats the platform 8", b.allowanceUsd === 20 && b.allowanceSource === "OVERLAY" && close(b.todayUsd, 1.25));
    check("c: no assignment row ⇒ the PLATFORM_SETTING 8 (never POLICY_DEFAULT on this surface)", c.allowanceUsd === 8 && c.allowanceSource === "PLATFORM_SETTING" && c.allowanceUtilizationPct === 6.3);
    check("bySurface has the four buckets", m.bySurface.map((s) => s.surface).join() === "chat,brief,harness,other");
    check("recentAlerts carry the two spend rules only, newest first", m.recentAlerts.length === 2 && m.recentAlerts[0].dedupeKey.startsWith("ai-spend-fleet-high") && m.recentAlerts.every((r) => !r.dedupeKey.startsWith("job-failing")));
    check("controls summary: enforced (default), platform allowance 8, user alert on at 3, paused", m.controls.allowanceEnforced && m.controls.allowanceDefaultUsd === 8 && m.controls.userAlertEnabled && m.controls.userAlertThresholdUsd === 3 && m.controls.paused);
    check("the governing sentence", m.estimateNote === ESTIMATE_NOT_BILLING);
    const empty = await loadAiBudgetUtilization({ now: NOW, groups: async () => [], controls: controls(), assignments: { customerPolicyAssignment: { findMany: async () => [] } } });
    check("an empty window: null fleet USD, null utilization, no customers, default allowance 5, not paused", empty.fleet.estimatedUsd === null && empty.fleet.utilizationPct === null && empty.customers.length === 0 && empty.controls.allowanceDefaultUsd === 5 && !empty.controls.paused);
    const many = await loadAiBudgetUtilization({ now: NOW, groups: async () => Array.from({ length: 30 }, (_, i) => g(`usr_${String(i).padStart(6, "0")}`, "chat", 1 + i)), controls: controls(), assignments: { customerPolicyAssignment: { findMany: async () => [] } } });
    check(`the customer list is capped at ${BUDGET_CUSTOMERS_CAP}, largest first`, many.customers.length === BUDGET_CUSTOMERS_CAP && many.customers[0].rolling24hUsd > many.customers[1].rolling24hUsd);
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
void main();
