/**
 * app/api/spaces/[id]/sections/settings-and-layout.test.ts
 *
 * UX-CUST-1A correction — invariants for:
 *   1. Settings is no longer an in-space rail tab (moved to ManageSpaceModal).
 *   2. ManageSpaceModal → Overview is the home for layout controls:
 *      reset-to-default (deferred/disabled) + saved-layout placeholder.
 *   3. Overview keeps section-backed visible drag/drop; Perspectives cards are
 *      NOT section-backed and are intentionally left fixed (no fake drag).
 *
 * Runnable with the already-installed `tsx`:
 *     npx tsx app/api/spaces/[id]/sections/settings-and-layout.test.ts
 * Exits 0 when all pass, 1 on failure. Auto-discovered by scripts/run-tests.ts.
 *
 * Source-scan (same rationale as lib/spaces/authorize.test.ts): the components
 * pull in React/next and heavy deps that don't load under a bare tsx script.
 */

import { readFileSync } from "fs";
import { join }         from "path";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
function read(...seg: string[]): string {
  return readFileSync(join(process.cwd(), ...seg), "utf8");
}
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

const dash   = code(read("components", "dashboard", "SpaceDashboard.tsx"));
const manage = code(read("components", "dashboard", "ManageSpaceModal.tsx"));

// ── 1. Settings removed from the in-space rail ───────────────────────────────
check("rail unconditionally filters out SETTINGS (no manager-gated button)",
  /id\s*!==\s*["']SETTINGS["']\s*\)/.test(dash) &&
  !/id\s*!==\s*["']SETTINGS["']\s*\|\|\s*canManage/.test(dash));
check("no in-space SettingsTab component is defined",
  !/function\s+SettingsTab\s*\(/.test(dash));
check("no in-space SettingsTab is rendered",
  !/<SettingsTab\b/.test(dash));
check("no tab-switch to SETTINGS remains (moved to Manage modal)",
  !/setActiveTab\(\s*["']SETTINGS["']\s*\)/.test(dash));
check("empty-state 'Manage sections' opens the Manage modal",
  /setShowManage\(\s*true\s*\)/.test(dash));

// ── 2. Overview keeps section-backed drag; Perspectives left fixed ───────────
check("Overview section stack is drag-wrapped (DndContext + SortableContext)",
  /<DndContext[\s\S]*?<SortableContext[\s\S]*?SortableSectionCard/.test(dash));
check("reorder persists via the batch reorder endpoint",
  /\/sections\/reorder/.test(dash));
check("Perspectives grid is NOT wrapped in a DndContext (left fixed)",
  (() => {
    const i = dash.indexOf('activeTab === "PERSPECTIVES"');
    if (i === -1) return false;
    // no DndContext in the immediate Perspectives render block
    return !/PerspectivesWidget[^;]*DndContext/.test(dash.slice(i, i + 400));
  })());

// ── 3. ManageSpaceModal → Overview: layout guidance only, no dead controls ───
// Unified Space Widget Layout (slice 1): the dead "Reset to default layout"
// control is removed until a real implementation exists; the modal keeps only a
// refresh, the reorder instruction, and a saved-layouts placeholder.
check("Manage Overview has NO Reset-to-default-layout control (removed until real)",
  !/Reset to default layout/.test(manage));
check("Manage Overview has a Refresh affordance",
  /Refresh/.test(manage));
check("Manage Overview keeps the reorder instruction",
  /use\s+<span[^>]*>Edit layout<\/span>\s+on the dashboard/.test(manage));
check("Manage Overview has a Saved-layouts placeholder",
  /Saved layouts/.test(manage));

// ── 4. Personal delete stays gone (regression guard) ─────────────────────────
check("Manage danger tab still gated on non-PERSONAL (delete stays unavailable)",
  /id:\s*["']danger["'][\s\S]{0,220}?type\s*!==\s*["']PERSONAL["']/.test(manage));

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("UX-CUST-1A settings/layout tests FAILED."); process.exit(1); }
console.log("UX-CUST-1A settings/layout tests passed.");
process.exit(0);
