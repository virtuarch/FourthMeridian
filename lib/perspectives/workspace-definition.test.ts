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
  workspaceConsumesShellTime,
  temporalControlVisibility,
  type WorkspaceDataNeed,
  type WorkspaceEnvelopeSource,
  type TemporalCapability,
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
  // verification). Scoped to the finance domain because the universal registry also
  // holds non-finance kind:"standard" workspaces — Platform Operations
  // (domain:"platform", OPS-5 S6) and the UI-Convergence utility surfaces
  // (domain:"connections"/"settings", Wave 1) — each validated in its own domain's
  // workspaces.test.ts. Finance ⇔ domain absent or "finance".
  check("finance kind:standard set === {overview,transactions,accounts,activity,members,goals}",
    sameSet(Object.values(WORKSPACE_REGISTRY).filter((d) => d.kind === "standard" && (d.domain ?? "finance") === "finance").map((d) => d.id), STANDARD));
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
  // M2 canonical IA: Debt & Investments are NO LONGER routed modals — they are
  // perspectives selected through Overview, so they carry no routing.targetTab.
  // Only Goals & Retirement remain routed (explicit compatibility boundary).
  const expectedTargets: Record<string, string | undefined> = {
    retirement: "RETIREMENT", goals: "GOALS",
    investments: undefined, debt: undefined,
    wealth: undefined, cashFlow: undefined, liquidity: undefined, overview: undefined,
  };
  for (const [id, target] of Object.entries(expectedTargets)) {
    check(`getWorkspaceTargetTab(${id}) === ${target}`, getWorkspaceTargetTab(id) === target);
  }
  // M2: the routed set shrank to exactly {GOALS, RETIREMENT} (order-free).
  check("ROUTED_WORKSPACE_TABS === {GOALS,RETIREMENT}",
    sameSet(ROUTED_WORKSPACE_TABS as readonly string[], ["GOALS", "RETIREMENT"]));
  check("isRoutedWorkspaceTab true for a routed tab (GOALS)", isRoutedWorkspaceTab("GOALS"));
  check("isRoutedWorkspaceTab true for a routed tab (RETIREMENT)", isRoutedWorkspaceTab("RETIREMENT"));
  // M2 regression: Debt/Investments must NEVER re-enter the routed-modal path —
  // one canonical destination each (the Perspective under Overview).
  check("isRoutedWorkspaceTab false for DEBT (retired)", !isRoutedWorkspaceTab("DEBT"));
  check("isRoutedWorkspaceTab false for INVESTMENTS (retired)", !isRoutedWorkspaceTab("INVESTMENTS"));
  check("isRoutedWorkspaceTab false for a non-routed tab", !isRoutedWorkspaceTab("OVERVIEW") && !isRoutedWorkspaceTab("ACCOUNTS"));
}

