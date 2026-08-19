/**
 * lib/space-templates/create-route.test.ts
 *
 * SP-2.1 guards. Standalone tsx script (repo convention, no DB):
 *     npx tsx lib/space-templates/create-route.test.ts
 *
 * Pure checks: every live template's birth plan is byte-identical to the
 * getPresetsForCategory output the route used before SP-2.1 (the zero-
 * behavior-change guarantee for the legacy category path), and hidden
 * templates are rejected material for the templateId path.
 *
 * Source-scan checks (precedent: purity.test.ts): POST /api/spaces
 * materializes via the SP-1 planner only, accepts templateId, enforces the
 * live-template rule, and hardcodes no section keys.
 *
 * Also carries the SP-2A-3 personal-materialization guards (merged from
 * lib/space-templates/personal-materialization.test.ts): the hidden `personal`
 * template's plan semantics, the register-route scan, the backfill-script
 * contract, and the schema-free guarantee.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { SpaceCategory, getPresetsForCategory } from "../space-presets";
import { SPACE_TEMPLATES, getTemplate, getTemplateForCategory } from "./registry";
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

// Legacy-path parity: for every SpaceCategory, the route's new source
// (category → template → planner) equals its old source
// (getPresetsForCategory). This is the SP-2.1 zero-behavior-change guarantee.
for (const cat of Object.values(SpaceCategory)) {
  const t = getTemplateForCategory(cat);
  check(`legacy path resolves a template for ${cat}`, t !== undefined);
  if (t) {
    check(
      `legacy path plan for ${cat} equals getPresetsForCategory(${cat})`,
      JSON.stringify(planTemplateApplication(t, new Set<string>()).sectionsToCreate) ===
        JSON.stringify(getPresetsForCategory(cat))
    );
  }
}

// templateId path material: every live template resolves by id; hidden
// templates resolve but carry the non-"live" status the route rejects on.
for (const t of SPACE_TEMPLATES) {
  check(`getTemplate("${t.id}") resolves`, getTemplate(t.id) === t);
}
check(
  "hidden templates are distinguishable for rejection",
  getTemplate("personal")?.status !== "live" && getTemplate("goal")?.status !== "live"
);
check("unknown template id resolves to undefined", getTemplate("no-such-template") === undefined);

// ── Source scans ──────────────────────────────────────────────────────────────

const routeSrc = readFileSync(
  path.join(process.cwd(), "app", "api", "spaces", "route.ts"),
  "utf8"
);

check(
  "create route no longer imports getPresetsForCategory",
  // Import statements only — the identifier may legitimately appear in
  // comments explaining what the planner replaced.
  ![...routeSrc.matchAll(/import[\s\S]*?from\s*["'][^"']+["']/g)].some((m) =>
    m[0].includes("getPresetsForCategory")
  )
);
check(
  "create route imports the SP-1 registry",
  routeSrc.includes('from "@/lib/space-templates/registry"')
);
check(
  "create route materializes via planTemplateApplication",
  routeSrc.includes("planTemplateApplication(")
);
check("create route accepts templateId", routeSrc.includes("templateId"));
check(
  "create route enforces the live-template rule",
  routeSrc.includes('.status !== "live"')
);
check(
  "create route records template provenance in the audit metadata",
  /metadata:\s*\{[^}]*templateId/.test(routeSrc)
);

// No hardcoded section keys — the route must never carry template content.
const allTemplateKeys = new Set(SPACE_TEMPLATES.flatMap((t) => t.sections.map((s) => s.key)));
for (const key of allTemplateKeys) {
  check(`create route does not hardcode section key "${key}"`, !routeSrc.includes(`"${key}"`));
}

// ── SP-2.2 — CreateSpaceModal picker scans ────────────────────────────────────

const modalSrc = readFileSync(
  path.join(process.cwd(), "components", "dashboard", "CreateSpaceModal.tsx"),
  "utf8"
);

check(
  "modal sources the picker from getLiveTemplates()",
  modalSrc.includes('from "@/lib/space-templates/registry"') &&
    modalSrc.includes("getLiveTemplates()")
);
check(
  "modal no longer imports category picker lists/metadata",
  !["CATEGORY_LABELS", "CATEGORY_ICONS", "PRIMARY_CATEGORIES", "SECONDARY_CATEGORIES"].some(
    (id) => modalSrc.includes(id)
  )
);
check("modal sends templateId in the create request", modalSrc.includes("templateId"));
check(
  "modal does not send category in the create request",
  !/category\s*:/.test(modalSrc)
);
check(
  "modal does not duplicate template metadata",
  // Template names/icons must come from the registry object (tpl.*), never
  // re-declared locally.
  modalSrc.includes("tpl.icon") && modalSrc.includes("tpl.name")
);

// ── SP-2.3 — planner authority scan ───────────────────────────────────────────
// Repo-wide guard: no production file may import getPresetsForCategory except
// the registry itself (which composes templates FROM the presets). Every Space
// birth path — register route, POST /api/spaces, prisma/seed.ts, backfill —
// must flow through the registry/planner. lib/space-presets.ts (the defining
// module) and *.test.ts files are exempt.

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const ROOT = process.cwd();
const PRESET_IMPORT_ALLOWLIST = new Set([
  path.join("lib", "space-templates", "registry.ts"),
]);

const offenders: string[] = [];
for (const dir of ["app", "components", "lib", "prisma", "scripts", "jobs"]) {
  const abs = path.join(ROOT, dir);
  let files: string[] = [];
  try {
    files = walk(abs);
  } catch {
    continue; // directory absent — nothing to scan
  }
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (rel.endsWith(".test.ts")) continue;
    if (PRESET_IMPORT_ALLOWLIST.has(rel)) continue;
    if (rel === path.join("lib", "space-presets.ts")) continue;
    const src = readFileSync(file, "utf8");
    const importsPreset = [...src.matchAll(/import[\s\S]*?from\s*["'][^"']+["']/g)].some((m) =>
      m[0].includes("getPresetsForCategory")
    );
    if (importsPreset) offenders.push(rel);
  }
}
check(
  "no production file bypasses the planner via getPresetsForCategory",
  offenders.length === 0,
  `offenders: ${offenders.join(", ")}`
);

// Seed births Spaces through the registry/planner like every other path.
const seedSrc = readFileSync(path.join(ROOT, "prisma", "seed.ts"), "utf8");
check(
  "seed resolves templates from the registry",
  seedSrc.includes("getTemplateForCategory(")
);
check(
  "seed materializes via planTemplateApplication",
  seedSrc.includes("planTemplateApplication(")
);

// ── merged from lib/space-templates/personal-materialization.test.ts
//    (SP-2A-3 guards) ──────────────────────────────────────────────────────────
// The legacy-path parity loop above already asserts that PERSONAL resolves and
// that its plan equals getPresetsForCategory(PERSONAL); only the checks below
// were distinct to the SP-2A-3 suite.

// The personal template is hidden (never in the picker).
const personal = getTemplateForCategory(SpaceCategory.PERSONAL);
check("personal template is hidden", personal?.status === "hidden");

if (personal) {
  // Non-empty plan at birth.
  const birthPlan = planTemplateApplication(personal, new Set<string>()).sectionsToCreate;
  check("planned Personal sections are non-empty", birthPlan.length > 0);

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
console.log("\nAll SP-2.1 create-route checks passed.");
