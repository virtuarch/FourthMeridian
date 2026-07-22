/**
 * lib/space-nav.ts
 *
 * Canonical top-level tab rail shared by every individual Space dashboard
 * (every Space — Personal included — renders via SpaceDashboard.tsx). Per
 * the Fourth Meridian Spaces redesign: every
 * Space — regardless of type — is built from the same modular skeleton.
 * Different Space types enable/disable modules; they do not get a
 * different tab order.
 *
 * SPACE_TAB_ORDER is intentionally fixed. A host dashboard may choose not
 * to render a given tab's button (e.g. SETTINGS only for managers), but it
 * must never reorder the ones it does render — this is what lets users
 * build muscle memory for "Accounts is always third" across 50+ Spaces of
 * different types.
 *
 * This file only owns ORDER + COPY. Icon components stay in the consuming
 * dashboard files (same pattern as the existing TAB_ICONS record in
 * SpaceDashboard.tsx) so this stays a plain, framework-agnostic module
 * — consistent with how lib/widget-registry.ts stores icon names as
 * strings rather than importing lucide-react directly.
 */

export type SpaceTabId =
  | "OVERVIEW"
  | "PERSPECTIVES"
  | "ACTIVITY"
  | "FINANCES"
  | "ACCOUNTS"
  | "TRANSACTIONS"
  | "MEMBERS"
  | "DOCUMENTS"
  | "SETTINGS";

// M2 canonical IA: "PERSPECTIVES" is NO LONGER a rail destination. Perspectives
// are specialized Workspaces selected through the Overview experience
// (?perspective=<id>), so the rail never shows a Perspectives button. The id is
// kept in SpaceTabId + SPACE_TAB_LABELS for back-compat (legacy
// ?tab=perspectives links canonicalize to Overview in the host URL layer), but
// it is deliberately absent from SPACE_TAB_ORDER so railVisibleTabs() can never
// re-surface it. Fixed ORDER remains law for every tab that DOES appear.
export const SPACE_TAB_ORDER: SpaceTabId[] = [
  "OVERVIEW",
  "ACTIVITY",
  "FINANCES",
  "ACCOUNTS",
  "TRANSACTIONS",
  "MEMBERS",
  "DOCUMENTS",
  "SETTINGS",
];

// Unified Space Widget Layout — "ACTIVITY" is a first-class rail tab whose id
// matches the SpaceDashboardTab.ACTIVITY section enum, so the recent_activity
// section renders inline through the normal section system (like OVERVIEW /
// ACCOUNTS). It replaces the former rail-only "TIMELINE" concept (which was a
// modal launched from an Overview doorway).
export const SPACE_TAB_LABELS: Record<SpaceTabId, string> = {
  OVERVIEW:     "Overview",
  PERSPECTIVES: "Perspectives",
  ACTIVITY:     "Activity",
  FINANCES:     "Finances",
  ACCOUNTS:     "Accounts",
  TRANSACTIONS: "Transactions",
  MEMBERS:      "Members",
  DOCUMENTS:    "Documents",
  SETTINGS:     "Settings",
};

/**
 * Tabs that don't yet have a real, working feature behind them anywhere in
 * the product (no API, no UI, in the shared-space dashboard implementation as
 * of this pass).
 *
 * v2.5 honesty slice: these tabs no longer get a rail control at all —
 * "rail earns tabs by having real content" (see
 * docs/investigations/SPACE_DASHBOARD_FUTURE_INVESTIGATION.md §2.9). The
 * tab *ids* stay valid (types, deep-link handling, and internal gating
 * still reference them); only their rail presence is gated, via
 * isRailTabVisible/railVisibleTabs below. Fixed ORDER remains law for
 * every tab that does appear.
 *
 * Note: TRANSACTIONS is real for the personal host (SpaceDashboard renders
 * SpaceTransactionsPanel on the personal shell) — the per-host gating below
 * is kept ready for any future tab that ships personal-first.
 *
 * FUTURE ENHANCEMENT: once Finances and Documents features exist, and
 * Transactions is wired for shared Spaces, remove entries here so the tabs
 * re-earn their rail slots.
 */
export const PLACEHOLDER_SPACE_TABS: SpaceTabId[] = ["FINANCES", "DOCUMENTS"];

/** Which host is asking — the personal shell or a shared Space. Both render
 *  through SpaceDashboard.tsx; the host only tunes rail/gating. */
export type SpaceDashboardHost = "personal" | "shared";

/** Tabs that are placeholders only on shared/non-personal Spaces.
 *  TRANSACTIONS re-earned its slot in the Space Template Redesign:
 *  SpaceDashboard now renders a real, KD-15-filtered SpaceTransactionsPanel
 *  (GET /api/spaces/[id]/transactions) as the doorway for every shared
 *  Space. Currently empty — kept so the gate (and its test) stand ready
 *  for any future tab that ships personal-first again. */
export const SHARED_ONLY_PLACEHOLDER_TABS: SpaceTabId[] = [];

