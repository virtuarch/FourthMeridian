/**
 * lib/markets/markets-mode.ts
 *
 * The Markets workspace's VIEW vocabulary — pure, framework-free, URL-facing.
 * The sibling of lib/wealth/wealth-mode.ts (Net Worth's Total · Assets · Debt):
 * one list, one label map, one parse/serialize pair, read by the sidebar, the
 * in-content selector and the URL authority alike.
 *
 *   portfolio     — the securities you own (the default)
 *   research      — exploring securities and companies
 *   fundamentals  — the business and its financials
 *   technicals    — price behaviour
 *   watchlist     — securities you follow, owned or not
 *
 * SKELETON: these are destinations only. None of them computes, fetches or
 * stores anything yet — each renders an honest empty state.
 *
 * URL: `?view=` beside `?perspective=markets`. The default (Portfolio) writes
 * nothing, so the Markets lens URL IS Portfolio — the same convention as Net
 * Worth ≡ Total. An unknown value canonicalises to the default; nothing 404s.
 */

export type MarketsMode = "portfolio" | "research" | "fundamentals" | "technicals" | "watchlist";
export const MARKETS_MODES: readonly MarketsMode[] = ["portfolio", "research", "fundamentals", "technicals", "watchlist"];
export const DEFAULT_MARKETS_MODE: MarketsMode = "portfolio";

/** The Space URL param carrying the Markets view. */
export const MARKETS_VIEW_PARAM = "view";

/** User-facing labels — the Markets sub-destinations. */
export const MARKETS_MODE_LABELS: Record<MarketsMode, string> = {
  portfolio:    "Portfolio",
  research:     "Research",
  fundamentals: "Fundamentals",
  technicals:   "Technicals",
  watchlist:    "Watchlist",
};

/** `?view=` → mode. Absent or unknown ⇒ the default (Portfolio). */
export function parseMarketsMode(raw: string | null | undefined): MarketsMode {
  const k = (raw ?? "").toLowerCase();
  return (MARKETS_MODES as readonly string[]).includes(k) ? (k as MarketsMode) : DEFAULT_MARKETS_MODE;
}

/** mode → `?view=` value; the default writes nothing (a clean Markets URL). */
export function serializeMarketsMode(mode: MarketsMode): string | null {
  return mode === DEFAULT_MARKETS_MODE ? null : mode;
}
