"use client";

/**
 * components/space/widgets/shared/BalanceCoverageNote.tsx  (PB-8 — owner ruling 2026-10-30)
 *
 * Under the Net Worth / Assets / Debt trend: when the plotted window reaches back
 * before an account's balance-history floor (a mortgage connected yesterday, a
 * card whose history cannot be walked), says the history there is PARTIAL — a
 * missing debt is never $0 owed. The sibling of ValuationCoverageNote (prices);
 * rides the same one data-health read and renders nothing while loading or when
 * the window starts on/after the floor; on a FAILED read it says completeness
 * could not be read (S2 sweep).
 *
 * B12 O-3 — with `partialHistory` (the Net Worth and Debt workspaces), the chart
 * DEFAULTS to starting at the coverage floor (clipToBalanceCoverage): the note
 * then says where history starts ("Your net worth history starts today. It
 * builds as your accounts sync.") beside a "Show partial history" control;
 * opted in, the PB-8 note is shown unchanged beside "Hide partial history".
 * Without `partialHistory` (fixture renders), the PB-8 note alone, as before.
 */

import { useSpaceIdContext } from "@/components/space/space-id-context";
import { useSpaceBalanceCoverage } from "@/components/space/PerspectiveEmptyState";
import {
  BALANCE_COVERAGE_UNREADABLE_CHART_NOTE, HIDE_PARTIAL_HISTORY_LABEL, SHOW_PARTIAL_HISTORY_LABEL,
  balanceCoverageNote, balanceCoverageSidesFor, balanceHistoryStartNote, isBalanceCoverageUnavailable,
  type ClientBalanceCoverage,
} from "@/lib/connections/balance-coverage.core";

/** B12 O-3 — the opt-in to the partial days before the coverage floor (state lives with the chart's caller). */
export interface PartialHistoryToggle {
  shown:    boolean;
  onToggle: () => void;
  /** YYYY-MM-DD — the note says "starts today" when the floor is today. */
  todayISO: string;
}

export function BalanceCoverageNote({ from, metric, coverage: given, partialHistory }: {
  /** The SELECTED window's first day (before any coverage clip). */
  from: string | null;
  metric: string;
  /** Fixture-driven renders only; the page always reads the Space's data-health. */
  coverage?: ClientBalanceCoverage;
  /** B12 O-3 — present ⇒ the chart defaults to the coverage floor and this note carries the opt-in. */
  partialHistory?: PartialHistoryToggle;
}) {
  const live = useSpaceBalanceCoverage(useSpaceIdContext());
  const coverage = given !== undefined ? given : live;
  // S2 sweep — a FAILED coverage read: say so under a series it governs (its change is withheld above).
  if (isBalanceCoverageUnavailable(coverage) && balanceCoverageSidesFor(metric).length > 0) {
    return <p className="mt-2 text-[11px] text-[var(--text-faint)]" data-balance-coverage-note="unavailable">{BALANCE_COVERAGE_UNREADABLE_CHART_NOTE}</p>;
  }
  // S2 2026-11-03 — LOADING renders nothing (balanceCoverageNote knows no floor yet):
  // the note is pending, never a sentence that the resolved read then contradicts.
  const note = balanceCoverageNote(coverage, balanceCoverageSidesFor(metric), from);
  if (!note) return null;
  if (!partialHistory) return <p className="mt-2 text-[11px] text-[var(--text-faint)]" data-balance-coverage-note>{note}</p>;
  // Same condition as `note` (balanceChartStartISO), so it is non-null here.
  const startNote = balanceHistoryStartNote(coverage, metric, from, partialHistory.todayISO);
  return (
    <p className="mt-2 text-[11px] text-[var(--text-faint)]" data-balance-coverage-note={partialHistory.shown ? "partial-shown" : "starts-at-floor"}>
      {partialHistory.shown ? note : startNote}{" "}
      <button
        type="button"
        onClick={partialHistory.onToggle}
        aria-pressed={partialHistory.shown}
        className="underline underline-offset-2 hover:text-[var(--text-primary)]"
        data-partial-history-toggle
      >
        {partialHistory.shown ? HIDE_PARTIAL_HISTORY_LABEL : SHOW_PARTIAL_HISTORY_LABEL}
      </button>
    </p>
  );
}
