"use client";

/**
 * components/space/shell/PerspectiveShell.tsx
 *
 * The Perspective shell as ONE visual object — two framed containers, then the
 * workspace below (rendered by the host). It reads as "time and trust remain
 * fixed; the lens changes":
 *
 *   Container 1 — "time":
 *     TimelineLens (the ONE canonical time selector — a compact period trigger
 *       + the resolved range) · ShellTrustRow (orthogonal caveats ONLY, and only
 *       when one exists — the Completeness / Evidence chips no longer sit here)
 *   Container 2 — "the lens" (lighter, --border-hairline):
 *     PerspectiveTabs (one SegmentedControl track)
 *
 * TIME COMES FIRST. The date picker is the first thing in the shell so its
 * position never depends on the lens: nothing above it varies with the open
 * workspace, and the lens row (hidden at lg+, where the sidebar switches
 * workspaces) and everything workspace-specific sit BELOW it. (This reverses
 * SHELL_NAV §2.2, which put the lens track above time and let the time row
 * shift whenever the row above it did.)
 *
 * The shell writes shell state only through its own controls; perspectives read
 * context and never own time. Presentation only.
 */

import { useState, type ReactNode } from "react";
import type { CashFlowPeriod, ExplicitCashFlowPeriod } from "@/lib/transactions/cash-flow";
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
  shortExplicitPeriodLabel,
  shortPeriodLabel,
  summarize,
  summarizeExplicitPeriod,
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
  /**
   * COMPACT DASHBOARD — hide the time row below lg only (the selector still
   * mounts; desktop unchanged). The host sets it for Markets, which consumes no
   * time (temporalCapability none) and must carry no Net Worth / Cash Flow controls.
   */
  compactHideTime?: boolean;
  /**
   * v2.7 (owner) — NO reporting-period picker at ANY width (Markets: it consumes
   * no Space time, so the global picker must not appear there). The compact
   * view selector still mounts.
   */
  hideTime?: boolean;
  /**
   * v2.7 — the active group's EXPLICIT calendar period (the heatmap's Month ·
   * Quarter · Year on Cash Flow / Spending), or null. When set, the trigger and
   * readout name that window and no preset reads as active — the header and the
   * heatmap always describe the same window.
   */
  explicitPeriod?: ExplicitCashFlowPeriod | null;
  /**
   * v2.7 R1 — the compact (<lg) financial-view selector (Net Worth ▾). When
   * passed, the ONE in-flow time row becomes the compact controls row below lg:
   * selector left, the period trigger right (range readout hidden, short label
   * below sm), one non-wrapping row. At lg+ the selector is absent (lg:hidden)
   * and the row is exactly the centred time row. Desktop unchanged.
   */
  compactViewSelector?: ReactNode;
  /** "none" — COMPACT DASHBOARD (P1): the host renders the compact view selector instead. */
  tabsVisibility?: "always" | "belowLg" | "none";
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
  // v2.7 R1 — the in-flow time row doubles as the compact controls row.
  const compactRow = props.compactViewSelector != null;

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

  // v2.7 (owner) — STICKY COMPACT CONTROLS ROW (<lg only). The row pins under the
  // GlobalHeader (sticky top-0, h-12 + 1px border-b ⇒ 3rem+1px) while the page
  // scrolls. A sticky box is confined to its PARENT's box, so this root becomes
  // `display: contents` below lg (and the host's wrapper does the same — see
  // SpaceDashboard), making the tall page column the row's containing block.
  // z-20: above content (whose highest layer is z-10) and below the header (z-40);
  // the selector's menu (z-30) opens inside the row's own stacking context, the
  // period panel portals to <body>. Solid page background + hairline, bled to the
  // page gutters (px-4, sm:px-5) so content never shows at the sides. At lg+ none of
  // these utilities apply — desktop markup is byte-identical.
  return (
    <div className={compactRow ? "space-y-3 max-lg:contents" : "space-y-3"}>
      {/* Container 1 — time. ONE canonical time selector, unconditionally, as two
          compact controls (period trigger + resolved range) — see TimelineLens.
          temporalCapability still gates the lens's explicit boundary fields
          (capabilityForLens); the period choice itself remains UNIVERSAL — never
          capability-gated, because the `period` axis describes interpretation,
          not availability.

          The row is centred above the centred lens tabs and wraps on its own, so
          it needs no breakpoint. (The former container query and its measured
          850px threshold existed only to stop the always-on Completeness /
          Evidence chips wrapping left-aligned beneath a 340px card; with both
          gone there is nothing wide enough to need it.)

          The date picker is ALONE in its row. Caveat chips come from the ACTIVE
          workspace's envelope, so sharing the centred row let one workspace's
          caveat push the picker sideways; they get their own centred row just
          below it (ShellTrustRow renders nothing — no gap — when there are
          none). */}
      {(compactRow || !props.hideTime) && (
      <div
        data-compact-controls={compactRow ? "" : undefined}
        className={compactRow
          ? "px-1 max-lg:flex max-lg:flex-nowrap max-lg:items-center max-lg:justify-between max-lg:gap-3 max-lg:sticky max-lg:top-[calc(3rem+1px)] max-lg:z-20 max-lg:-mx-5 max-lg:px-6 max-lg:max-sm:-mx-4 max-lg:max-sm:px-5 max-lg:py-2 max-lg:bg-[var(--bg-base)] max-lg:border-b max-lg:border-[var(--border-hairline)]"
          : props.compactHideTime ? "px-1 max-lg:hidden" : "px-1"}
      >
        {/* v2.7 R1 — compact controls row, LEFT: the financial-view selector
            (compact-only; never renders at lg+). */}
        {compactRow && <div className="lg:hidden min-w-0">{props.compactViewSelector}</div>}
        <div
          className={!compactRow
            ? "flex flex-wrap items-center justify-center gap-2"
            : props.compactHideTime
              ? "flex flex-wrap items-center justify-center gap-2 max-lg:hidden"
              : "flex flex-wrap items-center justify-center gap-2 max-lg:shrink-0 max-lg:flex-nowrap max-lg:[&_[data-timeline-period]~span]:hidden"}
        >
          {!props.hideTime && (
            <TimelineLens
              activeOptionId={props.explicitPeriod ? null : deriveActiveOptionId(props.timeState)}
              boundaries={deriveBoundaries(props.timeState)}
              summary={props.explicitPeriod ? summarizeExplicitPeriod(props.explicitPeriod, props.today) : summarize(props.timeState, props.today)}
              periodOptions={PERIOD_OPTIONS}
              capability={capabilityForLens(props.temporalCapability)}
              maxDate={props.today}
              boundaryError={boundaryError}
              onIntent={handleTimelineIntent}
              shortPeriodLabel={compactRow && !props.compactHideTime
                ? (props.explicitPeriod ? shortExplicitPeriodLabel(props.explicitPeriod) : shortPeriodLabel(props.timeState))
                : undefined}
            />
          )}
        </div>
      </div>
      )}
      <ShellTrustRow envelope={props.envelope} className="justify-center px-1" />

      {/* Container 2 — the lens. Rendered BELOW time (the date picker must not
          move with the lens), as the prototype's in-flow, centered lens
          chips (LensSelector) — the SAME selector as the Overview summary, so the
          engaged and summary lens rows are visually identical. The former floating
          pill (FloatingNavWrapper) is dropped: the prototype's lens selector is
          in-flow, and loose chips must not float over the content. */}
      {props.tabsVisibility !== "none" && (
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
      )}
    </div>
  );
}
