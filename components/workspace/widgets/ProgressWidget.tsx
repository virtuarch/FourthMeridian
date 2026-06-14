"use client";

/**
 * ProgressWidget
 *
 * Generic progress-toward-target widget. A single component that powers:
 *
 *   trip_budget           — spending against a capped budget   (mode: spending)
 *   trip_savings          — saving toward a trip target        (mode: savings)
 *   emergency_fund        — savings vs. months-of-expenses     (mode: savings)
 *   retirement_progress   — investments toward a target        (mode: savings)
 *
 * And any future savings-goal or budget-cap widget.
 *
 * ── Design contract ──────────────────────────────────────────────────────────
 * Pure presenter. All data computation (balances from accounts, FV projections,
 * target derivation) happens in the SectionRegistry adapters inside
 * WorkspaceDashboard.tsx. This component only knows how to render numbers.
 *
 * ── Mode semantics ───────────────────────────────────────────────────────────
 * "savings"  — filling the bar is good; ≥100% = goal achieved (green).
 * "spending" — filling the bar is a warning; ≥100% = over budget (red).
 */

import { Calendar, CheckCircle2 } from "lucide-react";
import { formatCurrency, formatDate, formatPercent } from "@/lib/format";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Controls bar + primary-amount colour semantics.
 * "savings"  — progress toward a goal; over 100% is celebrated.
 * "spending" — progress toward a cap; over 100% is a warning.
 */
export type ProgressMode = "savings" | "spending";

/** Base colour palette for savings-mode bars and primary amounts. */
export type ProgressTheme = "blue" | "green" | "orange" | "purple";

/** One cell in the supplemental stats grid below the progress bar. */
export interface ProgressStat {
  label:   string;
  value:   string;
  /** Optional colour applied to the value text. */
  accent?: "green" | "red" | "orange" | "blue" | "purple" | "default";
}

export interface ProgressWidgetProps {
  // ── Core numbers ────────────────────────────────────────────────────────────
  /**
   * Current amount (saved, spent, invested, etc.).
   * Pass null if the data source has not returned a usable value.
   * The widget treats null as 0 when a targetAmount is set.
   */
  currentAmount: number | null;
  /**
   * Target amount (goal, budget cap, etc.).
   * null or ≤ 0 → widget is unconfigured → empty state shown.
   */
  targetAmount: number | null;
  /** ISO 4217 currency code. Defaults to DEFAULT_DISPLAY_CURRENCY. */
  currency?: string;

  // ── Labels ──────────────────────────────────────────────────────────────────
  /** Appears below the primary large number. e.g. "Saved", "Spent", "Balance" */
  currentLabel?: string;
  /** Appears in the "X of Y" line. e.g. "Goal", "Budget", "Target" */
  targetLabel?: string;
  /** Short suffix after the percentage. e.g. "funded", "of budget used" */
  progressLabel?: string;

  // ── Behaviour ───────────────────────────────────────────────────────────────
  /** Default: "savings" */
  mode?: ProgressMode;
  /** Base colour theme for savings mode. Default: "blue" */
  theme?: ProgressTheme;

  // ── Supplemental stats ──────────────────────────────────────────────────────
  /**
   * Up to 4 stats displayed in a 1–2 column grid below the bar.
   * Computed by the adapter in WorkspaceDashboard — this component just renders.
   */
  stats?: ProgressStat[];

  // ── Deadline ────────────────────────────────────────────────────────────────
  /** ISO date string, e.g. "2025-06-15" */
  deadline?: string;
  /** Label shown before the date. Default: "Target date" */
  deadlineLabel?: string;

  // ── Empty state copy ────────────────────────────────────────────────────────
  emptyHeadline?: string;
  emptySubline?: string;
}

// ─── Color maps (literal strings so Tailwind includes all classes) ────────────

const THEME_BAR: Record<ProgressTheme, string> = {
  blue:   "bg-blue-500",
  green:  "bg-green-500",
  orange: "bg-orange-500",
  purple: "bg-purple-500",
};

const THEME_TEXT: Record<ProgressTheme, string> = {
  blue:   "text-blue-400",
  green:  "text-green-400",
  orange: "text-orange-400",
  purple: "text-purple-400",
};

const ACCENT_TEXT: Record<NonNullable<ProgressStat["accent"]>, string> = {
  green:   "text-green-400",
  red:     "text-red-400",
  orange:  "text-orange-400",
  blue:    "text-blue-400",
  purple:  "text-purple-400",
  default: "text-white",
};

// ─── Derived colour helpers ───────────────────────────────────────────────────

function barClass(pct: number, mode: ProgressMode, theme: ProgressTheme): string {
  if (mode === "spending") {
    if (pct >= 100) return "bg-red-500";
    if (pct >= 90)  return "bg-orange-500";
    if (pct >= 70)  return "bg-yellow-500";
    return "bg-green-500";
  }
  // savings — theme colour until complete, then always green
  return pct >= 100 ? "bg-green-500" : THEME_BAR[theme];
}

