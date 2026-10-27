"use client";

/**
 * components/space/widgets/CashFlowHistoryWidget.tsx
 *
 * The Activity heatmap for Cash Flow AND Spending (v2.7 final perspective UX pass).
 *
 * ONE view: the calendar heatmap (daily cells, 1 / 3 / 12 month grids by scale).
 * The former "Cards" alternative and its Calendar ⇄ Cards switch are removed
 * (owner decision) — the heatmap is the activity view on both pages; on Spending
 * it shows spending by day.
 *
 * REPORTING RANGE vs DISPLAY GRANULARITY — deliberately distinct:
 *   • the reporting range is the ONE period the sticky header owns (a relative
 *     preset such as 1M, or an explicit calendar Month · Quarter · Year);
 *   • the display granularity is always the DAY (one cell per day).
 * The control set here edits the reporting range THROUGH the header's state
 * (`onSelectPeriod` → the flow time group's explicit period), so the header and
 * the heatmap can never show two different windows. TWO rows (v2.7 final
 * follow-ups, Workstream A — cashflow/HeatmapPeriodControls.tsx):
 *   row 1 (always, never displaced) — Month · Quarter · Year (fixed-width
 *     segments; selects the calendar unit CONTAINING the current window's end:
 *     on 1M ending Oct 27 ⇒ Oct 2026 · Q4 2026 · 2026) and the page's measure;
 *   row 2 (only while a unit is active) — ◀ · the unit's label (opens the direct
 *     month / quarter / year picker) · ▶ · Reset (back to the rolling 1M default
 *     via `onResetPeriod`; the measure is kept). Arrows and picker share ONE range
 *     bound: never past today, never before the first data-bearing date.
 * Choosing a header preset clears the explicit unit (the header is the master), and
 * the heatmap then paints that preset's own range with no unit active.
 *
 * It computes nothing new: the calendar consumes the contract's pre-projected
 * per-day facts (projectDailyFacts — the same authority as the totals); the day
 * drill opens exactly the rows behind the selected measures (rowsForMeasures).
 * Controls stop pointerdown so they can't perturb a section drag source.
 */

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { CashFlowCalendar } from "@/components/space/widgets/CashFlowCalendar";
import { TransactionSliceDrawer, useTransactionSlice } from "@/components/space/widgets/TransactionSliceDrawer";
import { tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { rowsForMeasures, type DayFacts } from "@/lib/transactions/cash-flow-projection";
import { CashFlowMeasureSelect, defaultFilterFor, filterById, filtersForPage } from "@/components/space/widgets/CashFlowFilterControls";
import {
  filterByPeriod,
  asOfAnchor,
  dataBearingYears,
  periodKey,
  periodLabel,
  type CashFlowPeriod,
  type ExplicitCashFlowPeriod,
} from "@/lib/transactions/cash-flow";
import { calendarNavigation } from "@/lib/space/perspective-time-groups";
import { HeatmapPeriodRow, HeatmapPrimaryRow } from "@/components/space/widgets/cashflow/HeatmapPeriodControls";

export type ActivityPage = "cashFlow" | "spending";

/** v2.7 — Spending's heatmap legend. A spending day paints on the negative side
 *  (money spent); a day whose refunds exceed its purchases paints positive. */
export const SPENDING_LEGEND = { positive: "Refunds exceeded spending", negative: "Spending", neutral: "No spending" } as const;

const EMPTY_COPY: Record<ActivityPage, { headline: string; sub: string }> = {
  cashFlow: { headline: "No money moved in this period", sub: "Daily cash movement appears as transactions accumulate." },
  spending: { headline: "No spending in this period", sub: "Daily spending appears once you have purchases." },
};

function EmptyCard({ page }: { page: ActivityPage }) {
  return (
    <div className="text-center py-8">
      <p className="text-sm text-[var(--text-muted)]">{EMPTY_COPY[page].headline}</p>
      <p className="text-xs text-[var(--text-faint)] mt-1">{EMPTY_COPY[page].sub}</p>
    </div>
  );
}

const TRACK = { background: "var(--glass-ultrathin)", border: "1px solid var(--border-hairline)" } as const;

// ─── All Time year navigation (bounded single-year calendar) ──────────────────

/** ◀ / ▶ across the data-bearing years (newest-first) for the All Time calendar —
 *  a DISPLAY cursor only (the reporting range stays All Time). */
function AllTimeYearNav({ year, years, onChange }: { year: number; years: number[]; onChange: (y: number) => void }) {
  const idx   = years.indexOf(year);
  const older = years[idx + 1];
  const newer = years[idx - 1];
  const btn = "flex items-center justify-center h-6 w-6 rounded-[var(--radius-full)] text-[var(--text-muted)] enabled:hover:text-[var(--text-secondary)] disabled:opacity-30 disabled:cursor-default transition-colors max-lg:h-10 max-lg:w-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]";
  return (
    <div className="inline-flex items-center gap-1.5" onPointerDown={(e) => e.stopPropagation()} data-heatmap-year-nav>
      <button type="button" aria-label="Older year" disabled={older == null} onClick={() => older != null && onChange(older)} className={btn} style={TRACK}>
        <ChevronLeft size={14} />
      </button>
      <span className="text-xs font-semibold tabular-nums text-[var(--text-secondary)] min-w-[3ch] text-center">{year}</span>
      <button type="button" aria-label="Newer year" disabled={newer == null} onClick={() => newer != null && onChange(newer)} className={btn} style={TRACK}>
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

// ─── Widget ───────────────────────────────────────────────────────────────────

interface Props {
  transactions:   Transaction[] | null | undefined;
  /** THE reporting period (the header's — a relative preset or an explicit unit). */
  period:         CashFlowPeriod;
  /** Canonical As-of clock — anchors the calendar's month grid to the selected window. */
  now?:           () => Date;
  /** The selected As Of (YYYY-MM-DD) — the window's end for a relative preset, and
   *  the fallback anchor when no pre-windowed rows are supplied. */
  asOf?:          string;
  /** Today (YYYY-MM-DD) — the newest unit the stepper may reach. Absent ⇒ asOf. */
  today?:         string;
  ctx?:           ConversionContext;
  /** Account tiers — the calendar resolves the liquidity axis via these. */
  accounts:       { id: string; type: string }[];
  /** Which page hosts the heatmap — selects the measures it offers. Default Cash Flow. */
  page?:          ActivityPage;
  /** Move the page's reporting period to an explicit calendar unit (the header follows). */
  onSelectPeriod?: (period: ExplicitCashFlowPeriod) => void;
  /** Reset the page's period to the rolling 1M default (clears the explicit unit). */
  onResetPeriod?: () => void;
  /** Pre-computed slices from CashFlowSpaceData (the workspace composition boundary). */
  windowRows?:    Transaction[];
  daily?:         Map<string, DayFacts>;
}

/** The Activity heatmap (calendar only) with its compact reporting-unit controls. */
export function CashFlowHistoryWidget({ transactions, period, now, asOf, today, ctx, accounts, page = "cashFlow", onSelectPeriod, onResetPeriod, windowRows, daily }: Props) {
  const key = periodKey(period);
  const options = filtersForPage(page);
  const [filterId, setFilterId] = useState<string>(defaultFilterFor(page === "spending" ? "economic" : "liquidity").id);
  const activeFilter = options.find((f) => f.id === filterId) ?? filterById(options[0].id);
  const measures = activeFilter.measures;

  // All Time calendar — a bounded, navigable single year (display cursor only).
  const dataYears = dataBearingYears(transactions ?? []);
  const [viewYear, setViewYear] = useState<number | null>(null);
  const effectiveViewYear = viewYear != null && dataYears.includes(viewYear) ? viewYear : (dataYears[0] ?? null);

  // Drill-down slice drawer (local, in-place). Closes when the period moves.
  const [slice, setSlice] = useTransactionSlice(key);

  // The reporting-unit navigation, derived from the ONE period (never stored here).
  let earliest: string | null = null;
  for (const t of transactions ?? []) if (t.date && (earliest == null || t.date < earliest)) earliest = t.date;
  const windowEnd = asOf ?? today ?? "";
  const nav = windowEnd ? calendarNavigation({ period, windowEnd, today: today ?? windowEnd, earliest }) : null;

  const windowed = transactions == null ? null : (windowRows ?? filterByPeriod(transactions, period, asOfAnchor(asOf)));
  const showYearNav = windowed != null && windowed.length > 0 && period === "ALL" && effectiveViewYear != null;

  // Row 1 never changes shape; row 2 exists only while a unit is active (or, under
  // the All Time header preset, carries that preset's display-year cursor).
  const explicit = typeof period === "object" ? period : null;
  const controls = (
    <div className="space-y-2 min-w-0">
      <HeatmapPrimaryRow
        scale={nav?.scale ?? null}
        onPick={onSelectPeriod && nav ? (s) => onSelectPeriod(nav.choose[s]) : undefined}
        measure={<CashFlowMeasureSelect options={options} filterId={activeFilter.id} onChange={setFilterId} />}
      />
      {onSelectPeriod && nav?.scale && explicit
        ? <HeatmapPeriodRow period={explicit} label={periodLabel(period)} prev={nav.prev} next={nav.next}
            earliest={earliest} today={today ?? windowEnd} onSelect={onSelectPeriod} onReset={onResetPeriod} />
        : showYearNav && effectiveViewYear != null
          ? <AllTimeYearNav year={effectiveViewYear} years={dataYears} onChange={setViewYear} />
          : null}
    </div>
  );

  if (transactions == null) {
    return (
      <div className="space-y-3">
        {controls}
        <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading activity…</p>
      </div>
    );
  }
  const rows = windowed ?? [];
  const anchorDate = asOfAnchor(asOf);
  const gridClock = now ?? (anchorDate ? () => anchorDate : undefined);

  // The drill-down surfaces ONLY the rows behind the selected measures, so the
  // drawer reconciles with the heat-map cell. Same classifier as the totals.
  const liqCtx = tierResolver(accounts);
  const openDay = (iso: string, label: string) => {
    const dayRows = rows.filter((t) => t.date === iso);
    setSlice({ title: label, subtitle: `${activeFilter.label} · this day`, measureLabel: activeFilter.label,
      rows: rowsForMeasures(dayRows as LiquidityTx[], measures, liqCtx), allRows: dayRows });
  };

  return (
    <div className="space-y-3">
      {controls}
      {rows.length === 0
        ? <EmptyCard page={page} />
        : (
          <CashFlowCalendar
            transactions={rows} period={period} now={gridClock} ctx={ctx} accounts={accounts}
            measures={measures} onSelectDay={openDay}
            viewYear={period === "ALL" ? effectiveViewYear ?? undefined : undefined}
            daily={daily}
            legend={page === "spending" ? SPENDING_LEGEND : undefined}
          />
        )}

      <TransactionSliceDrawer slice={slice} ctx={ctx} onClose={() => setSlice(null)} />
    </div>
  );
}
