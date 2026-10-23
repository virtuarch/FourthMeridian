/**
 * lib/space-templates/registry.test.ts
 *
 * SP-1 registry validity guards. Standalone tsx script (repo convention —
 * no jest/vitest):  npx tsx lib/space-templates/registry.test.ts
 * Exits 0 on pass, 1 on failure.
 *
 * Covers: unique/stable ids · template shape · live/hidden exposure ·
 * category validity · exactly one live template per exposed category ·
 * empty section plans (W2) · no duplicate section keys · parity with
 * getPresetsForCategory · the deleted section render stack stays deleted.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import {
  SpaceCategory,
  getPresetsForCategory,
} from "../space-presets";
import {
  SPACE_TEMPLATES, getTemplate, getLiveTemplates, getComingSoonTemplates, getTemplateForCategory,
} from "./registry";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

const CATEGORY_VALUES = new Set<string>(Object.values(SpaceCategory));

// V25-CLOSE-4B — the picker's product truth, as template ids by exposure.
// W1 — "household" was removed from EXPECTED_HIDDEN: the HOUSEHOLD concept is
// RETIRED outright (FAMILY is the sole shared-family-space concept) and its
// template was DELETED, not hidden. Test 6 below pins the deletion.
// W2 — "retirement" removed from EXPECTED_COMING_SOON and "goal" from
// EXPECTED_HIDDEN: both surfaces are RETIRED outright (product decision,
// final) and their templates were DELETED — retirement was NOT preserved as a
// roadmap placeholder. Pinned below alongside the household pins.
const EXPECTED_LIVE        = ["family", "custom"];
const EXPECTED_COMING_SOON = ["business", "property", "vehicle", "trip"];
const EXPECTED_HIDDEN      = ["debt-payoff", "emergency-fund", "investment", "equipment", "other", "personal"];

// 1. Unique, stable slug ids.
const ids = SPACE_TEMPLATES.map((t) => t.id);
check("template ids are unique", new Set(ids).size === ids.length);
check(
  "template ids are stable slugs",
  ids.every((id) => /^[a-z][a-z0-9-]*$/.test(id)),
  `offenders: ${ids.filter((id) => !/^[a-z][a-z0-9-]*$/.test(id)).join(", ")}`
);

// 2. Valid template shape.
for (const t of SPACE_TEMPLATES) {
  check(
    `template "${t.id}" has a valid shape`,
    t.name.trim().length > 0 &&
      t.description.trim().length > 0 &&
      t.icon.trim().length > 0 &&
      Number.isInteger(t.version) &&
      t.version >= 1 &&
      (t.status === "live" || t.status === "comingSoon" || t.status === "hidden") &&
      Array.isArray(t.sections)
  );
  // 4. Every template maps to a valid SpaceCategory.
  check(
    `template "${t.id}" category "${t.category}" is a valid SpaceCategory`,
    CATEGORY_VALUES.has(t.category)
  );
}

// 3. Exposure — the three status groups are exactly the V25-CLOSE-4B picker model.
const live       = getLiveTemplates();
const comingSoon = getComingSoonTemplates();
const sortIds = (a: string[]) => [...a].sort();
check(
  "getLiveTemplates() is exactly the selectable set",
  sortIds(live.map((t) => t.id)).join() === sortIds(EXPECTED_LIVE).join(),
  `got ${live.map((t) => t.id).join(", ")}`
);
check("every live template has status live", live.every((t) => t.status === "live"));
check(
  "getComingSoonTemplates() is exactly the planned/disabled set",
  sortIds(comingSoon.map((t) => t.id)).join() === sortIds(EXPECTED_COMING_SOON).join(),
  `got ${comingSoon.map((t) => t.id).join(", ")}`
);
check("every comingSoon template has status comingSoon", comingSoon.every((t) => t.status === "comingSoon"));
for (const id of EXPECTED_HIDDEN) {
  check(`retired/hidden template "${id}" is hidden but still resolvable`,
    getTemplate(id)?.status === "hidden");
}
// W1 — HOUSEHOLD is retired OUTRIGHT, not hidden: no template resolves for the
// id or the category, and nothing may reintroduce one (FAMILY is the sole
// shared-family-space concept; the enum member alone survives until the
// enum-retirement migration).
check(`retired concept "household" has NO template (deleted, not hidden)`,
  getTemplate("household") === undefined);
check(`no template carries the retired HOUSEHOLD category`,
  getTemplateForCategory("HOUSEHOLD") === undefined);
// W2 — GOALS and RETIREMENT are retired OUTRIGHT (product decision, final):
// their templates were DELETED, not hidden — including the "retirement"
// comingSoon placeholder (it is NOT preserved as a roadmap surface). Production
// holds zero GOAL/RETIREMENT Spaces to materialize. Do not reintroduce either.
check(`retired concept "retirement" has NO template (deleted, not hidden)`,
  getTemplate("retirement") === undefined);
check(`retired concept "goal" has NO template (deleted, not hidden)`,
  getTemplate("goal") === undefined);
check(`no template carries the retired RETIREMENT category`,
  getTemplateForCategory("RETIREMENT") === undefined);
check(`no template carries the retired GOAL category`,
  getTemplateForCategory("GOAL") === undefined);
// The three groups partition the whole registry (nothing stranded in a 4th state).
check(
  "live + comingSoon + hidden partition the registry",
  live.length + comingSoon.length + SPACE_TEMPLATES.filter((t) => t.status === "hidden").length === SPACE_TEMPLATES.length
);
// Every SELECTABLE and every SHOWN template still resolves the category it needs.
for (const t of [...live, ...comingSoon]) {
  check(`picker template "${t.id}" resolves its category`, getTemplateForCategory(t.category)?.id !== undefined);
}

// 6. Section plans — W2: every built-in template's section list is EMPTY. The
//    last seeded key (the universal goals_progress) retired with the Goals
//    surface, and lib/widget-registry.ts (whose entries the keys used to
//    reference) was deleted with the section render stack. An empty plan is
//    legal end-to-end; a template may only regain a section together with a
//    real renderer AND a surface that renders it.
for (const t of SPACE_TEMPLATES) {
  check(`template "${t.id}" has an empty section plan (W2)`, t.sections.length === 0);
}

// 7. No duplicate section keys within a template (protects @@unique([spaceId, key])).
for (const t of SPACE_TEMPLATES) {
  const keys = t.sections.map((s) => s.key);
  check(`template "${t.id}" has no duplicate section keys`, new Set(keys).size === keys.length);
}

// V25-CLOSE-4B — the featured/PRIMARY-vs-SECONDARY two-row split is retired.
// Exposure is now the three-status model asserted above; the picker shows the
// selectable set then the disabled coming-soon set, with no "show more" toggle.

// 11. Parity — for every SpaceCategory, the category's template sections
//     deep-equal getPresetsForCategory(category). This is the SP-1 core
//     guarantee: the registry is a formalization, not a fork.
// W2 — GOAL / RETIREMENT are skipped: their templates are DELETED (retired
// outright; the categories' enum-mirror members survive only until the
// enum-retirement migration program), pinned above in the exposure section.
const W2_RETIRED_CATEGORIES = new Set<string>(["GOAL", "RETIREMENT"]);
for (const cat of Object.values(SpaceCategory)) {
  if (W2_RETIRED_CATEGORIES.has(cat)) continue;
  const t = getTemplateForCategory(cat);
  check(`getTemplateForCategory(${cat}) resolves a template`, t !== undefined);
  if (t) {
    check(
      `template "${t.id}" sections are byte-identical to getPresetsForCategory(${cat})`,
      JSON.stringify(t.sections) === JSON.stringify(getPresetsForCategory(cat))
    );
  }
}

// Drift guard — W2: the SectionRegistry render stack is DELETED with the
// Goals/Retirement retirement (its only remaining mounts). The former "every
// template key has a renderer" scan is replaced by its W2 truth: the renderer
// file stays gone, and (checked in test 6 above) no template seeds a section,
// so no key can lack a renderer.
check("SectionRegistry.tsx stays deleted (W2 — section render stack retired)",
  !existsSync(path.join(process.cwd(), "components", "space", "sections", "SectionRegistry.tsx")));
check("SectionCard.tsx stays deleted (W2 — section render stack retired)",
  !existsSync(path.join(process.cwd(), "components", "space", "sections", "SectionCard.tsx")));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll registry checks passed.");
