/**
 * components/space/shell/perspective-time-adapter.ts
 *
 * The translation layer between the Atlas TimelineLens primitive and the
 * canonical Perspective time system. Pure — no React, no I/O, no clock.
 *
 *   TimelineIntent → adapter → existing ShellTimeAction → shellTimeReducer
 *
 * It exists so that TimelineLens can stay domain-free (it may not import
 * lib/perspectives) while still driving canonical time. Everything domain-shaped
 * lives here: the preset vocabulary, the option labels, validation, and the
 * canonical → display derivations.
 *
 * NO new reducer action is introduced. Every intent maps onto an action that
 * already exists and is already exercised by the current controls.
 *
 * Direction of dependency is deliberate: shell → atlas. Atlas never imports the
 * shell (enforced by components/atlas/TimelineLens/TimelineLens.test.ts).
 */

import type {
  TimelineIntent,
  TimelineLensCapability,
  TimelineLensSummary,
  TimelinePeriodOption,
} from "@/components/atlas/TimelineLens";
import {
  isValidYmd,
  type PerspectiveTimeState,
  type ShellTimeAction,
} from "@/lib/perspectives/time-range";
import { temporalControlVisibility, type TemporalCapability } from "@/lib/perspectives";
import {
  ROLLING_PERIODS,
  TO_DATE_PERIODS,
  type RelativeCashFlowPeriod,
} from "@/lib/transactions/cash-flow";

/* ── Option table ──────────────────────────────────────────────────────────── */

/**
 * Editorial labels for the lens. The compact production labels (WTD, 3M) stay
 * the canonical ids; these are presentation only.
 *
 * Keyed by RelativeCashFlowPeriod so adding a preset to cash-flow.ts without a
 * label here is a TYPE error, not a silently missing option. The option list
 * itself is derived from TO_DATE_PERIODS / ROLLING_PERIODS rather than restated,
 * so this file can never become a second preset vocabulary.
 */
const EDITORIAL: Record<RelativeCashFlowPeriod, { label: string; supportingLabel: string }> = {
  // To-date presets: anchor-NEUTRAL. "Month to date" is true at any anchor —
  // it means "from the start of the containing month, up to the anchor", which
  // is exactly compareToForPreset's rule. The former "This month" asserted the
  // present and was simply false when anchored historically (TIME-1B).
  WTD:           { label: "Week to date",    supportingLabel: "From the start of the week" },
  MTD:           { label: "Month to date",   supportingLabel: "From the start of the month" },
  QTD:           { label: "Quarter to date", supportingLabel: "From the start of the quarter" },
  YTD:           { label: "Year to date",    supportingLabel: "From January 1" },
  // Rolling presets keep "Last N" — that reads as relative to the ANCHOR, which
  // is what it is, and no rolling label asserted the present. Renaming them to
  // "Trailing N" would be churn with no falsehood to fix.
  PAST_WEEK:     { label: "Last 7 days",   supportingLabel: "Rolling week" },
  PAST_MONTH:    { label: "Last 30 days",  supportingLabel: "Rolling month" },
  PAST_QUARTER:  { label: "Last 90 days",  supportingLabel: "Rolling quarter" },
  PAST_6_MONTHS: { label: "Last 6 months", supportingLabel: "Rolling half-year" },
  PAST_YEAR:     { label: "Last 12 months", supportingLabel: "Rolling year" },
  ALL:           { label: "All history",   supportingLabel: "Since first record" },
};

/** Option id IS the canonical preset id — one identity, nothing to keep in sync. */
export const PERIOD_OPTIONS: readonly TimelinePeriodOption[] = [
  ...TO_DATE_PERIODS.map((p) => ({
    id: p.id, group: "toDate" as const, intent: p.id, ...EDITORIAL[p.id],
  })),
  ...ROLLING_PERIODS.map((p) => ({
    id: p.id, group: "rolling" as const, intent: p.id, ...EDITORIAL[p.id],
  })),
];

/* ── Intent → action ───────────────────────────────────────────────────────── */

export type AdapterResult =
  | { ok: true; action: ShellTimeAction }
  | { ok: false; error: string };

export interface AdapterContext {
  /** Latest selectable date. Mirrors the `max` the controls already enforce. */
  today: string;
}

/**
 * The whole adapter. Four cases, each onto an action that already exists.
 *
 * Two deliberate decisions worth knowing about:
 *
 * 1. `clearComparison` maps to `setCompareTo(null)`, NOT `clearCompareTo`.
 *    That is what today's ✕ button dispatches — ShellContextRow calls
 *    `onCompareToChange(null)` → `shell.actions.setCompareTo(null)`. Nothing in
 *    the app calls `clearCompareTo` at all; it is reachable only through the
 *    hook's unused binding.
 *
 *    The two are in fact EQUIVALENT today — `inferPerspectiveTimePreset` returns
 *    CUSTOM as soon as compareTo is null (time-range.ts:167), and neither action
 *    touches asOf. Mirroring the existing dispatch is still the right call: it
 *    makes parity true by construction rather than by an equivalence argument
 *    that a future reducer change could quietly invalidate. The adapter test
 *    pins that equivalence, so if it ever stops holding, this decision is
 *    re-examined rather than silently broken.
 *
 * 2. Invalid boundary input returns an error instead of substituting a date.
 *    Today an emptied As-of field silently becomes today (`e.target.value ||
 *    today` in ShellContextRow). That is a fabricated date the user did not
 *    choose. Here it is rejected and the message travels back to the component's
 *    Field error slot. This is the one intentional deviation from current
 *    behavior in Slice 2 — see the promotion report.
 */
