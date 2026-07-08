/**
 * lib/space-templates/registry.test.ts
 *
 * SP-1 registry validity guards. Standalone tsx script (repo convention —
 * no jest/vitest):  npx tsx lib/space-templates/registry.test.ts
 * Exits 0 on pass, 1 on failure.
 *
 * Covers: unique/stable ids · template shape · live/hidden exposure ·
 * category validity · exactly one live template per exposed category ·
 * widget-key referential integrity (incl. no deprecated aliases) ·
 * no duplicate section keys · parity with getPresetsForCategory ·
 * template keys have a real SectionRegistry renderer (read-only source scan).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SpaceCategory,
  getPresetsForCategory,
  PRIMARY_CATEGORIES,
  SECONDARY_CATEGORIES,
} from "../space-presets";
import { WIDGET_REGISTRY } from "../widget-registry";
import { SPACE_TEMPLATES, getTemplate, getLiveTemplates, getTemplateForCategory } from "./registry";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

const CATEGORY_VALUES = new Set<string>(Object.values(SpaceCategory));
const EXPOSED_CATEGORIES = [...PRIMARY_CATEGORIES, ...SECONDARY_CATEGORIES];

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
      (t.status === "live" || t.status === "hidden") &&
      Array.isArray(t.sections)
  );
  // 4. Every template maps to a valid SpaceCategory.
  check(
    `template "${t.id}" category "${t.category}" is a valid SpaceCategory`,
    CATEGORY_VALUES.has(t.category)
  );
}

// 3. Live templates exclude hidden templates.
const live = getLiveTemplates();
check(
  "getLiveTemplates() excludes hidden templates",
  live.every((t) => t.status === "live") &&
    live.length === SPACE_TEMPLATES.filter((t) => t.status === "live").length
);
check(
  "hidden templates are still resolvable by id",
  getTemplate("personal")?.status === "hidden" && getTemplate("goal")?.status === "hidden"
);

// 5. Every exposed category has exactly one live template; live set matches exposure.
for (const cat of EXPOSED_CATEGORIES) {
  const matches = live.filter((t) => t.category === cat);
  check(`exposed category ${cat} has exactly one live template`, matches.length === 1);
}
check(
  "no live template exists for a non-exposed category",
  live.every((t) => (EXPOSED_CATEGORIES as string[]).includes(t.category)),
  `offenders: ${live.filter((t) => !(EXPOSED_CATEGORIES as string[]).includes(t.category)).map((t) => t.id).join(", ")}`
);

// 6. Widget-key referential integrity — every section key exists in
//    WIDGET_REGISTRY and is not a deprecated alias.
for (const t of SPACE_TEMPLATES) {
  for (const s of t.sections) {
    const entry = WIDGET_REGISTRY.get(s.key);
    check(`template "${t.id}" section key "${s.key}" exists in WIDGET_REGISTRY`, entry !== undefined);
    if (entry) {
      check(
        `template "${t.id}" section key "${s.key}" is not a deprecated alias`,
        entry.meta.deprecatedAlias === undefined
      );
    }
  }
}

// 7. No duplicate section keys within a template (protects @@unique([spaceId, key])).
for (const t of SPACE_TEMPLATES) {
  const keys = t.sections.map((s) => s.key);
  check(`template "${t.id}" has no duplicate section keys`, new Set(keys).size === keys.length);
}

// 11. Parity — for every SpaceCategory, the category's template sections
//     deep-equal getPresetsForCategory(category). This is the SP-1 core
//     guarantee: the registry is a formalization, not a fork.
for (const cat of Object.values(SpaceCategory)) {
  const t = getTemplateForCategory(cat);
  check(`getTemplateForCategory(${cat}) resolves a template`, t !== undefined);
  if (t) {
    check(
      `template "${t.id}" sections are byte-identical to getPresetsForCategory(${cat})`,
      JSON.stringify(t.sections) === JSON.stringify(getPresetsForCategory(cat))
    );
  }
}

// Optional drift guard (read-only): every template section key must have a
// real renderer in SpaceDashboard's SectionRegistry literal — the exact
// failure mode the Space Template Redesign eliminated ("no section whose key
// lacks a SectionRegistry renderer"). Source scan only; dashboard code is
// never imported or edited here.
const dashboardSrc = readFileSync(
  path.join(process.cwd(), "components", "dashboard", "SpaceDashboard.tsx"),
  "utf8"
);
const registryBlockMatch = dashboardSrc.match(
  /const SectionRegistry[\s\S]*?\n};/
);
check("SectionRegistry literal found in SpaceDashboard.tsx", registryBlockMatch !== null);
if (registryBlockMatch) {
  const block = registryBlockMatch[0];
  const templateKeys = new Set(SPACE_TEMPLATES.flatMap((t) => t.sections.map((s) => s.key)));
  for (const key of templateKeys) {
    check(
      `template section key "${key}" has a SectionRegistry renderer`,
      block.includes(`"${key}"`)
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll registry checks passed.");