// ── Modal chrome converged — behavior-identical to the removed PERSPECTIVE_MODAL_META
{
  // M2: only Goals & Retirement retain modal chrome (routed-modal boundary).
  const expectedModal: Record<string, { title: string; icon: string }> = {
    GOALS:       { title: "Goals",       icon: "Target" },
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
  // M2 regression: Debt/Investments no longer have modal chrome.
  check("getWorkspaceModalMeta(DEBT) undefined (retired)", getWorkspaceModalMeta("DEBT") === undefined);
  check("getWorkspaceModalMeta(INVESTMENTS) undefined (retired)", getWorkspaceModalMeta("INVESTMENTS") === undefined);
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

// ── temporalCapability is the DOCTRINE contract; consumesShellTime is DERIVED ─────
// Each financial Perspective declares WHICH canonical time axes it consumes
// (asOf/compareTo/period), at "full"/"partial"/"none". "partial" is an honest
// capability GAP (part of the impl reflects it), NOT a reclassification. The
// coarse consumesShellTime boolean is now derived (any axis !== "none"), never stored.
{
  const expected: Record<string, TemporalCapability> = {
    wealth:      { asOf: "full",    compareTo: "full",    period: "none" },
    investments: { asOf: "full",    compareTo: "full",    period: "none" },
    cashFlow:    { asOf: "full",    compareTo: "full",    period: "full" },
    debt:        { asOf: "partial", compareTo: "partial", period: "none" },
    liquidity:   { asOf: "partial", compareTo: "partial", period: "none" },
  };
  for (const [id, cap] of Object.entries(expected)) {
    const actual = WORKSPACE_REGISTRY[id].temporalCapability;
    check(`${id}.temporalCapability === ${JSON.stringify(cap)}`,
      actual?.asOf === cap.asOf && actual?.compareTo === cap.compareTo && actual?.period === cap.period);
    // Derived: every declared finance Perspective participates in shell time.
    check(`${id} derives consumesShellTime = true`, workspaceConsumesShellTime(WORKSPACE_REGISTRY[id]) === true);
  }
  // Standard/domain workspaces declare no capability and derive false.
  for (const id of ["overview", "transactions", "accounts", "activity", "members", "goals"]) {
    check(`${id} has no temporalCapability`, WORKSPACE_REGISTRY[id].temporalCapability === undefined);
    check(`${id} derives consumesShellTime = false`, workspaceConsumesShellTime(WORKSPACE_REGISTRY[id]) === false);
  }
  // DOCTRINE RATCHET: every renderer-backed financial Perspective is temporal — the
  // registry describes the intended contract, never fossilizing an impl gap as a
  // non-temporal category. (Renderer-backed = kind perspective, available, no routed modal.)
  for (const [id, def] of Object.entries(PERSPECTIVE_LIBRARY)) {
    if (def.kind === "perspective" && def.status === "available" && !def.routing?.targetTab) {
      check(`perspective workspace "${id}" declares a temporalCapability`, def.temporalCapability !== undefined);
      check(`perspective workspace "${id}" is temporal (derived consumesShellTime)`, workspaceConsumesShellTime(def) === true);
    }
  }

  // EXPLICIT point-in-time control visibility derives from the capability. The
  // universal preset/time slicer is NOT part of this — see the source-scan below.
  const vis = (id: string) => temporalControlVisibility(WORKSPACE_REGISTRY[id].temporalCapability);
  check("Wealth shell shows As-of + Compare-to inputs",
    vis("wealth").asOf && vis("wealth").compareTo);
  check("Investments shell shows As-of + Compare-to inputs",
    vis("investments").asOf && vis("investments").compareTo);
  check("Cash Flow shell SHOWS the As-of + Compare-to inputs (fully temporal — historical navigation)",
    vis("cashFlow").asOf && vis("cashFlow").compareTo);
  check("Debt shell shows As-of + Compare-to inputs (partial still renders)",
    vis("debt").asOf && vis("debt").compareTo);
  check("Liquidity shell shows As-of + Compare-to inputs (partial still renders)",
    vis("liquidity").asOf && vis("liquidity").compareTo);
  // Undeclared capability ⇒ both explicit inputs shown (pre-declaration default).
  check("undeclared capability shows both explicit inputs", (() => {
    const d = temporalControlVisibility(undefined); return d.asOf && d.compareTo;
  })());

  // UNIVERSAL SLICER (correction to SD-2C): the WTD/MTD/QTD/YTD/1W/… preset strip
  // is how EVERY Perspective selects canonical time — PerspectiveShell renders it
  // unconditionally, never behind a temporalCapability / vis.period gate.
  const shellSrc = readFileSync(
    path.join(process.cwd(), "components", "space", "shell", "PerspectiveShell.tsx"), "utf8",
  );
  check("PerspectiveShell renders the CashFlowPeriodSelector slicer", shellSrc.includes("<CashFlowPeriodSelector"));
  check("the slicer is NOT gated by capability (no vis.period gate remains)",
    !shellSrc.includes("vis.period") && !/\{vis\.period\s*&&/.test(shellSrc));
  check("temporalControlVisibility governs only the explicit inputs (no period key)",
    !("period" in temporalControlVisibility(WORKSPACE_REGISTRY.cashFlow.temporalCapability)));
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

// ── Top-level Space tabs are NOT workspaces (M2: PERSPECTIVES removed from the
//    rail — perspectives are selected through Overview, not a tab) ──────────────
check("SPACE_TAB_ORDER is the M2 rail (no PERSPECTIVES tier)",
  SPACE_TAB_ORDER.join(",") === "OVERVIEW,ACTIVITY,FINANCES,ACCOUNTS,TRANSACTIONS,MEMBERS,DOCUMENTS,SETTINGS");

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
