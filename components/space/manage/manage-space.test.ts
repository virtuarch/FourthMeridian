/**
 * components/space/manage/manage-space.test.ts  (MSM decomposition)
 *
 * Source-scan ratchets for the ManageSpaceModal decomposition (house pattern —
 * pure, DB-free; mirrors components/space/workspaces/workspaces.test.ts). Locks
 * the ARCHITECTURE, not the markup:
 *
 *   1. Each focused panel exists in components/space/manage/ + exports itself.
 *   2. The shell (ManageSpaceModal) is orchestration-only: it mounts each panel
 *      once, gated by activeTab, and no longer DEFINES any tab body / mutation.
 *   3. The shell stays thin (few useState; no per-tab fetch/mutation handlers).
 *   4. Permission + destructive gates are preserved on the shell / DangerZone.
 *   5. The unreachable, divergent GoalsTab duplicate is GONE (no Goals authority
 *      anywhere under manage/ — the canonical GoalsCard/AddGoalModal own goals).
 *   6. Canonical capabilities are REUSED, not re-implemented: the shared
 *      UserSearchInput + ShareExistingAccountsPanel are defined once and
 *      consumed by CreateSpaceModal; the sections panel consumes the canonical
 *      DashboardSection type.
 *
 *   npx tsx components/space/manage/manage-space.test.ts
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (...seg: string[]) => readFileSync(path.join(ROOT, ...seg), "utf8");
const M   = (f: string) => read("components", "space", "manage", f);
/** strip comments so scans match real code, not the (deliberately descriptive) prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const exists = (f: string) => existsSync(path.join(ROOT, "components", "space", "manage", f));

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function count(hay: string, needle: string): number {
  let n = 0, i = 0;
  for (;;) { const j = hay.indexOf(needle, i); if (j === -1) return n; n++; i = j + needle.length; }
}

const SHELL     = M("ManageSpaceModal.tsx");
const SHELLCODE = code(SHELL);

console.log("1. Every focused panel + shared helper exists and exports its component");
{
  const files: [string, string][] = [
    ["ManageSpaceModal.tsx",          "export function ManageSpaceModal"],
    ["GeneralSettingsPanel.tsx",      "export function GeneralSettingsPanel"],
    ["MembersPanel.tsx",              "export function MembersPanel"],
    ["FinancesPanel.tsx",             "export function FinancesPanel"],
    ["OverviewSectionsPanel.tsx",     "export function OverviewSectionsPanel"],
    ["DangerZonePanel.tsx",           "export function DangerZonePanel"],
    ["UserSearchInput.tsx",           "export function UserSearchInput"],
    ["ShareExistingAccountsPanel.tsx","export function ShareExistingAccountsPanel"],
    ["manage-shared.ts",              "export const ROLE_LABELS"],
  ];
  for (const [file, exp] of files) {
    check(`${file} exists`, exists(file));
    check(`${file} exports its member`, M(file).includes(exp));
  }
}

console.log("2. The shell MOUNTS each panel once, gated by its tab");
{
  const mounts: [string, string][] = [
    ['activeTab === "general"',   "<GeneralSettingsPanel"],
    ['activeTab === "members"',   "<MembersPanel"],
    ['activeTab === "finances"',  "<FinancesPanel"],
    ['activeTab === "dashboard"', "<OverviewSectionsPanel"],
    ['activeTab === "danger"',    "<DangerZonePanel"],
  ];
  for (const [gate, mount] of mounts) {
    check(`shell gates + mounts ${mount}`, SHELLCODE.includes(gate) && count(SHELLCODE, mount) === 1);
  }
}

console.log("3. The shell is orchestration-only (no tab body / mutation lives in it)");
{
  // The former inline tab components + their mutation handlers must NOT be
  // declared in the shell anymore — they live in their extracted panels.
  const gone = [
    "function GeneralTab(", "function MembersTab(", "function GoalsTab(",
    "function FinancesTab(", "function DashboardTab(", "function DangerZoneTab(",
    "handleInvite", "handleRoleChange", "handleRescind",   // members mutations
    "handleShare", "handleRevoke",                          // accounts mutations
    "loadSections", "loadAccounts", "loadGoals",            // per-tab loaders
    "handleArchive", "handleTrash", "handleLeave",          // danger mutations
    "UserSearchInput", "ShareExistingAccountsPanel",        // shared widgets (mounted in panels)
  ];
  for (const g of gone) check(`shell no longer contains \`${g}\``, !SHELLCODE.includes(g));
  // The shell owns only load-the-space + selected-tab + loading — three useState
  // declarations (count the `= useState` form so the react import isn't counted).
  check("shell keeps at most 3 useState declarations (thin orchestration)", count(SHELLCODE, "= useState") <= 3,
    `found ${count(SHELLCODE, "= useState")}`);
  // The shell does no per-tab data fetching beyond loading the Space itself.
  check("shell fetches only the Space (single fetch call)", count(SHELLCODE, "fetch(") === 1);
}

console.log("4. Permission + destructive gates preserved");
{
  // Shell tab-visibility gates (mirror the server role model).
  check("General tab is OWNER-only (show: canEdit; canEdit = isOwner)",
    /id:\s*"general"[\s\S]{0,120}?show:\s*canEdit/.test(SHELLCODE) && SHELLCODE.includes("canEdit   = isOwner"));
  check("Overview tab is OWNER/ADMIN (show: canManage)",
    /id:\s*"dashboard"[\s\S]{0,160}?show:\s*canManage/.test(SHELLCODE) &&
    SHELLCODE.includes('canManage = ["OWNER", "ADMIN"].includes(myRole)'));
  check("Danger tab gated on a loaded, non-PERSONAL Space",
    /id:\s*"danger"[\s\S]{0,220}?type\s*!==\s*"PERSONAL"/.test(SHELLCODE));
  check("Danger tab BODY gated on non-PERSONAL",
    /activeTab\s*===\s*"danger"[\s\S]{0,40}?type\s*!==\s*"PERSONAL"/.test(SHELLCODE));

  // DangerZone is the ONLY manage surface with destructive fetches, and
  // permanent deletion is never reachable from it.
  const DANGER = code(M("DangerZonePanel.tsx"));
  check("DangerZone owns leave/archive/trash", DANGER.includes("handleLeave") && DANGER.includes("handleArchive") && DANGER.includes("handleTrash"));
  check("DangerZone preserves the owner gate", DANGER.includes('isOwner = myRole === "OWNER"'));
  check("DangerZone never calls the permanent-delete route", !DANGER.includes("/permanent"));
  for (const other of ["GeneralSettingsPanel.tsx", "MembersPanel.tsx", "FinancesPanel.tsx", "OverviewSectionsPanel.tsx"]) {
    check(`${other} has no archive/trash destructive action`,
      !code(M(other)).includes("handleArchive") && !code(M(other)).includes("handleTrash"));
  }

  // Members panel keeps the personal-space invite gate.
  const MEMBERS = code(M("MembersPanel.tsx"));
  check("MembersPanel derives isPersonal + gates canInvite on it",
    MEMBERS.includes('isPersonal = space.type === "PERSONAL"') && MEMBERS.includes("canInvite = !isPersonal"));
}

console.log("5. The divergent GoalsTab duplicate is GONE (no Goals authority under manage/)");
{
  const manageFiles = [
    "ManageSpaceModal.tsx", "GeneralSettingsPanel.tsx", "MembersPanel.tsx",
    "FinancesPanel.tsx", "OverviewSectionsPanel.tsx", "DangerZonePanel.tsx",
    "UserSearchInput.tsx", "ShareExistingAccountsPanel.tsx", "manage-shared.ts",
  ];
  for (const f of manageFiles) {
    const c = code(M(f));
    check(`${f} declares no local Goal authority`,
      !c.includes("GOAL_CATEGORY_LABELS") && !c.includes("GoalsTab") &&
      !c.includes('id: "goals"') && !c.includes("/goals"));
  }
  // The canonical goal capability still lives where it belongs (untouched).
  check("canonical AddGoalModal still owns goal creation",
    read("components", "space", "workspaces", "AddGoalModal.tsx").includes("export function AddGoalModal"));
  // SEC-1 relocated the goal-list authority to its own module (still the single
  // authority — the registry imports it; MSM only cares that it exists once).
  check("canonical GoalsCard still owns the goal list/lifecycle",
    read("components", "space", "sections", "goals", "GoalsCard.tsx").includes("export function GoalsCard"));
}

console.log("6. Canonical capabilities REUSED, not re-implemented");
{
  // Shared invite/share widgets are defined once, under manage/.
  check("UserSearchInput defined exactly once (manage/)",
    M("UserSearchInput.tsx").includes("export function UserSearchInput"));
  check("ShareExistingAccountsPanel defined exactly once (manage/)",
    M("ShareExistingAccountsPanel.tsx").includes("export function ShareExistingAccountsPanel"));

  // CreateSpaceModal consumes the SAME widgets (one capability, two mount points).
  const CREATE = read("components", "dashboard", "CreateSpaceModal.tsx");
  check("CreateSpaceModal reuses UserSearchInput from manage/",
    /import\s*\{[^}]*UserSearchInput[^}]*\}\s*from\s*"@\/components\/space\/manage\/UserSearchInput"/.test(CREATE));
  check("CreateSpaceModal reuses ShareExistingAccountsPanel from manage/",
    /import\s*\{[^}]*ShareExistingAccountsPanel[^}]*\}\s*from\s*"@\/components\/space\/manage\/ShareExistingAccountsPanel"/.test(CREATE));
  check("CreateSpaceModal does not re-import from the retired dashboard path",
    !CREATE.includes("dashboard/ManageSpaceModal"));

  // The sections panel consumes the canonical DashboardSection type (no local re-decl).
  const SECTIONS = M("OverviewSectionsPanel.tsx");
  check("OverviewSectionsPanel imports the canonical DashboardSection type",
    SECTIONS.includes('from "@/lib/space/dashboard-types"'));
  check("OverviewSectionsPanel does not re-declare a local DashboardSection type",
    !code(SECTIONS).includes("type DashboardSection ="));

  // The old monolith path is fully retired.
  check("retired monolith components/dashboard/ManageSpaceModal.tsx is gone",
    !existsSync(path.join(ROOT, "components", "dashboard", "ManageSpaceModal.tsx")));
}

if (failures > 0) { console.error(`\n${failures} manage-space check(s) failed`); process.exit(1); }
console.log("\nAll MSM manage-space decomposition checks passed");
