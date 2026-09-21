"use client";

/**
 * lib/space/use-space-navigation.ts  (SD-8b)
 *
 * The Space's NAVIGATION state machine — extracted verbatim from SpaceDashboard.
 * It owns the URL ⇄ state synchronization and every piece of "where am I" state:
 *   - the active rail tab (activeTab) + one-shot initial-tab resolution,
 *   - the engaged analytical lens (selectedPerspectiveId → activePerspectiveId),
 *   - the Net Worth page subject + Assets slice (wealthMode ?metric=, assetsSlice
 *     ?slice=) — the evolved WealthMetric mechanism (OVERVIEW-CONSOLIDATION),
 *   - the Markets view (marketsMode ?view=) — the same mechanism, second workspace,
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
import { PERSPECTIVE_LIBRARY } from "@/lib/perspectives";
import { hasSpaceTrendHero } from "@/lib/space-hero";
import {
  legacyPerspectiveTarget, parseAssetsSlice, parseWealthMode,
  serializeAssetsSlice, serializeWealthMode,
  DEFAULT_ASSETS_SLICE, DEFAULT_WEALTH_MODE,
  WEALTH_MODES, WEALTH_MODE_LABELS,
  type AssetsSlice, type LegacyPerspectiveTarget, type WealthMode,
} from "@/lib/wealth/wealth-mode";
import {
  DEFAULT_MARKETS_MODE, MARKETS_MODES, MARKETS_MODE_LABELS, MARKETS_VIEW_PARAM,
  parseMarketsMode, serializeMarketsMode, type MarketsMode,
} from "@/lib/markets/markets-mode";
import type { DashboardSection } from "@/lib/space/dashboard-types";
import { MY_SPACE_HREF } from "@/lib/space-nav";

// ─── URL ⇄ tab vocabulary ───────────────────────────────────────────────────────
// M2 canonical IA: PERSPECTIVES / DEBT / INVESTMENTS are no longer runtime
// destinations — perspectives are selected through OVERVIEW (?perspective=), so
// only the true rail tabs are mirrored; Debt/Investments canonicalize to
// OVERVIEW+perspective. Every synced tab restores on refresh.
// W2 — GOALS / RETIREMENT are RETIRED (last routed-modal surfaces, deleted with
// the mechanism): they left this vocabulary, so a legacy ?tab=goals /
// ?tab=retirement deep link is now "present-but-invalid" and degrades to
// OVERVIEW via parseTabParam — never a crash, never an empty frame.
const URL_SYNCED_TABS = new Set([
  "OVERVIEW", "ACCOUNTS", "ACTIVITY", "TRANSACTIONS", "MEMBERS",
]);
// URL "tab" value → activeTab. Rail tabs plus legacy aliases
// (timeline/banking/credit) so existing deep links keep working.
const URL_TAB_ALIAS: Record<string, string> = {
  overview: "OVERVIEW", accounts: "ACCOUNTS", banking: "ACCOUNTS",
  activity: "ACTIVITY", timeline: "ACTIVITY", transactions: "TRANSACTIONS", members: "MEMBERS",
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
export function parsePerspectiveParam(raw: string | null): string | null {
  if (!raw) return null;
  const id = slugToPerspectiveId(raw);
  // M3-Reset — "wealth" is the underlying implementation of the Net Worth DEFAULT,
  // not a separate destination: canonicalize the legacy ?perspective=wealth alias
  // (and any unknown id) to the clean Net Worth default (null).
  if (id === "wealth") return null;
  // OVERVIEW-CONSOLIDATION — the retired peer lenses (liquidity / investments /
  // debt) are NOT engageable any more: they resolve to a Net Worth MODE (see
  // resolveUrlLens) and never to an engaged perspective.
  if (legacyPerspectiveTarget(id)) return null;
  return id in PERSPECTIVE_LIBRARY ? id : null;
}

/**
 * OVERVIEW-CONSOLIDATION — the ONE reading of the URL's lens vocabulary. A
 * legacy peer-lens link (`?perspective=liquidity|investments|debt`, or the older
 * `?tab=debt|credit|investments`) is a Net Worth mode + slice + one-shot section
 * focus; anything else is the engaged perspective (or the Net Worth default).
 * Pure over the raw params so it is unit-testable without a window.
 */
export function resolveUrlLens(params: { tab: string | null; perspective: string | null }): {
  perspective: string | null;
  legacy: LegacyPerspectiveTarget | null;
} {
  const forced = legacyTabPerspective(params.tab);
  const rawId = forced ?? (params.perspective ? slugToPerspectiveId(params.perspective) : null);
  const legacy = legacyPerspectiveTarget(rawId);
  if (legacy) return { perspective: null, legacy };
  return { perspective: forced ?? parsePerspectiveParam(params.perspective), legacy: null };
}

