/**
 * lib/space-nav.ts
 *
 * Canonical top-level tab rail shared by every individual Space dashboard
 * (Personal via DashboardClient.tsx, every other category via
 * WorkspaceDashboard.tsx). Per the Fourth Meridian Spaces redesign: every
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
 * WorkspaceDashboard.tsx) so this stays a plain, framework-agnostic module
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
 * the product (no API, no UI, in either dashboard implementation as of
 * this pass). Hosts render these with a calm "coming soon" placeholder
 * instead of pretending there's depth that isn't built yet.
 *
 * FUTURE ENHANCEMENT: once a Transactions aggregation view and a Documents
 * feature exist, remove the corresponding entry here — everything else
 * (tab position, styling) is already in place and needs no rework.
 */
export const PLACEHOLDER_SPACE_TABS: SpaceTabId[] = ["FINANCES", "TRANSACTIONS", "DOCUMENTS"];
