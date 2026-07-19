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
 *   Container 1 — "time & trust" (heaviest chrome, --border-hairline-strong):
 *     Row A  ShellContextRow (As of · ⇄ · Compare to · Completeness · Evidence)
 *     Row B  the preset segmented controls (to-date left · rolling right)
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
import { temporalControlVisibility, type TemporalCapability } from "@/lib/perspectives";
import { TimelineLens, type TimelineBoundaryError, type TimelineIntent } from "@/components/atlas/TimelineLens";
import { CashFlowPeriodSelector } from "@/components/space/widgets/CashFlowPeriodSelector";
import {
  PERIOD_OPTIONS,
  capabilityForLens,
  deriveActiveOptionId,
  deriveBoundaries,
  shellActionForIntent,
  summarize,
} from "./perspective-time-adapter";
import { usesTimelineLens } from "./timeline-lens-rollout";
import { ShellContextRow } from "./ShellContextRow";
import { ShellTrustRow } from "./ShellTrustRow";
import { PerspectiveTabs, type PerspectiveTabItem } from "./PerspectiveTabs";

interface Props {
  // Row A — time & trust context.
  asOf:              string;
  compareTo:         string | null;
  today:             string;
  onAsOfChange:      (v: string) => void;
  onCompareToChange: (v: string | null) => void;
  onSwap:            () => void;
  /** The active perspective's trust envelope (from the S3 registry). */
  envelope:          PerspectiveEnvelope;
  // Row B — presets (value is null under CUSTOM: no segment highlighted).
  presetValue:    CashFlowPeriod | null;
  onSelectPreset: (p: CashFlowPeriod) => void;
  /** The engaged lens's temporal capability — gates which time controls render.
   *  Undefined ⇒ render all (pre-declaration default). */
  temporalCapability?: TemporalCapability;
  /** Canonical time, for the TimelineLens path. Read-only: the shell derives its
   *  entire display from this and never stores a copy. */
  timeState: PerspectiveTimeState;
  /** Engaged Perspective id — decides which time UI renders (rollout allowlist). */
  activePerspectiveId: string | null;
  // Container 2 — the lens.
  tabs:        PerspectiveTabItem[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
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

  // The EXPLICIT point-in-time inputs (As-of / Compare-to) are capability-gated —
  // hidden for a lens that exposes no literal date input (e.g. Cash Flow). The
  // preset/time slicer below is UNIVERSAL: it is how every Perspective selects
  // canonical {preset, asOf, compareTo}, so it always renders (never gated by
  // temporalCapability — the `period` axis describes interpretation, not the slicer).
  const vis = temporalControlVisibility(props.temporalCapability);
  const useLens = usesTimelineLens(props.activePerspectiveId);
  return (
    <div className="space-y-3">
      {/* Container 2 — the lens. Rendered FIRST (SHELL_NAV §2.2: pick the lens
          above, read/adjust time below) as the prototype's in-flow, centered lens
          chips (LensSelector) — the SAME selector as the Overview summary, so the
          engaged and summary lens rows are visually identical. The former floating
          pill (FloatingNavWrapper) is dropped: the prototype's lens selector is
          in-flow, and loose chips must not float over the content. */}
      <div className="flex justify-center px-1">
        <PerspectiveTabs
          items={props.tabs}
          activeId={props.activeTabId}
          onSelect={props.onSelectTab}
        />
      </div>

      {/* Container 1 — time & trust, LIGHTENED (M3-Reset).
          The temporal capability (As of / Compare to / Completeness / Evidence +
          presets) is UNCHANGED, but it no longer sits in a heavy bordered glass
          instrument panel — the controls sit inline on the page, like the
          prototype's light TimeBar, so a lens reads as an editorial surface, not
          a dashboard control deck. Nothing about asOf/compareTo/evidence semantics
          changes; this is purely the surrounding chrome. */}
      <div className="space-y-3 px-1">
        {useLens ? (
          /* TimelineLens path (rollout allowlist). One control replaces the
             As-of/⇄/Compare-to row AND the preset strip; the trust chips move
             beside it, unchanged — data honesty and time window are separate
             concerns and the chips were never temporally gated. */
          <div className="flex flex-wrap items-start justify-between gap-3">
            <TimelineLens
              activeOptionId={deriveActiveOptionId(props.timeState)}
              boundaries={deriveBoundaries(props.timeState)}
              summary={summarize(props.timeState)}
              periodOptions={PERIOD_OPTIONS}
              capability={capabilityForLens(props.temporalCapability)}
              maxDate={props.today}
              boundaryError={boundaryError}
              onIntent={handleTimelineIntent}
            />
            <ShellTrustRow envelope={props.envelope} className="" />
          </div>
        ) : (
          <>
            <ShellContextRow
              asOf={props.asOf}
              onAsOfChange={props.onAsOfChange}
              compareTo={props.compareTo}
              onCompareToChange={props.onCompareToChange}
              onSwap={props.onSwap}
              today={props.today}
              envelope={props.envelope}
              showAsOf={vis.asOf}
              showCompareTo={vis.compareTo}
            />
            {/* Universal canonical time slicer — every Perspective selects time here. */}
            <CashFlowPeriodSelector value={props.presetValue} onChange={props.onSelectPreset} />
          </>
        )}
      </div>
    </div>
  );
}