function readUrlTabState(): { tab: string | null; perspective: string | null; legacy: LegacyPerspectiveTarget | null } {
  if (typeof window === "undefined") return { tab: null, perspective: null, legacy: null };
  const p = new URLSearchParams(window.location.search);
  const rawTab = p.get("tab");
  const { perspective, legacy } = resolveUrlLens({ tab: rawTab, perspective: p.get("perspective") });
  return { tab: parseTabParam(rawTab), perspective, legacy };
}

// M2: DEBT / INVESTMENTS removed — perspectives under Overview.
// W2: GOALS / RETIREMENT removed — the product decision landed (retire), so the
// live-but-orphaned routed-modal surfaces and their deep links are gone; the
// order is exactly the section-derived default-tab candidates.
export const TAB_ORDER = ["OVERVIEW", "ACCOUNTS", "ACTIVITY"];
// OVERVIEW-CONSOLIDATION — the canonical Overview LENS set is now TWO lenses:
// "Net Worth" is the default (a null engaged perspective ⇒ the wealth workspace,
// read through its Total · Assets · Debt modes); "Cash Flow" is the one other
// engageable lens — it describes movement, not balance-sheet position.
// Liquidity / Investments / Debt live INSIDE Net Worth (Assets / Assets / Debt).
// MARKETS — the third workspace (skeleton): Portfolio · Research · Fundamentals ·
// Technicals · Watchlist, the Markets view (?view=).
export const NET_WORTH_LENS_ID = "networth";
export const MARKETS_LENS_ID = "markets";
export const CORE_LENS_IDS = ["cashFlow", MARKETS_LENS_ID];

/**
 * The canonical deep link for a lens — the SAME ?tab=/?perspective= the URL
 * writer below commits when that lens is selected, so a sidebar link opened in
 * a new tab lands exactly where an in-place click does. Net Worth is the clean
 * Overview URL (no perspective param).
 */
export function lensHref(id: string): string {
  const params = new URLSearchParams({ tab: "overview" });
  if (id !== NET_WORTH_LENS_ID) params.set("perspective", perspectiveIdToSlug(id));
  return `${MY_SPACE_HREF}?${params.toString()}`;
}

/**
 * The canonical deep link for a Net Worth MODE — the Net Worth lens URL plus
 * the SAME ?metric= the mode writer commits (serializeWealthMode: Total is the
 * default and writes nothing). Read back on load by the ?metric= sync below.
 */
export function wealthModeHref(mode: WealthMode): string {
  const metric = serializeWealthMode(mode);
  return metric ? `${lensHref(NET_WORTH_LENS_ID)}&metric=${encodeURIComponent(metric)}` : lensHref(NET_WORTH_LENS_ID);
}

/** The canonical deep link for a Markets VIEW — the Markets lens URL plus the
 *  ?view= the view writer commits (Portfolio, the default, writes nothing). */
export function marketsModeHref(mode: MarketsMode): string {
  const view = serializeMarketsMode(mode);
  return view ? `${lensHref(MARKETS_LENS_ID)}&${MARKETS_VIEW_PARAM}=${encodeURIComponent(view)}` : lensHref(MARKETS_LENS_ID);
}

/** One view inside a workspace, as navigation surfaces present it. */
export interface WorkspaceChild { id: string; label: string; href: string }

/**
 * The views a workspace carries as CHILDREN (the sidebar nests them under the
 * open workspace; below lg the workspace's own selector shows them). Built from
 * each workspace's own vocabulary module — never restated. A workspace without
 * views (Cash Flow) returns undefined.
 */
export function workspaceChildren(workspaceId: string): WorkspaceChild[] | undefined {
  if (workspaceId === NET_WORTH_LENS_ID)
    return WEALTH_MODES.map((m) => ({ id: m, label: WEALTH_MODE_LABELS[m], href: wealthModeHref(m) }));
  if (workspaceId === MARKETS_LENS_ID)
    return MARKETS_MODES.map((m) => ({ id: m, label: MARKETS_MODE_LABELS[m], href: marketsModeHref(m) }));
  return undefined;
}

/** The OPEN workspace's current view id — its own mode state — or null. */
export function openChildId(
  openWorkspace: string | null,
  modes: { wealthMode: WealthMode; marketsMode: MarketsMode },
): string | null {
  if (openWorkspace === NET_WORTH_LENS_ID) return modes.wealthMode;
  if (openWorkspace === MARKETS_LENS_ID) return modes.marketsMode;
  return null;
}

