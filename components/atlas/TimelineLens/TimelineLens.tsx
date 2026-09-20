"use client";

/**
 * components/atlas/TimelineLens/TimelineLens.tsx
 *
 * The closed readout, as TWO compact controls instead of one card:
 *
 *   [ ▦ 1 month ▾ ]   [ Aug 20, 2026 → Sep 20, 2026 ]
 *
 *   • the PERIOD trigger — the one interactive element. It opens the Atlas
 *     LeftPanel (context / control, per the panel doctrine), which still owns
 *     every period option, the exact-boundary fields, swap/clear and the
 *     return-to-present escape hatch. Nothing about editing moved.
 *   • the RESOLVED RANGE — informational, not a second selector. It prints the
 *     parent's `summary.rangeLabel` verbatim; this component resolves no dates.
 *
 * The old readout was a three-row card (anchor eyebrow · period · range) that
 * out-weighed the content beneath it. The "AS OF TODAY" eyebrow is gone from the
 * closed state: the range already shows the endpoint and the period names the
 * window. The vantage point is NOT lost — a historical anchor tints the range
 * pill (the state a user can otherwise forget they are in), and the panel still
 * names the anchor in words and offers the way back to the present.
 *
 * Every displayed value is derived by the parent. The only state here is `open`.
 *
 * Both controls are h-9 (36px) — a reasonable touch target — and sit in a
 * wrapping row, so at narrow widths the range drops beneath the trigger instead
 * of overflowing or re-forming a card.
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
  const periodId = useId();

  // Choosing a period is a complete action — the same single click the segmented
  // slicer costs today — so apply it and get out of the way. Boundary edits need
  // two fields, so those keep the panel open and report through the footer.
  function handleIntent(intent: TimelineIntent) {
    onIntent(intent);
    if (intent.type === "period") setOpen(false);
  }

  return (
    <div className={`flex max-w-full min-w-0 flex-wrap items-center gap-2 ${className}`}>
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
        // The label names the ACTION; the description carries the current state —
        // the selected period, then the range it resolves to.
        aria-describedby={`${periodId} ${summaryId}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-timeline-period
        className="h-9 shrink-0 px-3 text-left disabled:cursor-not-allowed disabled:opacity-50"
        contentClassName="flex h-full items-center gap-2"
      >
        <CalendarRange size={14} strokeWidth={1.6} className="shrink-0 text-[var(--meridian-400)]" aria-hidden />
        <strong id={periodId} className="whitespace-nowrap text-[13px] font-medium text-[var(--text-primary)]">
          {summary.periodLabel}
        </strong>
        <ChevronDown size={14} strokeWidth={1.6} className="shrink-0 text-[var(--text-faint)]" aria-hidden />
      </GlassPanel>

      {/* The resolved range — a readout, deliberately not a control. A historical
          anchor tints it, which is the closed state's only vantage-point cue. */}
      <span
        id={summaryId}
        data-timeline-range
        data-anchored={summary.anchoredToPresent ? "present" : "past"}
        className={`inline-flex h-9 min-w-0 max-w-full items-center rounded-[var(--radius-lg)] border bg-[var(--surface-inset)] px-3 text-[12px] tabular-nums ${
          summary.anchoredToPresent
            ? "border-[var(--border-hairline)] text-[var(--text-muted)]"
            : "border-[var(--meridian-400)] text-[var(--text-primary)]"
        }`}
      >
        <span className="truncate">{summary.rangeLabel}</span>
      </span>

      {capability.comparison && summary.comparisonLabel && (
        <span className="min-w-0 truncate text-[11px] text-[var(--text-faint)]">{summary.comparisonLabel}</span>
      )}

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
