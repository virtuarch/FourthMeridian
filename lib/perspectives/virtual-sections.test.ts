/**
 * lib/perspectives/virtual-sections.test.ts
 *
 * UX-PER-3 — Perspective Workspace Renderer invariants, migrated for REVIEW-3
 * (slice F): the wealth / cashFlow / debt / liquidity widgets[] arrays were
 * deleted (their WORKSPACE_RENDERERS entries always won the dispatch, so the
 * virtual-section lists could never be read), and lib/widget-registry.ts was
 * cut to the surviving consumers' key set. Goals remains the ONE widgets[]-
 * backed workspace (deep-link only; kept per the conservative rule — live-
 * but-orphaned, not provably retired).
 *
 * Runnable with the already-installed `tsx`:
 *     npx tsx lib/perspectives/virtual-sections.test.ts
 * Exits 0 when all pass, 1 on failure. Auto-discovered by scripts/run-tests.ts.
 */

import { readFileSync } from "fs";
import { join } from "path";
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
/** Order-independent set equality — a workspace's widget MEMBERSHIP is the
 *  invariant; presentation order is a free UX knob and must not fail the ratchet. */
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

// ── 1. Renderer-backed perspectives carry NO widgets[] — WORKSPACE_RENDERERS
//      wins the dispatch, so a widgets[] list there would be dead config that
//      drags a registry behind it (exactly what REVIEW-3 deleted). ──
for (const id of ["wealth", "cashFlow", "liquidity", "investments", "debt"]) {
  check(`${id} carries NO widgets[] (renders via WORKSPACE_RENDERERS)`,
    !(PERSPECTIVE_LIBRARY[id].widgets?.length));
}

// ── 1b. Registry ↔ renderer parity (SD-2 closeout). ──
// WORKSPACE_REGISTRY (semantic identity) and WORKSPACE_RENDERERS (React render
// impls) are two authorities that must NOT drift. The renderer map is a component
// module (React) that can't be imported under bare tsx, so source-scan its
// top-level keys and bind them to the registry's "renders an inline workspace"
// set: a finance Perspective that is available and NOT a routed modal.
const rendererSrc = readFileSync(
  join(process.cwd(), "components", "space", "workspaces", "workspaceRenderers.tsx"), "utf8",
);
// Keys are the top-level `  <id>: (ctx) => (` entries of the WORKSPACE_RENDERERS object.
const rendererKeys = [...rendererSrc.matchAll(/^ {2}(\w+):\s*\(ctx\)\s*=>/gm)].map((m) => m[1]);
const rendererSet = new Set(rendererKeys);
const registryRenderIds = Object.values(PERSPECTIVE_LIBRARY)
  .filter((p) => p.kind === "perspective" && p.status === "available" && !p.routing?.targetTab)
  .map((p) => p.id);
check("no duplicate renderer keys", rendererKeys.length === rendererSet.size);
check("every WORKSPACE_RENDERERS key is a real registry perspective id",
  rendererKeys.every((id) => id in PERSPECTIVE_LIBRARY), `keys: ${rendererKeys.join(", ")}`);
check("registry render-set === WORKSPACE_RENDERERS keys (no perspective without a renderer, no orphan renderer)",
  sameSet(registryRenderIds, rendererKeys),
  `registry: [${[...registryRenderIds].sort().join(", ")}] renderers: [${[...rendererKeys].sort().join(", ")}]`);

// ── 2. Goals — the ONE surviving widgets[] workspace. ──
check("goals is the only widgets[]-backed entry in the library",
  Object.values(PERSPECTIVE_LIBRARY).filter((p) => p.widgets && p.widgets.length > 0)
    .map((p) => p.id).join() === "goals");
check("goals workspace set === {goal_progress, goal_on_track, goal_required_pace, goal_funding_gap}",
  sameSet(PERSPECTIVE_LIBRARY.goals.widgets ?? [],
    ["goal_progress", "goal_on_track", "goal_required_pace", "goal_funding_gap"]));
// Registry parity — every goals widget key resolves in the trimmed registry.
for (const key of PERSPECTIVE_LIBRARY.goals.widgets ?? []) {
  check(`goals widget "${key}" exists in WIDGET_REGISTRY`, WIDGET_REGISTRY.has(key));
}

// ── 3. toVirtualSections shape + virtual-id safety. ──
const GOAL_KEYS = ["goal_progress", "goal_on_track", "goal_required_pace"];
const vs = toVirtualSections("goals", GOAL_KEYS);
check("produces one virtual section per widget", vs.length === 3);
check("preserves widget order", vs.map((s) => s.key).join(",") === GOAL_KEYS.join(","));
check("order index is 0..n-1", vs.every((s, i) => s.order === i));
check("every id is prefixed virtual:", vs.every((s) => s.id.startsWith(VIRTUAL_SECTION_PREFIX)));
check("isVirtualSectionId recognizes generated ids", vs.every((s) => isVirtualSectionId(s.id)));
check("a real cuid-style id is NOT virtual", !isVirtualSectionId("ckxyz123realrow"));
check("labels resolve from WIDGET_REGISTRY (goal_progress → Goal Progress)",
  vs[0].label === (WIDGET_REGISTRY.get("goal_progress")?.meta.label ?? "goal_progress"));
check("an unregistered key falls back to the raw key as its label",
  toVirtualSections("goals", ["not_a_widget"])[0].label === "not_a_widget");
check("config is null and enabled is true (render-only)",
  vs.every((s) => s.config === null && s.enabled === true));

// ── 4. No second compositor / no mutation wiring in the workspace mount. ──
// Source-scan SpaceDashboard: the Perspective workspace must render through the
// existing SectionCard, and must NOT send virtual ids to the reorder endpoint.
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