/**
 * Presentation-level gate: should this tab get a visible rail control on
 * the given host? False for tabs whose only content would be a
 * SpaceComingSoonPanel. This does NOT invalidate the tab id itself —
 * routes, types, and internal activeTab values are untouched.
 */
export function isRailTabVisible(id: SpaceTabId, host: SpaceDashboardHost): boolean {
  if (PLACEHOLDER_SPACE_TABS.includes(id)) return false;
  if (host === "shared" && SHARED_ONLY_PLACEHOLDER_TABS.includes(id)) return false;
  return true;
}

/**
 * The rail for a host: SPACE_TAB_ORDER minus placeholder tabs, order
 * preserved. Hosts may apply further presentation filters on top (e.g.
 * SETTINGS only for managers) but must never re-add a tab this function
 * excludes, and must never reorder.
 */
export function railVisibleTabs(host: SpaceDashboardHost): SpaceTabId[] {
  return SPACE_TAB_ORDER.filter((id) => isRailTabVisible(id, host));
}

/**
 * The five top-level application destinations — the ONE navigation model, shared
 * by the desktop ContextualNavbar (global mode) and the mobile BottomNav, so the
 * two are responsive presentations of one model rather than separate systems.
 * This is the prototype's global nav (DS-6): Spaces · Brief · AI · Connections ·
 * Settings, in that fixed order.
 *
 * Data only (id/label/href/live) — icon components stay in the consuming
 * components (same convention as SPACE_TAB_LABELS above and lib/widget-registry),
 * so this stays a framework-agnostic module. Every destination is a real,
 * shipping production route, so all five are `live` (the prototype's "Settings ·
 * soon" stub does not apply here).
 */
export type GlobalDestId = "spaces" | "brief" | "ai" | "connections" | "settings";

export interface GlobalDest {
  id:    GlobalDestId;
  label: string;
  href:  string;
  live:  boolean;
}

export const GLOBAL_NAV: GlobalDest[] = [
  { id: "spaces",      label: "Spaces",      href: "/dashboard/spaces",      live: true },
  { id: "brief",       label: "Brief",       href: "/dashboard/brief",       live: true },
  { id: "ai",          label: "AI",          href: "/dashboard/analyze",     live: true },
  { id: "connections", label: "Connections", href: "/dashboard/connections", live: true },
  { id: "settings",    label: "Settings",    href: "/dashboard/settings",    live: true },
];

/**
 * Is a global destination active for the given pathname? "Spaces" owns both the
 * Spaces launcher AND an individual Space dashboard (/dashboard) — you reach a
 * Space by picking one under Spaces, so /dashboard reads as part of that section
 * (this mirrors the retired BottomNav's rule). The others match by prefix.
 */
export function isGlobalDestActive(id: GlobalDestId, pathname: string): boolean {
  if (id === "spaces") {
    return pathname.startsWith("/dashboard/spaces") || pathname === "/dashboard";
  }
  const dest = GLOBAL_NAV.find((d) => d.id === id);
  return dest ? pathname.startsWith(dest.href) : false;
}

/**
 * Cross-component CustomEvent names (window-level pub/sub between
 * Sidebar / CreateSpaceModal / ManageSpaceModal / SpacesClient /
 * SpaceDashboard / DashboardChrome — no shared parent state, so these
 * events are how one component tells the others "a Space changed").
 *
 * Centralized here instead of inline string literals at each dispatch/
 * listen call site, so a dispatcher and a listener can never silently
 * drift out of sync — the same class of bug Phase 1 had to hand-fix for
 * `WorkspaceAccountShare`'s Prisma field name; this is the UI-layer
 * equivalent guard.
 */
export const SPACE_LIST_CHANGED_EVENT     = "space-list-changed";
export const SPACE_INVITES_CHANGED_EVENT  = "space-invites-changed";
export const SPACE_ACCOUNTS_CHANGED_EVENT = "space-accounts-changed";
export const SPACE_GOALS_CHANGED_EVENT    = "space-goals-changed";
export const OPEN_CREATE_SPACE_EVENT      = "open-create-space";
// MC1 QA Q6 — a Space's reporting currency changed. router.refresh() re-runs
// the server tree (layout DisplayCurrencyProvider + card props), but a client
// host's own fetched data (SpaceDashboard's snapshots/perspectives/tx) keys on
// spaceId and won't re-run; this event tells such hosts to refetch the
// currency-sensitive data so the whole view updates without a manual reload.
// CustomEvent detail: { spaceId, currency } — hosts ignore other Spaces' ids.
export const SPACE_CURRENCY_CHANGED_EVENT = "space-currency-changed";
// Account balances/transactions/snapshots were refreshed (a manual Plaid sync
// completed). router.refresh() re-renders the server tree, but SpaceDashboard
// displays its OWN client-fetched accounts/snapshots/transactions (keyed on
// spaceId), which router.refresh() does NOT re-run — so a single refresh left
// the balances stale until a full reload. This event tells the active host to
// re-fetch that data so one refresh reflects the true DB state.
// CustomEvent detail: { spaceId? } — when present, hosts ignore other Spaces.
export const SPACE_DATA_REFRESHED_EVENT   = "space-data-refreshed";
