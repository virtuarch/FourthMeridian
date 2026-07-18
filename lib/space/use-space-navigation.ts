"use client";

/**
 * lib/space/use-space-navigation.ts  (SD-8b)
 *
 * The Space's NAVIGATION state machine — extracted verbatim from SpaceDashboard.
 * It owns the URL ⇄ state synchronization and every piece of "where am I" state:
 *   - the active rail tab (activeTab) + one-shot initial-tab resolution,
 *   - the engaged analytical lens (selectedPerspectiveId → activePerspectiveId),
 *   - the Wealth chart metric (chartMetric, ?metric=),
 *   - the account deep-link seed (?account= → initialAccountFilter),
 *   - and the ONE URL writer + ONE popstate reader (via useSpaceUrl).
 *
 * It is deliberately BORING — a straight relocation of the host's URL/tab logic,
 * not a rewrite: same ?tab=/?perspective=/?metric= contracts, same aliases, same
 * canonicalization, same replace-then-push write discipline.
 *
 * DATA stays out. This hook runs BEFORE useSpaceData (it produces
 * activePerspectiveId, which the host folds into the data hook's activation
 * gates), so it must not depend on any fetched data. The one place navigation
 * needs data — resolving the section-derived default tab — is exposed as
 * `applyInitialTab(sections)`, which the host calls once the data lands. That
 * keeps the dependency one-way (nav → data) with no cycle.
 *
 * INTENTIONALLY LEFT BEHIND: the Cash-Flow period derivation. It is computed from
 * the shell TIME slice (usePerspectiveShellState → shell.derived.cashFlowPeriod),
 * which is derived from fetched snapshots — placing it here would create a
 * nav → data → shell → nav cycle. It stays host-side, coordinated with the shell.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useSpaceUrl } from "@/components/space/shell/useSpaceUrl";
import { readSpaceParam, legacyTabPerspective } from "@/lib/space/space-url";
import { PERSPECTIVE_LIBRARY, isRoutedWorkspaceTab } from "@/lib/perspectives";
import { getSpaceHeroDef } from "@/lib/space-hero";
import type { WealthMetricKey } from "@/components/space/widgets/wealth/WealthTrendChart";
import type { DashboardSection } from "@/lib/space/dashboard-types";

// ─── URL ⇄ tab vocabulary ───────────────────────────────────────────────────────
// M2 canonical IA: PERSPECTIVES / DEBT / INVESTMENTS are no longer runtime
// destinations — perspectives are selected through OVERVIEW (?perspective=), so
// only the true rail tabs plus the two remaining legacy routed modals
// (GOALS / RETIREMENT) are mirrored; Debt/Investments canonicalize to
// OVERVIEW+perspective. Every synced tab restores on refresh.
const URL_SYNCED_TABS = new Set([
  "OVERVIEW", "ACCOUNTS", "ACTIVITY", "TRANSACTIONS", "MEMBERS",
  "GOALS", "RETIREMENT",
]);
// URL "tab" value → activeTab. Rail tabs, the two remaining routed modals, and
// legacy aliases (timeline/banking/credit) so existing deep links keep working.
const URL_TAB_ALIAS: Record<string, string> = {
  overview: "OVERVIEW", accounts: "ACCOUNTS", banking: "ACCOUNTS",
  activity: "ACTIVITY", timeline: "ACTIVITY", transactions: "TRANSACTIONS", members: "MEMBERS",
  goals: "GOALS", retirement: "RETIREMENT",
  // Legacy perspective-routing tabs → Overview (the lens is engaged separately).
  perspectives: "OVERVIEW", debt: "OVERVIEW", credit: "OVERVIEW", investments: "OVERVIEW",
};

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
/** URL "perspective" param → id. Present-but-invalid ⇒ null. Absent ⇒ null. */
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
  // M2: a legacy perspective-routing tab (debt/credit/investments) forces its lens;
  // otherwise the ?perspective= param drives it (null ⇒ Overview summary).
  const forced = legacyTabPerspective(rawTab);
  return {
    tab: parseTabParam(rawTab),
    perspective: forced ?? parsePerspectiveParam(p.get("perspective")),
  };
}

