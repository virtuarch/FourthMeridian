/**
 * components/platform/widgets/ops-policies-cost-controls.test.ts  (UI-010)
 *
 * The AI Cost Controls panel — the kill switch above all — renders from its
 * OWN fetch state: a failed, slow or empty /policies read must not hide it.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/ops-policies-cost-controls.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PoliciesSurface } from "./OpsPoliciesWidget";
import { AI_COST_CONTROL_SETTING_KEYS, type AiCostControlKey, type AiCostControlsReadModel, type ControlValueView } from "@/lib/platform/ai/cost-controls.types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-10-21T12:00:00.000Z");
const section = { id: "s1", key: "ops_policies", label: "Policies" };
const cv = <V extends boolean | number>(control: AiCostControlKey, label: string, value: V): ControlValueView<V> => ({
  control, settingKey: AI_COST_CONTROL_SETTING_KEYS[control], label, description: "d", value, defaultValue: value, origin: "DEFAULT", updatedAt: null, updatedByName: null,
  bounds: typeof value === "number" ? { min: 1, max: 20 } : null,
});
const controls: AiCostControlsReadModel = {
  checkedAt: NOW.toISOString(),
  allowance: { enforced: cv("allowance.enforced", "Allowance enforced", true), usd: cv("allowance.usd", "Daily allowance (USD)", 5), ceilingUsd: 20, effectiveDefaultUsd: 5, effectiveDefaultSource: "POLICY", overrides: { count: 0, customers: [] }, enforcementNote: "Judged at the routes." },
  userAlert: { ruleId: "ai-spend-user-high", enabled: cv("userAlert.enabled", "Per-user alert enabled", true), thresholdUsd: cv("userAlert.thresholdUsd", "Per-user threshold (USD / 24 h)", 3), status: { live: true, firingNow: false, lastFiredAt: null, recent: [] } },
  fleetAlert: { ruleId: "ai-spend-fleet-high", enabled: cv("fleetAlert.enabled", "Fleet alert enabled", true), thresholdUsd: cv("fleetAlert.thresholdUsd", "Fleet threshold (USD / 24 h)", 10), status: { live: true, firingNow: false, lastFiredAt: null, recent: [] } },
  killSwitch: { paused: cv("killSwitch.paused", "Paid AI requests paused", false), customerMessage: "AI features are paused." },
  propagation: { cached: false, note: "A change is visible to the very next decision." },
};
const render = (policies: { data: unknown; loading: boolean; error: string | null }, canControl: boolean) =>
  renderToStaticMarkup(createElement(PoliciesSurface, { section, state: policies as never, canControl, costControls: { data: controls, loading: false, error: null } }));

console.log("1. the policies read FAILED — the panel and the kill switch still render");
{
  const html = render({ data: null, loading: false, error: "Request failed (500)" }, true);
  check("policies failure is an alert", /role="alert"/.test(html));
  check("AI Cost Controls group is present", /AI Cost Controls/.test(html));
  check("the kill switch region is present with its pause affordance", /role="region"/.test(html) && /Pause AI/.test(html) && /Pause paid AI requests/.test(html));
}

console.log("2. the policies read is still LOADING — the panel does not wait for it");
{
  const html = render({ data: null, loading: true, error: null }, false);
  check("policies loading status is shown", /role="status"/.test(html));
  check("AI Cost Controls group is present while policies load", /AI Cost Controls/.test(html) && /Pause paid AI requests/.test(html));
}

console.log("3. the policies read succeeded — unchanged composition");
{
  const html = render({ data: { policies: [], grace: { hours: 2, fraction: 0.25 } }, loading: false, error: null }, false);
  check("AI Cost Controls group is present", /AI Cost Controls/.test(html));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
