"use client";

/**
 * SpaceDashboard
 *
 * Rendered for any non-PERSONAL space. Driven by SpaceDashboardSection
 * rows fetched from GET /api/spaces/[id]/sections.
 *
 * - Tabs are derived from enabled sections in TAB_ORDER
 * - Default tab is the first tab that has enabled sections (never SETTINGS by default)
 * - OWNER/ADMIN can toggle sections via the Settings tab
 */

import React, { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Loader2, LayoutDashboard, LogOut } from "lucide-react";
import { CATEGORY_LABELS, SpaceCategory } from "@/lib/space-presets";
// Unified Space Widget Layout (slice 1) — Personal Overview lede widgets, now
// section-backed (net_worth_chart + allocation).
import { formatRelativeTime, displaySpaceName } from "@/lib/format";
import { ManageSpaceModal } from "@/components/space/manage/ManageSpaceModal";
import { DEFAULT_CASH_FLOW_PERIOD, isExplicitPeriod, type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import { usePerspectiveShellState } from "@/components/space/shell/usePerspectiveShellState";
import { SpaceShell } from "@/components/space/shell/SpaceShell";
import { openPerspectiveDataNeeds } from "@/lib/space/workspace-resources";
import { useSpaceData } from "@/lib/space/use-space-data";
import { useSpaceNavigation, TAB_ORDER, NEW_SPACE_TABS, NET_WORTH_LENS_ID, CORE_LENS_IDS } from "@/lib/space/use-space-navigation";
import { useSpaceLensResults } from "@/lib/space/use-space-lens-results";
import { useActiveEnvelope } from "@/lib/space/use-active-envelope";
import { inferPerspectiveTimePreset } from "@/lib/perspectives/time-range";
import { PerspectiveShell } from "@/components/space/shell/PerspectiveShell";
import { PerspectiveTabs } from "@/components/space/shell/PerspectiveTabs";
import { WORKSPACE_RENDERERS, type WorkspaceRenderCtx } from "@/components/space/workspaces/workspaceRenderers";
import { MembersWorkspace } from "@/components/space/workspaces/MembersWorkspace";
import { TransactionsWorkspace, TX_SCOPE_NOTE } from "@/components/space/workspaces/TransactionsWorkspace";
import { AccountsWorkspace } from "@/components/space/workspaces/AccountsWorkspace";
import { ActivityWorkspace } from "@/components/space/workspaces/ActivityWorkspace";
import { OverviewWorkspace } from "@/components/space/workspaces/OverviewWorkspace";
import { AddGoalModal } from "@/components/space/workspaces/AddGoalModal";
import { RoutedWorkspaceModal } from "@/components/space/workspaces/RoutedWorkspaceModal";
import type { SectionCardBundle } from "@/components/space/workspaces/SpaceSectionStack";
import { railVisibleTabs, SPACE_TAB_LABELS } from "@/lib/space-nav";
import { useSpaceChromePublisher } from "@/lib/space/space-chrome-context";
import { getPerspectivesForCategory, getWorkspaceTargetTab, isRoutedWorkspaceTab, getWorkspaceDefinition } from "@/lib/perspectives";
import { toVirtualSections } from "@/lib/perspectives/virtual-sections";
import { PerspectivesWidget, type PerspectiveCardItem } from "@/components/dashboard/widgets/PerspectivesWidget";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { type HeroPoint } from "@/components/dashboard/widgets/SpaceTrendHero";
import { RecentTransactionsPanel } from "@/components/dashboard/widgets/RecentTransactionsPanel";
import { rehydrateContext, type SerializedConversionContext } from "@/lib/money/convert";
import { useDisplayCurrency, DisplayCurrencyProvider } from "@/lib/currency-context";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { CurrencyRevertedBanner } from "@/components/dashboard/CurrencyRevertedBanner";
import { getSpaceHeroDef } from "@/lib/space-hero";
import type { Transaction } from "@/types";
import { SectionCard } from "@/components/space/sections/SectionCard";
import { SectionRegistry } from "@/components/space/sections/SectionRegistry";
import { formatBalance } from "@/lib/currency";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  spaceId:   string;
  spaceName: string;
  spaceType: string;
  category:      string;
  myRole:        string;
  currentUserId?: string;
  /**
   * SP-2A-4a — initial rail tab override (e.g. mapped from a legacy
   * /dashboard?tab= deep link by the caller). No URL synchronization.
   * Omitted ⇒ existing section-derived default. Applied once, after the
   * first data load, exactly where the default would have been chosen.
   */
  initialTab?: string;
  /**
   * SD-2C — the Space-level display-currency ("view as" / FX) control. The
   * Personal host builds it (ViewCurrencyOverride) and its state; this host
   * forwards it to the SpaceShell header slot (display currency governs the whole
   * Space, so it is a shell capability, not an Overview one). Omitted ⇒ nothing
   * rendered ⇒ shared Spaces unchanged.
   */
  displayCurrencyControl?: React.ReactNode;
  /**
   * Unified Space Widget Layout (slice 1) — the currency the Space's
   * SpaceSnapshot totals are stamped in (its reporting currency), forwarded to
   * the snapshot-backed `net_worth_chart` section as the conversion "from"
   * side. The Personal host passes its reporting currency (read outside the
   * "view as" provider) so the chart converts correctly under an override.
   * Omitted ⇒ falls back to the shell's display currency (shared Spaces, where
   * display === reporting).
   */
  snapshotCurrency?: string;
  /**
   * UX-PER-3 Debt — the user's manual FICO score (user-level), passed by the
   * Personal host for the Debt workspace's credit-health companion. Absent ⇒
   * the widget shows its "add score" affordance. Never drives debt math.
   */
  ficoScore?: number | null;
  ficoUpdatedAt?: string;
  /**
   * MC1 — when set (Personal "view as" override active), Perspective lenses are
   * fetched with this display-currency target so their metrics + verdict
   * convert. Omitted (shared Spaces, or no override) ⇒ computed in the Space's
   * reporting currency — today's behavior, byte-identical.
   */
  perspectiveTargetCurrency?: string;
  /**
   * MC1 — when set (Personal "view as" override active), the Transactions-tab
   * SUMMARY totals (Spend / In) convert through THIS context instead of the
   * Space's saved-reporting-currency context, so the aggregates match the
   * override symbol. Transaction ROWS stay native regardless. Omitted (shared
   * Spaces, or no override) ⇒ the saved-currency context — today's behavior.
   */
  transactionsMoneyCtxOverride?: SerializedConversionContext;
}

// SD-8b — the URL⇄tab vocabulary (URL_SYNCED_TABS / URL_TAB_ALIAS / parseTabParam /
// perspectiveIdToSlug / parsePerspectiveParam / readUrlTabState) and the nav
// constants (TAB_ORDER / NEW_SPACE_TABS / NET_WORTH_LENS_ID / CORE_LENS_IDS) moved
// to lib/space/use-space-navigation.ts, the navigation authority. The host imports
// the constants it still renders with; the URL helpers are hook-internal.