// M2: DEBT / INVESTMENTS removed — perspectives under Overview. GOALS / RETIREMENT
// remain only as legacy routed modals, filtered out of the default-tab pick.
export const TAB_ORDER = ["OVERVIEW", "GOALS", "ACCOUNTS", "RETIREMENT", "ACTIVITY"];
/** New tab ids that live entirely on the fixed rail (not section-driven). */
export const NEW_SPACE_TABS = ["FINANCES", "TRANSACTIONS", "MEMBERS", "DOCUMENTS"];
// M3-Reset — the canonical Overview LENS set (prototype parity). "Net Worth" is the
// default lens (a null engaged perspective = the Overview summary); the rest engage
// their extracted Workspaces.
export const NET_WORTH_LENS_ID = "networth";
export const CORE_LENS_IDS = ["cashFlow", "liquidity", "investments", "debt"];

const WEALTH_METRICS: WealthMetricKey[] = ["netWorth", "totalAssets", "totalLiabilities", "liquidNetWorth"];

export interface UseSpaceNavigationArgs {
  /** Mapped legacy `?tab=` deep-link hint from the caller (unknown ⇒ section default). */
  initialTab?: string;
  /** Space category — drives the trend-hero default-tab shortcut. */
  category: string;
  /** Perspective ids available for this category (getPerspectivesForCategory ids). */
  availablePerspectives: string[];
}

export interface SpaceNavigation {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Clean lens SELECTION (null = the Net Worth default / Overview summary). */
  selectedPerspectiveId: string | null;
  setSelectedPerspectiveId: (id: string | null) => void;
  /** The RENDERED lens id: Net Worth default resolves to "wealth" on Overview. */
  activePerspectiveId: string | null;
  /** The lens-selector's active chip id (engaged lens, else Net Worth). */
  activeLensId: string;
  /** Select a lens from the selector: Net Worth ⇒ summary; any other id engages it. */
  selectLens: (id: string) => void;
  /** Engage a lens from within a workspace (keeps time context fixed). */
  switchLens: (id: string) => void;
  chartMetric: WealthMetricKey;
  /** Set the Wealth chart metric + mirror to ?metric= (netWorth clears the param). */
  setChartMetric: (m: WealthMetricKey) => void;
  /** ?account= deep-link seed for the Transactions tab (read once on mount). */
  initialAccountFilter: string | null;
  /** Resolve + apply the initial tab ONCE, from the URL / initialTab / sections. */
  applyInitialTab: (sections: DashboardSection[]) => void;
}

