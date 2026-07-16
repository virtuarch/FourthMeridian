/**
 * lib/perspectives/workspace-definition.test.ts
 *
 * SD-2 ratchets. Mostly PURE (registry + helpers); one source-scan section pins
 * that the old duplicate host maps are gone and the host consumes the registry.
 *   npx tsx lib/perspectives/workspace-definition.test.ts
 *
 * Proves: exactly ONE canonical workspace registry; unique/deterministic/
 * fail-safe lookup; routing metadata converged onto the definitions and behavior-
 * identical to the removed PERSPECTIVE_TARGET_TAB / PERSPECTIVE_ROUTED_TABS /
 * PERSPECTIVE_MODAL_META maps; dataNeeds + consumesTime + envelope declared to
 * match current runtime; SpaceShell stays workspace-agnostic; top-level tab order
 * unchanged (Space tabs are NOT workspaces).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PERSPECTIVE_LIBRARY,
  STANDARD_WORKSPACES,
  WORKSPACE_REGISTRY,
  getWorkspaceDefinition,
  getWorkspaceForTab,
  getWorkspaceTargetTab,
  ROUTED_WORKSPACE_TABS,
  isRoutedWorkspaceTab,
  getWorkspaceModalMeta,
  type WorkspaceDataNeed,
  type WorkspaceEnvelopeSource,
} from "../perspectives";
import { PERSPECTIVE_ICON_MAP } from "../perspective-icons";
import { SPACE_TAB_ORDER } from "../space-nav";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

// ── ONE canonical UNIVERSAL registry — standard + perspective, no duplication ────
{
  const keys = Object.keys(WORKSPACE_REGISTRY);
  // Every perspective AND every standard workspace resolves through the ONE registry.
  check("every PERSPECTIVE_LIBRARY entry is in WORKSPACE_REGISTRY (same object)",
    Object.keys(PERSPECTIVE_LIBRARY).every((k) => WORKSPACE_REGISTRY[k] === PERSPECTIVE_LIBRARY[k]));
  check("every STANDARD_WORKSPACES entry is in WORKSPACE_REGISTRY (same object)",
    Object.keys(STANDARD_WORKSPACES).every((k) => WORKSPACE_REGISTRY[k] === STANDARD_WORKSPACES[k]));
  // No duplicate identity between the two sources.
  check("standard + perspective id sets are disjoint (no duplicate identity)",
    Object.keys(STANDARD_WORKSPACES).every((k) => !(k in PERSPECTIVE_LIBRARY)));
  check("registry key === def.id everywhere", keys.every((k) => WORKSPACE_REGISTRY[k].id === k));
  check("workspace ids are unique", new Set(keys).size === keys.length);
}

// ── kind discriminator: standard vs perspective ─────────────────────────────────
// Doctrine: a Perspective is a TEMPORAL FINANCIAL LENS over the canonical financial
// knowledge (participates in asOf/compareTo). Goals is goal MANAGEMENT (its own
// domain) ⇒ standard, NOT a Perspective. Overview + the four rail destinations are
// structural ⇒ standard.
{
  const STANDARD = ["overview", "transactions", "accounts", "activity", "members", "goals"];
  const PERSPECTIVES = ["wealth", "cashFlow", "liquidity", "investments", "debt", "retirement", "tax", "property", "businessHealth"];
  for (const id of STANDARD) check(`${id}.kind === "standard"`, WORKSPACE_REGISTRY[id]?.kind === "standard");
  for (const id of PERSPECTIVES) check(`${id}.kind === "perspective"`, WORKSPACE_REGISTRY[id]?.kind === "perspective");
  check("Goals is a standard Workspace, NOT a Perspective", WORKSPACE_REGISTRY.goals?.kind === "standard");
  // Exhaustive: the FINANCE standard set is EXACTLY these six (registry
  // verification). Scoped to the finance domain because OPS-5 S6 registers Platform
  // Operations workspaces (domain:"platform") that are also kind:"standard" in the
  // same universal registry — those are validated in lib/platform/workspaces.test.ts.
  check("finance kind:standard set === {overview,transactions,accounts,activity,members,goals}",
    sameSet(Object.values(WORKSPACE_REGISTRY).filter((d) => d.kind === "standard" && d.domain !== "platform").map((d) => d.id), STANDARD));
  // Every Perspective is a Workspace: PERSPECTIVE_LIBRARY entries carry the base fields.
  check("every PERSPECTIVE_LIBRARY entry has an id/label/icon/kind",
    Object.values(PERSPECTIVE_LIBRARY).every((d) => !!d.id && !!d.label && !!d.icon && !!d.kind));
}

// ── Every primary SpaceShell destination is a registered Workspace ──────────────
{
  // The five standard rail destinations that render directly in the workspace slot.
  for (const id of ["overview", "transactions", "accounts", "activity", "members"]) {
    check(`primary destination "${id}" is registered`, !!getWorkspaceDefinition(id));
  }
  // getWorkspaceForTab maps a top-level tab id → its workspace (lowercased id).
  const tabMap: Record<string, string | undefined> = {
    OVERVIEW: "overview", TRANSACTIONS: "transactions", ACCOUNTS: "accounts",
    ACTIVITY: "activity", MEMBERS: "members",
    GOALS: "goals", DEBT: "debt", INVESTMENTS: "investments", RETIREMENT: "retirement",
    PERSPECTIVES: undefined, FINANCES: undefined, DOCUMENTS: undefined, SETTINGS: undefined,
  };
  for (const [tab, wid] of Object.entries(tabMap)) {
    check(`getWorkspaceForTab(${tab}) → ${wid}`, getWorkspaceForTab(tab)?.id === wid);
  }
}

// ── Deterministic + fail-safe lookup ────────────────────────────────────────────
check("lookup is deterministic", getWorkspaceDefinition("wealth") === PERSPECTIVE_LIBRARY.wealth);
check("Transactions is now lookup-able (no exception path for SD-3)", getWorkspaceDefinition("transactions")?.id === "transactions");
check("unknown id fails safe (undefined)", getWorkspaceDefinition("nope") === undefined);
check("empty id fails safe (undefined)", getWorkspaceDefinition("") === undefined);

// ── Routing converged — behavior-identical to the removed PERSPECTIVE_TARGET_TAB ──
{
  const expectedTargets: Record<string, string | undefined> = {
    investments: "INVESTMENTS", debt: "DEBT", retirement: "RETIREMENT", goals: "GOALS",
    wealth: undefined, cashFlow: undefined, liquidity: undefined, overview: undefined,
  };
  for (const [id, target] of Object.entries(expectedTargets)) {
    check(`getWorkspaceTargetTab(${id}) === ${target}`, getWorkspaceTargetTab(id) === target);
  }
  // ROUTED_WORKSPACE_TABS === the old PERSPECTIVE_ROUTED_TABS set (order-free).
  check("ROUTED_WORKSPACE_TABS === {GOALS,DEBT,INVESTMENTS,RETIREMENT}",
    sameSet(ROUTED_WORKSPACE_TABS as readonly string[], ["GOALS", "DEBT", "INVESTMENTS", "RETIREMENT"]));
  check("isRoutedWorkspaceTab true for a routed tab", isRoutedWorkspaceTab("DEBT"));
  check("isRoutedWorkspaceTab false for a non-routed tab", !isRoutedWorkspaceTab("OVERVIEW") && !isRoutedWorkspaceTab("ACCOUNTS"));
}

// ── Modal chrome converged — behavior-identical to the removed PERSPECTIVE_MODAL_META
{
  const expectedModal: Record<string, { title: string; icon: string }> = {
    GOALS:       { title: "Goals",       icon: "Target" },
    DEBT:        { title: "Debt",        icon: "CreditCard" },
    INVESTMENTS: { title: "Investments", icon: "TrendingUp" },
    RETIREMENT:  { title: "Retirement",  icon: "PiggyBank" },
  };
  for (const [tab, meta] of Object.entries(expectedModal)) {
    const got = getWorkspaceModalMeta(tab);
    check(`getWorkspaceModalMeta(${tab}) === {${meta.title}, ${meta.icon}}`,
      !!got && got.title === meta.title && got.icon === meta.icon);
    // The icon NAME must resolve in the shared map so the host render is identical.
    check(`modal icon "${meta.icon}" resolves in PERSPECTIVE_ICON_MAP`, !!PERSPECTIVE_ICON_MAP[meta.icon]);
  }
  check("getWorkspaceModalMeta(OVERVIEW) undefined (non-routed)", getWorkspaceModalMeta("OVERVIEW") === undefined);
}

// ── dataNeeds declared to match current runtime (per the SD-2 census) ────────────
{
  const expectedNeeds: Record<string, WorkspaceDataNeed[]> = {
    // perspective workspaces
    wealth:      ["accounts", "snapshots"],
    cashFlow:    ["accounts", "transactions"],
    liquidity:   ["accounts", "transactions", "lens"],
    investments: ["accounts", "investmentsHistory"],
    debt:        ["accounts", "snapshots", "lens", "fico"],
    goals:       ["accounts", "goals"],
    // standard workspaces
    overview:      ["accounts", "sections", "snapshots", "transactions", "lens"],
    transactions:  ["accounts", "transactions"],
    accounts:      ["accounts", "sections", "snapshots"],
    activity:      ["sections"],
    members:       [],
  };
  for (const [id, needs] of Object.entries(expectedNeeds)) {
    const got = WORKSPACE_REGISTRY[id].dataNeeds;
    check(`${id}.dataNeeds === [${needs.join(", ")}]`, !!got && sameSet(got, needs));
  }
  // Every declared need is a member of the closed WorkspaceDataNeed union.
  const VALID: WorkspaceDataNeed[] = ["accounts", "snapshots", "transactions", "lens", "investmentsHistory", "goals", "sections", "fico"];
  const allNeeds = Object.values(WORKSPACE_REGISTRY).flatMap((d) => d.dataNeeds ?? []);
  check("all declared dataNeeds are valid union members", allNeeds.every((n) => (VALID as string[]).includes(n)));
}

// ── consumesShellTime encodes the DOCTRINE contract, not current implementation ───
// Renamed from consumesTime (SD-2C): "participates in the SD-0B canonical
// asOf/compareTo model". DOCTRINE: every Perspective is a temporal financial lens
// ⇒ true, even where runtime support is incomplete (e.g. Liquidity — a gap to
// close, NOT a reclassification). Standard/domain workspaces ⇒ false.
{
  const expectedTime: Record<string, boolean> = {
    // temporal financial Perspectives — all true by contract
    wealth: true, investments: true, cashFlow: true, debt: true, liquidity: true,
    // standard/domain workspaces — false
    goals: false,
  };
  for (const [id, ct] of Object.entries(expectedTime)) {
    check(`${id}.consumesShellTime === ${ct}`, WORKSPACE_REGISTRY[id].consumesShellTime === ct);
  }
  // Standard workspaces never consume canonical shell time.
  for (const id of ["overview", "transactions", "accounts", "activity", "members", "goals"]) {
    check(`${id}.consumesShellTime === false`, WORKSPACE_REGISTRY[id].consumesShellTime === false);
  }
  // DOCTRINE RATCHET: every Perspective WITH a workspace body (widgets) MUST be a
  // temporal lens (consumesShellTime true) — the registry describes the intended
  // contract, never fossilizing an implementation gap as a non-temporal category.
  for (const [id, def] of Object.entries(PERSPECTIVE_LIBRARY)) {
    if (def.kind === "perspective" && def.widgets && def.widgets.length > 0) {
      check(`perspective workspace "${id}" is temporal (consumesShellTime === true)`, def.consumesShellTime === true);
    }
  }
}

// ── envelope source matches resolvePerspectiveEnvelope's switch ──────────────────
{
  const expectedEnvelope: Record<string, WorkspaceEnvelopeSource> = {
    wealth: "wealth", cashFlow: "cashFlow", investments: "investments",
    liquidity: "lens", debt: "lens", goals: "none",
  };
  for (const [id, env] of Object.entries(expectedEnvelope)) {
    check(`${id}.envelope === "${env}"`, WORKSPACE_REGISTRY[id].envelope === env);
  }
}

// ── Top-level Space tabs are NOT workspaces (order untouched — SD-2 P5) ───────────
check("SPACE_TAB_ORDER unchanged (Space tabs ≠ workspaces)",
  SPACE_TAB_ORDER.join(",") === "OVERVIEW,PERSPECTIVES,ACTIVITY,FINANCES,ACCOUNTS,TRANSACTIONS,MEMBERS,DOCUMENTS,SETTINGS");

// ── Source-scan: the old duplicate host maps are gone; host uses the registry ────
{
  const ROOT = process.cwd();
  const dashSrc = readFileSync(path.join(ROOT, "components", "dashboard", "SpaceDashboard.tsx"), "utf8");
  const dashCode = dashSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments (they name the removed maps)
  for (const gone of ["PERSPECTIVE_TARGET_TAB", "PERSPECTIVE_ROUTED_TABS", "PERSPECTIVE_MODAL_META"]) {
    check(`host no longer declares/uses ${gone}`, !dashCode.includes(gone));
  }
  // SD-7 extracted the routed-tab GlassModal into RoutedWorkspaceModal, so
  // getWorkspaceModalMeta is now consumed there (still the registry, not a host map).
  const routedCode = readFileSync(
    path.join(ROOT, "components", "space", "workspaces", "RoutedWorkspaceModal.tsx"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  check("host consumes the registry routing helpers",
    /getWorkspaceTargetTab\(/.test(dashCode) && /isRoutedWorkspaceTab\(/.test(dashCode) && /getWorkspaceModalMeta\(/.test(routedCode));

  // SpaceShell stays workspace-agnostic — it must not reach into the registry.
  const shellCode = readFileSync(path.join(ROOT, "components", "space", "shell", "SpaceShell.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  check("SpaceShell does not import the workspace registry",
    !/perspectives|WORKSPACE_REGISTRY|WorkspaceDefinition/.test(shellCode));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll SD-2 WorkspaceDefinition/registry ratchets passed.");
