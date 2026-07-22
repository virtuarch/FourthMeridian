/**
 * components/atlas/TimelineLens/types.ts
 *
 * The TimelineLens contract.
 *
 * TimelineLens is a PRESENTATION layer and an INTENT emitter. It is not a time
 * authority: it cannot construct `{preset, asOf, compareTo}` because those
 * fields do not exist in its vocabulary, and it performs no date arithmetic.
 *
 *   TimelineIntent → Perspective adapter → existing shell reducer → canonical time
 *
 * Everything the component displays is DERIVED by the parent from canonical
 * state on every render. It holds no draft. That is deliberate: a stored
 * selection would go stale whenever canonical time changes from a source the
 * component cannot see (URL back-navigation, async coverage arrival, a deep
 * link), and there would be no way for it to find out.
 *
 * Import boundary is enforced by TimelineLens.test.ts, co-located because the
 * Atlas guards are __dirname-scoped and would not otherwise cover this folder.
 */

/**
 * One user action. Each variant maps 1:1 onto an existing sanctioned
 * `ShellTimeAction`, so the adapter is a switch — there is no compound
 * resolution to get wrong and no new reducer action to add.
 */
export type TimelineIntent =
  /** A named period was chosen. `intent` is opaque here; the adapter reads it. */
  | { type: "period"; optionId: string; intent: string }
  /** A boundary date was edited. Raw user input — not a validated canonical date. */
  | { type: "customBoundary"; boundary: "asOf" | "compareTo"; value: string }
  /** Exchange the two boundaries. */
  | { type: "swap" }
  /** Drop the comparison boundary entirely. */
  | { type: "clearComparison" }
  /**
   * Return the anchor to the present.
   *
   * NOT a period — "today" is not a window, it is where you are standing. It is
   * an intent because the component must not decide what "the present" means;
   * the adapter resolves it to the canonical today. Maps to the existing
   * setAsOf action, so no new authority is introduced.
   */
  | { type: "returnToPresent" };

export interface TimelinePeriodOption {
  id: string;
  /** Editorial label: "Last 90 days", not "3M". */
  label: string;
  /** Quiet clarifier: "Rolling quarter". */
  supportingLabel?: string;
  group: "toDate" | "rolling";
  /**
   * Opaque to TimelineLens. The adapter alone knows this is a TimePreset.
   * Typed as `string` so Atlas never imports the domain union.
   */
  intent: string;
}

export interface TimelineLensSummary {
  /**
   * Names the vantage point: "As of today" / "As of Mar 31, 2026".
   *
   * ALWAYS present. asOf is meaningful at every moment — its present-day value
   * is not "unset", it is "anchored to now". A bare range ("Mar 1 → Mar 31")
   * shows the anchor without saying which end it is; this says it.
   */
  anchorLabel: string;
  /**
   * False when the anchor sits in the past. Drives the return-to-present
   * affordance. The parent decides this — the component owns no notion of today.
   */
  anchoredToPresent: boolean;
  /** "Month to date" / "Custom range" — the WINDOW, measured back from the anchor. */
  periodLabel: string;
  /** "Jul 19, 2025 → Jul 19, 2026" */
  rangeLabel: string;
  /** Honest note about the opening boundary, or null when there is nothing to say. */
  comparisonLabel: string | null;
}

/**
 * Which sections render. Mirrors the registry's per-axis temporal capability;
 * the parent maps it. TimelineLens never decides what a Perspective supports.
 */
export interface TimelineLensCapability {
  /** Render the exact-boundary date fields. */
  custom?: boolean;
  /** Render swap + clear, and the comparison note on the trigger. */
  comparison?: boolean;
}

/**
 * Parent-owned validation feedback. Carries WHICH boundary was rejected, so the
 * message renders under the field the user actually touched — a single opaque
 * string cannot say that, and defaulted to the wrong field.
 */
export interface TimelineBoundaryError {
  boundary: "asOf" | "compareTo";
  message: string;
}

export interface TimelineLensProps {
  /** Derived from canonical every render. `null` = no option matches (custom). */
  activeOptionId: string | null;
  /** Derived from canonical every render. Never held as draft. */
  boundaries: { asOf: string; compareTo: string };
  summary: TimelineLensSummary;
  periodOptions: readonly TimelinePeriodOption[];
  /**
   * The latest selectable date (YYYY-MM-DD), applied as `max` to BOTH boundary
   * inputs — parity with the production controls, which cap As-of and Compare-to
   * alike. This is an input constraint, not temporal meaning: the component takes
   * no position on whether compareTo precedes asOf. Forward comparison is a
   * supported canonical state (Wealth relies on it) and must stay expressible.
   */
  maxDate: string;
  /** The only mutation boundary. One user action, one intent, one parent commit. */
  onIntent: (intent: TimelineIntent) => void;
  capability?: TimelineLensCapability;
  /** Parent-owned validation feedback, surfaced on the field that was rejected. */
  boundaryError?: TimelineBoundaryError | null;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}
