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
 * SpaceDashboard.tsx. This component only knows how to render numbers.
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

/** Base colour theme (retained for API compatibility; no longer tints the bar
 *  under the Atlas token system — decorative theming resolves to neutral ink). */
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
  /** Base colour theme for savings mode. Retained for API compatibility; now
   *  ignored for colour (decorative theming → neutral ink under Atlas tokens). */
  theme?: ProgressTheme;

  // ── Supplemental stats ──────────────────────────────────────────────────────
  /**
   * Up to 4 stats displayed in a 1–2 column grid below the bar.
   * Computed by the adapter in SpaceDashboard — this component just renders.
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

// ─── Colour maps → Atlas tokens (Step B) ──────────────────────────────────────
// Semantic state only: green → positive, red → negative. Caution (orange) and
// decorative (blue/purple) resolve to neutral ink — colour is reserved for
// genuine good/over states. (A distinct caution/warning tone has no token yet.)

const ACCENT_TEXT: Record<NonNullable<ProgressStat["accent"]>, string> = {
  green:   "var(--accent-positive)",
  red:     "var(--accent-negative)",
  orange:  "var(--text-primary)",
  blue:    "var(--text-primary)",
  purple:  "var(--text-primary)",
  default: "var(--text-primary)",
};

// ─── Derived colour helpers (return Atlas token strings) ──────────────────────

function barColor(pct: number, mode: ProgressMode): string {
  if (mode === "spending") {
    if (pct >= 100) return "var(--accent-negative)"; // over budget
    if (pct >= 70)  return "var(--text-secondary)";  // caution → neutral
    return "var(--accent-positive)";                  // comfortably under budget
  }
  // savings — neutral until complete, then celebrated green
  return pct >= 100 ? "var(--accent-positive)" : "var(--text-secondary)";
}

function primaryAmountColor(pct: number, mode: ProgressMode): string {
  if (mode === "spending") return pct >= 100 ? "var(--accent-negative)" : "var(--text-primary)";
  return pct >= 100 ? "var(--accent-positive)" : "var(--text-primary)";
}

function pctTextColor(pct: number, mode: ProgressMode): string {
  if (mode === "spending") {
    if (pct >= 100) return "var(--accent-negative)";
    if (pct >= 70)  return "var(--text-secondary)"; // caution → neutral
    return "var(--accent-positive)";
  }
  return pct >= 100 ? "var(--accent-positive)" : "var(--text-secondary)";
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
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {emptyHeadline ?? "This widget hasn't been configured yet."}
        </p>
        <p className="text-xs leading-relaxed max-w-xs mx-auto" style={{ color: "var(--text-faint)" }}>
          {emptySubline ?? "Add a target amount in Settings to start tracking progress."}
        </p>
      </div>
    );
  }

  const current = currentAmount ?? 0;
  const pct     = (current / targetAmount) * 100;
  const isComplete = mode === "savings" && pct >= 100;
  const isOver     = mode === "spending" && pct >= 100;

  const barW = `${Math.min(100, pct).toFixed(2)}%`;

  return (
    <div className="space-y-4">

      {/* ── Primary amount ──────────────────────────────────────────────── */}
      <div>
        <div className="flex items-end gap-2">
          <p className="text-3xl font-bold" style={{ color: primaryAmountColor(pct, mode) }}>
            {formatCurrency(current, currency)}
          </p>
          {isComplete && (
            <CheckCircle2 size={18} className="mb-1 shrink-0" style={{ color: "var(--accent-positive)" }} />
          )}
        </div>
        {currentLabel && (
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{currentLabel}</p>
        )}
      </div>

      {/* ── Progress bar ────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--surface-inset)" }}>
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: barW, background: barColor(pct, mode) }}
          />
        </div>

        <div className="flex items-center justify-between text-xs">
          {/* Left: percentage */}
          <span className="font-semibold" style={{ color: pctTextColor(pct, mode) }}>
            {formatPercent(pct)}
            {progressLabel && (
              <span className="font-normal ml-1" style={{ color: "var(--text-faint)" }}>{progressLabel}</span>
            )}
          </span>

          {/* Right: X of Y */}
          <span style={{ color: "var(--text-faint)" }}>
            {formatCurrency(current, currency)}
            <span className="mx-1" style={{ color: "var(--text-faint)" }}>/</span>
            {targetLabel && <span style={{ color: "var(--text-muted)" }}>{targetLabel} </span>}
            {formatCurrency(targetAmount, currency)}
          </span>
        </div>
      </div>

      {/* ── Over-budget / complete banners ──────────────────────────────── */}
      {isOver && (
        <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20">
          <p className="text-xs" style={{ color: "var(--accent-negative)" }}>
            Over budget by {formatCurrency(current - targetAmount, currency)}
          </p>
        </div>
      )}
      {isComplete && (
        <div className="px-3 py-2 rounded-xl bg-green-500/10 border border-green-500/20">
          <p className="text-xs" style={{ color: "var(--accent-positive)" }}>
            Goal reached — {formatCurrency(current - targetAmount, currency)} ahead of target
          </p>
        </div>
      )}

      {/* ── Stats grid ──────────────────────────────────────────────────── */}
      {stats && stats.length > 0 && (
        <div className={`grid gap-3 ${stats.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-xl p-3" style={{ background: "var(--surface-inset)" }}>
              <p className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>{stat.label}</p>
              <p className="text-base font-semibold" style={{ color: ACCENT_TEXT[stat.accent ?? "default"] }}>
                {stat.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ── Deadline ────────────────────────────────────────────────────── */}
      {deadline && (
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
          <Calendar size={12} className="shrink-0" />
          <span>
            {deadlineLabel}: <span style={{ color: "var(--text-secondary)" }}>{formatDate(deadline)}</span>
          </span>
        </div>
      )}
    </div>
  );
}
