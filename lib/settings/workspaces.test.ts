/**
 * lib/settings/workspaces.test.ts  (UI Convergence Wave 1 — W1-0)
 *
 * Guards for the Settings utility-workspace identity + composition. Standalone tsx
 * (house pattern): npx tsx lib/settings/workspaces.test.ts — exits 0/1.
 * Auto-discovered by scripts/run-tests.ts.
 *
 * Pins: every Settings section resolves in the UNIVERSAL registry; ids namespaced +
 * disjoint; domain:"settings"; NO finance vocabulary; the single composition owner
 * (SETTINGS_WORKSPACE_ORDER) covers exactly the registered sections with unique,
 * canonical routes (D3 — the URL stays authoritative); navigation reuses SpaceShell
 * (global-peer, no Space-mode takeover).
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  SETTINGS_WORKSPACES,
  SETTINGS_WORKSPACE_ORDER,
  getSettingsWorkspace,
  isSettingsWorkspaceId,
} from "@/lib/settings/workspaces";
import { WORKSPACE_REGISTRY, getWorkspaceDefinition, STANDARD_WORKSPACES } from "@/lib/perspectives";
import { PLATFORM_WORKSPACES } from "@/lib/platform/workspaces";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
/** Strip comments so documentation prose (which may name an avoided call) never
 *  trips a code ratchet — the house pattern (see space-shell.test.ts). */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

console.log("universal registry identity");
{
  for (const [id, def] of Object.entries(SETTINGS_WORKSPACES)) {
    check(`"${id}" is registered in the universal WORKSPACE_REGISTRY`, WORKSPACE_REGISTRY[id] === def);
    check(`"${id}" resolves via the universal getWorkspaceDefinition`, getWorkspaceDefinition(id) === def);
    check(`"${id}" resolves via getSettingsWorkspace + isSettingsWorkspaceId`, getSettingsWorkspace(id) === def && isSettingsWorkspaceId(id));
    check(`"${id}" is "settings-*"-namespaced (disjoint from finance/platform ids)`, id.startsWith("settings-"));
    check(`"${id}" registry key === def.id`, def.id === id);
    check(`"${id}" declares domain:"settings"`, def.domain === "settings");
    check(`"${id}" is a standard Workspace`, def.kind === "standard");
  }
  check("no id collision with finance STANDARD_WORKSPACES", Object.keys(SETTINGS_WORKSPACES).every((id) => !(id in STANDARD_WORKSPACES)));
  check("no id collision with PLATFORM_WORKSPACES", Object.keys(SETTINGS_WORKSPACES).every((id) => !(id in PLATFORM_WORKSPACES)));
  // NOT the bare "settings" — the finance getWorkspaceForTab("SETTINGS") must stay undefined.
  check("no bare \"settings\" id (finance getWorkspaceForTab stays undefined)", getWorkspaceDefinition("settings") === undefined);
}

console.log("no finance-vocabulary pollution");
{
  for (const [id, def] of Object.entries(SETTINGS_WORKSPACES)) {
    const d = def as unknown as Record<string, unknown>;
    check(`"${id}" declares no finance dataNeeds`, d.dataNeeds === undefined);
    check(`"${id}" declares no finance envelope`, d.envelope === undefined);
    check(`"${id}" declares no finance routing`, d.routing === undefined);
    check(`"${id}" declares no temporalCapability`, d.temporalCapability === undefined);
  }
}

console.log("single composition owner integrity");
{
  const orderIds = SETTINGS_WORKSPACE_ORDER.map((w) => w.workspaceId);
  const routes = SETTINGS_WORKSPACE_ORDER.map((w) => w.route);
  check("every ordered section resolves to a registered Settings workspace", orderIds.every((id) => getSettingsWorkspace(id) != null));
  check("order covers EXACTLY the registered Settings sections (no orphans)", new Set(orderIds).size === Object.keys(SETTINGS_WORKSPACES).length && orderIds.every((id) => id in SETTINGS_WORKSPACES));
  check("routes are unique", new Set(routes).size === routes.length);
  check("every route is a canonical /dashboard/settings/* URL (D3 preserved)", routes.every((r) => r.startsWith("/dashboard/settings/")));
}

console.log("navigation reuse (SpaceShell, URL-driven)");
{
  // Activates once W1-B lands the SpaceShell layout host (W1-0 stays green before then).
  const layoutRel = "app/(shell)/dashboard/settings/layout.tsx";
  if (existsSync(path.join(process.cwd(), layoutRel))) {
    const layout = stripComments(read(layoutRel));
    check("layout reuses the shared SpaceShell", /@\/components\/space\/shell\/SpaceShell/.test(layout) && /railOptions/.test(layout));
    check("rail comes from SETTINGS_WORKSPACE_ORDER (not hardcoded JSX)", /SETTINGS_WORKSPACE_ORDER/.test(layout));
    check("URL-driven: derives active from pathname + navigates by router.push (D3)", /usePathname/.test(layout) && /router\.push/.test(layout));
    // D2 — global-nav peer: MUST NOT take over the ContextualNavbar.
    check("does NOT enter customer Space mode (no publishSpace / useSpaceChromePublisher)", !/publishSpace|useSpaceChromePublisher/.test(layout));
  } else {
    console.log("  … settings/layout.tsx not present yet (W1-B) — navigation scans deferred");
  }
}

if (failures > 0) {
  console.error(`\nsettings/workspaces.test: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nsettings/workspaces.test: all passed.");