function primaryAmountClass(
  pct: number,
  mode: ProgressMode,
  theme: ProgressTheme,
): string {
  if (mode === "spending") {
    return pct >= 100 ? "text-red-400" : "text-white";
  }
  return pct >= 100 ? "text-green-400" : THEME_TEXT[theme];
}

function pctTextClass(pct: number, mode: ProgressMode, theme: ProgressTheme): string {
  if (mode === "spending") {
    if (pct >= 100) return "text-red-400";
    if (pct >= 70)  return "text-orange-400";
    return "text-green-400";
  }
  return pct >= 100 ? "text-green-400" : THEME_TEXT[theme];
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProgressWidget({
  currentAmount,
  targetAmount,
  currency      = DEFAULT_DISPLAY_CURRENCY,
  currentLabel,
  targetLabel,
  progressLabel,
  mode          = "savings",
  theme         = "blue",
  stats,
  deadline,
  deadlineLabel = "Target date",
  emptyHeadline,
  emptySubline,
}: ProgressWidgetProps) {

  // ── Empty / unconfigured state ─────────────────────────────────────────────
  if (targetAmount == null || targetAmount <= 0) {
    return (
      <div className="text-center py-5 space-y-1">
        <p className="text-sm text-gray-400">
          {emptyHeadline ?? "This widget hasn't been configured yet."}
        </p>
        <p className="text-xs text-gray-600 leading-relaxed max-w-xs mx-auto">
          {emptySubline ?? "Add a target amount in Settings to start tracking progress."}
        </p>
      </div>
    );
  }

  const current = currentAmount ?? 0;
  const pct     = (current / targetAmount) * 100;
  const isComplete = mode === "savings" && pct >= 100;
  const isOver     = mode === "spending" && pct >= 100;

  const barW          = `${Math.min(100, pct).toFixed(2)}%`;
  const barCls        = barClass(pct, mode, theme);
  const amountCls     = primaryAmountClass(pct, mode, theme);
  const pctCls        = pctTextClass(pct, mode, theme);

  return (
    <div className="space-y-4">

      {/* ── Primary amount ──────────────────────────────────────────────── */}
      <div>
        <div className="flex items-end gap-2">
          <p className={`text-3xl font-bold ${amountCls}`}>
            {formatCurrency(current, currency)}
          </p>
          {isComplete && (
            <CheckCircle2 size={18} className="text-green-400 mb-1 shrink-0" />
          )}
        </div>
        {currentLabel && (
          <p className="text-xs text-gray-500 mt-0.5">{currentLabel}</p>
        )}
      </div>

      {/* ── Progress bar ────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${barCls}`}
            style={{ width: barW }}
          />
        </div>

        <div className="flex items-center justify-between text-xs">
          {/* Left: percentage */}
          <span className={`font-semibold ${pctCls}`}>
            {formatPercent(pct)}
            {progressLabel && (
              <span className="font-normal text-gray-600 ml-1">{progressLabel}</span>
            )}
          </span>

          {/* Right: X of Y */}
          <span className="text-gray-600">
            {formatCurrency(current, currency)}
            <span className="mx-1 text-gray-700">/</span>
            {targetLabel && <span className="text-gray-500">{targetLabel} </span>}
            {formatCurrency(targetAmount, currency)}
          </span>
        </div>
      </div>

      {/* ── Over-budget / complete banners ──────────────────────────────── */}
      {isOver && (
        <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20">
          <p className="text-xs text-red-400">
            Over budget by {formatCurrency(current - targetAmount, currency)}
          </p>
        </div>
      )}
      {isComplete && (
        <div className="px-3 py-2 rounded-xl bg-green-500/10 border border-green-500/20">
          <p className="text-xs text-green-400">
            Goal reached — {formatCurrency(current - targetAmount, currency)} ahead of target
          </p>
        </div>
      )}

      {/* ── Stats grid ──────────────────────────────────────────────────── */}
      {stats && stats.length > 0 && (
        <div className={`grid gap-3 ${stats.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
          {stats.map((stat) => (
            <div key={stat.label} className="bg-gray-800/50 rounded-xl p-3">
              <p className="text-xs text-gray-500 mb-1">{stat.label}</p>
              <p className={`text-base font-semibold ${ACCENT_TEXT[stat.accent ?? "default"]}`}>
                {stat.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ── Deadline ────────────────────────────────────────────────────── */}
      {deadline && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Calendar size={12} className="shrink-0" />
          <span>
            {deadlineLabel}: <span className="text-gray-400">{formatDate(deadline)}</span>
          </span>
        </div>
      )}
    </div>
  );
}
