/**
 * components/space/workspaces/workspaces.test.ts  (SD-7)
 *
 * Durable-invariant ratchets for the Standard Workspace extraction (house pattern —
 * pure, DB-free). TEST-3 cleanup: brittle existsSync/file-location + composed-once
 * count pins removed; the durable SD-7 ownership invariants kept: every primary
 * destination RESOLVES to its Workspace (host gates + mounts it per activeTab); the
 * host no longer DEFINES the extracted composition; the section subsystem + shared
 * dashboard types each have ONE home.
 *
 *   npx tsx components/space/workspaces/workspaces.test.ts
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (...seg: string[]) => readFileSync(path.join(ROOT, ...seg), "utf8");
const WS = (f: string) => read("components", "space", "workspaces", f);
const gone = (...seg: string[]) => !existsSync(path.join(ROOT, ...seg));
const DASH = read("components", "dashboard", "SpaceDashboard.tsx");
const DASHCODE = DASH.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments (prose names moved decls)
// W2 — the section RENDER subsystem (SectionCard.tsx / SectionRegistry.tsx) and
// the whole Goals surface (goals-perspective-adapters, sections/goals/,
// AddGoalModal, RoutedWorkspaceModal) are DELETED; sections 3 and 5 below pin
// the deletions instead of reading the files.
// SD-7b — the shared structural data lifecycle moved OUT of the host into useSpaceData.
const USE_SPACE_DATA  = read("lib", "space", "use-space-data.ts");
// SD-8b — the URL/tab/perspective navigation state machine moved into useSpaceNavigation.
const USE_SPACE_NAV   = read("lib", "space", "use-space-navigation.ts");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
// (W2: the `count` helper retired with the section-subsystem definition pins.)

console.log("1. Every primary destination RESOLVES to its Workspace (host gates + mounts it)");
{
  // The durable renderer-registration invariant: for each destination the host both
  // gates on activeTab AND mounts that destination's Workspace component.
  const mounts: [string, string][] = [
    ['activeTab === "MEMBERS"', "<MembersWorkspace"],
    ['activeTab === "TRANSACTIONS"', "<TransactionsWorkspace"],
    ['activeTab === "ACCOUNTS"', "<AccountsWorkspace"],
    ['activeTab === "ACTIVITY"', "<ActivityWorkspace"],
    // REVIEW-3 (slice F): OVERVIEW always renders the engaged Perspective
    // workspace through the exploration host — the summary canvas
    // (OverviewWorkspace) was deleted as product-unreachable.
    ['activeTab === "OVERVIEW"', "<WorkspaceExplorationHost"],
  ];
  for (const [gate, mount] of mounts) {
    check(`host gates + mounts ${mount}`, DASHCODE.includes(gate) && DASHCODE.includes(mount));
  }
  // W2 — the Goals/Retirement routed-modal path and the AddGoalModal overlay are
  // RETIRED: the host mounts neither, and the components are deleted from disk.
  check("the retired routed-modal path is not mounted anywhere in the host",
    !DASHCODE.includes("<RoutedWorkspaceModal") && !DASHCODE.includes("isRoutedWorkspaceTab("));
  check("the retired AddGoalModal overlay is not mounted anywhere in the host",
    !DASHCODE.includes("<AddGoalModal") && !DASHCODE.includes("showAddGoal"));
  check("the retired Overview summary canvas is not mounted anywhere in the host",
    !DASHCODE.includes("<OverviewWorkspace") && !DASHCODE.includes("perspectiveEngaged"));
}

console.log("2. Host no longer DEFINES the extracted composition (ownership left the host)");
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

console.log("3. The section RENDER subsystem is DELETED (W2) — and stays deleted");
{
  // W2 — the SectionCard/SectionRegistry compositor retired with its last
  // mounts (the GOALS/RETIREMENT routed modals + the Goals virtual sections).
  // Section CONFIG (SpaceDashboardSection rows, the sections API, Manage
  // toggles) survives; only RENDERING is gone.
  check("SectionCard.tsx is deleted", gone("components", "space", "sections", "SectionCard.tsx"));
  check("SectionRegistry.tsx is deleted", gone("components", "space", "sections", "SectionRegistry.tsx"));
  check("host no longer imports the section render modules",
    !DASH.includes('from "@/components/space/sections/SectionCard"') &&
    !DASH.includes('from "@/components/space/sections/SectionRegistry"') &&
    !DASHCODE.includes("<SectionCard"));
  // REVIEW-3: the <SpaceSectionStack> component was deleted with its last
  // mount; the module keeps only the shared vocabulary. W2: SectionCardBundle
  // survives solely as the AccountsWorkspace prop bundle (spaceId/accounts/ctx
  // are the read fields) — trimming that vocabulary is a follow-up seam.
  check("SpaceSectionStack no longer exports a stack component (vocabulary only)",
    !WS("SpaceSectionStack.tsx").includes("export function SpaceSectionStack(") &&
    WS("SpaceSectionStack.tsx").includes("export type SectionCardBundle"));
  // Accounts migrated OUT of the generic section stack into the editorial ledger
  // idiom — the tab mounts AccountsLedger (summary + grouped ledger + LeftPanel/
  // RightPanel exploration over the Space's accounts), no longer a section stack.
  check("Accounts is the editorial ledger (AccountsLedger), not a section stack",
    WS("AccountsWorkspace.tsx").includes("<AccountsLedger") &&
    !WS("AccountsWorkspace.tsx").includes("<SpaceSectionStack"));
  check("the Accounts ledger composes the Atlas exploration panels",
    read("components", "space", "widgets", "accounts", "AccountsLedger.tsx").includes("<LeftPanel") &&
    read("components", "space", "widgets", "accounts", "AccountsLedger.tsx").includes("<RightPanel"));
  // Activity migrated OUT of the generic section stack into the editorial timeline
  // idiom — it composes the hero + rail feed + RightPanel over the canonical feed,
  // and no longer renders a section stack.
  check("Activity is the editorial timeline (hero + RightPanel), not a section stack",
    WS("ActivityWorkspace.tsx").includes("<ActivityTimeline") &&
    WS("ActivityWorkspace.tsx").includes("<RightPanel") &&
    !WS("ActivityWorkspace.tsx").includes("<SpaceSectionStack"));
}

console.log("4. Shared dashboard types have ONE home (no host-inline re-declaration)");
{
  // SD-7b — the host stopped importing the shared view types (it consumes them via
  // useSpaceData's typed return); the ONE-home invariant now lives at the hook.
  check("the shared dashboard types have ONE home, imported (now by useSpaceData) not re-declared",
    USE_SPACE_DATA.includes('from "@/lib/space/dashboard-types"'));
  check("host no longer declares the view types inline",
    !DASHCODE.includes("type SpaceAccount =") && !DASHCODE.includes("type DashboardSection ="));
}

console.log("5. The Goals surface is RETIRED (W2) — deleted end to end, host reads nothing of it");
{
  // (a) The host no longer fetches, holds, or threads any Goals data. `DASHCODE`
  // is comment-stripped, so an explanatory comment does not trip these.
  check("host no longer fetches the goals endpoint", !DASHCODE.includes("/goals"));
  check("host no longer holds spaceGoals state", !DASHCODE.includes("spaceGoals"));
  check("host no longer derives perspectiveNeedsGoals", !DASHCODE.includes("perspectiveNeedsGoals"));
  check("host no longer threads a goals prop", !DASHCODE.includes("goals={"));
  check("host no longer imports the SpaceGoal type", !DASHCODE.includes("SpaceGoal"));

  // (b) Every Goals module is deleted from disk (product decision, final):
  // the API route dir, the card + adapters, the create modal, and the
  // virtual-section machinery that rendered the goals workspace.
  check("goals API route dir is deleted", gone("app", "api", "spaces", "[id]", "goals"));
  check("sections/goals/ (GoalsCard) is deleted", gone("components", "space", "sections", "goals"));
  check("goals-perspective-adapters.tsx is deleted",
    gone("components", "space", "widgets", "goals-perspective-adapters.tsx"));
  check("AddGoalModal.tsx is deleted", gone("components", "space", "workspaces", "AddGoalModal.tsx"));
  check("lib/perspectives/virtual-sections.ts is deleted", gone("lib", "perspectives", "virtual-sections.ts"));
  check("lib/widget-registry.ts is deleted (goals-only registry)", gone("lib", "widget-registry.ts"));

  // (c) The Prisma SpaceGoal MODEL is deliberately untouched (tables/enums stay
  // until a later migration train) — only the UI/API surface retired. The shared
  // view type is gone with its last consumer.
  check("dashboard-types no longer declares the SpaceGoal view type",
    !read("lib", "space", "dashboard-types.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "").includes("SpaceGoal"));
}

console.log("6. Shared Space data ownership left the host (SD-7b) — useSpaceData owns the lifecycle");
{
  // (a) The host no longer OWNS the shared-data fetch effects or their refresh
  // orchestration. `DASHCODE` is comment-stripped, so the SD-7b explanatory
  // comments don't trip these — only real code would.
  check("host no longer fetches snapshots",      !DASHCODE.includes("/snapshots"));
  check("host no longer fetches the view-context",!DASHCODE.includes("/view-context"));
  for (const setter of ["setSections", "setAccounts", "setLoading", "setSnapshots", "setSpaceTransactions", "setSpaceMoneyCtx", "setWidgetMoneyCtx", "setMemberCount"]) {
    check(`host no longer holds ${setter}`, !DASHCODE.includes(setter));
  }
  check("host no longer owns the refresh nonce",      !DASHCODE.includes("refreshNonce"));
  check("host no longer owns the shared-account listener", !DASHCODE.includes("SPACE_ACCOUNTS_CHANGED_EVENT"));
  check("host no longer owns the manual-sync listener",    !DASHCODE.includes("SPACE_DATA_REFRESHED_EVENT"));

  // (b) The host CONSUMES the hook — imports it and destructures its data.
  check("host imports useSpaceData", DASH.includes('from "@/lib/space/use-space-data"'));
  check("host calls useSpaceData", DASHCODE.includes("useSpaceData({"));
  check("host destructures the hook's transactions + money context",
    DASHCODE.includes("transactions: spaceTransactions") && DASHCODE.includes("moneyCtx: spaceMoneyCtx"));

  // (c) useSpaceData OWNS the whole lifecycle: every moved fetch, every listener,
  // and the backfill poll now live in the hook.
  check("useSpaceData is a hook", USE_SPACE_DATA.includes("export function useSpaceData("));
  for (const url of ["/sections", "/accounts", "/snapshots", "/transactions", "/view-context"]) {
    check(`useSpaceData fetches ${url}`, USE_SPACE_DATA.includes(url));
  }
  // Currency change + manual sync + shared-account refresh all live in the hook.
  for (const ev of ["SPACE_CURRENCY_CHANGED_EVENT", "SPACE_DATA_REFRESHED_EVENT", "SPACE_ACCOUNTS_CHANGED_EVENT"]) {
    check(`useSpaceData owns the ${ev} listener`, USE_SPACE_DATA.includes(ev));
  }
  check("useSpaceData owns the currency + refresh nonces",
    USE_SPACE_DATA.includes("currencyNonce") && USE_SPACE_DATA.includes("refreshNonce"));
  check("useSpaceData owns the 12s backfill poll",
    USE_SPACE_DATA.includes("setInterval") && USE_SPACE_DATA.includes("12000"));

  // (d) SD-9A — the PERSPECTIVE-engine loader (lensResults) left the host too. It is
  // now useSpaceLensResults: the host neither owns lens-result state nor subscribes to
  // the lens currency-refresh signal; it only mounts the hook. (Its own invariants
  // live in lib/space/space-runtime-ownership.test.ts.)
  check("host no longer owns the lens-result state", !DASHCODE.includes("setLensResults"));
  check("host no longer owns a currency-refresh for the perspective loader",
    !DASHCODE.includes("perspectivesCurrencyNonce") && !DASHCODE.includes("SPACE_CURRENCY_CHANGED_EVENT"));
  check("host mounts useSpaceLensResults", DASHCODE.includes("useSpaceLensResults({"));
}

console.log("7. Navigation ownership left the host (SD-8b) — useSpaceNavigation owns the URL state machine");
{
  // (a) The host no longer OWNS the URL/tab/perspective/metric machinery.
  check("host no longer calls the URL authority directly", !DASHCODE.includes("useSpaceUrl"));
  check("host no longer owns the URL tab reader", !DASHCODE.includes("readUrlTabState"));
  check("host no longer owns the perspective slug helper", !DASHCODE.includes("perspectiveIdToSlug"));
  for (const cell of ["const [activeTab", "const [selectedPerspectiveId", "const [chartMetric", "const [wealthMode", "const [initialAccountFilter"]) {
    check(`host no longer holds ${cell}]`, !DASHCODE.includes(cell));
  }

  // (b) The host CONSUMES the nav hook.
  check("host imports useSpaceNavigation", DASH.includes('from "@/lib/space/use-space-navigation"'));
  check("host calls useSpaceNavigation", DASHCODE.includes("useSpaceNavigation({"));

  // (c) useSpaceNavigation OWNS the URL state machine.
  check("useSpaceNavigation is a hook", USE_SPACE_NAV.includes("export function useSpaceNavigation("));
  check("nav hook owns the URL authority (useSpaceUrl commit/subscribe)",
    USE_SPACE_NAV.includes("useSpaceUrl(") && USE_SPACE_NAV.includes("spaceUrl.commit(") && USE_SPACE_NAV.includes("spaceUrl.subscribe("));
  check("nav hook owns the tab reader + slug helper", USE_SPACE_NAV.includes("readUrlTabState") && USE_SPACE_NAV.includes("perspectiveIdToSlug"));
  // OVERVIEW-CONSOLIDATION — the chart metric became the Net Worth page subject
  // (wealthMode) + Assets slice; still the nav hook's, still ?metric=.
  check("nav hook owns activeTab + activePerspectiveId + wealthMode/assetsSlice (?metric= / ?slice=)",
    USE_SPACE_NAV.includes("activePerspectiveId") && USE_SPACE_NAV.includes("wealthMode") && USE_SPACE_NAV.includes("assetsSlice")
    && USE_SPACE_NAV.includes("?metric=") && USE_SPACE_NAV.includes("?slice="));
  check("nav constants (TAB_ORDER / lens ids) live in the nav hook",
    USE_SPACE_NAV.includes("export const TAB_ORDER") && USE_SPACE_NAV.includes("export const NET_WORTH_LENS_ID"));

  // W2 — GOALS/RETIREMENT left the LOCAL tab vocabulary entirely, and legacy
  // deep links DEGRADE, never crash: ?tab=goals|retirement is now
  // "present-but-invalid", which parseTabParam maps to OVERVIEW (the pinned
  // fallback below), and TAB_ORDER carries no routed member.
  const NAVCODE = USE_SPACE_NAV.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  check("nav vocabulary carries no GOALS/RETIREMENT member",
    !NAVCODE.includes('"GOALS"') && !NAVCODE.includes('"RETIREMENT"') &&
    !NAVCODE.includes("goals:") && !NAVCODE.includes("retirement:"));
  check("unknown ?tab= values degrade to OVERVIEW (parseTabParam fallback)",
    NAVCODE.includes('URL_TAB_ALIAS[raw.toLowerCase()] ?? "OVERVIEW"'));
  check("TAB_ORDER is exactly the section-derived default candidates",
    NAVCODE.includes('export const TAB_ORDER = ["OVERVIEW", "ACCOUNTS", "ACTIVITY"]'));

  // (d) Data ⇄ nav stay separate + the one intentional coordination point.
  check("nav hook does not fetch data (no /sections, /snapshots)",
    !USE_SPACE_NAV.includes("/sections") && !USE_SPACE_NAV.includes("/snapshots"));
  check("host folds activePerspectiveId into the DATA gates (nav → data, one-way)",
    DASHCODE.includes("perspectiveNeedsSnapshots") && DASHCODE.includes("useSpaceData({"));
  check("initial-tab resolution is coordinated via applyInitialTab(sections)", DASHCODE.includes("applyInitialTab(sections)"));

  // (e) INTENTIONALLY LEFT BEHIND: cashFlowPeriod is derived from the shell TIME
  // slice (data-derived), so it stays host-side — moving it would cycle nav→data→shell→nav.
  check("cashFlowPeriod stays host-side (shell-time derived; nav hook declares no such state)",
    DASHCODE.includes("shell.derived.cashFlowPeriod") &&
    !USE_SPACE_NAV.includes("const cashFlowPeriod") && !USE_SPACE_NAV.includes("setCashFlowExplicitPeriod"));
}

if (failures > 0) { console.error(`\n${failures} workspaces check(s) failed`); process.exit(1); }
console.log("\nAll SD-7 workspaces checks passed");
