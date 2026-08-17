"use client";
import { todayUTCISO } from "@/lib/time/clock";

/**
 * SpaceDashboard
 *
 * The shared Space shell host (Personal renders through it too, via
 * PersonalDashboard). The rail is fixed (lib/space-nav SPACE_TAB_ORDER); the
 * OVERVIEW slot always renders the engaged Perspective workspace (the Net
 * Worth default resolves to Wealth). SpaceDashboardSection rows (GET
 * /api/spaces/[id]/sections) now drive only the GOALS / RETIREMENT routed
 * modals and the initial-tab pick — the section-driven Overview canvas was
 * retired in REVIEW-3.
 */

import React, { useState, useEffect, useMemo } from "react";
import type { ExpenseBaseline } from "@/lib/liquidity/expense-baseline";
import { useRouter } from "next/navigation";
import { Loader2, LogOut } from "lucide-react";
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
import { useSpaceNavigation, NET_WORTH_LENS_ID, CORE_LENS_IDS } from "@/lib/space/use-space-navigation";
import { useSpaceLensResults } from "@/lib/space/use-space-lens-results";
import { useActiveEnvelope } from "@/lib/space/use-active-envelope";
import { inferPerspectiveTimePreset } from "@/lib/perspectives/time-range";
import { PerspectiveShell } from "@/components/space/shell/PerspectiveShell";
import { WORKSPACE_RENDERERS, WorkspaceExplorationHost, type WorkspaceRenderCtx } from "@/components/space/workspaces/workspaceRenderers";
import { MembersWorkspace } from "@/components/space/workspaces/MembersWorkspace";
import { TransactionsWorkspace } from "@/components/space/workspaces/TransactionsWorkspace";
import { AccountsWorkspace } from "@/components/space/workspaces/AccountsWorkspace";
import { ActivityWorkspace } from "@/components/space/workspaces/ActivityWorkspace";
import { AddGoalModal } from "@/components/space/workspaces/AddGoalModal";
import { RoutedWorkspaceModal } from "@/components/space/workspaces/RoutedWorkspaceModal";
import type { SectionCardBundle } from "@/components/space/workspaces/SpaceSectionStack";
import { railVisibleTabs, SPACE_TAB_LABELS } from "@/lib/space-nav";
import { useSpaceChromePublisher } from "@/lib/space/space-chrome-context";
import { resolveSpaceFreshness } from "@/lib/freshness/space-freshness";
import { getPerspectivesForCategory, isRoutedWorkspaceTab, getWorkspaceDefinition, type PerspectiveDef } from "@/lib/perspectives";
import { toVirtualSections } from "@/lib/perspectives/virtual-sections";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { rehydrateContext, type SerializedConversionContext } from "@/lib/money/convert";
import { useDisplayCurrency, DisplayCurrencyProvider } from "@/lib/currency-context";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { CurrencyRevertedBanner } from "@/components/dashboard/CurrencyRevertedBanner";
import { hasSpaceTrendHero } from "@/lib/space-hero";
import { SectionCard } from "@/components/space/sections/SectionCard";
import { SectionRegistry } from "@/components/space/sections/SectionRegistry";
import type { FinancialInitialWorkspacePayload } from "@/lib/space/mount-composition";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  spaceId:   string;
  spaceName: string;
  spaceType: string;
  category:      string;
  myRole:        string;
  currentUserId?: string;
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
  /**
   * PS-6B — the finance initial-Workspace payload (sections + accounts + member
   * count), composed once at the /dashboard RSC boundary and consumed by
   * useSpaceData to hydrate the shell without the client re-fetching those three
   * eager structural resources. Absent ⇒ the hook fetches on mount, exactly as
   * before. This is the FINANCIAL InitialWorkspacePayload (PS-6P boundary) — it is
   * a separate value from the domain-neutral SpaceMountContext.
   *
   * PS-6F — this FINANCIAL shell deliberately does NOT take a `SpaceMountContext`
   * prop. The context is REPRESENTABLE from finance (the resolver + its tests
   * prove it) but the shell reads its identity/nav from native props + this
   * payload; consuming the context here would add indirection without
   * consolidating any authority (see docs/architecture/SPACE_MOUNT_DOCTRINE.md
   * §"domain asymmetry"). Platform consumes the context directly because it
   * consolidates real authority; finance does not, by design.
   */
  initialWorkspace?: FinancialInitialWorkspacePayload;
}

