/**
 * lib/space-templates/apply.test.ts
 *
 * SP-1 planner guards. Standalone tsx script (repo convention):
 *     npx tsx lib/space-templates/apply.test.ts
 *
 * Covers: idempotence · skip-existing-keys · additive-only ·
 * field passthrough (key/label/tab/enabled/order/config) ·
 * input immutability · creation-path parity with getPresetsForCategory.
 */

import { SpaceCategory, getPresetsForCategory } from "../space-presets";
import { SPACE_TEMPLATES, getTemplateForCategory } from "./registry";
import { planTemplateApplication } from "./apply";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

const EMPTY = new Set<string>();

// Creation-path parity: against an empty Space the plan is exactly the
// template's sections — which are exactly getPresetsForCategory(category).
for (const cat of Object.values(SpaceCategory)) {
  const t = getTemplateForCategory(cat);
  if (!t) continue; // registry.test.ts already fails on missing templates
  const plan = planTemplateApplication(t, EMPTY);
  check(
    `plan(${t.id}, ∅) equals getPresetsForCategory(${cat})`,
    JSON.stringify(plan.sectionsToCreate) === JSON.stringify(getPresetsForCategory(cat))
  );
}

// Use a template with several sections for the behavioral cases.
const template = getTemplateForCategory(SpaceCategory.DEBT_PAYOFF)!;
const allKeys = template.sections.map((s) => s.key);
check("fixture template has multiple sections", allKeys.length >= 3);

// 9. Skips existing keys.
const partial = new Set(allKeys.slice(0, 2));
const partialPlan = planTemplateApplication(template, partial);
check(
  "planner skips keys already present",
  partialPlan.sectionsToCreate.every((s) => !partial.has(s.key)) &&
    partialPlan.sectionsToCreate.length === allKeys.length - partial.size
);
check(
  "planner preserves template order among created sections",
  JSON.stringify(partialPlan.sectionsToCreate.map((s) => s.key)) ===
    JSON.stringify(allKeys.filter((k) => !partial.has(k)))
);

// 8. Idempotent: planning against a fully-applied Space yields nothing;
//    planning twice with the same inputs yields the same plan.
const fullyApplied = new Set(allKeys);
check(
  "plan against fully-applied Space is empty",
  planTemplateApplication(template, fullyApplied).sectionsToCreate.length === 0
);
const planA = planTemplateApplication(template, partial);
const planB = planTemplateApplication(template, partial);
check(
  "planning twice with identical inputs yields identical plans",
  JSON.stringify(planA) === JSON.stringify(planB)
);
// Simulated apply-then-replan: materializing a plan and replanning is a no-op.
const afterApply = new Set([...partial, ...partialPlan.sectionsToCreate.map((s) => s.key)]);
check(
  "replanning after applying a plan is a no-op",
  planTemplateApplication(template, afterApply).sectionsToCreate.length === 0
);

// 10. Field passthrough — every created section carries key/label/tab/
//     enabled/order/config through unchanged.
for (const t of SPACE_TEMPLATES) {
  const plan = planTemplateApplication(t, EMPTY);
  const ok = plan.sectionsToCreate.every((s, i) => {
    const src = t.sections[i];
    return (
      s.key === src.key &&
      s.label === src.label &&
      s.tab === src.tab &&
      s.enabled === src.enabled &&
      s.order === src.order &&
      JSON.stringify(s.config) === JSON.stringify(src.config)
    );
  });
  check(`template "${t.id}" plan preserves key/label/tab/enabled/order/config`, ok);
}

// Input immutability: planning never mutates the template or the key set,
// and mutating a returned section never leaks back into the registry.
const before = JSON.stringify(template);
const keySetBefore = new Set(partial);
const mutablePlan = planTemplateApplication(template, partial);
if (mutablePlan.sectionsToCreate.length > 0) {
  mutablePlan.sectionsToCreate[0].label = "MUTATED";
  if (mutablePlan.sectionsToCreate[0].config) {
    (mutablePlan.sectionsToCreate[0].config as Record<string, unknown>).injected = true;
  }
}
check("planner does not mutate the template", JSON.stringify(template) === before);
check(
  "planner does not mutate the existing-keys set",
  partial.size === keySetBefore.size && [...partial].every((k) => keySetBefore.has(k))
);
check(
  "mutating a planned section does not leak into the registry",
  JSON.stringify(template) === before
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll planner checks passed.");