export function useSpaceNavigation({
  initialTab,
  category,
  availablePerspectives,
}: UseSpaceNavigationArgs): SpaceNavigation {
  const [activeTab, setActiveTab] = useState("");
  const [selectedPerspectiveId, setSelectedPerspectiveId] = useState<string | null>(null);
  const [chartMetric, setChartMetric] = useState<WealthMetricKey>("netWorth");
  const [initialAccountFilter, setInitialAccountFilter] = useState<string | null>(null);
  const initialTabSet = useRef(false);

  // ── Canonical Space URL authority (SD-0A) — the ONE serializer + Back/Forward
  //    listener. tab/perspective and ?metric= write through spaceUrl.commit and
  //    re-hydrate through spaceUrl.subscribe. Every commit preserves unrelated
  //    params, so no two writers clobber each other.
  const spaceUrl = useSpaceUrl();

  // M3-Reset — NET WORTH SUBSUMES WEALTH. On Overview the RENDERED lens defaults to
  // "wealth" when no other lens is engaged; selectedPerspectiveId stays the clean
  // selection state (null = Net Worth default → clean URL). Non-Overview tabs engage
  // no lens.
  const wealthAvailable = availablePerspectives.includes("wealth");
  const activePerspectiveId =
    activeTab === "OVERVIEW" ? (selectedPerspectiveId ?? (wealthAvailable ? "wealth" : null)) : null;
  // Net Worth ⇒ the summary (clear the engaged lens); any other id engages it.
  const selectLens = useCallback(
    (id: string) => setSelectedPerspectiveId(id === NET_WORTH_LENS_ID ? null : id),
    [],
  );
  const switchLens = useCallback((id: string) => setSelectedPerspectiveId(id), []);
  // Highlight the engaged non-default lens, else "Net Worth" (the default).
  const activeLensId = selectedPerspectiveId ?? NET_WORTH_LENS_ID;

  // ── URL-backed tab state (write) — mirror activeTab (+ engaged lens) into
  //    ?tab=…&perspective=…. First sync canonicalizes with replace (a legacy URL
  //    self-heals); later user changes push so back/forward works. The perspective
  //    param is written only on OVERVIEW when a non-default lens is engaged.
  const urlInitDone = useRef(false);
  useEffect(() => {
    if (!activeTab || !URL_SYNCED_TABS.has(activeTab)) return;
    const wrote = spaceUrl.commit(
      {
        tab: activeTab.toLowerCase(),
        perspective:
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

  // ── Account deep-link (Banking→Transactions retarget) — `?account=<id>` seeds
  //    the Transactions tab's account filter. Read once on mount (SSR-safe).
  useEffect(() => {
    const account = readSpaceParam(spaceUrl.getSearch(), "account");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (account) setInitialAccountFilter(account);
  }, [spaceUrl]);

  // ── Wealth chart metric (?metric=) — a wealth-only view toggle kept OUT of the
  //    canonical time model. Read on mount + re-read on back/forward.
  useEffect(() => {
    const syncFromUrl = () => {
      const m = readSpaceParam(spaceUrl.getSearch(), "metric");
      setChartMetric(m && (WEALTH_METRICS as string[]).includes(m) ? (m as WealthMetricKey) : "netWorth");
    };
    syncFromUrl();
    return spaceUrl.subscribe(syncFromUrl);
  }, [spaceUrl]);
  const handleMetricChange = useCallback(
    (m: WealthMetricKey) => {
      setChartMetric(m);
      // metric is a wealth-only view toggle → always replace (never a history
      // entry); netWorth (the default) clears the param.
      spaceUrl.commit({ metric: m === "netWorth" ? null : m }, { history: "replace" });
    },
    [spaceUrl],
  );

  // ── Initial-tab resolution (called ONCE by the host when data lands) ─────────
  // URL wins, then the mapped legacy initialTab, then the section-derived default:
  // a trend-hero Space opens on Overview; else the first non-Activity, non-routed
  // enabled tab; else Activity if enabled; else Overview (e.g. CUSTOM, no sections).
  const applyInitialTab = useCallback(
    (sections: DashboardSection[]) => {
      if (initialTabSet.current) return;
      initialTabSet.current = true;
      const url = readUrlTabState();
      const enabledTabs = new Set(sections.filter((s) => s.enabled).map((s) => s.tab));
      const nextTab =
        url.tab ??
        (initialTab || null) ??
        (getSpaceHeroDef(category)
          ? "OVERVIEW"
          : TAB_ORDER.find((t) => t !== "ACTIVITY" && !isRoutedWorkspaceTab(t) && enabledTabs.has(t)) ??
            (enabledTabs.has("ACTIVITY") ? "ACTIVITY" : "OVERVIEW"));
      if (url.perspective) setSelectedPerspectiveId(url.perspective);
      setActiveTab(nextTab);
    },
    [category, initialTab],
  );

  return {
    activeTab,
    setActiveTab,
    selectedPerspectiveId,
    setSelectedPerspectiveId,
    activePerspectiveId,
    activeLensId,
    selectLens,
    switchLens,
    chartMetric,
    setChartMetric: handleMetricChange,
    initialAccountFilter,
    applyInitialTab,
  };
}
