/**
 * components/space/workspaces/workspaces.test.ts  (SD-7)
 *
 * Source-scan ratchets for the Standard Workspace extraction (house pattern — pure,
 * DB-free). Locks the SD-7 architecture: SpaceDashboard stops owning page composition
 * and only MOUNTS each destination's Workspace; the section subsystem + section stack
 * are shared modules. Behavior is byte-identical — these pin ownership, not markup.
 *
 *   npx tsx components/space/workspaces/workspaces.test.ts
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (...seg: string[]) => readFileSync(path.join(ROOT, ...seg), "utf8");
const WS = (f: string) => read("components", "space", "workspaces", f);
const DASH = read("components", "dashboard", "SpaceDashboard.tsx");
const DASHCODE = DASH.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments (prose names moved decls)
const SECTIONS = read("components", "space", "sections", "SpaceSections.tsx");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function count(hay: string, needle: string): number {
  let n = 0, i = 0;
  for (;;) { const j = hay.indexOf(needle, i); if (j === -1) return n; n++; i = j + needle.length; }
}

console.log("1. Every standard Workspace file exists + exports its component");
{
  const files: [string, string][] = [
    ["MembersWorkspace.tsx", "export function MembersWorkspace"],
    ["TransactionsWorkspace.tsx", "export function TransactionsWorkspace"],
    ["AccountsWorkspace.tsx", "export function AccountsWorkspace"],
    ["ActivityWorkspace.tsx", "export function ActivityWorkspace"],
    ["OverviewWorkspace.tsx", "export function OverviewWorkspace"],
    ["AddGoalModal.tsx", "export function AddGoalModal"],
    ["RoutedWorkspaceModal.tsx", "export function RoutedWorkspaceModal"],
    ["SpaceSectionStack.tsx", "export function SpaceSectionStack"],
  ];
  for (const [file, exp] of files) {
    check(`${file} exists`, existsSync(path.join(ROOT, "components", "space", "workspaces", file)));
    check(`${file} exports its component`, WS(file).includes(exp));
  }
  check("SpaceSectionStack exports the shared NoSectionsCard", WS("SpaceSectionStack.tsx").includes("export function NoSectionsCard"));
}

console.log("2. Host MOUNTS each destination's Workspace (once each), per activeTab");
{
  const mounts: [string, string][] = [
    ['activeTab === "MEMBERS"', "<MembersWorkspace"],
    ['activeTab === "TRANSACTIONS"', "<TransactionsWorkspace"],
    ['activeTab === "ACCOUNTS"', "<AccountsWorkspace"],
    ['activeTab === "ACTIVITY"', "<ActivityWorkspace"],
    ['activeTab === "OVERVIEW"', "<OverviewWorkspace"],
    ["isRoutedWorkspaceTab(activeTab)", "<RoutedWorkspaceModal"],
  ];
  for (const [gate, mount] of mounts) {
    check(`host gates + mounts ${mount}`, DASHCODE.includes(gate) && count(DASHCODE, mount) === 1);
  }
  check("host mounts <AddGoalModal (overlay, once)", count(DASHCODE, "<AddGoalModal") === 1);
}

console.log("3. Host no longer DEFINES the extracted composition (ownership left the host)");
{
  // Section subsystem, section renderers, the Overview setup card, the goal modal —
  // none are declared in the host anymore (they live in their extracted modules).
  const gone = [
    "function SectionCard(",
    "function SortableSectionCard(",
    "const SectionRegistry",
    "function AccountsCard(",
    "function GoalsCard(",
    "function ActivityCard(",
    "function OverviewSetupCard(",
    "function AddGoalModal(",
    "const GOAL_TYPE_META",
    "<SpaceTrendHero",         // hero render moved into OverviewWorkspace
    "<PerspectiveSwitcher",    // composition switcher moved into OverviewWorkspace
    "<GlassModal",             // routed modal moved into RoutedWorkspaceModal
  ];
  for (const g of gone) check(`host no longer contains \`${g}\``, !DASHCODE.includes(g));
  // The host no longer owns the Overview composition state.
  check("host no longer owns composition switcher state", !DASHCODE.includes("const [composition"));
}

console.log("4. The section subsystem is the ONE home for SectionCard + the registry");
{
  check("SpaceSections defines SectionCard once", count(SECTIONS, "export function SectionCard(") === 1);
  check("SpaceSections defines the SectionRegistry once", count(SECTIONS, "export const SectionRegistry") === 1);
  check("host imports SectionCard/SortableSectionCard/SectionRegistry from the module",
    DASH.includes('from "@/components/space/sections/SpaceSections"'));
  check("Accounts/Activity/Overview compose the shared SpaceSectionStack",
    WS("AccountsWorkspace.tsx").includes("<SpaceSectionStack") &&
    WS("ActivityWorkspace.tsx").includes("<SpaceSectionStack") &&
    WS("OverviewWorkspace.tsx").includes("<SpaceSectionStack"));
}

console.log("5. Shared dashboard types have ONE home (no host-inline re-declaration)");
{
  check("host imports the shared dashboard types",
    DASH.includes('from "@/lib/space/dashboard-types"'));
  check("host no longer declares the view types inline",
    !DASHCODE.includes("type SpaceAccount =") && !DASHCODE.includes("type DashboardSection ="));
}

if (failures > 0) { console.error(`\n${failures} workspaces check(s) failed`); process.exit(1); }
console.log("\nAll SD-7 workspaces checks passed");
