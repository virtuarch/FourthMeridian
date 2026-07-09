"use client";

/**
 * components/space/widgets/goals-perspective-adapters.tsx
 *
 * Goals Perspective widgets (UX-PER-3). The Goals workspace answers ONE
 * question — "Am I on track?" — about TRAJECTORY vs TARGET, not current
 * balances. No net worth, allocation, debt payoff, spending, or investment
 * performance.
 *
 * Mirrors the wealth/liquidity/cash-flow/debt adapters: pure presentational
 * render functions over the EXISTING BreakdownWidget / SummaryWidget presenters
 * plus a lightweight progress-bar list (no new chart system). All math comes
 * from the pure lib/goals/goal-trajectory helpers.
 *
 * HONESTY: there is no dated contribution history in the model, so actual pace
 * and pace-based forecasts are NOT computed — we show only what the data
 * supports (progress, gap, overdue, and the REQUIRED monthly contribution to a
 * dated target) and say plainly that pace forecasting needs contribution
 * history.
 */

import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import { SummaryWidget } from "@/components/space/widgets/SummaryWidget";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency, formatDate } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import { Target } from "lucide-react";
import {
  activeFinancialGoals,
  progressPct,
  remainingGap,
  requiredMonthly,
  isOverdue,
  onTrackSummary,
  type TrajectoryGoal,
} from "@/lib/goals/goal-trajectory";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMoney(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);
}
function valueFormatterProps(ctx?: ConversionContext) {
  return ctx ? { formatValue: (v: number) => formatCurrency(v, ctx.target) } : {};
}

function LoadingCard() {
  return <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading goals…</p>;
}
function EmptyGoals({ sub }: { sub: string }) {
  return (
    <div className="text-center py-8">
      <Target size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
      <p className="text-sm text-[var(--text-muted)]">No financial goals yet</p>
      <p className="text-xs text-[var(--text-faint)] mt-1">{sub}</p>
    </div>
  );
}

/** Loading / empty gate shared by every goal widget. */
function resolve(goals: TrajectoryGoal[] | null | undefined) {
  if (goals == null) return { state: "loading" as const, active: [] as TrajectoryGoal[] };
  const active = activeFinancialGoals(goals);
  return { state: active.length ? ("ok" as const) : ("empty" as const), active };
}

// ─── 1. Goal Progress ─────────────────────────────────────────────────────────

