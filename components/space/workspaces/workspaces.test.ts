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

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (...seg: string[]) => readFileSync(path.join(ROOT, ...seg), "utf8");
const WS = (f: string) => read("components", "space", "workspaces", f);
const DASH = read("components", "dashboard", "SpaceDashboard.tsx");
const DASHCODE = DASH.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments (prose names moved decls)
// SEC-2 split the former SpaceSections.tsx into the card chrome (SectionCard.tsx)
// and the renderer catalog (SectionRegistry.tsx).
const SECTIONCARD     = read("components", "space", "sections", "SectionCard.tsx");
const SECTIONREGISTRY = read("components", "space", "sections", "SectionRegistry.tsx");
// SD-7a — Goals data ownership moved OUT of the host into the Goals consumers.
const GOALS_ADAPTERS  = read("components", "space", "widgets", "goals-perspective-adapters.tsx");
const GOALS_CARD      = read("components", "space", "sections", "goals", "GoalsCard.tsx");
// SD-7b — the shared structural data lifecycle moved OUT of the host into useSpaceData.
const USE_SPACE_DATA  = read("lib", "space", "use-space-data.ts");
// SD-8b — the URL/tab/perspective navigation state machine moved into useSpaceNavigation.
const USE_SPACE_NAV   = read("lib", "space", "use-space-navigation.ts");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function count(hay: string, needle: string): number {
  let n = 0, i = 0;
  for (;;) { const j = hay.indexOf(needle, i); if (j === -1) return n; n++; i = j + needle.length; }
}

console.log("1. Every primary destination RESOLVES to its Workspace (host gates + mounts it)");
{
  // The durable renderer-registration invariant: for each destination the host both
  // gates on activeTab AND mounts that destination's Workspace component.
  const mounts: [string, string][] = [
    ['activeTab === "MEMBERS"', "<MembersWorkspace"],
    ['activeTab === "TRANSACTIONS"', "<TransactionsWorkspace"],
    ['activeTab === "ACCOUNTS"', "<AccountsWorkspace"],
    ['activeTab === "ACTIVITY"', "<ActivityWorkspace"],
    ['activeTab === "OVERVIEW"', "<OverviewWorkspace"],
    ["isRoutedWorkspaceTab(activeTab)", "<RoutedWorkspaceModal"],
  ];
  for (const [gate, mount] of mounts) {
    check(`host gates + mounts ${mount}`, DASHCODE.includes(gate) && DASHCODE.includes(mount));
  }
  check("host mounts <AddGoalModal (overlay)", DASHCODE.includes("<AddGoalModal"));
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

console.log("3. The section subsystem is the ONE home for SectionCard + the registry");
{
  check("SectionCard.tsx defines SectionCard once", count(SECTIONCARD, "export function SectionCard(") === 1);
  check("SectionRegistry.tsx defines the SectionRegistry once", count(SECTIONREGISTRY, "export const SectionRegistry") === 1);
  check("host imports SectionCard from the card module + SectionRegistry from the registry module",
    DASH.includes('from "@/components/space/sections/SectionCard"') &&
    DASH.includes('from "@/components/space/sections/SectionRegistry"'));
  check("Accounts/Activity/Overview compose the shared SpaceSectionStack",
    WS("AccountsWorkspace.tsx").includes("<SpaceSectionStack") &&
    WS("ActivityWorkspace.tsx").includes("<SpaceSectionStack") &&
    WS("OverviewWorkspace.tsx").includes("<SpaceSectionStack"));
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

console.log("5. Goals data ownership left the host (SD-7a) — the consumer self-fetches");
{
  // (a) The host no longer fetches or holds Goals data. `DASHCODE` is
  // comment-stripped, so an explanatory comment mentioning the old name does not
  // trip these — only real code would.
  check("host no longer fetches the goals endpoint", !DASHCODE.includes("/goals"));
  check("host no longer holds spaceGoals state", !DASHCODE.includes("spaceGoals"));
  check("host no longer derives perspectiveNeedsGoals", !DASHCODE.includes("perspectiveNeedsGoals"));
  check("host no longer threads a goals prop", !DASHCODE.includes("goals={"));
  check("host no longer imports the SpaceGoal type", !DASHCODE.includes("SpaceGoal"));

  // (b) The Goals CONSUMER owns its own data dependency (the self-fetching
  // wrapper), and the four perspective widgets render through it.
  check("goals adapters export the self-fetching GoalPerspectiveWidget",
    count(GOALS_ADAPTERS, "export function GoalPerspectiveWidget(") === 1);
  check("GoalPerspectiveWidget fetches goals by spaceId",
    GOALS_ADAPTERS.includes("/goals") && GOALS_ADAPTERS.includes("fetch("));
  check("all four goal_* registry entries render through GoalPerspectiveWidget",
    count(SECTIONREGISTRY, "<GoalPerspectiveWidget") === 4);
  // GoalsCard (the goals_progress list surface) already owned its data — unchanged.
  check("GoalsCard still self-fetches its goals", GOALS_CARD.includes("/goals") && GOALS_CARD.includes("fetch("));

  // (c) Existing Goals rendering is unchanged — the four pure render fns and their
  // registry keys still exist; only their DATA SOURCE moved.
  for (const key of ['"goal_progress"', '"goal_on_track"', '"goal_required_pace"', '"goal_funding_gap"']) {
    check(`registry still maps ${key}`, SECTIONREGISTRY.includes(key));
  }
  for (const fn of ["renderGoalProgress", "renderGoalOnTrack", "renderGoalRequiredPace", "renderGoalFundingGap"]) {
    check(`goals adapters still define ${fn}`, GOALS_ADAPTERS.includes(`export function ${fn}(`));
  }

  // (d) No other consumer relied on the old prop — the section subsystem no longer
  // declares/threads a goals prop at all.
  check("SectionRenderProps no longer declares a goals field", !SECTIONREGISTRY.includes("goals?:"));
  check("SectionCard no longer threads a goals prop", !SECTIONCARD.includes("goals?:") && !SECTIONCARD.includes("SpaceGoal"));
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
  for (const cell of ["const [activeTab", "const [selectedPerspectiveId", "const [chartMetric", "const [initialAccountFilter"]) {
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
  check("nav hook owns activeTab + activePerspectiveId + chartMetric",
    USE_SPACE_NAV.includes("activePerspectiveId") && USE_SPACE_NAV.includes("chartMetric") && USE_SPACE_NAV.includes("?metric="));
  check("nav constants (TAB_ORDER / lens ids) live in the nav hook",
    USE_SPACE_NAV.includes("export const TAB_ORDER") && USE_SPACE_NAV.includes("export const NET_WORTH_LENS_ID"));

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
