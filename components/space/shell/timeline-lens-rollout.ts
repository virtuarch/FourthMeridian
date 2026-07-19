/**
 * components/space/shell/timeline-lens-rollout.ts
 *
 * TimelineLens rollout flag.
 *
 * The canonical time control is SHARED — PerspectiveShell renders one time block
 * for every Perspective (see docs/audits/TIMELINELENS_V4_MIGRATION_MATRIX.md §0).
 * So there is no such thing as "migrate Wealth's slicer"; without an opt-in,
 * swapping the control swaps it for all five financial Perspectives at once.
 *
 * This allowlist makes the rollout incremental: a Perspective in the set renders
 * TimelineLens, everything else renders the existing ShellContextRow +
 * CashFlowPeriodSelector pair, unchanged. Both paths drive the SAME canonical
 * reducer through the SAME shell actions — only the UI expressing the intent
 * differs.
 *
 * Rollback is deleting an entry from this set. The old controls are NOT removed
 * until the whole rollout is proven (Slice 5), so there is a clean path back for
 * as long as the canary is running.
 *
 * Growth order (one at a time, each behind its own parity gate):
 *   wealth → investments → cashFlow → debt, liquidity
 */

/**
 * Perspective ids that render the Atlas TimelineLens instead of the legacy pair.
 *
 * All five temporal Perspectives, each verified against the legacy control before
 * being added. No per-Perspective adapter exists or should: the differences
 * between these lenses live DOWNSTREAM of time selection (the historicalCompareTo
 * clamp in workspaceRenderers, the Cash-Flow explicit-period fork in
 * SpaceDashboard), never in how time is chosen. Selecting MTD is the same act
 * everywhere. One adapter, one authority, five consumers.
 */
export const TIMELINE_LENS_PERSPECTIVES: ReadonlySet<string> = new Set<string>([
  "wealth",
  "cashFlow",
  "investments",
  "debt",
  "liquidity",
]);

/** Whether the engaged Perspective renders TimelineLens. Null/unknown ⇒ legacy. */
export function usesTimelineLens(perspectiveId: string | null | undefined): boolean {
  return perspectiveId != null && TIMELINE_LENS_PERSPECTIVES.has(perspectiveId);
}
