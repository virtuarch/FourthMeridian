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

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import { useSpaceUrl } from "@/components/space/shell/useSpaceUrl";
import { readSpaceParam, legacyTabPerspective } from "@/lib/space/space-url";
import { openPerspectiveDataNeeds } from "@/lib/space/workspace-resources";
import { inferPerspectiveTimePreset } from "@/lib/perspectives/time-range";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { PerspectiveShell } from "@/components/space/shell/PerspectiveShell";
import { PerspectiveTabs } from "@/components/space/shell/PerspectiveTabs";
import { WealthWorkspace } from "@/components/space/widgets/wealth/WealthWorkspace";
import { CashFlowWorkspace } from "@/components/space/widgets/cashflow/CashFlowWorkspace";
import { LiquidityWorkspace } from "@/components/space/widgets/liquidity/LiquidityWorkspace";
import { InvestmentsWorkspace } from "@/components/space/widgets/investments/InvestmentsWorkspace";
import { DebtWorkspace } from "@/components/space/widgets/debt/DebtWorkspace";
import { MembersWorkspace } from "@/components/space/workspaces/MembersWorkspace";
import { TransactionsWorkspace, TX_SCOPE_NOTE } from "@/components/space/workspaces/TransactionsWorkspace";
import { AccountsWorkspace } from "@/components/space/workspaces/AccountsWorkspace";
import { ActivityWorkspace } from "@/components/space/workspaces/ActivityWorkspace";
import { OverviewWorkspace } from "@/components/space/workspaces/OverviewWorkspace";
import { AddGoalModal } from "@/components/space/workspaces/AddGoalModal";
import { RoutedWorkspaceModal } from "@/components/space/workspaces/RoutedWorkspaceModal";
import type { SectionCardBundle } from "@/components/space/workspaces/SpaceSectionStack";
import type { WealthMetricKey } from "@/components/space/widgets/wealth/WealthTrendChart";
import { railVisibleTabs, SPACE_TAB_LABELS, SPACE_ACCOUNTS_CHANGED_EVENT, SPACE_CURRENCY_CHANGED_EVENT, SPACE_DATA_REFRESHED_EVENT } from "@/lib/space-nav";
import { useSpaceChromePublisher } from "@/lib/space/space-chrome-context";
import { getPerspectivesForCategory, PERSPECTIVE_LIBRARY, getWorkspaceTargetTab, isRoutedWorkspaceTab } from "@/lib/perspectives";
import { toVirtualSections } from "@/lib/perspectives/virtual-sections";
import type { LensResult } from "@/lib/perspective-engine/types";
import { PerspectivesWidget, type PerspectiveCardItem } from "@/components/dashboard/widgets/PerspectivesWidget";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { type HeroPoint } from "@/components/dashboard/widgets/SpaceTrendHero";
import { RecentTransactionsPanel } from "@/components/dashboard/widgets/RecentTransactionsPanel";
import { rehydrateContext, type SerializedConversionContext } from "@/lib/money/convert";
import { useDisplayCurrency } from "@/lib/currency-context";
import { getSpaceHeroDef } from "@/lib/space-hero";
import type { Snapshot, Transaction } from "@/types";
import type { DashboardSection, SpaceAccount, SpaceGoal } from "@/lib/space/dashboard-types";
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

// ─── URL-backed tab state (?tab=…&perspective=…) ────────────────────────────────
// Persist the active Space tab (and, on Perspectives, the selected Perspective)
// in the query string via window.history — no server re-run, no full reload.
// Every tab that `parseTabParam`/`URL_TAB_ALIAS` can restore is synced, so a
// refresh lands back where it left off — INCLUDING the modal-routed tabs
// (GOALS/DEBT/INVESTMENTS/RETIREMENT). Those render the DB section-template
// stack in a GlassModal — genuinely distinct content from the same-named
// Perspective compositions — and were previously dropped to OVERVIEW on refresh
// because the write below was gated off them (the read path already handled
// ?tab=debt etc. via URL_TAB_ALIAS).
// M2 canonical IA: PERSPECTIVES / DEBT / INVESTMENTS are no longer runtime
// destinations — perspectives are selected through OVERVIEW (?perspective=), so
// they are dropped from the synced set. Only the true rail tabs plus the two
// remaining legacy routed modals (GOALS / RETIREMENT) are mirrored, so refreshing
// inside one restores it. Debt/Investments canonicalize to OVERVIEW+perspective.
const URL_SYNCED_TABS = new Set([
  "OVERVIEW", "ACCOUNTS", "ACTIVITY", "TRANSACTIONS", "MEMBERS",
  "GOALS", "RETIREMENT",
]);
// URL "tab" value → activeTab. Rail tabs, the two remaining routed modals
// (goals/retirement), and legacy aliases (timeline/banking/credit) so existing
// deep links keep working. M2: the former perspective-routing tabs
// (perspectives/debt/credit/investments) canonicalize to OVERVIEW; when they
// encoded a specific lens it is forced via LEGACY_TAB_PERSPECTIVE below.
const URL_TAB_ALIAS: Record<string, string> = {
  overview: "OVERVIEW", accounts: "ACCOUNTS", banking: "ACCOUNTS",
  activity: "ACTIVITY", timeline: "ACTIVITY", transactions: "TRANSACTIONS", members: "MEMBERS",
  goals: "GOALS", retirement: "RETIREMENT",
  // Legacy perspective-routing tabs → Overview (the lens is engaged separately).
  perspectives: "OVERVIEW", debt: "OVERVIEW", credit: "OVERVIEW", investments: "OVERVIEW",
};

// M2: the legacy ?tab= → forced-lens mapping lives in the canonical URL module
// (lib/space/space-url.ts → legacyTabPerspective) so it has ONE authority and is
// regression-tested there.

