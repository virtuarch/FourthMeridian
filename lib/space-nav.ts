/**
 * lib/space-nav.ts
 *
 * Canonical top-level tab rail shared by every individual Space dashboard
 * (Personal via DashboardClient.tsx, every other category via
 * SpaceDashboard.tsx). Per the Fourth Meridian Spaces redesign: every
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
  | "TIMELINE"
  | "FINANCES"
  | "ACCOUNTS"
  | "TRANSACTIONS"
  | "MEMBERS"
  | "DOCUMENTS"
  | "SETTINGS";

export const SPACE_TAB_ORDER: SpaceTabId[] = [
  "OVERVIEW",
  "PERSPECTIVES",
  "TIMELINE",
  "FINANCES",
  "ACCOUNTS",
  "TRANSACTIONS",
  "MEMBERS",
  "DOCUMENTS",
  "SETTINGS",
];

export const SPACE_TAB_LABELS: Record<SpaceTabId, string> = {
  OVERVIEW:     "Overview",
  PERSPECTIVES: "Perspectives",
  TIMELINE:     "Timeline",
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
 * of this pass). Hosts render these with a calm "coming soon" placeholder
 * instead of pretending there's depth that isn't built yet.
 *
 * Note: TRANSACTIONS is real in the Personal Space (DashboardClient renders
 * SpaceTransactionsPanel). SpaceDashboard still shows a placeholder for
 * Transactions on shared/non-personal Spaces — that's a separate workstream.
 *
 * FUTURE ENHANCEMENT: once Finances and Documents features exist, and
 * Transactions is wired for shared Spaces, remove entries here.
 */
export const PLACEHOLDER_SPACE_TABS: SpaceTabId[] = ["FINANCES", "DOCUMENTS"];

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
