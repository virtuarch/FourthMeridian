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

// REVIEW-3 (slice F) — dead nav ids deleted:
//   - "PERSPECTIVES": no longer a rail destination since M2 (perspectives are
//     selected through Overview via ?perspective=); the legacy ?tab=perspectives
//     deep link canonicalizes to Overview in the host URL layer (a string
//     alias, not a SpaceTabId), so the id + label carried no consumer.
//   - "FINANCES" / "DOCUMENTS": permanent placeholders — no rail control since
//     the v2.5 honesty slice, no body branch, no API. The PLACEHOLDER_SPACE_TABS
//     / SHARED_ONLY_PLACEHOLDER_TABS gating machinery (isRailTabVisible's host
//     parameter was inert — the shared-only list was permanently empty) went
//     with them: every tab in SPACE_TAB_ORDER is rail-real now.
//   - "SETTINGS": not an in-space tab since UX-CUST-1A (Manage modal owns
//     settings); the host filtered it out of the rail unconditionally.
// The Prisma SpaceDashboardTab enum (lib/space-presets mirror) keeps every
// member — DB enum members are never dropped in this program.
export type SpaceTabId =
  | "OVERVIEW"
  | "ACTIVITY"
  | "ACCOUNTS"
  | "TRANSACTIONS"
  | "MEMBERS";

export const SPACE_TAB_ORDER: SpaceTabId[] = [
  "OVERVIEW",
  "ACTIVITY",
  "ACCOUNTS",
  "TRANSACTIONS",
  "MEMBERS",
];

// Unified Space Widget Layout — "ACTIVITY" is a first-class rail tab whose id
// matches the SpaceDashboardTab.ACTIVITY section enum. It replaces the former
// rail-only "TIMELINE" concept (which was a modal launched from an Overview
// doorway).
export const SPACE_TAB_LABELS: Record<SpaceTabId, string> = {
  OVERVIEW:     "Overview",
  ACTIVITY:     "Activity",
  ACCOUNTS:     "Accounts",
  TRANSACTIONS: "Transactions",
  MEMBERS:      "Members",
};

/**
 * The rail: SPACE_TAB_ORDER, order preserved. Every id is rail-real (the
 * placeholder gating retired with its permanently-empty lists in REVIEW-3).
 * Hosts may apply further presentation filters on top but must never re-add
 * a tab outside this list, and must never reorder.
 */
export function railVisibleTabs(): SpaceTabId[] {
  return [...SPACE_TAB_ORDER];
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
