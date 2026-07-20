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
} from "../space-presets";
import { WIDGET_REGISTRY } from "../widget-registry";
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
const EXPECTED_LIVE        = ["family", "custom"];
const EXPECTED_COMING_SOON = ["retirement", "business", "property", "vehicle", "trip"];
const EXPECTED_HIDDEN      = ["household", "debt-payoff", "emergency-fund", "investment", "equipment", "other", "personal", "goal"];

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
// The three groups partition the whole registry (nothing stranded in a 4th state).
check(
  "live + comingSoon + hidden partition the registry",
  live.length + comingSoon.length + SPACE_TEMPLATES.filter((t) => t.status === "hidden").length === SPACE_TEMPLATES.length
);
// Every SELECTABLE and every SHOWN template still resolves the category it needs.
for (const t of [...live, ...comingSoon]) {
  check(`picker template "${t.id}" resolves its category`, getTemplateForCategory(t.category)?.id !== undefined);
}

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

// V25-CLOSE-4B — the featured/PRIMARY-vs-SECONDARY two-row split is retired.
// Exposure is now the three-status model asserted above; the picker shows the
// selectable set then the disabled coming-soon set, with no "show more" toggle.

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
// real renderer in the SectionRegistry literal — the exact failure mode the
// Space Template Redesign eliminated ("no section whose key lacks a
// SectionRegistry renderer"). SD-7 extracted the section subsystem out of
// SpaceDashboard into components/space/sections/SpaceSections.tsx, so the scan
// now reads the registry from its new home. Source scan only; the code is never
// imported or edited here.
const sectionsSrc = readFileSync(
  path.join(process.cwd(), "components", "space", "sections", "SectionRegistry.tsx"),
  "utf8"
);
const registryBlockMatch = sectionsSrc.match(
  /const SectionRegistry[\s\S]*?\n};/
);
check("SectionRegistry literal found in SectionRegistry.tsx", registryBlockMatch !== null);
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
