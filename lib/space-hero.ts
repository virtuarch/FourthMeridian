/**
 * lib/space-hero.ts
 *
 * Space Template Redesign — per-category hero VOCABULARY ("One Space, One
 * Lede"), reduced in REVIEW-3 (slice F) to what the product still consumes.
 *
 * The SpaceTrendHero rendering path (title / value selector / framing /
 * chartType / scopeLabel and the hero chart itself) was retired with the
 * Overview summary canvas: the Overview slot now always renders the engaged
 * Perspective workspace, so no surface draws a category trend hero anymore.
 *
 * What SURVIVES is the category MEMBERSHIP — "is this a chartable category
 * with a snapshot-backed lede story?" — because two consumers still decide on
 * it:
 *   - lib/space/use-space-navigation.ts (applyInitialTab): a hero category
 *     defaults to the OVERVIEW tab rather than the first section-backed tab;
 *   - components/dashboard/SpaceDashboard.tsx (wantSnapshots): a hero category
 *     keeps eagerly fetching snapshots, preserving pre-REVIEW-3 activation.
 *
 * Categories NOT listed intentionally have no trend-hero identity
 * (PERSONAL renders through the shared shell; GOAL / TRIP / VEHICLE /
 * EQUIPMENT / CUSTOM / OTHER have no honest series for a lede).
 */

const SPACE_HERO_CATEGORIES = new Set<string>([
  "HOUSEHOLD",
  "FAMILY",
  "BUSINESS",
  "INVESTMENT",
  "RETIREMENT",
  "DEBT_PAYOFF",
  "EMERGENCY_FUND",
  "PROPERTY",
]);

/** True when the category has a trend-hero identity (drives the OVERVIEW
 *  default tab + eager snapshot activation); false when it intentionally
 *  has none. Replaces the former getSpaceHeroDef(category) — the rendering
 *  def it returned was retired in REVIEW-3 with the Overview canvas. */
export function hasSpaceTrendHero(category: string): boolean {
  return SPACE_HERO_CATEGORIES.has(category);
}
