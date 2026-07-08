/**
 * lib/space-templates/personal-materialization.test.ts
 *
 * SP-2A-3 guards. Standalone tsx script (repo convention, no DB):
 *     npx tsx lib/space-templates/personal-materialization.test.ts
 *
 * Pure checks: the hidden `personal` template resolves, its plan is
 * non-empty, matches getPresetsForCategory(PERSONAL), skips existing keys,
 * and is idempotent.
 *
 * Source-scan checks (precedent: purity.test.ts / security-surface.test.ts):
 * the register route uses the SP-1 planner/registry and hardcodes no section
 * keys; the backfill script is dry-run-by-default, additive-only (createMany;
 * no update/delete on sections), and planner-driven; the Prisma schema gained
 * no SpaceTemplate model (SP-2A-3 is schema-free).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { SpaceCategory, getPresetsForCategory } from "../space-presets";
import { getTemplateForCategory } from "./registry";
import { planTemplateApplication } from "./apply";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

// ── Pure checks ───────────────────────────────────────────────────────────────

// The personal template resolves and is hidden (never in the picker).
const personal = getTemplateForCategory(SpaceCategory.PERSONAL);
check("personal template resolves via getTemplateForCategory", personal !== undefined);
check("personal template is hidden", personal?.status === "hidden");

if (personal) {
  // Non-empty plan at birth.
  const birthPlan = planTemplateApplication(personal, new Set<string>()).sectionsToCreate;
  check("planned Personal sections are non-empty", birthPlan.length > 0);

  // Exact parity with the preset path POST /api/spaces uses today.
  check(
    "planned Personal sections equal getPresetsForCategory(PERSONAL)",
    JSON.stringify(birthPlan) === JSON.stringify(getPresetsForCategory(SpaceCategory.PERSONAL))
  );

  // Backfill semantics: skips existing keys.
  const someKeys = new Set(birthPlan.slice(0, 1).map((s) => s.key));
  const partial = planTemplateApplication(personal, someKeys).sectionsToCreate;
  check(
    "backfill planner skips existing keys",
    partial.length === birthPlan.length - 1 && partial.every((s) => !someKeys.has(s.key))
  );

  // Idempotence: after a full apply, the plan is empty; replanning is stable.
  const allKeys = new Set(birthPlan.map((s) => s.key));
  check(
    "backfill planner is idempotent (full Space → empty plan)",
    planTemplateApplication(personal, allKeys).sectionsToCreate.length === 0
  );
  check(
    "backfill planner is deterministic",
    JSON.stringify(planTemplateApplication(personal, someKeys)) ===
      JSON.stringify(planTemplateApplication(personal, someKeys))
  );
}

// ── Source scans ──────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const registerSrc = readFileSync(
  path.join(ROOT, "app", "api", "auth", "register", "route.ts"),
  "utf8"
);
const backfillSrc = readFileSync(
  path.join(ROOT, "scripts", "backfill-personal-sections.ts"),
  "utf8"
);
const schemaSrc = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");

// Register route uses the SP-1 registry + planner.
check(
  "register route imports the SP-1 registry",
  registerSrc.includes('from "@/lib/space-templates/registry"')
);
check(
  "register route imports the SP-1 planner",
  registerSrc.includes('from "@/lib/space-templates/apply"')
);
check(
  "register route calls planTemplateApplication",
  registerSrc.includes("planTemplateApplication(")
);
check(
  "register route materializes dashboardSections",
  registerSrc.includes("dashboardSections")
);

// Register route hardcodes no section keys — every key the personal template
// (or the universal set) carries must be absent as a literal.
if (personal) {
  const templateKeys = planTemplateApplication(personal, new Set<string>())
    .sectionsToCreate.map((s) => s.key);
  for (const key of templateKeys) {
    check(
      `register route does not hardcode section key "${key}"`,
      !registerSrc.includes(`"${key}"`)
    );
  }
}

// Backfill script contract.
check(
  "backfill script uses planTemplateApplication",
  backfillSrc.includes("planTemplateApplication(")
);
check(
  "backfill script resolves the template from the SP-1 registry",
  backfillSrc.includes("getTemplateForCategory(")
);
check(
  "backfill script is dry-run by default (--apply gate present)",
  backfillSrc.includes('"--apply"')
);
check(
  "backfill script writes via createMany only",
  backfillSrc.includes("spaceDashboardSection.createMany")
);
check(
  "backfill script never updates section rows",
  !/spaceDashboardSection\s*\.\s*update/i.test(backfillSrc) &&
    !backfillSrc.includes(".updateMany(")
);
check(
  "backfill script never deletes section rows",
  !/\.delete(Many)?\s*\(/.test(backfillSrc)
);
check(
  "backfill script never upserts section rows",
  !backfillSrc.includes(".upsert(")
);

// SP-2A-3 is schema-free: no SpaceTemplate model, no template provenance column.
check("prisma schema has no SpaceTemplate model", !/model\s+SpaceTemplate\b/.test(schemaSrc));
check("prisma schema has no templateId column on Space", !/\btemplateId\b/.test(schemaSrc));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll SP-2A-3 checks passed.");
