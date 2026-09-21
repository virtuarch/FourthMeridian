"use client";

/**
 * components/space/shell/PerspectiveShell.tsx
 *
 * The Perspective shell as ONE visual object — two framed containers, then the
 * workspace below (rendered by the host). It reads as "time and trust remain
 * fixed; the lens changes":
 *
 *   Container 2 — "the lens" (lighter, --border-hairline):
 *     PerspectiveTabs (one SegmentedControl track)
 *   Container 1 — "time":
 *     TimelineLens (the ONE canonical time selector — a compact period trigger
 *       + the resolved range) · ShellTrustRow (orthogonal caveats ONLY, and only
 *       when one exists — the Completeness / Evidence chips no longer sit here)
 *
 * SHELL_NAV redesign (§2.2): the lens tab track now sits ABOVE the time/trust +
 * period-preset block — you pick the lens first, then read/adjust time beneath
 * it. Container numbering keeps its original semantics (1 = time & trust, 2 =
 * the lens); only the render order swapped.
 *
 * The shell writes shell state only through its own controls; perspectives read
 * context and never own time. Presentation only.
 */

import { useState } from "react";
import type { CashFlowPeriod } from "@/lib/transactions/cash-flow";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import type { PerspectiveTimeState } from "@/lib/perspectives/time-range";
import type { TemporalCapability } from "@/lib/perspectives";
import { TimelineLens, type TimelineBoundaryError, type TimelineIntent } from "@/components/atlas/TimelineLens";
import {
  PERIOD_OPTIONS,
  capabilityForLens,
  deriveActiveOptionId,
  deriveBoundaries,
  shellActionForIntent,
  summarize,
} from "./perspective-time-adapter";
import { ShellTrustRow } from "./ShellTrustRow";
import { PerspectiveTabs, type PerspectiveTabItem } from "./PerspectiveTabs";

interface Props {
  today: string;
  /**
   * The canonical time MUTATION callbacks.
   *
   * These are NOT legacy selector plumbing — they are the behavioral adapter
   * seam. handleTimelineIntent resolves a TimelineIntent into a sanctioned
   * ShellTimeAction and then dispatches it through exactly these, so the host's
   * handlers run unchanged: onSelectPreset still reaches handleSelectSlice
   * (including its Cash-Flow-override clearing), onCompareToChange still
   * re-infers. Removing them would strand cashFlowExplicitPeriod.
   */
  onAsOfChange:      (v: string) => void;
  onCompareToChange: (v: string | null) => void;
  onSwap:            () => void;
  onSelectPreset:    (p: CashFlowPeriod) => void;
  /** The active perspective's trust envelope (from the S3 registry). */
  envelope: PerspectiveEnvelope;
  /** The engaged lens's temporal capability — gates the explicit boundary fields. */
  temporalCapability?: TemporalCapability;
  /** Canonical time. Read-only: the shell derives its entire display from this
   *  and never stores a copy. */
  timeState: PerspectiveTimeState;
  // Container 2 — the lens.
  tabs:        PerspectiveTabItem[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  /**
   * Where the lens row is SHOWN. "always" (default) — every width. "belowLg" —
   * only below the `lg` breakpoint, for a host whose desktop sidebar already is
   * the workspace switcher (a customer Space: ContextualNavbar's Net Worth ·
   * Cash Flow, `hidden … lg:block`). The exact complement of that breakpoint, so
   * exactly one switcher shows at any width. Presentation only: the row stays
   * mounted (the host's workspace region names itself, so hiding this row
   * leaves no label behind) and its selection
   * logic is untouched.
   */
  tabsVisibility?: "always" | "belowLg";
}

export function PerspectiveShell(props: Props) {
  // Validation feedback for the lens's boundary fields. Presentation state only —
  // a rejected intent produces NO action, so canonical time cannot move to a date
  // the user did not choose.
  const [boundaryError, setBoundaryError] = useState<TimelineBoundaryError | null>(null);

  /**
   * The whole TimelineLens integration.
   *
   * An intent becomes a sanctioned ShellTimeAction (adapter, unit-tested for
   * parity), and that action is then routed back through the SAME callbacks the
   * legacy controls already use. Nothing new reaches the host: `onSelectPreset`
   * still runs handleSelectSlice (including its Cash-Flow-override clearing),
   * `onCompareToChange` still re-infers, `onSwap` is untouched. The lens is a
   * pure swap of the UI that expresses the intent.
   */
  function handleTimelineIntent(intent: TimelineIntent) {
    const result = shellActionForIntent(intent, { today: props.today });
    if (!result.ok) {
      // Only a boundary edit can be rejected; attribute the message to the field
      // the user actually touched so it renders under that input.
      if (intent.type === "customBoundary") {
        setBoundaryError({ boundary: intent.boundary, message: result.error });
      }
      return;
    }
    setBoundaryError(null);
    const action = result.action;
    switch (action.type) {
      case "selectPreset":  props.onSelectPreset(action.preset); return;
      case "setAsOf":       props.onAsOfChange(action.asOf); return;
      case "setCompareTo":  props.onCompareToChange(action.compareTo); return;
      case "swap":          props.onSwap(); return;
      // clearCompareTo is never emitted by the adapter — the ✕ affordance maps to
      // setCompareTo(null), matching what today's control dispatches.
      case "clearCompareTo": props.onCompareToChange(null); return;
    }
  }

  return (
    <div className="space-y-3">
      {/* Container 2 — the lens. Rendered FIRST (SHELL_NAV §2.2: pick the lens
          above, read/adjust time below) as the prototype's in-flow, centered lens
          chips (LensSelector) — the SAME selector as the Overview summary, so the
          engaged and summary lens rows are visually identical. The former floating
          pill (FloatingNavWrapper) is dropped: the prototype's lens selector is
          in-flow, and loose chips must not float over the content. */}
      <div
        data-lens-row
        className={["flex justify-center px-1", props.tabsVisibility === "belowLg" ? "lg:hidden" : ""].join(" ").trim()}
      >
        <PerspectiveTabs
          items={props.tabs}
          activeId={props.activeTabId}
          onSelect={props.onSelectTab}
        />
      </div>

      {/* Container 1 — time. ONE canonical time selector, unconditionally, as two
          compact controls (period trigger + resolved range) — see TimelineLens.
          temporalCapability still gates the lens's explicit boundary fields
          (capabilityForLens); the period choice itself remains UNIVERSAL — never
          capability-gated, because the `period` axis describes interpretation,
          not availability.

          The row is centred under the centred lens tabs and wraps on its own, so
          it needs no breakpoint. (The former container query and its measured
          850px threshold existed only to stop the always-on Completeness /
          Evidence chips wrapping left-aligned beneath a 340px card; with both
          gone there is nothing wide enough to need it.) A caveat chip, when one
          exists, joins the same wrapping row. */}
      <div className="px-1">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <TimelineLens
            activeOptionId={deriveActiveOptionId(props.timeState)}
            boundaries={deriveBoundaries(props.timeState)}
            summary={summarize(props.timeState, props.today)}
            periodOptions={PERIOD_OPTIONS}
            capability={capabilityForLens(props.temporalCapability)}
            maxDate={props.today}
            boundaryError={boundaryError}
            onIntent={handleTimelineIntent}
          />
          <ShellTrustRow envelope={props.envelope} />
        </div>
      </div>
    </div>
  );
}