export function shellActionForIntent(intent: TimelineIntent, ctx: AdapterContext): AdapterResult {
  switch (intent.type) {
    case "period":
      // `intent` is opaque to Atlas; here it is known to be a preset id.
      return { ok: true, action: { type: "selectPreset", preset: intent.intent as Exclude<RelativeCashFlowPeriod, never> } };

    case "swap":
      return { ok: true, action: { type: "swap" } };

    case "clearComparison":
      return { ok: true, action: { type: "setCompareTo", compareTo: null } };

    // The anchor moves ONLY by an explicit anchor action. This is that action —
    // and it is the ONLY way out of a historical anchor, since selecting a
    // preset deliberately preserves it (TIME-1 doctrine).
    case "returnToPresent":
      return { ok: true, action: { type: "setAsOf", asOf: ctx.today } };

    case "customBoundary": {
      const { boundary, value } = intent;

      // An emptied comparison boundary is a legitimate "no comparison" — same
      // as the ✕ button. An emptied as-of is not a expressible state.
      if (value === "") {
        return boundary === "compareTo"
          ? { ok: true, action: { type: "setCompareTo", compareTo: null } }
          : { ok: false, error: "Enter an as-of date." };
      }

      if (!isValidYmd(value)) return { ok: false, error: "Enter a valid date." };
      if (value > ctx.today) return { ok: false, error: "Date cannot be in the future." };

      // NOTE: no compareTo-vs-asOf ordering check. A comparison boundary AFTER
      // the as-of date is a supported canonical state — Wealth relies on it, and
      // the strictly-earlier rule is a DERIVATION (historicalCompareTo), not an
      // invariant. Re-adding an ordering rule here would resurrect the v2 bug.
      return boundary === "asOf"
        ? { ok: true, action: { type: "setAsOf", asOf: value } }
        : { ok: true, action: { type: "setCompareTo", compareTo: value } };
    }
  }
}

/* ── Canonical → display ───────────────────────────────────────────────────── */

/**
 * Which option reads as active. Derived on every render rather than stored, so
 * canonical changes the lens never saw (URL back-navigation, async coverage
 * arrival, a deep link) are reflected automatically.
 */
export function deriveActiveOptionId(state: PerspectiveTimeState): string | null {
  return state.preset === "CUSTOM" ? null : state.preset;
}

/** Canonical → the boundary field values ("" = no comparison boundary). */
export function deriveBoundaries(state: PerspectiveTimeState): { asOf: string; compareTo: string } {
  return { asOf: state.asOf, compareTo: state.compareTo ?? "" };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T12:00:00Z`));
}

/**
 * Canonical → the readout.
 *
 * Comparison copy is deliberately narrow. Canonical `compareTo` is an OPENING
 * BOUNDARY, not a "previous period" dataset — so the lens says only what is
 * true, and says nothing at all when the range line already carries it.
 */
export function summarize(state: PerspectiveTimeState, today: string): TimelineLensSummary {
  const option = PERIOD_OPTIONS.find((o) => o.id === deriveActiveOptionId(state));
  const anchoredToPresent = state.asOf >= today;
  return {
    // The vantage point, always named. A window is only meaningful once you know
    // where you are standing to look at it.
    anchorLabel: anchoredToPresent ? "As of today" : `As of ${formatDate(state.asOf)}`,
    anchoredToPresent,
    periodLabel: option?.label ?? "Custom range",
    rangeLabel: state.compareTo
      ? `${formatDate(state.compareTo)} → ${formatDate(state.asOf)}`
      : `As of ${formatDate(state.asOf)}`,
    comparisonLabel: state.compareTo ? null : "Point-in-time · no opening date",
  };
}

/**
 * Registry capability → which lens sections render.
 *
 * Reuses `temporalControlVisibility` rather than re-deriving, so the lens is
 * gated by exactly the rule that gates the current controls. Note the preset
 * strip is UNIVERSAL and never gated — `capability` governs only the explicit
 * boundary controls, matching PerspectiveShell's documented behavior.
 */
export function capabilityForLens(cap: TemporalCapability | undefined): TimelineLensCapability {
  const vis = temporalControlVisibility(cap);
  return { custom: vis.asOf || vis.compareTo, comparison: vis.asOf && vis.compareTo };
}
