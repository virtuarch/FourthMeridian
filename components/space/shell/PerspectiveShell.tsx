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
 *   Container 1 — "time & trust":
 *     TimelineLens (the ONE canonical time selector) · ShellTrustRow
 *       (Completeness · Evidence · orthogonal warnings)
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
      <div className="@container space-y-3 px-1">
        {/* ONE canonical time selector, unconditionally. The As-of/⇄/Compare-to
            row and the preset strip both collapsed into TimelineLens; the trust
            chips sit beside it, unchanged — data honesty and time window are
            separate concerns and the chips were never temporally gated.

            temporalCapability still gates the lens's explicit boundary fields
            (capabilityForLens), exactly as it gated the old date inputs. The
            period choice itself remains UNIVERSAL — never capability-gated,
            because the `period` axis describes interpretation, not availability. */}
        {/* Centred once the trust chips wrap beneath the lens, spread while the
            two still share a row. Left-aligning a wrapped stack under a
            full-width header reads as an accident; centring reads as a
            deliberate narrow layout.

            A CONTAINER query, not a viewport breakpoint: the wrap depends on how
            much room this row actually has, which is the viewport MINUS the
            space rail and page padding. Keyed to the viewport it would drift the
            moment the rail's width changes or a workspace renders at a different
            inset.

            850px is the WIDEST perspective's requirement, not the average one.
            The trust row is content-sized and varies a lot by perspective,
            because the completeness LABEL varies: Cash Flow reads "Complete
            within transaction depth" where Net Worth reads "Observed". Measured
            chip widths — completeness 176 (Observed) vs 313 (Cash Flow's), and
            evidence 106 ("—") vs 177 ("365 snapshots"). So the widest pairing is
            313 + gap-2 (8) + 177 = 498 of chips, and 340 (lens max-w) + gap-3
            (12) + 498 = 850 before the two can no longer share a line.

            Keyed to the narrower 714 that Net Worth alone needs, Cash Flow wraps
            at 850 but keeps space-between down to 714 — wrapped AND left-
            aligned, which is exactly the artefact this block exists to remove.

            The cost of taking the widest number is that narrow-chip
            perspectives centre before they strictly must. Measured bands where
            the row is centred but would still have fit inline: Cash Flow
            778–850, Net Worth 714–850, Debt 693–850, Liquidity 599–850 — so
            Liquidity, the narrowest, carries the most, up to ~125px of inset per
            side at the top of its band. That is the deliberate direction to err:
            centring slightly early is a cosmetic softness, whereas left-
            aligning a wrapped stack is the visible defect. Flex exposes no
            wrap-aware selector, so one number has to serve every perspective.

            Residual, knowingly accepted: a space carrying an orthogonal warning
            chip (an FX caveat) adds ~170 + gap and needs ~1028, so it can still
            wrap while spread between 850 and 1028. Raising the threshold that
            far would centre the row on ordinary laptop widths, which is a worse
            trade than the rare warning case. Re-measure before changing it. */}
        <div className="flex flex-wrap items-start justify-center @min-[850px]:justify-between gap-3">
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
          <ShellTrustRow envelope={props.envelope} className="" />
        </div>
      </div>
    </div>
  );
}