/** URL "tab" param → activeTab. Present-but-invalid ⇒ OVERVIEW. Absent ⇒ null. */
function parseTabParam(raw: string | null): string | null {
  if (!raw) return null;
  return URL_TAB_ALIAS[raw.toLowerCase()] ?? "OVERVIEW";
}
/** cashFlow → "cash-flow"; wealth → "wealth". */
function perspectiveIdToSlug(id: string): string {
  return id.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
}
/** "cash-flow" → cashFlow. */
function slugToPerspectiveId(slug: string): string {
  return slug.toLowerCase().replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}
/** URL "perspective" param → id. Present-but-invalid ⇒ "wealth". Absent ⇒ null. */
function parsePerspectiveParam(raw: string | null): string | null {
  if (!raw) return null;
  const id = slugToPerspectiveId(raw);
  // M3-Reset — "wealth" is the underlying implementation of the Net Worth DEFAULT,
  // not a separate destination: canonicalize the legacy ?perspective=wealth alias
  // (and any unknown id) to the clean Net Worth default (null).
  if (id === "wealth") return null;
  return id in PERSPECTIVE_LIBRARY ? id : null;
}
function readUrlTabState(): { tab: string | null; perspective: string | null } {
  if (typeof window === "undefined") return { tab: null, perspective: null };
  const p = new URLSearchParams(window.location.search);
  const rawTab = p.get("tab");
  // M2: a legacy perspective-routing tab (debt/credit/investments) forces its
  // lens; otherwise the ?perspective= param drives it (null ⇒ Overview summary).
  const forced = legacyTabPerspective(rawTab);
  return {
    tab: parseTabParam(rawTab),
    perspective: forced ?? parsePerspectiveParam(p.get("perspective")),
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

// M2: DEBT / INVESTMENTS removed — they are no longer standalone tabs (now
// perspectives under Overview). GOALS / RETIREMENT remain only as legacy routed
// modals (isRoutedWorkspaceTab), and are filtered out of the default-tab pick.
const TAB_ORDER = ["OVERVIEW", "GOALS", "ACCOUNTS", "RETIREMENT", "ACTIVITY"];

// (TAB_LABELS removed with the in-space Settings tab — UX-CUST-1A correction.
//  Rail labels come from SPACE_TAB_LABELS in lib/space-nav.ts.)

// ─── Fixed Spaces rail (lib/space-nav.ts) ──────────────────────────────────────
//
// The legacy data-driven tabs above (GOALS/ACCOUNTS/DEBT/INVESTMENTS/
// RETIREMENT/ACTIVITY/SETTINGS) stay exactly as they are — this dashboard is
// still section-template-driven underneath. What changes is which of them
// get their own button on the new fixed top rail (OVERVIEW, ACCOUNTS, and
// SETTINGS keep direct buttons; everything else routes through Perspectives
// or the new Timeline tab) vs. which become reachable only as a Perspective
// card, so nothing real is lost, just re-entered through one calm front door.

// M3-Reset — the old per-tab RailTabIcon (icon-based rail) is deleted; the rail
// is now text-only, matching the prototype.

// SD-2: workspace routing identity (target tab, modal-routed set, modal chrome)
// is now owned by the canonical registry (lib/perspectives.ts) via
// getWorkspaceTargetTab / isRoutedWorkspaceTab / getWorkspaceModalMeta — the
// former host-side PERSPECTIVE_TARGET_TAB / PERSPECTIVE_ROUTED_TABS /
// PERSPECTIVE_MODAL_META maps were removed to keep one source of truth.

/** New tab ids that live entirely on the fixed rail (not section-driven).
 *  ACTIVITY is NOT here: it renders its recent_activity section inline through
 *  the normal section system (Unified Space Widget Layout — Activity slice). */
const NEW_SPACE_TABS = ["FINANCES", "TRANSACTIONS", "MEMBERS", "DOCUMENTS"];

// M3-Reset — the canonical Overview LENS set (prototype parity). "Net Worth" is
// the default lens and maps to the Overview summary (a null engaged perspective);
// the rest engage their extracted Workspaces. "Wealth" and "Goals" are
// deliberately absent from the core row (see the lensSelectorItems comment).
const NET_WORTH_LENS_ID = "networth";
const CORE_LENS_IDS = ["cashFlow", "liquidity", "investments", "debt"];

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

  const [sections,      setSections]      = useState<DashboardSection[]>([]);
  const [accounts,      setAccounts]      = useState<SpaceAccount[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [activeTab,     setActiveTab]     = useState("");
  const [showAddGoal,   setShowAddGoal]   = useState(false);
  const [showManage,    setShowManage]    = useState(false);
  const [confirmLeave,  setConfirmLeave]  = useState(false);
  const [leaveBusy,     setLeaveBusy]    = useState(false);
  // Track whether we've set the initial tab from real data
  const initialTabSet = useRef(false);

  // Header member count — read-only fetch against an existing endpoint.
  const [memberCount,    setMemberCount]    = useState<number | null>(null);

  // Perspective Engine results (commit 7) — keyed by lensId, fetched once
  // per Space from the batch route. null = not loaded / fetch failed; the
  // cards then render their static description (graceful fallback is the
  // widget's contract, not this host's job).
  const [lensResults, setLensResults] = useState<Record<string, LensResult> | null>(null);

  // ── Space Template Redesign state ─────────────────────────────────────────
  // SpaceSnapshot history for the trend hero (chartable categories only)
  // and the KD-15-filtered transaction list (flow categories' Overview
  // preview + every shared Space's Transactions tab doorway).
  const [snapshots,         setSnapshots]         = useState<Snapshot[] | null>(null);
  // Part-6 — a snapshot backfill is actively running for this Space (derived
  // server-side from PlaidItem.syncIncompleteAt). Drives the Wealth loading state.
  const [snapshotsBackfilling, setSnapshotsBackfilling] = useState(false);
  const [spaceTransactions, setSpaceTransactions] = useState<Transaction[] | null>(null);
  // MC1 P4 Slice 6 (F-6) — serialized conversion context from the same fetch;
  // undefined => the panel's context-less native sums (kill switch).
  const [spaceMoneyCtx, setSpaceMoneyCtx] = useState<SerializedConversionContext | undefined>(undefined);

  // ── MC1 QA Q4 — widget/planner conversion context ──────────────────────────
  // The dashboard layout mounts DisplayCurrencyProvider with this Space's
  // reportingCurrency (this component only renders as the active Space), so
  // the hook IS the Space's currency. The view-context route covers exactly
  // what the section widgets aggregate: account balances at the latest close.
  // Fetch failure ⇒ undefined ⇒ every consumer's kill switch (today's render).
  const displayCurrency = useDisplayCurrency();
  const [widgetMoneyCtx, setWidgetMoneyCtx] = useState<SerializedConversionContext | undefined>(undefined);
  useEffect(() => {
    let active = true;
    fetch(`/api/money/view-context?target=${encodeURIComponent(displayCurrency)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (active) setWidgetMoneyCtx(data?.moneyCtx ?? undefined); })
      .catch(() => { if (active) setWidgetMoneyCtx(undefined); });
    return () => { active = false; };
  }, [displayCurrency]);
  const widgetCtx = useMemo(
    () => (widgetMoneyCtx ? rehydrateContext(widgetMoneyCtx) : undefined),
    [widgetMoneyCtx],
  );

  // ── MC1 QA Q6 — live-update after a reporting-currency change ───────────────
  // The dashboard layout's DisplayCurrencyProvider and the /view-context fetch
  // above already follow `displayCurrency` (updated by the modal's
  // router.refresh()). But this host's OWN fetched data — snapshots (hero),
  // perspectives (converted lens metrics) and space transactions (F-6 context)
  // — keys on spaceId and would keep the old currency's values. A bump of this
  // nonce re-runs those three fetches; the tx fetch also needs its cached list
  // cleared so its "already loaded" guard lets it re-run. All server routes
  // read the Space's now-persisted reportingCurrency, so the refetch is
  // currency-correct regardless of refresh timing. All-USD: the event never
  // fires (currencyChanged is false), so nothing here ever runs.
  const [currencyNonce, setCurrencyNonce] = useState(0);
  // Part-2 fix — bumped by SPACE_DATA_REFRESHED_EVENT (a manual Plaid sync
  // finished) so the host's OWN client-fetched accounts/snapshots/transactions
  // re-run. router.refresh() alone can't do this: it merges the server RSC
  // payload but never re-runs these client effects, so one refresh otherwise
  // left the balances stale until a full reload.
  const [refreshNonce, setRefreshNonce] = useState(0);
  useEffect(() => {
    function onCurrencyChanged(e: Event) {
      const detail = (e as CustomEvent<{ spaceId?: string }>).detail;
      // Ignore currency changes for other Spaces (e.g. edited from the Spaces list).
      if (detail?.spaceId && detail.spaceId !== spaceId) return;
      setSpaceTransactions(null);       // clear the tx fetch's "already loaded" guard
      setSpaceMoneyCtx(undefined);
      setCurrencyNonce((n) => n + 1);
    }
    window.addEventListener(SPACE_CURRENCY_CHANGED_EVENT, onCurrencyChanged);
    return () => window.removeEventListener(SPACE_CURRENCY_CHANGED_EVENT, onCurrencyChanged);
  }, [spaceId]);

  // SD-7 — the Overview composition switcher state (composition / compositionItems /
  // activeComposition) is now OWNED by <OverviewWorkspace> (Overview-only state); the
  // host no longer holds it.

  const canManage = ["OWNER", "ADMIN"].includes(myRole);
  const canLeave  = !canManage; // MEMBER and VIEWER can leave

  // Data freshness — newest lastUpdated across this Space's shared accounts
  // (existing field, no new fetch). Surfaced in the header subtitle so no
  // balance is ever read without knowing how old it is (v2.5 honesty
  // slice). Client-only by construction: `accounts` starts [] and is
  // populated by a post-mount fetch, so formatRelativeTime (not SSR-safe,
  // see its doc comment in lib/format.ts) never runs during SSR.
  const newestAccountUpdate = accounts.length
    ? accounts.reduce((best, a) => (a.lastUpdated > best ? a.lastUpdated : best), accounts[0].lastUpdated)
    : null;

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
    [category, lensResults]
  );

  // ── Perspective Workspace (UX-PER-3) ───────────────────────────────────────
  // The Perspectives TAB is selector-driven (free-form tabs, not cards). The
  // selector lists the category's Perspectives (overview already excluded from
  // perspectiveItems); the selected one renders its workspace (widgets[] →
  // virtual sections → existing SectionCard) or an honest placeholder below.
  // Default = the first workspace-backed Perspective (Wealth) so the tab opens
  // on a real workspace. The Overview doorway keeps `perspectiveItems` intact.
  const [selectedPerspectiveId, setSelectedPerspectiveId] = useState<string | null>(null);
  // M2 canonical IA: null ⇒ the Overview summary (default landing); a lens id ⇒
  // that Perspective is engaged through the Overview experience. There is no
  // default-to-Wealth fallback — the summary is the Overview home, and a lens is
  // engaged explicitly (selector / doorway / ?perspective=).
  // M3-Reset — NET WORTH SUBSUMES WEALTH. The user-facing "Net Worth" lens IS the
  // canonical Wealth capability (WealthResult time-machine: asOf/compareTo,
  // evidence, completeness — all unchanged). So on Overview the RENDERED lens
  // defaults to "wealth" when no other lens is engaged; there is no separate
  // user-facing Wealth chip or destination. `selectedPerspectiveId` stays the
  // clean selection state (null = Net Worth default → clean URL); this derived id
  // is what actually renders + drives dataNeeds. Non-Overview tabs engage no lens.
  const wealthAvailable = useMemo(() => perspectiveItems.some((p) => p.id === "wealth"), [perspectiveItems]);
  const activePerspectiveId =
    activeTab === "OVERVIEW" ? (selectedPerspectiveId ?? (wealthAvailable ? "wealth" : null)) : null;
  const activePerspective = activePerspectiveId
    ? perspectiveItems.find((p) => p.id === activePerspectiveId) ?? null
    : null;
  // A Perspective is "engaged" (its Workspace occupies the Overview content slot)
  // whenever Overview resolves a lens — which, with the Net Worth default, is
  // always true for finance Spaces. Stock-category Spaces without a Wealth
  // perspective resolve null and keep the summary fallback.
  const perspectiveEngaged = activeTab === "OVERVIEW" && activePerspective != null;

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
  const lensSelectorItems = useMemo(
    () => [
      { id: NET_WORTH_LENS_ID, label: "Net Worth", hasWorkspace: true },
      ...CORE_LENS_IDS.map((id) => perspectiveItems.find((p) => p.id === id))
        .filter((p): p is (typeof perspectiveItems)[number] => Boolean(p))
        .map((p) => ({ id: p.id, label: p.label, hasWorkspace: !!(p.widgets && p.widgets.length > 0) })),
    ],
    [perspectiveItems],
  );
  // Net Worth ⇒ the summary (clear the engaged lens); any other id engages it.
  const selectLens = (id: string) => setSelectedPerspectiveId(id === NET_WORTH_LENS_ID ? null : id);
  // The selector's active id: the engaged lens, or "Net Worth" on the summary.
  // Highlight: the engaged non-default lens, else "Net Worth" (the default, whose
  // implementation is Wealth). Uses the SELECTION state, so the Net Worth chip is
  // active whenever no other lens is explicitly chosen.
  const activeLensId = selectedPerspectiveId ?? NET_WORTH_LENS_ID;

  // Overview Perspectives doorway — each workspace-backed card engages that
  // Perspective through the Overview experience (M2 canonical IA: stay on
  // OVERVIEW, set the lens; the URL sync then writes ?tab=overview&perspective=
  // <slug>). Perspectives without a workspace stay non-clickable "Soon"
  // placeholders. This is the summary-level entry into the lens selector.
  const perspectiveDoorwayItems = useMemo(
    () =>
      perspectiveItems.map((p) =>
        p.widgets && p.widgets.length > 0
          ? { ...p, onSelect: () => { setSelectedPerspectiveId(p.id); setActiveTab("OVERVIEW"); } }
          : { ...p, onSelect: undefined },
      ),
    [perspectiveItems],
  );

  // ── Canonical Space URL authority (SD-0A) ───────────────────────────────────
  // The ONE serializer + the ONE Back/Forward listener. tab/perspective and the
  // Wealth ?metric= both write through `spaceUrl.commit` (never window.history)
  // and re-hydrate through `spaceUrl.subscribe` (one shared popstate path). The
  // shell time hook (?asof/?compareto/?preset) uses the same authority. Every
  // commit preserves unrelated params, so no two writers can clobber each other.
  const spaceUrl = useSpaceUrl();

  // ── URL-backed tab state (write) ────────────────────────────────────────────
  // Mirror activeTab (+ engaged Perspective) into ?tab=…&perspective=… — no
  // server re-run, no reload. First sync canonicalizes with replace (so a legacy
  // ?tab=debt / ?tab=perspectives URL self-heals to the canonical form); later
  // user changes push so browser back/forward works. M2 canonical IA: the
  // perspective param is written only on OVERVIEW when a lens is engaged (else
  // deleted), so a bare tab yields a clean ?tab=<name> and an engaged lens yields
  // ?tab=overview&perspective=<slug>.
  const urlInitDone = useRef(false);
  useEffect(() => {
    if (!activeTab || !URL_SYNCED_TABS.has(activeTab)) return;
    const wrote = spaceUrl.commit(
      {
        tab: activeTab.toLowerCase(),
        perspective:
          // Uses the SELECTION state so the Net Worth default (null) yields a clean
          // ?tab=overview with no perspective param; only an explicitly-engaged
          // non-default lens writes ?perspective=. (Legacy ?perspective=wealth is
          // canonicalized away by parsePerspectiveParam → null.)
          activeTab === "OVERVIEW" && selectedPerspectiveId
            ? perspectiveIdToSlug(selectedPerspectiveId)
            : null,
      },
      { history: urlInitDone.current ? "push" : "replace" },
    );
    if (wrote) urlInitDone.current = true;
  }, [activeTab, selectedPerspectiveId, spaceUrl]);

  // ── URL-backed tab state (read: browser back/forward) ───────────────────────
  useEffect(
    () =>
      spaceUrl.subscribe(() => {
        const { tab, perspective } = readUrlTabState();
        // Set unconditionally: navigating BACK to a summary URL (no perspective)
        // must clear an engaged lens, not leave the previous one stuck.
        setSelectedPerspectiveId(perspective);
        if (tab) setActiveTab(tab);
      }),
    [spaceUrl],
  );

  // ── Account deep-link (Banking→Transactions retarget) ───────────────────────
  // `?account=<id>` seeds the Transactions tab's account filter — the target of
  // AccountsPerspective's "View transactions" row action, which navigates to
  // /dashboard?tab=transactions&account=<id>. Read once on mount through the
  // canonical authority (the same window.location channel readUrlTabState uses,
  // not the search-params hook, which would force a Suspense boundary; see the
  // space-shell-seams contract). The paired ?tab=transactions drives the tab via
  // the initial-tab logic below; this only carries the filter seed.
  const [initialAccountFilter, setInitialAccountFilter] = useState<string | null>(null);
  useEffect(() => {
    // One-time read of an external system (the URL) into state — SSR-safe (never
    // read during render), so the seed can't cause a hydration mismatch.
    const account = readSpaceParam(spaceUrl.getSearch(), "account");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (account) setInitialAccountFilter(account);
  }, [spaceUrl]);

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

  // Wealth chart metric (Net Worth default) — a wealth-only view toggle kept OUT
  // of the canonical time model. URL-synced with the same replaceState mechanism
  // the shell hook uses (?metric=), so a copied Perspectives URL restores it.
  // SSR-safe: default on server + first client render, hydrated post-mount.
  const WEALTH_METRICS: WealthMetricKey[] = ["netWorth", "totalAssets", "totalLiabilities", "liquidNetWorth"];
  const [chartMetric, setChartMetric] = useState<WealthMetricKey>("netWorth");
  useEffect(() => {
    // Read on mount and re-read on back/forward through the canonical authority —
    // a subscription to the URL as an external system (the ONE popstate path).
    const syncFromUrl = () => {
      const m = readSpaceParam(spaceUrl.getSearch(), "metric");
      setChartMetric(m && (WEALTH_METRICS as string[]).includes(m) ? (m as WealthMetricKey) : "netWorth");
    };
    syncFromUrl();
    return spaceUrl.subscribe(syncFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceUrl]);
  const handleMetricChange = (m: WealthMetricKey) => {
    setChartMetric(m);
    // metric is a wealth-only view toggle → always replace (never a history
    // entry), and netWorth (the default) clears the param.
    spaceUrl.commit({ metric: m === "netWorth" ? null : m }, { history: "replace" });
  };

  // Switching lens from within a workspace (e.g. Wealth's Liquid Net Worth →
  // Liquidity) changes only the active perspective — the shell's time context
  // (As Of / Compare To / preset) stays fixed (P1).
  const handleSwitchLens = (lensId: string) => setSelectedPerspectiveId(lensId);

  // ONE trust envelope for whichever workspace is engaged. Every financial
  // workspace (Wealth/Cash Flow/Liquidity/Investments/Debt) owns its data + FX +
  // as-of trust and emits its envelope up (onEnvelopeChange). Because exactly one
  // workspace is mounted at a time, a single state holds the active one — the
  // former five per-lens envelope states + their selection ternary collapse here.
  const [activeEnvelope, setActiveEnvelope] = useState<PerspectiveEnvelope>({});
  // SD-6C — the Cash Flow / Spending perspective + measure filter is now OWNED by
  // CashFlowWorkspace (workspace-local semantic slice), no longer host state. SD-6
  // gate — the completeness stamp AND its trust envelope are now workspace-owned too
  // (emitted up via cashFlowEnvelope, below); the host retains only the canonical-time
  // seam (cashFlowPeriod).
  // SD-3 — declarative lazy activation. The host no longer hardcodes which
  // perspective needs which resource (the former debtWorkspaceActive /
  // wealthWorkspaceActive / liquidityWorkspaceActive / goalsWorkspaceActive /
  // investmentsActive booleans). It asks the canonical registry what the OPEN
  // perspective declared (WORKSPACE_REGISTRY[id].dataNeeds) and derives stable
  // activation booleans from that. Behavior is identical: among perspectives, only
  // {wealth,debt} declare `snapshots`, only {cashFlow,liquidity} declare
  // `transactions`, only goals declares `goals`, only investments declares
  // `investmentsHistory` — so each boolean below reduces to exactly the per-id
  // check it replaced (ratcheted in lib/space/workspace-resources.test.ts).
  const openNeeds = openPerspectiveDataNeeds(activeTab, activePerspectiveId);
  const perspectiveNeedsSnapshots = openNeeds.has("snapshots");       // ⇔ wealth | debt
  const perspectiveNeedsTransactions = openNeeds.has("transactions"); // ⇔ cashFlow | liquidity
  const perspectiveNeedsGoals = openNeeds.has("goals");               // ⇔ goals
  const perspectiveNeedsInvestments = openNeeds.has("investmentsHistory"); // ⇔ investments
  // SD-6A — the Debt WORKSPACE owns its data consumption (the useDebtSpaceData
  // fetch moved inside <DebtWorkspace>); this gates its as-of lens fetch to when
  // the Debt perspective is open. compareTo is guarded to a strictly-earlier window.
  const debtActive = activeTab === "OVERVIEW" && activePerspectiveId === "debt";
  const debtCompareTo = compareTo && compareTo < asOf ? compareTo : null;
  // SD-4D+ — the Investments WORKSPACE now OWNS its data consumption (the
  // useInvestmentsSpaceData fetch moved inside <InvestmentsWorkspace>). The host keeps
  // NO Investments fetch; it only relays the workspace's trust envelope to the shell
  // Completeness chip via this state (the narrow bridge, §1). compareTo is guarded to a
  // valid strictly-earlier window (the route 400s on compareTo >= asOf).
  const investmentsCompareTo = compareTo && compareTo < asOf ? compareTo : null;
  // SD-6B — the Liquidity WORKSPACE now OWNS its data consumption (the
  // useLiquiditySpaceData fetch moved inside <LiquidityWorkspace>), activating the
  // historical engine end-to-end. Like Investments, the host keeps NO Liquidity fetch;
  // it only gates the workspace's historical read to when the perspective is open, and
  // relays the workspace's trust envelope (present-day OR as-of) to the shell chip.
  const liquidityActive = activeTab === "OVERVIEW" && activePerspectiveId === "liquidity";
  const liquidityCompareTo = compareTo && compareTo < asOf ? compareTo : null;
  const [spaceGoals, setSpaceGoals] = useState<SpaceGoal[] | null>(null);
  useEffect(() => {
    if (!perspectiveNeedsGoals || spaceGoals !== null) return;
    let active = true;
    fetch(`/api/spaces/${spaceId}/goals`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => { if (active) setSpaceGoals(Array.isArray(data) ? data : []); })
      .catch(() => { if (active) setSpaceGoals([]); });
    return () => { active = false; };
  }, [spaceId, perspectiveNeedsGoals, spaceGoals]);
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

  const loadSections = useCallback(async () => {
    const res = await fetch(`/api/spaces/${spaceId}/sections`);
    if (res.ok) {
      const secs: DashboardSection[] = await res.json();
      setSections(secs);
      return secs;
    }
    return sections;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  const loadAccounts = useCallback(async () => {
    const res = await fetch(`/api/spaces/${spaceId}/accounts`);
    if (res.ok) setAccounts(await res.json());
  }, [spaceId]);

  // Refetch accounts whenever another component (e.g. ManageSpaceModal Finances tab) signals a change
  useEffect(() => {
    function handleAccountsChanged() { loadAccounts(); }
    window.addEventListener(SPACE_ACCOUNTS_CHANGED_EVENT, handleAccountsChanged);
    return () => window.removeEventListener(SPACE_ACCOUNTS_CHANGED_EVENT, handleAccountsChanged);
  }, [loadAccounts]);

  // Part-2 fix — a manual Plaid sync finished (SPACE_DATA_REFRESHED_EVENT). Re-run
  // ALL of this host's self-fetched data so a single refresh reflects the true DB
  // state: accounts (balances), snapshots (net-worth hero) and transactions.
  // Nulling spaceTransactions releases the tx effect's "already loaded" guard;
  // bumping refreshNonce re-runs the snapshot + tx effects.
  useEffect(() => {
    function onDataRefreshed(e: Event) {
      const detail = (e as CustomEvent<{ spaceId?: string }>).detail;
      if (detail?.spaceId && detail.spaceId !== spaceId) return; // ignore other Spaces
      loadAccounts();
      setSpaceTransactions(null);
      setRefreshNonce((n) => n + 1);
    }
    window.addEventListener(SPACE_DATA_REFRESHED_EVENT, onDataRefreshed);
    return () => window.removeEventListener(SPACE_DATA_REFRESHED_EVENT, onDataRefreshed);
  }, [spaceId, loadAccounts]);

  // (Activity slice) — the host no longer pre-fetches the activity feed for an
  // Overview doorway/modal. The recent_activity SECTION (TimelineWidget) self-
  // fetches /api/spaces/[id]/activity and paginates, so Activity owns its data.

  // Perspective Engine results — one batch fetch against the membership-
  // gated route (mirrors the activity fetch above). Failure of any kind
  // (network, 403, malformed) resolves to null: lens-backed cards then
  // keep their static descriptions — the engine's rollback property, live.
  useEffect(() => {
    let active = true;
    // MC1 view-as: when an override target is set, ask the engine to recompute
    // the lenses in that currency (headline + verdict + sums together).
    const url = perspectiveTargetCurrency
      ? `/api/spaces/${spaceId}/perspectives?target=${encodeURIComponent(perspectiveTargetCurrency)}`
      : `/api/spaces/${spaceId}/perspectives`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!active) return;
        const results: LensResult[] = Array.isArray(data?.results) ? data.results : [];
        setLensResults(
          results.length
            ? Object.fromEntries(results.map((res) => [res.lensId, res]))
            : null,
        );
      })
      .catch(() => { if (active) setLensResults(null); });
    return () => { active = false; };
    // currencyNonce (Q6): refetch converted lens metrics after a currency change.
    // perspectiveTargetCurrency: refetch when the "view as" override changes.
  }, [spaceId, currencyNonce, perspectiveTargetCurrency]);

  // Header member count — same endpoint SpaceMembersWidget/ManageSpaceModal use.
  useEffect(() => {
    let active = true;
    fetch(`/api/spaces/${spaceId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (active) setMemberCount(data?.members?.length ?? null); })
      .catch(() => { if (active) setMemberCount(null); });
    return () => { active = false; };
  }, [spaceId]);

  // ── Trend hero data (Space Template Redesign) ─────────────────────────────
  // Only chartable categories (lib/space-hero.ts) fetch snapshot history.
  const heroDef = getSpaceHeroDef(category);
  useEffect(() => {
    // Unified Space Widget Layout (slice 1): Personal has no heroDef but its
    // Overview now includes the snapshot-backed `net_worth_chart` section, so
    // it still needs the snapshot fetch. Shared non-chartable categories skip
    // it as before. (Future: fetch when any snapshot-tier section is present.)
    if (!heroDef && spaceType !== "PERSONAL" && !perspectiveNeedsSnapshots) return;
    let active = true;
    fetch(`/api/spaces/${spaceId}/snapshots`)
      .then((r) => (r.ok ? r.json() : { snapshots: [] }))
      .then((data) => {
        if (!active) return;
        setSnapshots(data?.snapshots ?? []);
        setSnapshotsBackfilling(!!data?.backfillInProgress); // Part-6
      })
      .catch(() => { if (active) { setSnapshots([]); setSnapshotsBackfilling(false); } });
    return () => { active = false; };
  // currencyNonce (Q6): re-fetch the stamp-aware hero series after a currency change.
  // refreshNonce (Part-2): re-fetch after a manual Plaid sync so net worth updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, category, perspectiveNeedsSnapshots, currencyNonce, refreshNonce]);

  // Part-6 — while a backfill is running, re-fetch snapshots on an interval so
  // the Wealth loading state clears AUTOMATICALLY once it finishes (no manual
  // refresh). Bumping refreshNonce re-runs the snapshot fetch above, which
  // updates snapshotsBackfilling; when it flips false this effect stops. Same
  // syncIncompleteAt-derived signal Parts 4/5 use — not a fourth "done" detector.
  useEffect(() => {
    if (!snapshotsBackfilling) return;
    const iv = setInterval(() => setRefreshNonce((n) => n + 1), 12000);
    return () => clearInterval(iv);
  }, [snapshotsBackfilling]);

  // ── Space transactions (KD-15-filtered on the server) ────────────────────
  // Flow-identified templates show an Overview preview, so they fetch up
  // front; every other category fetches lazily when the Transactions tab
  // (doorway) is opened.
  const isFlowCategory = FLOW_TX_CATEGORIES.includes(category);
  useEffect(() => {
    // Fetch for flow categories, the Transactions doorway, OR the Cash Flow /
    // Liquidity Perspective workspaces (both need transaction history regardless
    // of category — Liquidity for its What Changed panel). Guarded by
    // spaceTransactions === null so it runs once.
    if (!isFlowCategory && activeTab !== "TRANSACTIONS" && !perspectiveNeedsTransactions) return;
    if (spaceTransactions !== null) return;
    let active = true;
    fetch(`/api/spaces/${spaceId}/transactions`)
      .then((r) => (r.ok ? r.json() : { transactions: [] }))
      .then((data) => {
        if (!active) return;
        setSpaceTransactions(data?.transactions ?? []);
        setSpaceMoneyCtx(data?.moneyCtx ?? undefined); // MC1 P4 Slice 6 (F-6)
      })
      .catch(() => { if (active) setSpaceTransactions([]); });
    return () => { active = false; };
  // currencyNonce (Q6): re-fetch tx rows + F-6 context after a currency change
  // (the handler also nulls spaceTransactions to release the guard above).
  // refreshNonce (Part-2): same, after a manual Plaid sync.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, isFlowCategory, activeTab, perspectiveNeedsTransactions, spaceTransactions === null, currencyNonce, refreshNonce]);

  useEffect(() => {
    Promise.all([
      fetch(`/api/spaces/${spaceId}/sections`).then((r) => r.ok ? r.json() : []),
      fetch(`/api/spaces/${spaceId}/accounts`).then((r)  => r.ok ? r.json() : []),
    ]).then(([secs, accs]: [DashboardSection[], SpaceAccount[]]) => {
      setSections(secs);
      setAccounts(accs);
      setLoading(false);

      // Set default tab from real section data — never default to SETTINGS
      if (!initialTabSet.current) {
        initialTabSet.current = true;
        // URL-backed tab state: the query string (?tab=…&perspective=…) is the
        // source of truth on load/refresh, then the caller's mapped legacy
        // initialTab, then the section-derived default below.
        const url = readUrlTabState();
        if (url.perspective) setSelectedPerspectiveId(url.perspective);
        const urlTab = url.tab ?? (initialTab || null);
        if (urlTab) {
          setActiveTab(urlTab);
          return;
        }
        const enabledTabs = new Set(secs.filter((s) => s.enabled).map((s) => s.tab));
        // Template polish: a Space with a trend hero has a real Overview
        // even when its signature modules live on other tabs (post-
        // curation Household/Business/Investment/Retirement) — open on it.
        if (getSpaceHeroDef(category)) {
          setActiveTab("OVERVIEW");
          return;
        }
        // Don't auto-default into ACTIVITY (prefer a content tab like
        // Overview/Accounts), and never open a Space directly into a
        // Perspective-routed tab: those render as GlassModals now, and landing
        // inside a modal is disorienting.
        const firstTab = TAB_ORDER.find(
          (t) => t !== "ACTIVITY" && !isRoutedWorkspaceTab(t) && enabledTabs.has(t)
        );
        if (firstTab) {
          setActiveTab(firstTab);
        } else if (enabledTabs.has("ACTIVITY")) {
          // ACTIVITY is a real rail tab now — land on it directly (no modal).
          setActiveTab("ACTIVITY");
        } else {
          // No section tabs (e.g. CUSTOM space with no sections) — land on
          // Overview. Settings is no longer a tab; manage via ManageSpaceModal.
          setActiveTab("OVERVIEW");
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

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

  if (loading) {
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
      heroSublineNote      = `at ${formatBalance(monthlyExp, displayCurrency)}/mo expenses`;
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
              const first = perspectiveItems.find((p) => p.widgets && p.widgets.length > 0)?.id;
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
    snapshotCurrency: snapshotCurrency ?? displayCurrency,
  };

  // Perspective workspace registry — replaces the former `activePerspectiveId ===
  // "..." ? <XWorkspace/> : ...` render ladder with a declarative id → renderer
  // map: adding a lens is an entry, not another branch. Each is a THUNK so only
  // the engaged workspace is evaluated. The map's KEYS are also the single source
  // of truth for "which lenses own a workspace" — reused for the trust-envelope
  // selection (an engaged workspace emits its own envelope into activeEnvelope;
  // anything else falls through to the canonical resolver).
  const workspaceRenderers: Record<string, () => React.ReactNode> = {
    wealth: () => (
      <WealthWorkspace
        snapshots={snapshots}
        snapshotCurrency={snapshotCurrency ?? displayCurrency}
        asOf={asOf}
        compareTo={compareTo}
        accounts={accounts}
        ctx={widgetCtx}
        metric={chartMetric}
        onMetricChange={handleMetricChange}
        onSwitchLens={handleSwitchLens}
        onEnvelopeChange={setActiveEnvelope}
        backfillInProgress={snapshotsBackfilling}
      />
    ),
    cashFlow: () => (
      <CashFlowWorkspace
        transactions={spaceTransactions}
        txCtx={txConversionCtx}
        accounts={accounts}
        period={cashFlowPeriod}
        onSelectPeriod={(p) => setCashFlowExplicitPeriod(p)}
        onEnvelopeChange={setActiveEnvelope}
      />
    ),
    liquidity: () => (
      <LiquidityWorkspace
        spaceId={spaceId}
        asOf={asOf}
        compareTo={liquidityCompareTo}
        today={shellToday}
        active={liquidityActive}
        accounts={accounts}
        ctx={widgetCtx}
        presentLens={lensResults?.["liquidity"] ?? null}
        transactions={spaceTransactions}
        txCtx={txConversionCtx}
        period={cashFlowPeriod}
        onOpenCashFlow={() => setSelectedPerspectiveId("cashFlow")}
        onEnvelopeChange={setActiveEnvelope}
      />
    ),
    investments: () => (
      <InvestmentsWorkspace
        spaceId={spaceId}
        asOf={asOf}
        compareTo={investmentsCompareTo}
        active={perspectiveNeedsInvestments}
        today={shellToday}
        accounts={accounts}
        ctx={widgetCtx}
        onEnvelopeChange={setActiveEnvelope}
      />
    ),
    debt: () => (
      <DebtWorkspace
        spaceId={spaceId}
        asOf={asOf}
        compareTo={debtCompareTo}
        today={shellToday}
        active={debtActive}
        accounts={accounts}
        ctx={widgetCtx}
        snapshots={snapshots}
        snapshotCurrency={snapshotCurrency ?? displayCurrency}
        ficoScore={ficoScore}
        ficoUpdatedAt={ficoUpdatedAt}
        presentLens={lensResults?.["debt"] ?? null}
        targetCurrency={perspectiveTargetCurrency}
        onEnvelopeChange={setActiveEnvelope}
      />
    ),
  };

  return (
    <SpaceShell
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
                loadSections();
                loadAccounts();
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
      subtitle={
        <>
          {catLabel} Space{memberCount !== null ? ` · ${memberCount} member${memberCount === 1 ? "" : "s"}` : ""}
          {newestAccountUpdate ? ` · Updated ${formatRelativeTime(newestAccountUpdate)}` : ""}
        </>
      }
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
              asOf={asOf}
              compareTo={compareTo}
              today={shellToday}
              onAsOfChange={handleAsOfChange}
              onCompareToChange={handleCompareToChange}
              onSwap={shell.actions.swap}
              envelope={
                // The engaged workspace emits its OWN trust envelope into
                // activeEnvelope; a lens without a workspace (e.g. goals) falls
                // through to the canonical resolver. The registry keys decide which.
                activePerspectiveId && workspaceRenderers[activePerspectiveId]
                  ? activeEnvelope
                  : resolvePerspectiveEnvelope({
                      perspectiveId: activePerspectiveId ?? "",
                      lensResult: activePerspectiveId ? lensResults?.[activePerspectiveId] ?? null : null,
                    })
              }
              presetValue={timePreset === "CUSTOM" ? null : timePreset}
              onSelectPreset={handleSelectSlice}
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
              {activePerspectiveId && workspaceRenderers[activePerspectiveId] ? (
                // Registry-driven: the engaged financial workspace (Wealth / Cash Flow
                // / Liquidity / Investments / Debt). Each owns its data + FX + as-of
                // trust and emits its envelope up; the host only supplies shared inputs
                // + shell time. See workspaceRenderers above.
                workspaceRenderers[activePerspectiveId]()
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
                    snapshotCurrency={snapshotCurrency ?? displayCurrency}
                    transactions={spaceTransactions}
                    txCtx={txConversionCtx}
                    period={cashFlowPeriod}
                    onSelectPeriod={(p) => setCashFlowExplicitPeriod(p)}
                    ficoScore={ficoScore}
                    ficoUpdatedAt={ficoUpdatedAt}
                    goals={spaceGoals}
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
            transactions={spaceTransactions}
            accounts={accounts}
            // MC1 view-as: summary totals convert through the override context when
            // active; the panel's rows stay native either way.
            moneyCtx={transactionsMoneyCtxOverride ?? spaceMoneyCtx}
            // Banking→Transactions retarget — deep-link account pre-filter.
            initialAccountFilter={initialAccountFilter}
          />
        )}

        {/* Members tab — real data. */}
        {activeTab === "MEMBERS" && (
          <MembersWorkspace spaceId={spaceId} onManage={() => setShowManage(true)} />
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
              heroCurrency={displayCurrency}
              snapshotsLoading={snapshots === null}
              sectionsForTab={sectionsForTab}
              card={sectionCardBundle}
              recentTransactionsDoorway={recentTransactionsDoorway}
              perspectivesDoorway={perspectivesDoorway}
            />
          </div>
        )}

        {/* Accounts — a section-backed tab (SD-7): the shared section stack + its
            empty state, no hero/doorways. */}
        {activeTab === "ACCOUNTS" && (
          <AccountsWorkspace
            sections={sectionsForTab}
            canManage={canManage}
            onManage={() => setShowManage(true)}
            card={sectionCardBundle}
          />
        )}

        {/* Activity — a first-class rail tab (SD-7): its recent_activity section
            through the shared section stack. Never reorders. */}
        {activeTab === "ACTIVITY" && (
          <ActivityWorkspace
            sections={sectionsForTab}
            canManage={canManage}
            onManage={() => setShowManage(true)}
            card={sectionCardBundle}
          />
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
  );
}