/**
 * Which workspace destination is OPEN — read from the RENDERED lens, not the
 * selection chip: on Overview, "wealth" is the Net Worth workspace (whatever its
 * Total · Assets · Debt mode — those are wealthMode, a separate axis) and any
 * other rendered lens is itself. Off Overview (Activity / Accounts / …) none is.
 */
export function openWorkspaceId(activeTab: string, activePerspectiveId: string | null): string | null {
  if (activeTab !== "OVERVIEW" || !activePerspectiveId) return null;
  return activePerspectiveId === "wealth" ? NET_WORTH_LENS_ID : activePerspectiveId;
}

export interface UseSpaceNavigationArgs {
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
  /** The Net Worth page subject (Total · Assets · Debt) — mirrored to ?metric=. */
  wealthMode: WealthMode;
  /** Set the subject + mirror to ?metric= (total clears the param). */
  setWealthMode: (m: WealthMode) => void;
  /** The Markets view (Portfolio · … · Watchlist) — mirrored to ?view=. */
  marketsMode: MarketsMode;
  /** Set the Markets view + mirror to ?view= (Portfolio clears the param). */
  setMarketsMode: (m: MarketsMode) => void;
  /** The Assets balance-history slice (All · Cash · Investments) — mirrored to ?slice=. */
  assetsSlice: AssetsSlice;
  /** Set the slice + mirror to ?slice= (all clears the param). */
  setAssetsSlice: (s: AssetsSlice) => void;
  /** One-shot Assets section focus from a legacy peer-lens deep link, else null. */
  wealthFocus: "cash" | "investments" | null;
  /** ?account= deep-link seed for the Transactions tab (read once on mount). */
  initialAccountFilter: string | null;
  /** Resolve + apply the initial tab ONCE, from the URL / sections. */
  applyInitialTab: (sections: DashboardSection[]) => void;
}

