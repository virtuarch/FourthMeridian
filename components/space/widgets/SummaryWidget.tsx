"use client";

/**
 * SummaryWidget
 *
 * Generic financial summary card. A single component that powers any widget
 * whose job is: "show a headline number, then optionally show context."
 *
 * Supports two layout patterns that commonly appear in financial dashboards:
 *
 *   Pattern A — Headline + stat grid (no rows)
 *     net_worth → total, assets vs. debt
 *
 *   Pattern B — Headline + account list (rows, no stat grid)
 *     debt_summary      → total debt, each debt account
 *     investment_summary → total investments, each investment account
 *     mortgage_tracker  → same as debt_summary
 *     auto_loan_tracker → same as debt_summary
 *
 * Both patterns can coexist (stats grid + rows) for future use.
 *
 * ── Design contract ──────────────────────────────────────────────────────────
 * Pure presenter. All data extraction and formatting happen in SectionRegistry
 * adapters inside SpaceDashboard.tsx. This component only renders.
 *
 * Trend is a forward-looking placeholder: currently renders a small directional
 * icon next to the primary value. Future: replace with an inline sparkline.
 */

import { TrendingUp, TrendingDown, Minus } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SummaryColor  = "white" | "green" | "red" | "blue" | "orange" | "purple";
export type SummaryAccent = "green"  | "red"  | "blue" | "orange" | "purple" | "default";
export type SummaryTrend  = "up" | "down" | "flat";

export interface SummaryPrimary {
  /** Pre-formatted value string (e.g. "$12,450"). */
  value:  string;
  /** Sub-label shown below the value (e.g. "Net worth across all shared accounts"). */
  label?: string;
  /** Text colour applied to the value. Default: "white". */
  color?: SummaryColor;
  /**
   * Font size of the value.
   * "3xl" → text-3xl (hero stat, no rows — e.g. net worth)
   * "2xl" → text-2xl (sub-hero, typically has a rows list below — e.g. debt total)
   * Default: "3xl"
   */
  size?: "2xl" | "3xl";
}

export interface SummarySecondary {
  /** Pre-formatted value string. */
  value:  string;
  /** Sub-label shown below the value. */
  label?: string;
  /** Text colour. Default: "white". */
  color?: SummaryColor;
}

/** One cell in the supplemental stats grid. */
export interface SummaryStat {
  label:   string;
  value:   string;
  accent?: SummaryAccent;
}

/** One row in the constituent-accounts list below the headline. */
export interface SummaryRow {
  id:          string;
  /** Primary text (e.g. account name). */
  label:       string;
  /** Secondary text (e.g. institution). */
  sublabel?:   string;
  /** Pre-formatted value (e.g. "$3,200"). */
  value:       string;
  /** Colour applied to the value. Default: "white". */
  valueColor?: SummaryColor;
}

export interface SummaryWidgetProps {
  /**
   * The headline number. Pass undefined to show the empty state.
   */
  primary?:   SummaryPrimary;
  secondary?: SummarySecondary;
  /** Up to 4 stats displayed in a grid below the primary metric. */
  stats?:     SummaryStat[];
  /**
   * Flat list of constituent items (e.g. individual accounts) shown below
   * the stats grid. Useful for "total + breakdown" summaries.
   */
  rows?:      SummaryRow[];
  /**
   * Directional trend indicator shown inline with the primary value.
   * Currently renders a small icon; intended for future sparkline upgrade.
   */
  trend?:     SummaryTrend;
  /** Arbitrary content rendered at the very bottom of the widget. */
  footer?:    React.ReactNode;
  /** Icon rendered in the empty state (pass a sized lucide icon node). */
  emptyIcon?:    React.ReactNode;
  emptyHeadline?: string;
  emptySubline?:  string;
}

// ─── Color maps (literal strings — Tailwind must see these at build time) ─────