/** Flow-identified templates (Space Template Redesign): money movement is
 *  part of these Spaces' story, so Transactions is a first-class Overview
 *  preview module. Stock-identified categories (Investment / Property /
 *  Goal / value trackers) reach transactions through the Transactions tab
 *  doorway instead — never on the Overview. */
const FLOW_TX_CATEGORIES = ["HOUSEHOLD", "FAMILY", "BUSINESS", "DEBT_PAYOFF"];

/** Scope honesty label for shared-Space transaction lists — KD-15 filters
 *  rows to FULL-visibility shares, so the list is structurally partial. */
// TX_SCOPE_NOTE now lives with its primary owner (TransactionsWorkspace) and is
// re-imported here for the Overview doorway preview (below).


// ─── Main component ───────────────────────────────────────────────────────────

export function SpaceDashboard({
  spaceId,
  spaceName,
  spaceType,
  category,
  myRole,
  currentUserId = "",
  initialTab,
  displayCurrencyControl,
  snapshotCurrency,
  ficoScore,
  ficoUpdatedAt,
  perspectiveTargetCurrency,
  transactionsMoneyCtxOverride,
}: Props) {
  const router = useRouter();

  const [showAddGoal,   setShowAddGoal]   = useState(false);
  const [showManage,    setShowManage]    = useState(false);
  const [confirmLeave,  setConfirmLeave]  = useState(false);
  const [leaveBusy,     setLeaveBusy]    = useState(false);

  // SD-9A — Perspective-Engine results (present-day lens verdicts, keyed by lensId)
  // are loaded by useSpaceLensResults: the batch fetch, the "view as" target-currency
  // param, and currency invalidation all live in that hook now. null = not loaded /
  // fetch failed; cards then render their static description (the widget's contract).
  // A SEPARATE seam from useSpaceData (perspective-engine output, not structural data).
  const { lensResults } = useSpaceLensResults({ spaceId, targetCurrency: perspectiveTargetCurrency });

  // The dashboard layout mounts DisplayCurrencyProvider with this Space's
  // reportingCurrency (this component only renders as the active Space), so
  // useDisplayCurrency() IS the Space's currency.
  const displayCurrency = useDisplayCurrency();

  // ── SD-8b — navigation state machine (useSpaceNavigation) ───────────────────
  // Owns the URL⇄state sync + tab / perspective / metric / deep-link. Runs BEFORE
  // useSpaceData: it produces activePerspectiveId, which the host folds into the
  // data hook's activation gates (one-way nav → data). availablePerspectives
  // (category-pure) tells it whether the Net Worth default lens exists.
  const availablePerspectives = useMemo(
    () => getPerspectivesForCategory(category).map((p) => p.id),
    [category],
  );
  const {
    activeTab, setActiveTab,
    setSelectedPerspectiveId,
    activePerspectiveId, activeLensId, selectLens, switchLens,
    chartMetric, setChartMetric,
    initialAccountFilter,
    applyInitialTab,
  } = useSpaceNavigation({ initialTab, category, availablePerspectives });

  // SD-7b — the shared structural data lifecycle (sections / accounts / snapshots /
  // transactions / view-context / member count) + its refresh orchestration moved
  // to useSpaceData. The host CONSUMES this data; the call itself is a few lines
  // below, once the nav-derived activation gates are known.

  // SD-7 — the Overview composition switcher state (composition / compositionItems /
  // activeComposition) is now OWNED by <OverviewWorkspace> (Overview-only state); the
  // host no longer holds it.

  const canManage = ["OWNER", "ADMIN"].includes(myRole);
  const canLeave  = !canManage; // MEMBER and VIEWER can leave

  // Fixed rail options — starts from railVisibleTabs(railHost) (v2.5
  // honesty slice: placeholder tabs — Finances/Documents — get no rail control
  // until real; see lib/space-nav.ts). On top of that, SETTINGS only renders a
  // button for managers. ACTIVITY is now a real rail tab (Unified Space Widget
  // Layout — Activity slice): clicking it sets activeTab="ACTIVITY", which
  // renders the recent_activity section inline. Order is inherited from
  // SPACE_TAB_ORDER — these filters never reorder.
  // SP-2A-4a — host derives from spaceType instead of the previous hardcoded
  // "shared". railVisibleTabs("personal") and ("shared") return identical
  // lists today (SHARED_ONLY_PLACEHOLDER_TABS is empty), so shared Spaces —
  // and any future Personal mount — inherit the same fixed rail order.
  const railHost = spaceType === "PERSONAL" ? ("personal" as const) : ("shared" as const);
  // M3-Reset — TEXT-ONLY rail options (the prototype's rail language); the old
  // per-tab RailTabIcon treatment is dropped.
  const railOptions: { id: string; label: string }[] = railVisibleTabs(railHost)
    // UX-CUST-1A correction: Settings is no longer an in-space rail tab.
    // Space-level settings (incl. section show/hide and layout controls) live
    // in ManageSpaceModal → Overview. "SETTINGS" stays a valid tab id in
    // lib/space-nav for types/back-compat, but it renders no rail button here.
    .filter((id) => id !== "SETTINGS")
    .map((id) => ({ id, label: SPACE_TAB_LABELS[id] }));

  // "overview" is filtered out here, not in lib/perspectives.ts: it's never
  // a clickable Perspective *card* (see that file's doc comment on the
  // id) — only the PerspectiveSwitcher dropdown on Overview renders it.
  const perspectiveItems: PerspectiveCardItem[] = useMemo(
    () =>
      getPerspectivesForCategory(category)
        .filter((p) => p.id !== "overview")
        .map((p) => {
          const target = getWorkspaceTargetTab(p.id);
          // Engine answer for lens-backed cards (liquidity, debt). Missing
          // key (fetch pending/failed, or a lens that errored server-side
          // returns status "error") → undefined → the widget renders the
          // static description exactly as before.
          const result = p.lensId ? lensResults?.[p.lensId] : undefined;
          return target
            ? { ...p, result, onSelect: () => setActiveTab(target) }
            : { ...p, result };
        }),
    [category, lensResults, setActiveTab]
  );

  // ── Perspective Workspace (UX-PER-3) ───────────────────────────────────────
  // The Perspectives TAB is selector-driven (free-form tabs, not cards). The
  // selector lists the category's Perspectives (overview already excluded from
  // perspectiveItems); the selected one renders its workspace (widgets[] →
  // virtual sections → existing SectionCard) or an honest placeholder below.
  // Default = the first workspace-backed Perspective (Wealth) so the tab opens
  // on a real workspace. The Overview doorway keeps `perspectiveItems` intact.
  // SD-8b — the lens SELECTION state (selectedPerspectiveId) + its resolution to
  // the RENDERED activePerspectiveId (Net Worth default → "wealth" on Overview)
  // now live in useSpaceNavigation. The host only looks the engaged lens up in
  // perspectiveItems (which carries the engine result) and decides "engaged".
  const activePerspective = activePerspectiveId
    ? perspectiveItems.find((p) => p.id === activePerspectiveId) ?? null
    : null;
  // A Perspective is "engaged" (its Workspace occupies the Overview content slot)
  // whenever Overview resolves a lens — which, with the Net Worth default, is
  // always true for finance Spaces. Stock-category Spaces without a Wealth
  // perspective resolve null and keep the summary fallback.
  const perspectiveEngaged = activeTab === "OVERVIEW" && activePerspective != null;

  // ── SD-3 — declarative lazy activation. The host asks the canonical registry
  //    what the OPEN perspective declared (WORKSPACE_REGISTRY[id].dataNeeds):
  //    among perspectives only {wealth,debt} declare `snapshots`, only
  //    {cashFlow,liquidity} declare `transactions`, only investments declares
  //    `investmentsHistory` (ratcheted in lib/space/workspace-resources.test.ts).
  const openNeeds = openPerspectiveDataNeeds(activeTab, activePerspectiveId);
  const perspectiveNeedsSnapshots = openNeeds.has("snapshots");       // ⇔ wealth | debt
  const perspectiveNeedsTransactions = openNeeds.has("transactions"); // ⇔ cashFlow | liquidity
  const perspectiveNeedsInvestments = openNeeds.has("investmentsHistory"); // ⇔ investments

  // ── SD-7b — shared structural data lifecycle (useSpaceData) ─────────────────
  // Fold the nav-derived lazy-activation gates into two booleans and hand the
  // whole data lifecycle to the hook (it stays nav-agnostic). heroDef /
  // isFlowCategory are pure category helpers, also used for rendering below.
  const heroDef = getSpaceHeroDef(category);
  const isFlowCategory = FLOW_TX_CATEGORIES.includes(category);
  const wantSnapshots = Boolean(heroDef) || spaceType === "PERSONAL" || perspectiveNeedsSnapshots;
  const wantTransactions = isFlowCategory || activeTab === "TRANSACTIONS" || perspectiveNeedsTransactions;
  const {
    sections,
    accounts,
    loading,
    snapshots,
    backfilling: snapshotsBackfilling,
    transactions: spaceTransactions,
    transactionsMeta,
    moneyCtx: spaceMoneyCtx,
    widgetCtx,
    memberCount,
    currencyReverted,
    requestedCurrency,
    effectiveCurrency,
    reloadSections,
    reloadAccounts,
  } = useSpaceData({ spaceId, displayCurrency, wantSnapshots, wantTransactions });

  // V25-CLOSE-3A — the reporting-currency failure contract, resolved once at the
  // shared /view-context boundary and applied here at the composition root. When
  // the requested display currency cannot be satisfied, the WHOLE tree reverts to
  // the effective (USD) currency for formatting AND snapshot nominal currency, and
  // one banner explains it. No per-perspective handling; the stored preference is
  // untouched. `displayCurrency` (the fetch target) is deliberately NOT changed —
  // it is what lets /view-context keep detecting the unsatisfiable request.
  const effectiveDisplay = currencyReverted
    ? (effectiveCurrency ?? DEFAULT_DISPLAY_CURRENCY)
    : displayCurrency;
  const effectiveSnapshotCurrency = currencyReverted
    ? (effectiveCurrency ?? DEFAULT_DISPLAY_CURRENCY)
    : (snapshotCurrency ?? displayCurrency);

  // Data freshness — newest lastUpdated across this Space's shared accounts (no
  // new fetch). Surfaced in the header subtitle so no balance is read without
  // knowing how old it is. Client-only: `accounts` starts [] and populates
  // post-mount, so formatRelativeTime (not SSR-safe) never runs during SSR.
  const newestAccountUpdate = accounts.length
    ? accounts.reduce((best, a) => (a.lastUpdated > best ? a.lastUpdated : best), accounts[0].lastUpdated)
    : null;

  // M3-Reset — the Overview LENS row, reconciled to the Design Lab's set + feel.
  //
  //   Net Worth · Cash Flow · Liquidity · Investments · Debt   (text-only, no icons)
  //
  // "Net Worth" is the DEFAULT lens and IS the Overview summary (point-in-time
  // net worth + composition), matching the prototype's `temporal:false` Net Worth
  // lens — selecting it clears the engaged perspective. The other four engage
  // their existing extracted Workspaces. Reconciliation notes:
  //   • "Wealth" (assets-only, a full asOf/compareTo time-machine) is dropped from
  //     the core lens row — it is heavier than the prototype's point-in-time Net
  //     Worth lens; its semantics are untouched and it stays reachable at
  //     ?perspective=wealth.
  //   • "Goals" is not a core financial analytical lens (prototype excludes it);
  //     removed from the selector, its Workspace architecture treated separately.
  // ONE shared PerspectiveTabs renders this on the summary AND (engaged) inside
  // PerspectiveShell — same items, same handler; never two selectors at once.
  // SD-2 — "is this Perspective workspace-backed?" is answered by the renderer
  // contract (a dedicated WORKSPACE_RENDERERS entry) OR real widgets[] (the
  // virtual-section path, e.g. Goals) — never by widget presence alone. Investments
  // has a renderer but no widgets, so the widget-only proxy would wrongly gray it out.
  const isWorkspaceBacked = (p: { id: string; widgets?: readonly string[] }) =>
    p.id in WORKSPACE_RENDERERS || !!(p.widgets && p.widgets.length > 0);
  const lensSelectorItems = useMemo(
    () => [
      { id: NET_WORTH_LENS_ID, label: "Net Worth", hasWorkspace: true },
      ...CORE_LENS_IDS.map((id) => perspectiveItems.find((p) => p.id === id))
        .filter((p): p is (typeof perspectiveItems)[number] => Boolean(p))
        .map((p) => ({ id: p.id, label: p.label, hasWorkspace: isWorkspaceBacked(p) })),
    ],
    [perspectiveItems],
  );
  // selectLens + activeLensId now come from useSpaceNavigation (SD-8b).

  // Overview Perspectives doorway — each workspace-backed card engages that
  // Perspective through the Overview experience (M2 canonical IA: stay on
  // OVERVIEW, set the lens; the URL sync then writes ?tab=overview&perspective=
  // <slug>). Perspectives without a workspace stay non-clickable "Soon"
  // placeholders. This is the summary-level entry into the lens selector.
  const perspectiveDoorwayItems = useMemo(
    () =>
      perspectiveItems.map((p) =>
        isWorkspaceBacked(p)
          ? { ...p, onSelect: () => { setSelectedPerspectiveId(p.id); setActiveTab("OVERVIEW"); } }
          : { ...p, onSelect: undefined },
      ),
    [perspectiveItems, setSelectedPerspectiveId, setActiveTab],
  );

  // SD-8b — the ?tab=/?perspective= write + Back/Forward read + the ?account=
  // deep-link seed all moved into useSpaceNavigation (the URL authority). The host
  // consumes activeTab / selectedPerspectiveId / initialAccountFilter from it.

  // Shared Perspective shell TIME state — the ONE canonical {preset, asOf,
  // compareTo} triple, owned by usePerspectiveShellState (the lib/perspectives/
  // time-range.ts reducer + the SD-0A URL authority). Defaults to MTD (As Of
  // today, Compare To the first of this month). earliestDefensibleDate = the
  // oldest non-fxMiss snapshot (Space-level, lens-independent) → powers the ALL
  // slice's Compare To; null ⇒ never fabricated.
  const shellToday = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const earliestDefensibleDate = useMemo(
    () => snapshots?.find((s) => !s.fxMiss)?.date ?? null,
    [snapshots],
  );
  const shell = usePerspectiveShellState({ spaceId, today: shellToday, earliestDefensibleDate });
  const { asOf, compareTo, preset: timePreset } = shell.state;

  // ── Cash Flow period (SD-0B) ────────────────────────────────────────────────
  // Cash Flow's active period is DERIVED from the canonical shell slice — there
  // is no second mutable time state. The shell already exposes the relative
  // period its slice implies (shell.derived.cashFlowPeriod: the preset, or null
  // under CUSTOM). The ONLY independently-mutable piece here is the Cash-Flow-
  // local drill to an EXPLICIT calendar period (a Month/Quarter/Year the relative
  // canonical model can't express); that override wins until the user picks a
  // relative slice again. Under CUSTOM the canonical slice implies no period, so
  // Cash Flow holds its last relative one (§3.5) — captured in a ref that only
  // ever mirrors canonical, never an independent authority.
  const [cashFlowExplicitPeriod, setCashFlowExplicitPeriod] = useState<CashFlowPeriod | null>(null);
  // Cache of the last relative slice the canonical shell showed — NOT an
  // independent time authority: it only ever mirrors canonical state, so Cash
  // Flow can hold its last relative period while the shell sits on CUSTOM (§3.5).
  // Kept in state (not a ref) so the derived cashFlowPeriod below never reads a
  // ref during render; the sync only fires when the canonical slice is relative.
  const [lastRelativePeriod, setLastRelativePeriod] = useState<CashFlowPeriod>(DEFAULT_CASH_FLOW_PERIOD);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (shell.derived.cashFlowPeriod) setLastRelativePeriod(shell.derived.cashFlowPeriod);
  }, [shell.derived.cashFlowPeriod]);
  const cashFlowPeriod: CashFlowPeriod =
    cashFlowExplicitPeriod ?? shell.derived.cashFlowPeriod ?? lastRelativePeriod;

  // Cash Flow follows the shell slice: the canonical reducer is the single master
  // for the relative slice, so these handlers only clear the Cash-Flow-local
  // explicit override when a relative slice is (re)established — they never keep
  // a shadow copy of the shared time state.
  const handleAsOfChange      = (next: string)        => shell.actions.setAsOf(next);
  const handleCompareToChange = (next: string | null) => {
    shell.actions.setCompareTo(next);
    const inferred = inferPerspectiveTimePreset({ asOf, compareTo: next, coverageFrom: earliestDefensibleDate, currentPreset: timePreset });
    if (inferred !== "CUSTOM") setCashFlowExplicitPeriod(null); // snaps onto a preset ⇒ follow canonical
  };
  const handleSelectSlice = (slice: CashFlowPeriod) => {
    if (isExplicitPeriod(slice)) { setCashFlowExplicitPeriod(slice); return; } // explicit drill — CF-local
    shell.actions.selectPreset(slice);   // relative slice ⇒ canonical is the master
    setCashFlowExplicitPeriod(null);      // follow canonical
  };

  // SD-5 — the Wealth Time Machine read model + its per-date display-currency FX now
  // live INSIDE <WealthWorkspace> (the composition/render boundary), driven off the
  // SHARED host-fetched snapshot series passed as a prop. The host no longer computes
  // WealthResult; it only relays the workspace's trust envelope to the shell chip via
  // `wealthEnvelope` state (the Investments onEnvelopeChange bridge, below).

  // SD-8b — the Wealth chart metric (chartMetric + ?metric= sync) and the
  // switch-lens-from-workspace handler moved into useSpaceNavigation. The host
  // consumes chartMetric / setChartMetric / switchLens from it.

  // SD-9B — the trust-PUBLICATION seam. useActiveEnvelope holds the engaged
  // workspace's emitted envelope and owns the workspace-backed-vs-lens-only
  // selection (formerly an inline host ternary). It does NOT calculate trust —
  // the authority stays resolvePerspectiveEnvelope / PerspectiveEnvelope /
  // CompletenessTier. The host only wires onEnvelopeChange into the render context
  // and hands `activeEnvelope` to the shell.
  const { envelope: activeEnvelope, onEnvelopeChange } = useActiveEnvelope({ activePerspectiveId, lensResults });
  // SD-6C — the Cash Flow / Spending perspective + measure filter is now OWNED by
  // CashFlowWorkspace (workspace-local semantic slice), no longer host state. SD-6
  // gate — the completeness stamp AND its trust envelope are now workspace-owned too
  // (emitted up via cashFlowEnvelope, below); the host retains only the canonical-time
  // seam (cashFlowPeriod).
  // Debt/Investments/Liquidity own their own historical fetch (inside each
  // Workspace) and gate it on being the open perspective. The strictly-earlier
  // compareTo (those historical routes 400 on compareTo >= asOf) is now a CANONICAL
  // derived value — shell.derived.historicalCompareTo — not computed host-local.
  const debtActive = activeTab === "OVERVIEW" && activePerspectiveId === "debt";
  const liquidityActive = activeTab === "OVERVIEW" && activePerspectiveId === "liquidity";
  // SD-7a — Goals data ownership moved OUT of the host: each Goals Perspective
  // widget self-fetches via GoalPerspectiveWidget (mirroring GoalsCard). The host
  // no longer fetches goals, holds `spaceGoals`, or threads it through SectionCard.
  const txConversionCtx = useMemo(() => {
    const serialized = transactionsMoneyCtxOverride ?? spaceMoneyCtx;
    return serialized ? rehydrateContext(serialized) : undefined;
  }, [transactionsMoneyCtxOverride, spaceMoneyCtx]);

  async function handleLeave() {
    setLeaveBusy(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/members/${currentUserId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        router.push(`/dashboard/spaces?left=${encodeURIComponent(displaySpaceName(spaceName))}`);
      }
    } finally {
      setLeaveBusy(false);
    }
  }

  // (Activity slice) — the host no longer pre-fetches the activity feed for an
  // Overview doorway/modal. The recent_activity SECTION (TimelineWidget) self-
  // fetches /api/spaces/[id]/activity and paginates, so Activity owns its data.

  // SD-9A — the lensResults loader (state + currency-refresh listener + batch fetch)
  // moved to useSpaceLensResults (called at the top of the component). The host is no
  // longer a perspective-loading authority: it neither fetches perspectives, owns lens
  // result state, nor subscribes to the currency-refresh signal for lenses.

  // ── Initial-tab selection (NAV ⇄ DATA coordination point) ───────────────────
  // SD-8b — the RESOLUTION rules live in useSpaceNavigation; the host only
  // COORDINATES the timing: once useSpaceData's first load lands (loading flips
  // false), hand the sections to applyInitialTab, which resolves the tab once
  // (URL / initialTab / section-derived) and applies it. This is the one place
  // navigation reads data — kept one-way (data → applyInitialTab), no cycle. The
  // render early-return waits on `activeTab` too, so no untabbed frame shows.
  useEffect(() => {
    if (!loading) applyInitialTab(sections);
  }, [loading, sections, applyInitialTab]);

  // Template redesign: seeded section rows whose key has no SectionRegistry
  // renderer (and no debt-space legacy override) previously fell through to
  // a permanent ContextualCard "coming soon" body. Presets no longer seed
  // such keys, but EXISTING Spaces still carry the rows — gate them out at
  // render time ("nothing appears that the data cannot defend"). The rows
  // themselves are untouched (still visible/toggleable in Settings), so a
  // key regains its card the moment a renderer ships.
  const isDebtSpaceCategory = category === "DEBT_PAYOFF";
  const hasRenderer = (key: string) =>
    key in SectionRegistry ||
    (isDebtSpaceCategory && (key === "cash_flow" || key === "savings_rate"));

  // Derive tabs from enabled sections. (Settings is no longer an in-space
  // tab — section show/hide and layout controls live in ManageSpaceModal.)
  const enabledSections = sections.filter((s) => s.enabled && hasRenderer(s.key));
  const tabSet = Array.from(new Set(enabledSections.map((s) => s.tab)));
  const tabs   = TAB_ORDER.filter((t) => tabSet.includes(t));

  const catLabel = CATEGORY_LABELS[category as SpaceCategory] ?? category;

  // ── SHELL migration — publish this Space's identity + controls UP to the
  //    ContextualNavbar (Space mode). The transforming sidebar lives in the
  //    app-global chrome ABOVE this route child, so the host reaches it through
  //    SpaceChrome rather than props. Cleared on unmount ⇒ the sidebar reverts to
  //    global navigation when you leave the Space. Declared BEFORE the loading
  //    early-return so the hook order is unconditional. Section anchors are
  //    deferred (they require workspace-body ids, out of scope for this shell-only
  //    pass), so an empty list keeps the SECTIONS block hidden — honest.
  const { publishSpace, publishCurrencyControl } = useSpaceChromePublisher();
  const chromeSubtitle =
    `${catLabel} Space` +
    (memberCount !== null ? ` · ${memberCount} member${memberCount === 1 ? "" : "s"}` : "");
  const chromeUpdated = newestAccountUpdate ? `Updated ${formatRelativeTime(newestAccountUpdate)}` : null;

  useEffect(() => {
    publishSpace({
      identity: {
        name: displaySpaceName(spaceName),
        subtitle: chromeSubtitle,
        updatedLabel: chromeUpdated,
        shared: spaceType !== "PERSONAL",
      },
      onManage: canManage ? () => setShowManage(true) : undefined,
      onLeave: () => router.push("/dashboard/spaces"),
      onLeaveSpace: canLeave ? () => setConfirmLeave(true) : undefined,
    });
    return () => publishSpace(null);
  }, [publishSpace, spaceName, chromeSubtitle, chromeUpdated, spaceType, canManage, canLeave, router]);

  useEffect(() => {
    publishCurrencyControl(displayCurrencyControl ?? null);
    return () => publishCurrencyControl(null);
  }, [publishCurrencyControl, displayCurrencyControl]);

  // SD-7b — wait on the data load AND the initial-tab selection. The tab is now
  // picked in a follow-up effect (once `loading` flips false), so guarding on
  // `activeTab` too keeps the spinner up for that extra tick instead of flashing
  // an untabbed frame — preserving the former "spinner until ready" behavior.
  if (loading || !activeTab) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={20} className="animate-spin text-[var(--text-faint)]" />
      </div>
    );
  }

  // Unified Space Widget Layout (slice 1) — every tab (Personal OVERVIEW
  // included) renders its ordered section stack. The former renderHero
  // suppression that emptied Personal's Overview is gone: Net Worth / chart /
  // allocation are now section-backed, so Edit Layout works here naturally.
  const sectionsForTab = enabledSections
    .filter((s) => s.tab === activeTab)
    .sort((a, b) => a.order - b.order);

  // ── Hero series (Space Template Redesign) ─────────────────────────────────
  // MC1 QA Q4b — drop fxMiss points (off-stamp rows whose FX rate missed, so
  // their values are native/unconverted) so the hero series never plots mixed
  // units: a shorter honest trend beats a silently mixed-magnitude one.
  const heroPoints: HeroPoint[] = heroDef && snapshots
    ? snapshots.filter((s) => !s.fxMiss).map((s) => ({ date: s.date, value: heroDef.value(s) }))
    : [];

  // Debt Space preview = the PAYMENTS story (template polish D6): only
  // rows on debt accounts. Pure render-phase filter over data already
  // fetched; other flow categories pass the list through unchanged.
  const previewTransactions: Transaction[] = (() => {
    const txs = spaceTransactions ?? [];
    if (category !== "DEBT_PAYOFF") return txs;
    const debtIds = new Set(accounts.filter((a) => a.type === "debt").map((a) => a.id));
    return txs.filter((t) => debtIds.has(t.accountId));
  })();
  const previewScopeNote =
    category === "DEBT_PAYOFF" ? `Debt accounts · ${TX_SCOPE_NOTE.toLowerCase()}` : TX_SCOPE_NOTE;

  // Emergency-fund lede: "how long could I last" — months covered, computed
  // from the existing emergency_fund_progress section config. Only shown
  // with its assumption disclosed (sublineNote); without config the hero
  // falls back to the plain savings balance.
  let heroHeadlineOverride: string | undefined;
  let heroSublineNote:      string | undefined;
  if (heroDef && category === "EMERGENCY_FUND" && heroPoints.length > 0) {
    const efCfg      = sections.find((s) => s.key === "emergency_fund_progress")?.config;
    const monthlyExp = Number(efCfg?.monthlyExpenses);
    if (!isNaN(monthlyExp) && monthlyExp > 0) {
      const months = heroPoints[heroPoints.length - 1].value / monthlyExp;
      heroHeadlineOverride = `${months.toFixed(1)} months covered`;
      // MC1 QA Q4 — the config expense figure is Space-native; label follows.
      heroSublineNote      = `at ${formatBalance(monthlyExp, effectiveDisplay)}/mo expenses`;
    }
  }

  // Overview doorways. (Activity slice) — the Recent Activity preview is
  // removed from Overview: Activity is now its own rail tab. The Recent
  // Transactions preview stays on flow-identified Spaces (money movement is
  // part of their story; it's a doorway to the Transactions tab, not Activity).
  // Non-flow Spaces get nothing here now.
  const recentTransactionsDoorway =
    isFlowCategory && accounts.length > 0 ? (
      <RecentTransactionsPanel
        transactions={previewTransactions}
        previewCount={5}
        scopeNote={previewScopeNote}
        onViewAll={() => setActiveTab("TRANSACTIONS")}
      />
    ) : null;

  const perspectivesDoorway =
    accounts.length > 0 ? (
      /* Doorways — hidden at day zero (every lens would open onto empty data;
         the setup card is the one call to action). */
      <div>
        <div className="flex items-center justify-between px-1 mb-2">
          <p className="text-sm font-semibold text-white">Perspectives</p>
          <button
            type="button"
            // M2: engage the first workspace-backed lens through Overview (no
            // separate Perspectives tab). Stays on OVERVIEW; the lens selector
            // then lets the user move between lenses or back to the summary.
            onClick={() => {
              const first = perspectiveItems.find((p) => isWorkspaceBacked(p))?.id;
              if (first) setSelectedPerspectiveId(first);
            }}
            className="text-xs font-medium text-[var(--meridian-400)] hover:text-[var(--meridian-300)] transition-colors"
          >
            See all
          </button>
        </div>
        <PerspectivesWidget items={perspectiveDoorwayItems} variant="row" />
      </div>
    ) : null;

  // SD-7 — the SectionCard prop bundle that the section-backed Workspaces
  // (Accounts / Activity / Overview) thread through SpaceSectionStack.
  const sectionCardBundle: SectionCardBundle = {
    accounts,
    spaceId,
    spaceType,
    category,
    canManage,
    onAddGoal: () => setShowAddGoal(true),
    ctx: widgetCtx,
    snapshots,
    snapshotCurrency: effectiveSnapshotCurrency,
  };

  // SD-2 closeout — the perspective render implementations moved to the
  // component-layer WORKSPACE_RENDERERS map (workspaceRenderers.tsx), keyed by the
  // registry's workspace ids and bound to the registry by a parity test. The host
  // no longer defines which component renders; it materializes ONE render context
  // (from useSpaceData + useSpaceNavigation + shell time + props) and dispatches.
  // The Space's monthly-expense baseline, read from the SAME emergency_fund_progress
  // config the Overview EF hero uses (line ~581) — the ONLY honest source of a coverage
  // multiple. null when unset; the Liquidity Hero then shows no coverage (never faked).
  const liquidityMonthlyExpenses = (() => {
    const raw = Number(sections.find((s) => s.key === "emergency_fund_progress")?.config?.monthlyExpenses);
    return !isNaN(raw) && raw > 0 ? raw : null;
  })();

  const renderCtx: WorkspaceRenderCtx = {
    spaceId,
    snapshotCurrency: effectiveSnapshotCurrency,
    ficoScore,
    ficoUpdatedAt,
    perspectiveTargetCurrency,
    liquidityMonthlyExpenses,
    accounts,
    snapshots,
    snapshotsBackfilling,
    transactions: spaceTransactions,
    transactionsMeta,
    widgetCtx,
    txCtx: txConversionCtx,
    asOf,
    compareTo,
    historicalCompareTo: shell.derived.historicalCompareTo,
    today: shellToday,
    debtActive,
    liquidityActive,
    investmentsActive: perspectiveNeedsInvestments,
    lensResults,
    cashFlowPeriod,
    chartMetric,
    onMetricChange: setChartMetric,
    onSwitchLens: switchLens,
    onEnvelopeChange,
    onSelectCashFlowPeriod: setCashFlowExplicitPeriod,
    onOpenCashFlow: () => setSelectedPerspectiveId("cashFlow"),
  };

  return (
    // V25-CLOSE-3A — when the requested currency was unsatisfiable, a nested
    // provider re-scopes EVERY descendant's aggregate formatting to the effective
    // (USD) currency, overriding the ambient provider (which still carries the
    // requested currency so /view-context keeps detecting the failure). No-op when
    // not reverted (effectiveDisplay === displayCurrency).
    <DisplayCurrencyProvider currency={effectiveDisplay}>
    <SpaceShell
      mobileOptimized
      // Global shell overlays — the shell owns WHERE they mount (above the
      // frame); the host owns their open state + what they do.
      overlays={
        <>
          {/* (Activity slice) — the Timeline modal is gone. Activity is now a
              first-class rail tab rendering the recent_activity section inline
              (TimelineWidget, which self-fetches + paginates), so there's no
              modal to launch. */}
          {showAddGoal && (
            <AddGoalModal
              spaceId={spaceId}
              spaceCategory={category}
              accounts={accounts}
              onClose={() => setShowAddGoal(false)}
              onCreated={() => {
                setShowAddGoal(false);
                setActiveTab("GOALS");
              }}
            />
          )}

          {showManage && (
            <ManageSpaceModal
              spaceId={spaceId}
              spaceName={spaceName}
              myRole={myRole}
              currentUserId={currentUserId}
              onClose={() => setShowManage(false)}
              onRefresh={() => {
                setShowManage(false);
                reloadSections();
                reloadAccounts();
              }}
            />
          )}

          {/* ── Leave space confirmation (Atlas ConfirmDialog, doctrine Phase 4) ── */}
          {confirmLeave && (
            <ConfirmDialog
              onClose={() => setConfirmLeave(false)}
              onConfirm={handleLeave}
              icon={LogOut}
              title={`Leave ${displaySpaceName(spaceName)}?`}
              message={
                <>
                  You&apos;ll lose access to this Space and all of its shared data.
                  To rejoin, an <span className="text-white font-medium">Owner</span> or{" "}
                  <span className="text-white font-medium">Admin</span> will need to manually
                  re-add you.
                </>
              }
              confirmLabel="Leave Space"
              confirmIcon={<LogOut size={14} />}
              busy={leaveBusy}
            />
          )}
        </>
      }
      title={displaySpaceName(spaceName)}
      // SD-9C — ONE canonical subtitle derivation (chromeSubtitle + chromeUpdated,
      // computed once above and also published to the desktop ContextualNavbar). The
      // mobile relocation composes the same parts instead of recomputing catLabel /
      // memberCount / formatRelativeTime a second time.
      subtitle={chromeUpdated ? `${chromeSubtitle} · ${chromeUpdated}` : chromeSubtitle}
      // SHELL migration — the canonical FX + Manage cluster. On desktop these
      // render in the ContextualNavbar's Space mode (published above); here they
      // feed SpaceShell's mobile (<lg) relocation, where the sidebar is hidden.
      // Same state, second mount point. (Membership "Leave" moved to the sidebar
      // Space mode; the ConfirmDialog overlay above is unchanged.)
      currencyControl={displayCurrencyControl}
      onManage={canManage ? () => setShowManage(true) : undefined}
      // Space-level navigation rail — fixed Spaces rail (lib/space-nav.ts), shared
      // order across every Space type, centered + stationary on every Workspace
      // and lens (no railStatic left-shift).
      railOptions={railOptions}
      activeTab={activeTab}
      // M3: selecting the Overview rail tab always lands on the summary — it
      // clears any engaged lens, so "Overview" is the way back from a Perspective.
      onSelectTab={(id) => {
        if (id === "OVERVIEW") setSelectedPerspectiveId(null);
        setActiveTab(id);
      }}
    >

        {/* M3-Reset — the "turn a page" transition. The shell + rail stay fixed;
            only THIS body region re-enters on any change of Workspace OR engaged
            lens (keyed on both), so switching feels like content arriving in
            place, never a route change or a page rebuild. Reduced-motion users get
            no animation (the @media rule below). */}
        <div key={`${activeTab}:${activePerspectiveId ?? "networth"}`} className="fm-view-enter">

        {/* V25-CLOSE-3A — non-blocking disclosure when the requested reporting
            currency could not be satisfied and the display fell back to USD. One
            banner at the composition root; no per-perspective handling. */}
        {currencyReverted && (
          <CurrencyRevertedBanner
            requested={requestedCurrency ?? "the selected currency"}
            effective={effectiveCurrency ?? DEFAULT_DISPLAY_CURRENCY}
          />
        )}

        {/* Settings is no longer an in-space tab (UX-CUST-1A correction):
            section show/hide and layout controls moved to ManageSpaceModal →
            Overview. Opened via the "Manage" button above. */}

        {/* M2 canonical IA — the Perspective experience now lives UNDER Overview
            (no separate PERSPECTIVES rail tab). When a lens is engaged
            (perspectiveEngaged) the Perspective's WORKSPACE + the lens selector
            occupy the Overview content slot IN PLACE of the summary; the "Overview"
            item in the selector returns to the summary. Selecting a lens swaps the
            panel below: workspace-backed Perspectives (widgets[]) render through
            the EXISTING SectionCard/SectionRegistry compositor as VIRTUAL,
            render-only sections (virtual ids never reach a mutation endpoint);
            others show an honest "coming soon" placeholder. The financial
            workspaces, contracts, time semantics, Evidence, and FX are unchanged. */}
        {activeTab === "OVERVIEW" && perspectiveEngaged && (
          <div className="space-y-4">
            {/* ── Perspective shell — two framed containers (§2) ────────────────
                Container 1 (time & trust): As of / Compare to / Completeness /
                Evidence over the preset row. Container 2 (the lens): the tabs.
                Time is shared context above every Perspective; the shell writes
                shell state only through its own controls. Wealth supplies the
                Completeness/Evidence envelope; other Perspectives leave them as
                neutral placeholders until their engines drive them. */}
            <PerspectiveShell
              today={shellToday}
              onAsOfChange={handleAsOfChange}
              onCompareToChange={handleCompareToChange}
              onSwap={shell.actions.swap}
              // SD-9B — the resolved envelope from useActiveEnvelope (workspace-backed
              // → emitted; lens-only → resolvePerspectiveEnvelope). No host selection.
              envelope={activeEnvelope}
              onSelectPreset={handleSelectSlice}
              // Temporal-capability gating: the shell renders only the time controls
              // the engaged lens actually consumes (As-of/Compare-to vs Period).
              temporalCapability={activePerspectiveId ? getWorkspaceDefinition(activePerspectiveId)?.temporalCapability : undefined}
              // TimelineLens path (rollout allowlist). Read-only canonical state:
              // the lens DERIVES its entire display from this every render and
              // stores nothing, so back-navigation and async coverage arrival are
              // reflected without it knowing they happened. Every intent it emits
              // comes back through the handlers above — same actions, same order.
              timeState={shell.state}
              tabs={lensSelectorItems}
              activeTabId={activeLensId}
              onSelectTab={selectLens}
            />

            {/* Row 4 — Perspective-specific controls slot. These stay
                Perspective-specific (never shared): Cash Flow's perspective /
                measure controls currently live in their own widgets below;
                future Perspectives surface their controls in this slot. Below it
                begins the existing widget/card stack. */}
            <div
              role="tabpanel"
              aria-labelledby={activePerspectiveId ? `ptab-${activePerspectiveId}` : undefined}
              className="space-y-3"
            >
              {activePerspectiveId && WORKSPACE_RENDERERS[activePerspectiveId] ? (
                // Registry-driven: the engaged financial workspace (Wealth / Cash Flow
                // / Liquidity / Investments / Debt). Each owns its data + FX + as-of
                // trust and emits its envelope up; the host only supplies the render
                // context. See components/space/workspaces/workspaceRenderers.tsx.
                WORKSPACE_RENDERERS[activePerspectiveId](renderCtx)
              ) : activePerspective?.widgets && activePerspective.widgets.length > 0 ? (
                toVirtualSections(activePerspective.id, activePerspective.widgets).map((vs) => (
                  <SectionCard
                    key={vs.id}
                    section={vs}
                    accounts={accounts}
                    spaceId={spaceId}
                    spaceType={spaceType}
                    category={category}
                    canManage={canManage}
                    ctx={widgetCtx}
                    snapshots={snapshots}
                    snapshotCurrency={effectiveSnapshotCurrency}
                    transactions={spaceTransactions}
                    txCtx={txConversionCtx}
                    period={cashFlowPeriod}
                    onSelectPeriod={(p) => setCashFlowExplicitPeriod(p)}
                    ficoScore={ficoScore}
                    ficoUpdatedAt={ficoUpdatedAt}
                  />
                ))
              ) : activePerspective ? (
                <div className="text-center py-12">
                  <p className="text-sm text-[var(--text-muted)]">{activePerspective.label}</p>
                  <p className="text-xs text-[var(--text-faint)] mt-1">
                    This perspective&apos;s workspace is coming soon.
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {/* Activity — a first-class rail tab now (Activity slice). It renders
            its recent_activity section through the shared section stack below
            (activeTab === "ACTIVITY"), like Overview/Accounts. No modal. */}

        {/* Finances / Documents — no rail control and no body on this host
            (v2.5 honesty slice): gated off the rail by
            railVisibleTabs(railHost) in lib/space-nav.ts until a real
            feature backs them. The ids remain valid members of
            NEW_SPACE_TABS so internal gating below keeps working. */}

        {/* Transactions tab — real data (Space Template Redesign): the
            doorway destination for every shared Space, and the "View all"
            target of flow templates' Overview preview. Rows come from
            GET /api/spaces/[id]/transactions, KD-15-filtered server-side,
            hence the scope note. */}
        {activeTab === "TRANSACTIONS" && (
          <TransactionsWorkspace
            // TX-3.3 — the explorer queries the server itself (keyset-paged,
            // server-filtered), so it needs only the Space identity. The host's
            // shared transaction array still feeds the analytical surfaces.
            spaceId={spaceId}
            accounts={accounts}
            // Banking→Transactions retarget — deep-link account pre-filter.
            initialAccountFilter={initialAccountFilter}
          />
        )}

        {/* Members tab — the editorial People destination (owns roster, roles,
            invites, pending queue via the existing member/invite routes).
            "Manage Space" still routes to the modal for General / Add Accounts /
            Delete; onRefresh keeps host totals honest when a removal revokes
            the departing member's shared accounts. */}
        {activeTab === "MEMBERS" && (
          <MembersWorkspace
            spaceId={spaceId}
            myRole={myRole}
            currentUserId={currentUserId}
            onManage={() => setShowManage(true)}
            onRefresh={() => { reloadSections(); reloadAccounts(); }}
          />
        )}

        {/* Goals / Retirement — the last remaining legacy routed-modal surfaces
            (M2 explicit compatibility boundary). Debt & Investments were retired
            from this path — they now have ONE canonical destination each: the
            Perspective under Overview. Goals/Retirement keep the GlassModal until
            their future product architecture is decided (not this slice), so the
            legacy mechanism is deliberately isolated to these two ids via the
            registry's routing.targetTab (ROUTED_WORKSPACE_TABS = {GOALS, RETIREMENT}). */}
        {isRoutedWorkspaceTab(activeTab) && (
          <RoutedWorkspaceModal
            activeTab={activeTab}
            sections={sectionsForTab}
            canManage={canManage}
            onClose={() => setActiveTab("OVERVIEW")}
            onManage={() => setShowManage(true)}
            onAddGoal={() => setShowAddGoal(true)}
            accounts={accounts}
            spaceId={spaceId}
            spaceType={spaceType}
            category={category}
            ctx={widgetCtx}
          />
        )}

        {/* Overview summary — the Space's primary canvas (SD-7), shown when no
            lens is engaged (M2: an engaged lens swaps in the Perspective block
            above). OverviewWorkspace owns the composition switcher + coming-soon
            panel + the canvas (hero → day-zero setup / section stack → doorways).
            Host passes shared data + host-derived hero values + the Edit-Layout
            controls + the fetched doorway nodes (incl. the Perspectives entry). */}
        {activeTab === "OVERVIEW" && !perspectiveEngaged && (
          <div className="space-y-7 sm:space-y-9">
            {/* M3 Design Lab convergence — the lens selector, surfaced on the
                Overview summary so Perspective selection is front-and-centre.
                Hidden at day zero (no accounts) where every lens would open onto
                empty data — there the setup card is the one call to action. */}
            {accounts.length > 0 && lensSelectorItems.length > 0 && (
              <div className="flex flex-col items-center gap-2">
                <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-faint)]">
                  Lens
                </p>
                <PerspectiveTabs
                  items={lensSelectorItems}
                  activeId={activeLensId}
                  onSelect={selectLens}
                />
              </div>
            )}
            <OverviewWorkspace
              category={category}
              spaceType={spaceType}
              accounts={accounts}
              loading={loading}
              canManage={canManage}
              onManage={() => setShowManage(true)}
              onAddGoal={() => setShowAddGoal(true)}
              heroDef={heroDef ?? null}
              heroPoints={heroPoints}
              heroHeadlineOverride={heroHeadlineOverride}
              heroSublineNote={heroSublineNote}
              heroCurrency={effectiveDisplay}
              snapshotsLoading={snapshots === null}
              sectionsForTab={sectionsForTab}
              card={sectionCardBundle}
              recentTransactionsDoorway={recentTransactionsDoorway}
              perspectivesDoorway={perspectivesDoorway}
            />
          </div>
        )}

        {/* Accounts — a fixed rail tab, now the editorial AccountsLedger (ground-truth
            list of the Space's financial objects). Consumes the SAME shared data +
            conversion context the section cards use, via the card bundle. */}
        {activeTab === "ACCOUNTS" && (
          <AccountsWorkspace card={sectionCardBundle} />
        )}

        {/* Activity — a first-class rail tab: the editorial Activity timeline
            (hero + date-banded feed → RightPanel detail), reading the canonical
            activity feed. Presentation-only convergence; never reorders. */}
        {activeTab === "ACTIVITY" && (
          <ActivityWorkspace spaceId={spaceId} />
        )}

        {/* No sections at all — only meaningful for the legacy data-driven
            tabs above; the fixed-rail tabs always have their own content. */}
        {tabs.length === 0 && !loading && activeTab !== "SETTINGS" && activeTab !== "ACTIVITY" &&
         !NEW_SPACE_TABS.includes(activeTab) && !isRoutedWorkspaceTab(activeTab) && (
          <div className="text-center py-12">
            <LayoutDashboard size={30} className="text-[var(--text-faint)] mx-auto mb-3" />
            <p className="text-sm text-[var(--text-muted)]">No dashboard sections configured</p>
            {canManage && (
              <p className="text-xs text-[var(--text-faint)] mt-1">This Space was created without a template.</p>
            )}
          </div>
        )}
        </div>

        {/* M3-Reset page-turn keyframes. opacity + a short lift + a brief
            de-blur reads as "focus arriving" (the prototype's lens/workspace
            transition feel) without a directional route-change slide. */}
        <style>{`
          @media (prefers-reduced-motion: no-preference) {
            .fm-view-enter { animation: fm-view-in 300ms cubic-bezier(0.22, 1, 0.36, 1) both; }
          }
          @keyframes fm-view-in {
            from { opacity: 0; transform: translateY(10px); filter: blur(4px); }
            to   { opacity: 1; transform: translateY(0);    filter: blur(0);   }
          }
        `}</style>
    </SpaceShell>
    </DisplayCurrencyProvider>
  );
}
