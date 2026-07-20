/**
 * lib/space-templates/template-truthfulness.test.ts
 *
 * Standalone tsx guard (house convention: exit 0/1). V25-CLOSE-4.
 *
 * Locks the two honesty invariants this slice established:
 *
 *   1. NO CATEGORY LEADS WITH AN INACCESSIBLE LENS. A category's perspective
 *      list must not contain a comingSoon lens — those have no workspace and
 *      rendered as a non-clickable "Soon" card leading the Perspectives doorway
 *      (Property led with `property`, Business with `businessHealth`). This is a
 *      BEHAVIOURAL check over getPerspectivesForCategory, so it also catches a
 *      future category that adds one.
 *
 *   2. EVERY PICKER TEMPLATE HAS A DESCRIPTION, AND THE PICKER RENDERS IT. The
 *      descriptions already existed (registry → CATEGORY_DESCRIPTIONS) but the
 *      picker showed only icon + name. A source-scan asserts CreateSpaceModal
 *      actually references tpl.description (a data-only check can't prove it
 *      reaches the screen).
 *
 *   npx tsx lib/space-templates/template-truthfulness.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { getPerspectivesForCategory } from "../perspectives";
import { getLiveTemplates } from "./registry";
import { SpaceCategory, CATEGORY_DESCRIPTIONS } from "../space-presets";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function main(): void {
  const categories = Object.values(SpaceCategory);

  console.log("1. no category leads with (or contains) a comingSoon lens");
  for (const cat of categories) {
    const defs = getPerspectivesForCategory(cat);
    const soon = defs.filter((d) => d.status === "comingSoon").map((d) => d.id);
    check(`${cat}: no comingSoon lens in the perspective list`, soon.length === 0,
      soon.length ? `found ${soon.join(", ")}` : undefined);
  }
  // Explicit regression pins for the two the audit removed.
  check("PROPERTY no longer surfaces the `property` lens",
    !getPerspectivesForCategory("PROPERTY").some((d) => d.id === "property"));
  check("BUSINESS no longer surfaces the `businessHealth` lens",
    !getPerspectivesForCategory("BUSINESS").some((d) => d.id === "businessHealth"));

  console.log("2. every live picker template carries a description");
  const live = getLiveTemplates();
  check("there are live templates to show", live.length > 0);
  for (const t of live) {
    check(`${t.id}: has a non-empty description`,
      typeof t.description === "string" && t.description.trim().length > 0);
  }

  console.log("3. the picker actually renders tpl.description");
  const modal = stripComments(read("components/dashboard/CreateSpaceModal.tsx"));
  check("CreateSpaceModal references tpl.description", modal.includes("tpl.description"));

  console.log("4. reworded descriptions no longer promise unsupported features");
  // Property/Vehicle/Equipment previously promised rental income / auto-loan /
  // maintenance — capabilities that do not render. The copy must not reappear.
  const banned: { cat: string; phrase: string }[] = [
    { cat: SpaceCategory.PROPERTY,  phrase: "rental income" },
    { cat: SpaceCategory.VEHICLE,   phrase: "auto loan" },
    { cat: SpaceCategory.EQUIPMENT, phrase: "maintenance" },
  ];
  for (const { cat, phrase } of banned) {
    check(`${cat} description drops "${phrase}"`,
      !CATEGORY_DESCRIPTIONS[cat as SpaceCategory].toLowerCase().includes(phrase));
  }

  console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