const VALUE_COLOR: Record<SummaryColor, string> = {
  white:  "text-white",
  green:  "text-green-400",
  red:    "text-red-400",
  blue:   "text-blue-400",
  orange: "text-orange-400",
  purple: "text-purple-400",
};

const ACCENT_TEXT: Record<SummaryAccent, string> = {
  green:   "text-green-400",
  red:     "text-red-400",
  blue:    "text-blue-400",
  orange:  "text-orange-400",
  purple:  "text-purple-400",
  default: "text-white",
};

const PRIMARY_SIZE: Record<NonNullable<SummaryPrimary["size"]>, string> = {
  "2xl": "text-2xl",
  "3xl": "text-3xl",
};

// ─── Stat grid adaptive columns ───────────────────────────────────────────────

const STAT_GRID_COLS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
};

// ─── Component ────────────────────────────────────────────────────────────────

export function SummaryWidget({
  primary,
  secondary,
  stats,
  rows,
  trend,
  footer,
  emptyIcon,
  emptyHeadline,
  emptySubline,
}: SummaryWidgetProps) {

  // ── Empty / unconfigured state ─────────────────────────────────────────────
  if (!primary) {
    return (
      <div className="text-center py-4">
        {emptyIcon && <div className="flex justify-center mb-2">{emptyIcon}</div>}
        <p className="text-sm text-gray-500">
          {emptyHeadline ?? "Nothing to display yet."}
        </p>
        {emptySubline && (
          <p className="text-xs text-gray-600 mt-0.5 leading-relaxed max-w-xs mx-auto">
            {emptySubline}
          </p>
        )}
      </div>
    );
  }

  const primaryColorCls = VALUE_COLOR[primary.color ?? "white"];
  const primarySizeCls  = PRIMARY_SIZE[primary.size ?? "3xl"];
  const statCols        = STAT_GRID_COLS[Math.min(stats?.length ?? 0, 3)] ?? "grid-cols-2";

  return (
    <div className="space-y-3">

      {/* ── Primary metric ──────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2">
          <p className={`font-bold ${primarySizeCls} ${primaryColorCls}`}>
            {primary.value}
          </p>
          {trend === "up"   && <TrendingUp   size={16} className="text-green-400 shrink-0" />}
          {trend === "down" && <TrendingDown  size={16} className="text-red-400   shrink-0" />}
          {trend === "flat" && <Minus         size={16} className="text-gray-500  shrink-0" />}
        </div>
        {primary.label && (
          <p className="text-xs text-gray-500 mt-0.5">{primary.label}</p>
        )}
      </div>

      {/* ── Secondary metric ────────────────────────────────────────────── */}
      {secondary && (
        <div>
          <p className={`text-xl font-semibold ${VALUE_COLOR[secondary.color ?? "white"]}`}>
            {secondary.value}
          </p>
          {secondary.label && (
            <p className="text-xs text-gray-500 mt-0.5">{secondary.label}</p>
          )}
        </div>
      )}

      {/* ── Stats grid ──────────────────────────────────────────────────── */}
      {stats && stats.length > 0 && (
        <div className={`grid gap-3 ${statCols}`}>
          {stats.map((stat) => (
            <div key={stat.label} className="bg-gray-800/50 rounded-xl p-3">
              <p className="text-xs text-gray-500 mb-1">{stat.label}</p>
              <p className={`text-lg font-semibold ${ACCENT_TEXT[stat.accent ?? "default"]}`}>
                {stat.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ── Rows (constituent accounts / items) ─────────────────────────── */}
      {rows && rows.length > 0 && (
        <div className="space-y-1">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex items-center gap-3 px-3 py-2 rounded-xl bg-gray-800/40"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{row.label}</p>
                {row.sublabel && (
                  <p className="text-xs text-gray-500">{row.sublabel}</p>
                )}
              </div>
              <p className={`text-sm font-medium shrink-0 ${VALUE_COLOR[row.valueColor ?? "white"]}`}>
                {row.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      {footer && <div>{footer}</div>}
    </div>
  );
}
