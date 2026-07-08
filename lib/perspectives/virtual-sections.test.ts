/**
 * lib/perspectives/virtual-sections.test.ts
 *
 * UX-PER-3 — Perspective Workspace Renderer invariants.
 *
 * Runnable with the already-installed `tsx`:
 *     npx tsx lib/perspectives/virtual-sections.test.ts
 * Exits 0 when all pass, 1 on failure. Auto-discovered by scripts/run-tests.ts.
 *
 * These import cleanly (pure modules — no DB / React / next).
 */

import { PERSPECTIVE_LIBRARY } from "@/lib/perspectives";
import { WIDGET_REGISTRY } from "@/lib/widget-registry";
import {
  toVirtualSections,
  isVirtualSectionId,
  VIRTUAL_SECTION_PREFIX,
} from "@/lib/perspectives/virtual-sections";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

// ── 1. Registry parity — every PerspectiveDef.widgets[] key exists in
//      WIDGET_REGISTRY and is a real (implemented, non-deprecated) widget. ──
const withWidgets = Object.values(PERSPECTIVE_LIBRARY).filter((p) => p.widgets && p.widgets.length > 0);
check("at least one Perspective has a widgets[] workspace (wealth)",
  withWidgets.some((p) => p.id === "wealth"));

for (const p of withWidgets) {
  for (const key of p.widgets!) {
    const entry = WIDGET_REGISTRY.get(key);
    check(`perspective "${p.id}" widget "${key}" exists in WIDGET_REGISTRY`, entry !== undefined);
    if (entry) {
      check(`perspective "${p.id}" widget "${key}" is implemented`, entry.implemented === true);
      check(`perspective "${p.id}" widget "${key}" is not a deprecated alias`,
        entry.meta.deprecatedAlias === undefined);
    }
  }
}

// ── 2. Wealth workspace uses its purpose-built, assets-only widgets. ──
check("wealth workspace = [wealth_by_account, asset_allocation, institution_allocation, wealth_concentration]",
  JSON.stringify(PERSPECTIVE_LIBRARY.wealth.widgets) ===
    JSON.stringify(["wealth_by_account", "asset_allocation", "institution_allocation", "wealth_concentration"]));
// Doctrine: Wealth must NOT reuse the Overview widgets.
check("wealth workspace excludes Overview widgets (net_worth / net_worth_chart / allocation)",
  !(PERSPECTIVE_LIBRARY.wealth.widgets ?? []).some((k) =>
    k === "net_worth" || k === "net_worth_chart" || k === "allocation"));

// ── 3. toVirtualSections shape + virtual-id safety. ──
const vs = toVirtualSections("wealth", ["net_worth", "net_worth_chart", "allocation"]);
check("produces one virtual section per widget", vs.length === 3);
check("preserves widget order", vs.map((s) => s.key).join(",") === "net_worth,net_worth_chart,allocation");
check("order index is 0..n-1", vs.every((s, i) => s.order === i));
check("every id is prefixed virtual:", vs.every((s) => s.id.startsWith(VIRTUAL_SECTION_PREFIX)));
check("isVirtualSectionId recognizes generated ids", vs.every((s) => isVirtualSectionId(s.id)));
check("a real cuid-style id is NOT virtual", !isVirtualSectionId("ckxyz123realrow"));
check("labels resolve from WIDGET_REGISTRY (net_worth → Net Worth)",
  vs[0].label === (WIDGET_REGISTRY.get("net_worth")?.meta.label ?? "net_worth"));
check("config is null and enabled is true (render-only)",
  vs.every((s) => s.config === null && s.enabled === true));

// ── 4. No second compositor / no mutation wiring in the workspace mount. ──
// Source-scan SpaceDashboard: the Perspective workspace must render through the
// existing SectionCard, and must NOT send virtual ids to the reorder endpoint.
import { readFileSync } from "fs";
import { join } from "path";
const dash = readFileSync(join(process.cwd(), "components", "dashboard", "SpaceDashboard.tsx"), "utf8");
const code = dash.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
check("workspace renders via toVirtualSections", /toVirtualSections\(/.test(code));
check("workspace feeds virtual sections into the existing SectionCard",
  /toVirtualSections\([\s\S]{0,400}?<SectionCard/.test(code));
check("reorder endpoint is never called with a virtual: id",
  !/virtual:[\s\S]{0,200}\/sections\/reorder/.test(code) &&
  !/\/sections\/reorder[\s\S]{0,200}virtual:/.test(code));

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("UX-PER-3 virtual-section tests FAILED."); process.exit(1); }
console.log("UX-PER-3 virtual-section tests passed.");
process.exit(0);
