/** UI interaction/transport contract tests; mocked responses, no database writes. */
import assert from "node:assert/strict";
import { mutate } from "./policy-editor-kit";
import { draftFromModel, patchBody, resolveDraft, restoreDefaultsChanges, confirmationSentences } from "./ai-cost-controls-view";
import { resolveMutationOutcome } from "./policies-view";
import { AI_COST_CONTROLS_URL, AI_COST_CONTROL_SETTING_KEYS, type AiCostControlKey, type AiCostControlsReadModel, type ControlValueView } from "@/lib/platform/ai/cost-controls.types";

const version = "2026-10-16T05:00:00.000Z";
function view<V extends number | boolean>(control: AiCostControlKey, value: V, defaultValue: V): ControlValueView<V> {
  return { control, settingKey: AI_COST_CONTROL_SETTING_KEYS[control], label: control, description: "", value, defaultValue,
    origin: "SETTING", updatedAt: version, updatedByName: null, bounds: typeof value === "number" ? { min: 1, max: 20 } : null };
}
const model: AiCostControlsReadModel = {
  checkedAt: version,
  allowance: { enforced: view("allowance.enforced", true, true), usd: view("allowance.usd", 7, 5), ceilingUsd: 20, effectiveDefaultUsd: 7, effectiveDefaultSource: "PLATFORM_SETTING", overrides: { count: 0, customers: [] }, enforcementNote: "" },
  userAlert: { enabled: view("userAlert.enabled", true, true), thresholdUsd: view("userAlert.thresholdUsd", 3, 3), ruleId: "ai-spend-user-high", status: { live: true, firingNow: false, lastFiredAt: null, recent: [] } },
  fleetAlert: { enabled: view("fleetAlert.enabled", true, true), thresholdUsd: view("fleetAlert.thresholdUsd", 10, 10), ruleId: "ai-spend-fleet-high", status: { live: true, firingNow: false, lastFiredAt: null, recent: [] } },
  killSwitch: { paused: view("killSwitch.paused", false, false), customerMessage: "Paused" }, propagation: { cached: false, note: "" },
};
async function main() {
  const draft = { ...draftFromModel(model, "allowance"), "allowance.usd": "9" };
  const resolved = resolveDraft(model, "allowance", draft);
  assert.deepEqual(resolved.errors, {});
  assert.deepEqual(resolved.changes, [{ control: "allowance.usd", value: 9, expectedUpdatedAt: version }]);
  assert.ok(Object.keys(resolveDraft(model, "allowance", { ...draft, "allowance.usd": "21" }).errors).length);
  assert.ok(confirmationSentences(resolveDraft(model, "allowance", { ...draftFromModel(model, "allowance"), "allowance.enforced": false }).changes).length);
  assert.ok(confirmationSentences(resolveDraft(model, "killSwitch", { "killSwitch.paused": true }).changes).length);
  assert.ok(restoreDefaultsChanges(model, "allowance").every((change) => change.value === null && change.expectedUpdatedAt === version));
  assert.deepEqual(restoreDefaultsChanges(model, "killSwitch"), []);
  const originalFetch = globalThis.fetch;
  const reason = { code: "SUPPORT_REQUEST" as const };
  const body = patchBody(resolved.changes, reason);
  try {
    let requests = 0;
    globalThis.fetch = async (input, init) => {
      requests++;
      assert.equal(input, AI_COST_CONTROLS_URL);
      assert.equal(init?.method, "PATCH");
      assert.equal(init?.credentials, "same-origin");
      assert.deepEqual(JSON.parse(String(init?.body)), body);
      return new Response(JSON.stringify(model), { status: 200 });
    };
    const result = await mutate<AiCostControlsReadModel>(AI_COST_CONTROLS_URL, "PATCH", body as unknown as Record<string, unknown>, "AI policy");
    assert.equal(requests, 1);
    const settled = resolveMutationOutcome(result, "Saved.");
    assert.deepEqual(settled.model, model);
    assert.equal(settled.close, true);
    assert.equal(settled.notice.tone, "ok");
    for (const status of [400, 403, 409]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "Refused", ...(status === 409 ? { model } : {}) }), { status });
      const refusal = resolveMutationOutcome(await mutate<AiCostControlsReadModel>(AI_COST_CONTROLS_URL, "PATCH", body as unknown as Record<string, unknown>, "AI policy"), "Saved.");
      assert.notEqual(refusal.notice.tone, "ok");
      assert.equal(refusal.model, status === 409 ? refusal.model : null);
      if (status === 409) assert.deepEqual(refusal.model, model);
    }
    globalThis.fetch = async () => { throw new Error("Offline"); };
    const offline = resolveMutationOutcome(await mutate<AiCostControlsReadModel>(AI_COST_CONTROLS_URL, "PATCH", body as unknown as Record<string, unknown>, "AI policy"), "Saved.");
    assert.equal(offline.model, null);
    assert.equal(offline.close, false);
    assert.equal(offline.notice.tone, "bad");
  } finally { globalThis.fetch = originalFetch; }
  console.log("AI policy interaction/transport checks passed (mocked transport; no authenticated persistence claim).");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