export function useSpaceNavigation({
  category,
  availablePerspectives,
}: UseSpaceNavigationArgs): SpaceNavigation {
  const [activeTab, setActiveTab] = useState("");
  const [selectedPerspectiveId, setSelectedPerspectiveId] = useState<string | null>(null);
  const [wealthMode, setWealthMode] = useState<WealthMode>(DEFAULT_WEALTH_MODE);
  const [marketsMode, setMarketsMode] = useState<MarketsMode>(DEFAULT_MARKETS_MODE);
  const [assetsSlice, setAssetsSlice] = useState<AssetsSlice>(DEFAULT_ASSETS_SLICE);
  const [wealthFocus, setWealthFocus] = useState<"cash" | "investments" | null>(null);
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
  //
  // REVIEW-3 (slice F) — the Overview slot ALWAYS renders the resolved lens's
  // workspace now (the summary canvas is retired), so the resolution must never
  // produce an id the category cannot render: a selected id outside this
  // category's lens list (only reachable via a hand-crafted ?perspective= URL —
  // parsePerspectiveParam validates against the whole library, not the
  // category) degrades to the wealth default instead of falling through to a
  // deleted summary branch. "overview" is likewise not an engageable lens.
  const wealthAvailable = availablePerspectives.includes("wealth");
  const selectedAvailableId =
    selectedPerspectiveId &&
    selectedPerspectiveId !== "overview" &&
    availablePerspectives.includes(selectedPerspectiveId)
      ? selectedPerspectiveId
      : null;
  const activePerspectiveId =
    activeTab === "OVERVIEW" ? (selectedAvailableId ?? (wealthAvailable ? "wealth" : null)) : null;
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

  // OVERVIEW-CONSOLIDATION — a legacy peer-lens link canonicalises to the mode
  // it now lives in. Applied from the URL read (mount + back/forward) below.
  const applyLegacy = useCallback((legacy: LegacyPerspectiveTarget | null) => {
    if (!legacy) return;
    setWealthMode(legacy.mode);
    setAssetsSlice(legacy.slice);
    setWealthFocus(legacy.focus);
    // Self-heal the URL: the mode + slice become the canonical params (the tab
    // write above drops the retired `perspective` value on the same tick).
    spaceUrl.commit(
      { metric: serializeWealthMode(legacy.mode), slice: serializeAssetsSlice(legacy.slice) },
      { history: "replace" },
    );
  }, [spaceUrl]);

  // ── URL-backed tab state (read: browser back/forward) ───────────────────────
  useEffect(
    () =>
      spaceUrl.subscribe(() => {
        const { tab, perspective, legacy } = readUrlTabState();
        // Set unconditionally: navigating BACK to a summary URL (no perspective)
        // must clear an engaged lens, not leave the previous one stuck.
        setSelectedPerspectiveId(perspective);
        applyLegacy(legacy);
        if (tab) setActiveTab(tab);
      }),
    [spaceUrl, applyLegacy],
  );

  // ── Account deep-link (Banking→Transactions retarget) — `?account=<id>` seeds
  //    the Transactions tab's account filter. Read once on mount (SSR-safe).
  useEffect(() => {
    const account = readSpaceParam(spaceUrl.getSearch(), "account");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (account) setInitialAccountFilter(account);
  }, [spaceUrl]);

  // ── Net Worth subject (?metric=) + Assets slice (?slice=) — wealth-only view
  //    toggles kept OUT of the canonical time model. Read on mount + re-read on
  //    back/forward. The param keeps its historical name: the four legacy values
  //    (netWorth / totalAssets / totalLiabilities / liquidNetWorth) canonicalise
  //    to a mode (parseWealthMode), so old links keep resolving. A legacy
  //    peer-lens link (?perspective=liquidity | …) outranks ?metric= — it names
  //    the subject the user asked for.
  useEffect(() => {
    const syncFromUrl = () => {
      const search = spaceUrl.getSearch();
      // The Markets view is independent of the Net Worth legacy aliases below.
      setMarketsMode(parseMarketsMode(readSpaceParam(search, MARKETS_VIEW_PARAM)));
      const legacy = readUrlTabState().legacy;
      if (legacy) { applyLegacy(legacy); return; }
      setWealthMode(parseWealthMode(readSpaceParam(search, "metric")));
      setAssetsSlice(parseAssetsSlice(readSpaceParam(search, "slice")));
    };
    syncFromUrl();
    return spaceUrl.subscribe(syncFromUrl);
  }, [spaceUrl, applyLegacy]);
  const handleModeChange = useCallback(
    (m: WealthMode) => {
      setWealthMode(m);
      setWealthFocus(null);
      // A view toggle → always replace (never a history entry); the default clears
      // the param. Leaving Assets also clears the slice (it has no meaning elsewhere).
      spaceUrl.commit(
        { metric: serializeWealthMode(m), ...(m !== "assets" ? { slice: null } : {}) },
        { history: "replace" },
      );
      if (m !== "assets") setAssetsSlice(DEFAULT_ASSETS_SLICE);
    },
    [spaceUrl],
  );
  // The Markets view — the same discipline as the Net Worth subject: a view
  // toggle REPLACES (never a history entry), and the default clears the param.
  const handleMarketsModeChange = useCallback(
    (m: MarketsMode) => {
      setMarketsMode(m);
      spaceUrl.commit({ [MARKETS_VIEW_PARAM]: serializeMarketsMode(m) }, { history: "replace" });
    },
    [spaceUrl],
  );
  const handleSliceChange = useCallback(
    (sl: AssetsSlice) => {
      setAssetsSlice(sl);
      setWealthFocus(null);
      spaceUrl.commit({ slice: serializeAssetsSlice(sl) }, { history: "replace" });
    },
    [spaceUrl],
  );

  // ── Initial-tab resolution (called ONCE by the host when data lands) ─────────
  // URL wins, then the section-derived default: a trend-hero Space opens on
  // Overview; else the first non-Activity enabled tab; else Activity if enabled;
  // else Overview (e.g. CUSTOM, no sections). (The legacy initialTab prop seam
  // was removed in REVIEW-3; the routed-tab exclusion retired with the routed
  // modals in W2 — TAB_ORDER carries no routed member anymore.)
  //
  // W2 NOTE — sections are still an input here, deliberately: SpaceDashboardSection
  // CONFIG survives (rows stay toggleable in Manage → Overview), and a section-less
  // Space (the empty-plan default for new Spaces) resolves to OVERVIEW through the
  // final fallback. Only the RENDER stack retired; tab defaulting still honors
  // whatever enabled rows an existing Space carries.
  const applyInitialTab = useCallback(
    (sections: DashboardSection[]) => {
      if (initialTabSet.current) return;
      initialTabSet.current = true;
      const url = readUrlTabState();
      const enabledTabs = new Set(sections.filter((s) => s.enabled).map((s) => s.tab));
      const nextTab =
        url.tab ??
        (hasSpaceTrendHero(category)
          ? "OVERVIEW"
          : TAB_ORDER.find((t) => t !== "ACTIVITY" && enabledTabs.has(t)) ??
            (enabledTabs.has("ACTIVITY") ? "ACTIVITY" : "OVERVIEW"));
      if (url.perspective) setSelectedPerspectiveId(url.perspective);
      applyLegacy(url.legacy);
      setActiveTab(nextTab);
    },
    [category, applyLegacy],
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
    wealthMode,
    setWealthMode: handleModeChange,
    marketsMode,
    setMarketsMode: handleMarketsModeChange,
    assetsSlice,
    setAssetsSlice: handleSliceChange,
    wealthFocus,
    initialAccountFilter,
    applyInitialTab,
  };
}
