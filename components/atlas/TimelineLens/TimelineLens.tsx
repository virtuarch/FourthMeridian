"use client";

/**
 * components/atlas/TimelineLens/TimelineLens.tsx
 *
 * The closed readout: what lens am I looking through? Period, exact boundaries,
 * and — when the consumer supports one — a note about the opening boundary.
 * Opens the Atlas LeftPanel (context / control, per the panel doctrine) for
 * editing.
 *
 * Every displayed value is derived by the parent. The only state here is `open`.
 *
 * Typography note: Atlas defines --font-ui and --font-data only; there is no
 * serif token in the design language. The editorial weight comes from scale,
 * leading, and tracking. Earlier drafts referenced a --font-serif that does not
 * exist and silently fell back to sans.
 *
 * DENSITY (visual refinement — no behaviour, contract, or layout-ownership
 * change): the closed readout was reading as a hero card next to the 28px
 * workspace tabs. Only three levers moved — container vertical padding
 * (py-3.5 → py-2), icon container (h-9/36px → h-8/32px, with the grid column
 * tracking it), and the text stack's internal gap (gap-1 → gap-0.5). Type scale,
 * weights, and the eyebrow → title → range hierarchy are untouched.
 *
 * The floor is the text itself: eyebrow 15px + title 21.85px + range 16.5px is
 * 53.35px of line boxes before any padding or gap. A target of ~2x the 28px tab
 * row (~56px) is therefore not reachable without shrinking the type, which would
 * trade the hierarchy for the height. ~75px (3-row state) is the honest minimum
 * that keeps the hierarchy intact; the 4-row state (comparison label shown) sits
 * ~19px taller. Do not close the remaining gap by dropping a row or reducing the
 * title — the readout's whole job is saying which lens you are looking through.
 */

import { useId, useState } from "react";
import { CalendarRange, ChevronDown } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { TimelineLensPanel } from "./TimelineLensPanel";
import type { TimelineIntent, TimelineLensProps } from "./types";

export function TimelineLens({
  activeOptionId,
  boundaries,
  summary,
  periodOptions,
  maxDate,
  onIntent,
  capability = { custom: true, comparison: true },
  boundaryError = null,
  disabled = false,
  ariaLabel = "Change time period",
  className = "",
}: TimelineLensProps) {
  const [open, setOpen] = useState(false);
  const summaryId = useId();

  // Choosing a period is a complete action — the same single click the segmented
  // slicer costs today — so apply it and get out of the way. Boundary edits need
  // two fields, so those keep the panel open and report through the footer.
  function handleIntent(intent: TimelineIntent) {
    onIntent(intent);
    if (intent.type === "period") setOpen(false);
  }

  return (
    <div className={`w-full max-w-[340px] sm:shrink-0 ${className}`}>
      <GlassPanel
        as="button"
        type="button"
        depth="thin"
        elevation="e1"
        radius="lg"
        interactive
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label={ariaLabel}
        aria-describedby={summaryId}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="w-full border-l-2 border-l-[var(--meridian-400)] px-3.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
        contentClassName="grid w-full min-w-0 grid-cols-[32px_minmax(0,1fr)_16px] items-start gap-3"
      >
        <span
          className="grid h-8 w-8 place-items-center rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--surface-inset)] text-[var(--meridian-400)]"
          aria-hidden
        >
          <CalendarRange size={16} strokeWidth={1.6} />
        </span>

        <span id={summaryId} className="grid min-w-0 gap-0.5">
          {/* The eyebrow names the VANTAGE POINT, not a generic verb. A bare
              range shows both dates without saying which one you are standing
              on; this resolves that. Emphasised when the anchor is historical,
              because that is the state a user can otherwise forget they are in. */}
          <span
            className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${
              summary.anchoredToPresent ? "text-[var(--text-faint)]" : "text-[var(--meridian-400)]"
            }`}
          >
            {summary.anchorLabel}
          </span>
          <strong className="truncate text-[19px] font-normal leading-[1.15] tracking-[-0.01em] text-[var(--text-primary)]">
            {summary.periodLabel}
          </strong>
          <span className="truncate text-[11px] tabular-nums text-[var(--text-muted)]">
            {summary.rangeLabel}
          </span>
          {capability.comparison && summary.comparisonLabel && (
            <span className="truncate text-[11px] text-[var(--text-faint)]">{summary.comparisonLabel}</span>
          )}
        </span>

        <ChevronDown size={16} strokeWidth={1.6} className="mt-5 text-[var(--text-faint)]" aria-hidden />
      </GlassPanel>

      <TimelineLensPanel
        open={open}
        activeOptionId={activeOptionId}
        boundaries={boundaries}
        summary={summary}
        periodOptions={periodOptions}
        capability={capability}
        maxDate={maxDate}
        boundaryError={boundaryError}
        onIntent={handleIntent}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