// SD-8b — the URL⇄tab vocabulary (URL_SYNCED_TABS / URL_TAB_ALIAS / parseTabParam /
// perspectiveIdToSlug / parsePerspectiveParam / readUrlTabState) and the nav
// constants (TAB_ORDER / NET_WORTH_LENS_ID / CORE_LENS_IDS) moved to
// lib/space/use-space-navigation.ts, the navigation authority. The host imports
// the constants it still renders with; the URL helpers are hook-internal.

/** Flow-identified templates (Space Template Redesign): money movement is
 *  part of these Spaces' story. The former Overview transactions-preview
 *  doorway is retired with the summary canvas (REVIEW-3); the list survives
 *  as the eager-transaction-fetch activation gate (wantTransactions). */
const FLOW_TX_CATEGORIES = ["HOUSEHOLD", "FAMILY", "BUSINESS", "DEBT_PAYOFF"];


// ─── Main component ───────────────────────────────────────────────────────────

export function SpaceDashboard({
  spaceId,
  spaceName,
  spaceType,
  category,
  myRole,
  currentUserId = "",
  displayCurrencyControl,
  snapshotCurrency,
  ficoScore,
  ficoUpdatedAt,
  perspectiveTargetCurrency,
  transactionsMoneyCtxOverride,
  initialWorkspace,
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
  const { lensResults, syncIncomplete } = useSpaceLensResults({ spaceId, targetCurrency: perspectiveTargetCurrency });

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
  } = useSpaceNavigation({ category, availablePerspectives });

  // SD-7b — the shared structural data lifecycle (sections / accounts / snapshots /
  // transactions / view-context / member count) + its refresh orchestration moved
  // to useSpaceData. The host CONSUMES this data; the call itself is a few lines
  // below, once the nav-derived activation gates are known.

  // SD-7 — the Overview composition switcher state (composition / compositionItems /
  // activeComposition) is now OWNED by <OverviewWorkspace> (Overview-only state); the
  // host no longer holds it.

  const canManage = ["OWNER", "ADMIN"].includes(myRole);
  const canLeave  = !canManage; // MEMBER and VIEWER can leave

  // Fixed rail options (lib/space-nav SPACE_TAB_ORDER — every id is rail-real
  // since REVIEW-3 deleted the placeholder ids: FINANCES/DOCUMENTS/SETTINGS/
  // PERSPECTIVES). M3-Reset — TEXT-ONLY rail options (the prototype's rail
  // language); the old per-tab RailTabIcon treatment is dropped. Order is
  // inherited from SPACE_TAB_ORDER — never reordered here.
  const railOptions: { id: string; label: string }[] =
    railVisibleTabs().map((id) => ({ id, label: SPACE_TAB_LABELS[id] }));

  // "overview" is filtered out here, not in lib/perspectives.ts: it's the
  // OVERVIEW destination's own identity, never an engageable lens. (The former
  // PerspectiveCardItem mapping — engine results + doorway onSelect — retired
  // with the Overview summary canvas and its Perspectives doorway, REVIEW-3.)
  const perspectiveItems: PerspectiveDef[] = useMemo(
    () => getPerspectivesForCategory(category).filter((p) => p.id !== "overview"),
    [category]
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
  // REVIEW-3 (slice F) — the Overview content slot ALWAYS renders the resolved
  // lens's workspace now. The former `!perspectiveEngaged` summary canvas
  // (OverviewWorkspace: trend hero / section stack / doorways) was product-
  // unreachable for every creatable category (the Net Worth default always
  // resolves to "wealth"; only TRIP lacks it, and TRIP is neither creatable nor
  // present in production) and has been deleted. The nav hook guarantees
  // activePerspectiveId is category-valid, so activePerspective is null only
  // for a category with no wealth lens — where the slot renders nothing.

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
  // whole data lifecycle to the hook (it stays nav-agnostic). hasSpaceTrendHero /
  // isFlowCategory are pure category predicates (activation gates only — the
  // hero rendering path was retired with the Overview canvas, REVIEW-3).
  const isFlowCategory = FLOW_TX_CATEGORIES.includes(category);
  const wantSnapshots = hasSpaceTrendHero(category) || spaceType === "PERSONAL" || perspectiveNeedsSnapshots;
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
  } = useSpaceData({ spaceId, displayCurrency, wantSnapshots, wantTransactions, initial: initialWorkspace });

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

  // V25-CLOSE-3A-FIX-2 — the banner is informational, so it is dismissible.
  // Dismissal is PRESENTATION-ONLY, session-scoped, and keyed to the requested
  // currency: closing it touches nothing (currency, fallback, and stored
  // preference are all unchanged — the revert above still applies). It re-arms on
  // any NEW failure event via React's "adjust state when a prop changes" pattern
  // (reset during render, not in an effect): whenever the requested currency
  // changes — a different currency failing, OR the condition clearing (USD) and
  // returning — the dismissal clears, so "reopening the condition" always
  // discloses again. Not persisted: a refresh re-discloses a still-true condition
  // (the safe direction).
  const [dismissedCurrency, setDismissedCurrency] = useState<string | null>(null);
  const [prevRequestedCurrency, setPrevRequestedCurrency] = useState(requestedCurrency);
  if (prevRequestedCurrency !== requestedCurrency) {
    setPrevRequestedCurrency(requestedCurrency);
    setDismissedCurrency(null);
  }
  const showCurrencyBanner = currencyReverted && requestedCurrency !== dismissedCurrency;

  // ── Data freshness (v2.6-L1) ────────────────────────────────────────────────
  // This WAS a MAX across the Space's accounts — the most optimistic claim the
  // data permits. On the live corpus that header read "Updated 16 hr ago" while
  // 96.4% of the value it described sat behind balances nobody had observed in
  // eight weeks. The comment that used to sit here stated the correct intent
  // ("no balance is read without knowing how old it is") and the reducer
  // inverted it.
  //
  // Freshness is now resolved by the canonical authority: the claim ANCHORS on
  // the OLDEST observation (so it can never overstate) and carries a qualifier
  // describing what a single age cannot — stale account count, and the share of
  // VALUE behind them. No arithmetic here; this component only formats.
  //
  // Client-only, same as before: `accounts` starts [] and populates post-mount,
  // so neither `new Date()` nor formatRelativeTime (not SSR-safe) runs during
  // SSR. Recomputed when the account list reloads, which is exactly when the
  // underlying observations can have changed.
  const freshness = useMemo(
    () =>
      accounts.length
        ? resolveSpaceFreshness(
            accounts.map((a) => ({
              accountId:          a.id,
              ingestedAt:         a.lastUpdated,
              providerBalanceAt:  a.balanceLastUpdatedAt ?? null,
              balance:            a.balance,
            })),
            new Date(),
          )
        : null,
    [accounts],
  );

  // M3-Reset — the Overview LENS row, reconciled to the Design Lab's set + feel.
  //
  //   Net Worth · Cash Flow · Liquidity · Investments · Debt   (text-only, no icons)
  //
  // "Net Worth" is the DEFAULT lens — REVIEW-3: selecting it clears the engaged
  // selection, which re-resolves to the Wealth workspace (the summary canvas it
  // used to return to is retired). The other four engage their extracted
  // Workspaces. "Goals" is not a core financial analytical lens (prototype
  // excludes it); it stays reachable only via its routed-modal deep link.
  // ONE shared PerspectiveTabs renders inside PerspectiveShell.
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

  // (REVIEW-3) The Overview Perspectives doorway-card row retired with the
  // summary canvas; the lens selector inside PerspectiveShell is the one
  // remaining lens entry surface.

  // SD-8b — the ?tab=/?perspective= write + Back/Forward read + the ?account=
  // deep-link seed all moved into useSpaceNavigation (the URL authority). The host
  // consumes activeTab / selectedPerspectiveId / initialAccountFilter from it.

  // Shared Perspective shell TIME state — the ONE canonical {preset, asOf,
  // compareTo} triple, owned by usePerspectiveShellState (the lib/perspectives/
  // time-range.ts reducer + the SD-0A URL authority). Defaults to MTD (As Of
  // today, Compare To the first of this month). earliestDefensibleDate = the
  // oldest non-fxMiss snapshot (Space-level, lens-independent) → powers the ALL
  // slice's Compare To; null ⇒ never fabricated.
  // B-6 — the client's UTC day, from THE clock seam (lib/time/clock.ts). It
  // gates fetches and seeds time-range defaults; where a server read answers
  // an as-of question, the server's classification wins (lib/time/basis.ts).
  const shellToday = useMemo(() => todayUTCISO(), []);
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
  const { envelope: activeEnvelope, onEnvelopeChange } = useActiveEnvelope({ activePerspectiveId, lensResults, syncIncomplete });
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

  // Enabled, renderer-backed sections — consumed by the routed-modal tabs
  // (GOALS / RETIREMENT) via sectionsForTab below. (The former section-derived
  // `tabs` list fed only the "no sections configured" fallback, deleted with
  // the Overview summary canvas in REVIEW-3.)
  const enabledSections = sections.filter((s) => s.enabled && hasRenderer(s.key));

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
  // v2.6-L1 — "Last checked N ago" (our fetch clock) rather than "Updated N ago"
  // (which reads as the institution's). `label` comes from the authority and
  // becomes "Balances as of" only when EVERY account is provider-attested.
  const chromeUpdated = freshness
    ? freshness.anchor.observedAt
      ? `${freshness.label} ${formatRelativeTime(freshness.anchor.observedAt)}`
      : freshness.label
    : null;
  const chromeFreshnessNote = freshness?.qualifier ?? null;
  const chromeFreshnessWarn = freshness?.claim === "STALE" || freshness?.claim === "UNKNOWN";

  useEffect(() => {
    publishSpace({
      identity: {
        name: displaySpaceName(spaceName),
        subtitle: chromeSubtitle,
        updatedLabel: chromeUpdated,
        freshnessNote: chromeFreshnessNote,
        freshnessWarn: chromeFreshnessWarn,
        shared: spaceType !== "PERSONAL",
      },
      onManage: canManage ? () => setShowManage(true) : undefined,
      onLeave: () => router.push("/dashboard/spaces"),
      onLeaveSpace: canLeave ? () => setConfirmLeave(true) : undefined,
    });
    return () => publishSpace(null);
  }, [publishSpace, spaceName, chromeSubtitle, chromeUpdated, chromeFreshnessNote, chromeFreshnessWarn, spaceType, canManage, canLeave, router]);

  useEffect(() => {
    publishCurrencyControl(displayCurrencyControl ?? null);
    return () => publishCurrencyControl(null);
  }, [publishCurrencyControl, displayCurrencyControl]);

  // v2.6-ASSESS-3 — the RESOLVED monthly-expense baseline, fetched from the server
  // when the Liquidity perspective is open.
  //
  // This used to read the `emergency_fund_progress` config here and call it "the
  // ONLY honest source of a coverage multiple". It was not the only one — it was
  // one of two, and the other (the reliable-month average) is what the assessment
  // engine had been dividing by all along. Measured on the corpus, NO Space
  // declared a figure, so this returned null everywhere and the Liquidity Hero
  // showed no coverage at all while the engine graded the same position and told
  // the AI about it.
  //
  // The precedence (declared outranks measured) and the positive-or-refuse rule
  // now live in `lib/liquidity/expense-baseline.ts`, and the route resolves them
  // server-side because the two candidate figures sit on opposite sides of this
  // boundary: the declared one is in the section config, the measured one needs
  // the transactions assembler. Nothing is re-derived here — the host receives an
  // answer and its basis.
  //
  // Lazy, per the mount hydration doctrine: fetched only while Liquidity is the
  // open perspective, never on every Space mount.
  //
  // ⚠️ Placed ABOVE the `loading` early return below. These are hooks, and this
  // component returns a spinner before that point — putting them after it would
  // change hook order between the loading and loaded renders.
  //
  // v2.6-LEGACY-1 — ONE live consumer now: the Liquidity workspace's runway
  // ("how long could I last on reachable cash?"). The Overview emergency-fund
  // hero was the second, and it is retired with its category — see the lede
  // block below. The route stays Space-level rather than liquidity-scoped: the
  // baseline is a UNIT, and the next surface to express an answer in months of
  // expenses should read it rather than mint a second one.
  const liquidityOpen = openNeeds.has("transactions") && activePerspectiveId === "liquidity";
  const [expenseBaseline, setExpenseBaseline] =
    useState<ExpenseBaseline | null>(null);
  useEffect(() => {
    if (!liquidityOpen) return;
    let alive = true;
    fetch(`/api/spaces/${spaceId}/expense-baseline`)
      .then((r) => (r.ok ? r.json() : { baseline: null }))
      .then((d) => { if (alive) setExpenseBaseline(d?.baseline ?? null); })
      .catch(() => { if (alive) setExpenseBaseline(null); });
    return () => { alive = false; };
  }, [liquidityOpen, spaceId]);

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

  // The active tab's enabled, renderer-backed sections — consumed by the
  // GOALS / RETIREMENT routed modals (the last section-driven surfaces).
  const sectionsForTab = enabledSections
    .filter((s) => s.tab === activeTab)
    .sort((a, b) => a.order - b.order);

  // (REVIEW-3, slice F) The Overview summary canvas — trend-hero series, the
  // v2.6-LEGACY-1 hero-override dead lets, the Recent-Transactions preview and
  // the Perspectives doorway row — was deleted with OverviewWorkspace: the
  // Overview slot always renders the engaged Perspective workspace, so the
  // summary composition had no reachable mount.

  // SD-7 — the SectionCard prop bundle for the section-backed surfaces.
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
    asOf,
  };

  // SD-2 closeout — the perspective render implementations moved to the
  // component-layer WORKSPACE_RENDERERS map (workspaceRenderers.tsx), keyed by the
  // registry's workspace ids and bound to the registry by a parity test. The host
  // no longer defines which component renders; it materializes ONE render context
  // (from useSpaceData + useSpaceNavigation + shell time + props) and dispatches.

  const renderCtx: WorkspaceRenderCtx = {
    spaceId,
    snapshotCurrency: effectiveSnapshotCurrency,
    ficoScore,
    ficoUpdatedAt,
    perspectiveTargetCurrency,
    liquidityExpenseBaseline: expenseBaseline,
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
            banner at the composition root; no per-perspective handling.
            FIX-2 — dismissible (presentation only; the revert above is unaffected). */}
        {showCurrencyBanner && (
          <CurrencyRevertedBanner
            requested={requestedCurrency ?? "the selected currency"}
            effective={effectiveCurrency ?? DEFAULT_DISPLAY_CURRENCY}
            onDismiss={() => setDismissedCurrency(requestedCurrency ?? null)}
          />
        )}

        {/* Settings is no longer an in-space tab (UX-CUST-1A correction):
            section show/hide and layout controls moved to ManageSpaceModal →
            Overview. Opened via the "Manage" button above. */}

        {/* M2 canonical IA — the Perspective experience lives UNDER Overview
            (no separate PERSPECTIVES rail tab). REVIEW-3: the Overview content
            slot ALWAYS renders the resolved lens's workspace + the lens
            selector (the Net Worth default resolves to the Wealth workspace;
            the former summary canvas was unreachable and is deleted).
            Selecting a lens swaps the panel below: workspace-backed
            Perspectives render their WORKSPACE_RENDERERS entry; widgets[]-
            backed ones (Goals, deep-link only) render through the EXISTING
            SectionCard/SectionRegistry compositor as VIRTUAL, render-only
            sections (virtual ids never reach a mutation endpoint); others show
            an honest "coming soon" placeholder. The financial workspaces,
            contracts, time semantics, Evidence, and FX are unchanged. */}
        {activeTab === "OVERVIEW" && activePerspective != null && (
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
                // v2.6 — every workspace renders inside the ONE exploration host,
                // so the shared sheet has a single mount and a deep link restores
                // even when the workspace behind it has nothing to plot.
                <WorkspaceExplorationHost spaceId={spaceId} asOf={asOf}>
                  {WORKSPACE_RENDERERS[activePerspectiveId](renderCtx)}
                </WorkspaceExplorationHost>
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
                    asOf={asOf}
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

        {/* (REVIEW-3) The former Overview summary branch (OverviewWorkspace:
            composition switcher, trend hero, day-zero setup card, section
            stack, doorways) is deleted — with the Net Worth default always
            resolving to the Wealth workspace it had no reachable mount. The
            "no dashboard sections configured" fallback went with it: every
            rail tab now renders real content regardless of section rows. */}

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
