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
 * Source-scan checks (precedent: purity.test.ts / personal-materialization
 * .test.ts): POST /api/spaces materializes via the SP-1 planner only, accepts
 * templateId, enforces the live-template rule, and hardcodes no section keys.
 */

import { readFileSync } from "node:fs";
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll SP-2.1 create-route checks passed.");