/** Each active financial goal's progress toward target — ranked progress bars. */
export function renderGoalProgress(
  goals: TrajectoryGoal[] | null | undefined,
  ctx?:  ConversionContext,
): React.ReactElement {
  const { state, active } = resolve(goals);
  if (state === "loading") return <LoadingCard />;
  if (state === "empty") return <EmptyGoals sub="Create a financial goal to track progress toward it." />;

  const rows = [...active].sort((a, b) => progressPct(b) - progressPct(a));

  return (
    <div className="space-y-3">
      {rows.map((g) => {
        const pct = progressPct(g);
        const overdue = isOverdue(g);
        const color = pct >= 100 ? "var(--accent-positive)" : overdue ? "var(--accent-negative)" : "var(--accent-info)";
        return (
          <div key={g.id} className="space-y-1">
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-[var(--text-secondary)] truncate">{g.name}</span>
              <span className="font-semibold" style={{ color }}>{pct.toFixed(0)}%</span>
            </div>
            <div className="h-2 rounded-full bg-[var(--surface-inset)] overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
            </div>
            <p className="text-[10px] text-[var(--text-faint)]">
              {fmtMoney(g.currentAmount, ctx)} of {fmtMoney(g.targetAmount ?? 0, ctx)}
              {g.targetDate ? ` · by ${formatDate(g.targetDate)}${overdue ? " · overdue" : ""}` : ""}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ─── 2. On Track (summary + honest projection note) ───────────────────────────

/** How many goals are on track (by deadline), how many overdue — and an honest
 *  statement that pace-based projection needs contribution history. */
export function renderGoalOnTrack(
  goals: TrajectoryGoal[] | null | undefined,
): React.ReactElement {
  const { state, active } = resolve(goals);
  if (state === "loading") return <LoadingCard />;
  if (state === "empty") return <EmptyGoals sub="Progress tracking appears once you have a financial goal." />;

  const s = onTrackSummary(active);

  return (
    <SummaryWidget
      primary={{
        value: `${s.onTrack} of ${s.active}`,
        label: "goals on track by their deadline",
        color: s.overdue > 0 ? "orange" : "green",
        size:  "3xl",
      }}
      stats={[
        { label: "Fully funded", value: `${s.funded}`, accent: s.funded > 0 ? "green" : "default" },
        { label: "Overdue",      value: `${s.overdue}`, accent: s.overdue > 0 ? "red" : "default" },
        // Honest data-thin: no dated contributions ⇒ no actual-pace forecast.
        { label: "Pace forecast", value: "Needs contribution history" },
      ]}
    />
  );
}

// ─── 3. Required Contribution Pace ─────────────────────────────────────────────

/** For goals with a target date, the monthly amount needed to hit the target on
 *  time. This is what you'd NEED to contribute — actual pace isn't tracked. */
export function renderGoalRequiredPace(
  goals: TrajectoryGoal[] | null | undefined,
  ctx?:  ConversionContext,
): React.ReactElement {
  const { state, active } = resolve(goals);
  if (state === "loading") return <LoadingCard />;
  if (state === "empty") return <EmptyGoals sub="Set a target date on a goal to see the required monthly pace." />;

  const dated = active.filter((g) => g.targetDate);
  if (dated.length === 0) {
    return (
      <div className="text-center py-8">
        <Target size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">No dated goals</p>
        <p className="text-xs text-[var(--text-faint)] mt-1">Add a target date to a goal to see the required monthly contribution.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {dated
        .sort((a, b) => (a.targetDate! < b.targetDate! ? -1 : 1))
        .map((g) => {
          const req = requiredMonthly(g);
          const overdue = isOverdue(g);
          return (
            <div key={g.id} className="flex items-center justify-between gap-3 text-[12px]">
              <span className="text-[var(--text-secondary)] truncate">{g.name}</span>
              <span className={`font-semibold shrink-0 ${overdue ? "text-[var(--accent-negative)]" : "text-[var(--text-primary)]"}`}>
                {overdue ? "Overdue" : req != null ? `${fmtMoney(req, ctx)}/mo` : req === null && remainingGap(g) <= 0 ? "Funded" : "—"}
              </span>
            </div>
          );
        })}
      <p className="text-[10px] text-[var(--text-faint)] pt-1">Required to hit each target on time. Actual contribution pace isn’t tracked yet.</p>
    </div>
  );
}

// ─── 4. Funding Gap (which goals need the most) ───────────────────────────────

/** Goals ranked by remaining amount — where the biggest funding gaps are. */
export function renderGoalFundingGap(
  goals: TrajectoryGoal[] | null | undefined,
  ctx?:  ConversionContext,
): React.ReactElement {
  const { state, active } = resolve(goals);
  if (state === "loading") return <LoadingCard />;
  if (state === "empty") return <EmptyGoals sub="Funding gaps appear once you have a financial goal." />;

  const items: BreakdownItem[] = active
    .map((g) => ({ g, gap: remainingGap(g) }))
    .filter((x) => x.gap > 0)
    .sort((x, y) => y.gap - x.gap)
    .map(({ g, gap }) => ({
      id:    g.id,
      label: g.name,
      value: gap,
      color: isOverdue(g) ? "var(--accent-negative)" : undefined,
      meta:  g.targetDate ? `by ${formatDate(g.targetDate)}${isOverdue(g) ? " · overdue" : ""}` : undefined,
    }));

  return (
    <BreakdownWidget
      items={items}
      viewMode="bar"
      itemNoun="goal"
      emptyHeadline="All goals funded"
      emptySubline="Every financial goal has reached its target — nice."
      {...valueFormatterProps(ctx)}
    />
  );
}
