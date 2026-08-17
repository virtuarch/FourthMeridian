"use client";

/**
 * components/space/sections/SectionRegistry.tsx  (SEC-2)
 *
 * The section RENDERER CATALOG — the section-key → renderer dispatch map plus the
 * renderers and helpers it wires. Split out of the former SpaceSections.tsx so
 * the catalog (what draws inside a section; changes when section TYPES change) is
 * a distinct module from the card chrome (./SectionCard.tsx, which changes when
 * card PRESENTATION changes). One-way dependency: SectionCard imports
 * SectionRegistry + ContextualCard + toDisplay from here; nothing here imports
 * SectionCard.
 *
 * REVIEW-3 (slice F) — the catalog was cut to keys a surface can still reach.
 * Persisted SpaceDashboardSection rows render in exactly two places now: the
 * GOALS / RETIREMENT routed modals (deep-link only), plus the goals widgets[]
 * virtual-section path. The Overview canvas — the only mount for the
 * net_worth / net_worth_chart / allocation lede and the perspective widget
 * keys (wealth_* / liquidity_* / cash_flow_* / debt-perspective keys, whose
 * perspectives render via WORKSPACE_RENDERERS, never via widgets[]) — was
 * deleted, so those entries and their renderers (renderNetWorth,
 * renderDebtSummary, NetWorthChartSection, AllocationSection, the
 * NetWorthChart family) are gone. Production rows with deleted keys are gated
 * out at render time by the host's hasRenderer check and stay visible /
 * toggleable in Manage → Sections; ContextualCard remains the graceful
 * unknown-key fallback.
 */

import React from "react";
import { LayoutDashboard, TrendingUp } from "lucide-react";
import { getWidgetMeta } from "@/lib/widget-registry";
import { AssetValueWidget, type AssetValueConfig } from "@/components/space/widgets/AssetValueWidget";
import { ProgressWidget, type ProgressStat } from "@/components/space/widgets/ProgressWidget";
import { type BreakdownViewMode } from "@/components/space/widgets/BreakdownWidget";
import { SummaryWidget } from "@/components/space/widgets/SummaryWidget";
import { formatBalance } from "@/lib/currency";
import { GoalsCard } from "@/components/space/sections/goals/GoalsCard";
import { renderDebtBreakdownChart, renderDebtPayoffCalculator } from "@/components/space/widgets/debt-adapters";
import { renderGoalProgress, renderGoalOnTrack, renderGoalRequiredPace, renderGoalFundingGap, GoalPerspectiveWidget } from "@/components/space/widgets/goals-perspective-adapters";
import { type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import type { CashFlowPerspective } from "@/lib/transactions/cash-flow-projection";
import { AccountsPerspective } from "@/components/space/widgets/accounts/AccountsPerspective";
import { TimelineWidget } from "@/components/space/widgets/TimelineWidget";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot, Transaction } from "@/types";
import type { SpaceAccount } from "@/lib/space/dashboard-types";

// ─── Section cards ────────────────────────────────────────────────────────────

function ActivityCard({ spaceId }: { spaceId: string }) {
  return <TimelineWidget spaceId={spaceId} pageSize={10} />;
}
/**
 * Contextual empty state for section keys that have no real component yet.
 *
 * Hint text is sourced from the widget registry (meta.description +
 * meta.requires[0].reason) when available, with a hardcoded override table
 * for keys that need friendlier user-facing copy.
 */
export function ContextualCard({ sectionKey, label }: { sectionKey: string; label: string }) {
  // Friendly user-facing override messages (shown instead of raw registry description)
  const messages: Record<string, { body: string; hint: string }> = {
    cash_flow:               { body: "No cash flow data yet",          hint: "Connect your accounts to track income and expenses." },
    savings_rate:            { body: "Savings rate not available",     hint: "Connect accounts to calculate your monthly savings rate." },
    business_cash_flow:      { body: "Business cash flow",             hint: "Share your business accounts to track cash flow." },
    property_value:          { body: "Property value not set",         hint: "Add your property value manually or connect an integration." },
    vehicle_value:            { body: "Vehicle value not set",          hint: "Add your vehicle's current market value to track depreciation." },
    trip_budget:             { body: "No trip budget set",             hint: "Set a trip budget to start tracking expenses." },
    trip_savings:            { body: "No trip savings tracked",        hint: "Share a savings account to track progress toward your trip." },
    emergency_fund_progress: { body: "Emergency fund not set",         hint: "Set a target to track your emergency fund progress." },
    monthly_expenses:        { body: "No expense data",                hint: "Connect accounts to track monthly expenses." },
    retirement_progress:     { body: "Retirement progress",            hint: "Set a retirement target to track your progress." },
    equipment_value:         { body: "Equipment value not set",        hint: "Add your equipment's current value to track depreciation." },
  };

  const msg = messages[sectionKey];
  if (msg) {
    return (
      <div className="text-center py-5">
        <LayoutDashboard size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">{msg.body}</p>
        <p className="text-xs text-[var(--text-faint)] mt-0.5">{msg.hint}</p>
      </div>
    );
  }

  // Fall back to registry description if available
  const widgetMeta = getWidgetMeta(sectionKey);
  const hint = widgetMeta?.requires[0]?.reason ?? "This section is in development.";

  return (
    <div className="text-center py-5">
      <LayoutDashboard size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
      <p className="text-sm text-[var(--text-muted)]">{widgetMeta?.label ?? label}</p>
      <p className="text-xs text-[var(--text-faint)] mt-0.5">{hint}</p>
    </div>
  );
}

// ─── Section registry ─────────────────────────────────────────────────────────
//
// Maps section keys to their render functions.
// Adding a new section type requires ONE entry here — no switch modifications.
//
// THIS map is the dispatch authority: SectionCard consults it directly and
// falls back to ContextualCard for keys without an entry. (REVIEW-3 corrected
// the former claim that WIDGET_REGISTRY's `implemented:false` also forced the
// ContextualCard fallback — SectionCard never consulted that flag; the trimmed
// lib/widget-registry.ts no longer carries it.)

export type SectionRenderProps = {
  accounts:              SpaceAccount[];
  spaceId:           string;
  /** Wealth-timeline amendment (Phase 2) — "PERSONAL" | "SHARED"; gates the
   *  personal-only "Rebuild history" action on net_worth_chart. */
  spaceType:             string;
  canManage:             boolean;
  onAddGoal?:            () => void;
  payoffFullscreen:      boolean;
  closePayoffFullscreen: () => void;
  /** Parsed section.config — passed through to config-driven widgets */
  config:                Record<string, unknown> | null;
  /**
   * MC1 QA Q4 — conversion context targeting the Space's reporting currency
   * (rehydrated from GET /api/money/view-context in the host). Present ⇒
   * section aggregates convert per-row at the latest close and labels follow
   * ctx.target; absent (fetch pending/failed) ⇒ the original raw sums with
   * the historical default label, byte-for-byte (kill switch). Itemized
   * per-account rows stay native either way.
   */
  ctx?:                  ConversionContext;
  /**
   * Unified Space Widget Layout (slice 1) — SpaceSnapshot history for
   * snapshot-backed widgets (net_worth_chart). Host-fetched once; null while
   * loading. `snapshotCurrency` is the currency the snapshot totals are stamped
   * in (the Space's reporting currency) — the "from" currency for the chart's
   * conversion (ctx.target is the display/"view as" currency).
   */
  snapshots?:            Snapshot[] | null;
  snapshotCurrency?:     string;
  /**
   * UX-PER-3 Cash Flow — transaction history + the transactions' conversion
   * context (rehydrated spaceMoneyCtx / "view as" override, which converts each
   * row at its own date — distinct from the latest-close `ctx`) and the
   * workspace-selected period. Only the Cash Flow widgets read these; every
   * other widget ignores them. null transactions = still loading.
   */
  transactions?:         Transaction[] | null;
  txCtx?:                ConversionContext;
  period?:               CashFlowPeriod;
  /**
   * THE SELECTED AS-OF DATE (YYYY-MM-DD) — the anchor every interval widget
   * resolves its window against.
   *
   * Without it a widget fell back to `new Date()`, so a section card showed
   * TODAY's period while the dashboard displayed a historical date. The window
   * is not the widget's to choose; it is the shell's, and this is how it
   * arrives. Optional so a caller that renders no interval widget is unaffected.
   */
  asOf?:                 string;
  /** UX-PER-3 Cash Flow — move the whole Perspective to an explicit historical
   *  period from inside a widget (Cash Flow History's Month/Quarter/Year
   *  selectors). Only the Cash Flow History widget uses it. */
  onSelectPeriod?:       (period: CashFlowPeriod) => void;
  /** CF-3 — the workspace-shared Cash Flow / Spending perspective + measure filter.
   *  Every Cash Flow widget (Summary, History, Calendar, Income/Cash In by Source)
   *  reads the SAME perspective so they never disagree. Set from the History
   *  widget's mounted selector. */
  perspective?:          CashFlowPerspective;
  filterId?:             string;
  onPerspectiveChange?:  (perspective: CashFlowPerspective, filterId: string) => void;
  /**
   * UX-PER-3 Debt — the user's manual credit score for the Debt workspace's
   * credit-health companion (FicoCard). User-level, threaded from the Personal
   * host; absent ⇒ FicoCard's "add score" affordance. Never drives debt math.
   */
  ficoScore?:            number | null;
  ficoUpdatedAt?:        string;
};

// ─── ProgressWidget adapter helpers ──────────────────────────────────────────
//
// These live here (not in ProgressWidget.tsx) to keep the presenter pure.
// Each adapter converts raw section.config + accounts into typed presenter props.

/** Extract a number from an unknown config value (handles string-encoded JSON). */
function cfgNum(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

/** Extract a string from an unknown config value. */
function cfgStr(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

/**
 * MC1 QA Q4 — row amount in the display currency, valued at the latest close.
 * Without a context this is the identity pass-through (kill switch); with one,
 * unresolvable rows keep their native amount and taint the sum (plan D-3).
 */
export function toDisplay(
  amount:   number,
  currency: string | null | undefined,
  ctx?:     ConversionContext,
): { amount: number; estimated: boolean } {
  if (!ctx) return { amount, estimated: false };
  const c = convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx);
  // V25-FINAL-1 — unavailable conversion excluded (0); `estimated` (true on a miss)
  // rides through so the surface still discloses the sum is approximate/incomplete.
  return { amount: c.amount ?? 0, estimated: c.estimated };
}

/** Sum balances (in the display currency when a context is supplied) from
 *  accounts matching any of the given type strings — map-then-reduce so the
 *  estimated taint survives the sum. */
function sumAccounts(
  accounts: SpaceAccount[],
  ctx:      ConversionContext | undefined,
  ...types: string[]
): { sum: number; estimated: boolean } {
  const set  = new Set(types);
  const conv = accounts.filter((a) => set.has(a.type)).map((a) => toDisplay(a.balance, a.currency, ctx));
  return {
    sum:       conv.reduce((s, c) => s + c.amount, 0),
    estimated: conv.some((c) => c.estimated),
  };
}

/**
 * Future Value of a lump sum plus an annuity — simplified annual compounding.
 * Used for the retirement projection stat.
 *
 *   FV = PV × (1+r)^n  +  PMT × ((1+r)^n − 1) / r
 *
 * where r = annualReturnPct / 100, n = years, PMT = annualContribution.
 */
function projectFV(
  currentBalance:    number,
  annualContrib:     number,
  annualReturnPct:   number,
  years:             number,
): number {
  if (years <= 0) return currentBalance;
  const r       = annualReturnPct / 100;
  const growth  = Math.pow(1 + r, years);
  const fvLump  = currentBalance * growth;
  const fvAnnuity = r > 0
    ? annualContrib * ((growth - 1) / r)
    : annualContrib * years;
  return fvLump + fvAnnuity;
}

// ─── SectionRegistry adapter helpers ─────────────────────────────────────────
// These are reused across multiple section keys that share the same data shape.
// (renderNetWorth and renderDebtSummary were deleted in REVIEW-3 with their
// last reachable keys — the Overview lede and the render-branch-less DEBT tab.)

const renderInvestmentSummary = (p: SectionRenderProps): React.ReactElement => {
  const investments = p.accounts.filter((a) => a.type === "investment");
  // MC1 QA Q4 — headline total converts (labels follow); rows stay native.
  const conv  = investments.map((a) => toDisplay(a.balance, a.currency, p.ctx));
  const total = conv.reduce((s, c) => s + c.amount, 0);
  const est   = conv.some((c) => c.estimated) ? "≈ " : "";
  return (
    <SummaryWidget
      primary={investments.length > 0 ? {
        value: `${est}${formatBalance(total, p.ctx?.target)}`,
        label: "Total investments",
        color: "blue",
        size:  "2xl",
      } : undefined}
      rows={investments.map((a) => ({
        id:         a.id,
        label:      a.name,
        sublabel:   a.institution || undefined,
        value:      formatBalance(a.balance, a.currency),
        valueColor: "blue" as const,
      }))}
      emptyHeadline="No investment accounts shared"
      emptySubline="Share investment accounts from the Spaces page."
      emptyIcon={<TrendingUp size={22} className="text-[var(--text-faint)]" />}
    />
  );
};

export const SectionRegistry: Record<string, (p: SectionRenderProps) => React.ReactElement> = {
  // ── Goals Perspective (UX-PER-3) — trajectory vs target ─────────────────────
  // SD-7a — each Goals widget owns its data via the self-fetching wrapper (the
  // host no longer fetches or threads goals). The pure render fn still does the
  // rendering; the wrapper just supplies the goals it fetches by spaceId.
  // (Kept with the goals surface per REVIEW-3's conservative rule: goals is
  // live-but-orphaned — deep-link only — not provably retired.)
  "goal_progress":           (p) => <GoalPerspectiveWidget spaceId={p.spaceId} ctx={p.ctx} render={renderGoalProgress} />,
  "goal_on_track":           (p) => <GoalPerspectiveWidget spaceId={p.spaceId} render={renderGoalOnTrack} />,
  "goal_required_pace":      (p) => <GoalPerspectiveWidget spaceId={p.spaceId} ctx={p.ctx} render={renderGoalRequiredPace} />,
  "goal_funding_gap":        (p) => <GoalPerspectiveWidget spaceId={p.spaceId} ctx={p.ctx} render={renderGoalFundingGap} />,
  "accounts_overview":      (p) => <AccountsPerspective spaceId={p.spaceId} accounts={p.accounts} />,
  "debt_breakdown_chart": (p) => {
    const viewMode = (cfgStr(p.config?.viewMode) as BreakdownViewMode | undefined) ?? "donut";
    return renderDebtBreakdownChart(
      p.accounts,
      viewMode,
      "Share your debt accounts from Manage → Add Accounts to see your debt breakdown.",
      p.ctx,
    );
  },
  "debt_payoff_calculator": (p) => renderDebtPayoffCalculator(p.accounts, p.payoffFullscreen, p.closePayoffFullscreen, p.ctx),
  "investment_summary":     renderInvestmentSummary,
  "investment_allocation":  renderInvestmentSummary, // TODO: replace with BreakdownWidget when adapter is ready
  "retirement_accounts":    renderInvestmentSummary,
  // retirement_progress — moved to ProgressWidget family below
  "goals_progress":         (p) => <GoalsCard spaceId={p.spaceId} canManage={p.canManage} onAddGoal={p.onAddGoal} />,
  "recent_activity":        (p) => <ActivityCard spaceId={p.spaceId} />,
  // ── Config-driven asset value widgets (all powered by AssetValueWidget) ──────
  // Account resolution order:
  //   1. config.accountId — explicit pin (set via ManageSpaceModal, stored in section.config)
  //   2. Name heuristic   — regex on account.name, catches common naming conventions
  //   3. First type=other — fallback when space has only one manual asset account
  "property_value": (p) => {
    const cfg    = p.config as AssetValueConfig | null;
    const others = p.accounts.filter((a) => a.type === "other");
    const match  =
      (cfg?.accountId ? others.find((a) => a.id === cfg.accountId) : undefined) ??
      others.find((a) => /home|house|property|real.?estate|condo|apt|cabin|cottage|villa/i.test(a.name)) ??
      others[0];
    // MC1 QA Q4 — the live balance is a Space aggregate: convert into the
    // reporting currency and label to match. An explicit config.currency is
    // the legacy per-section override — respect it untouched (no conversion).
    const hasCfgCur = cfgStr(cfg?.currency) != null;
    return (
      <AssetValueWidget
        title="Property Value"
        assetType="property"
        config={cfg}
        accountBalance={match && !hasCfgCur ? toDisplay(match.balance, match.currency, p.ctx).amount : match?.balance}
        currency={hasCfgCur ? undefined : p.ctx?.target}
      />
    );
  },
  "vehicle_value": (p) => {
    const cfg    = p.config as AssetValueConfig | null;
    const others = p.accounts.filter((a) => a.type === "other");
    const match  =
      (cfg?.accountId ? others.find((a) => a.id === cfg.accountId) : undefined) ??
      others.find((a) => /car|vehicle|truck|suv|van|motor|rv|boat|cr-v|camry|f-150|tesla|bmw|audi/i.test(a.name)) ??
      others[0];
    const hasCfgCur = cfgStr(cfg?.currency) != null;
    return (
      <AssetValueWidget
        title="Vehicle Value"
        assetType="vehicle"
        config={cfg}
        accountBalance={match && !hasCfgCur ? toDisplay(match.balance, match.currency, p.ctx).amount : match?.balance}
        currency={hasCfgCur ? undefined : p.ctx?.target}
      />
    );
  },
  "equipment_value": (p) => {
    const cfg    = p.config as AssetValueConfig | null;
    const others = p.accounts.filter((a) => a.type === "other");
    const match  =
      (cfg?.accountId ? others.find((a) => a.id === cfg.accountId) : undefined) ??
      others.find((a) => /equip|tool|machine|laptop|computer|hardware|gear|camera|studio/i.test(a.name)) ??
      others[0];
    const hasCfgCur = cfgStr(cfg?.currency) != null;
    return (
      <AssetValueWidget
        title="Equipment Value"
        assetType="equipment"
        config={cfg}
        accountBalance={match && !hasCfgCur ? toDisplay(match.balance, match.currency, p.ctx).amount : match?.balance}
        currency={hasCfgCur ? undefined : p.ctx?.target}
      />
    );
  },

  // ── ProgressWidget family ─────────────────────────────────────────────────
  // Adapters compute currentAmount + targetAmount from config / accounts,
  // then pass pre-resolved numbers to the pure ProgressWidget presenter.

  "trip_budget": (p) => {
    const cfg           = p.config ?? {};
    const targetAmount  = cfgNum(cfg.totalBudget)  ?? null;
    const currentAmount = cfgNum(cfg.amountSpent)  ?? 0;
    const deadline      = cfgStr(cfg.departureDate);
    // MC1 QA Q4 — config amounts carry no currency stamp: they are entered in
    // the Space's own currency, so no conversion — labels follow ctx.target.
    const stats: ProgressStat[] = [];
    if (targetAmount != null) {
      const rem = targetAmount - currentAmount;
      stats.push({
        label:  rem >= 0 ? "Remaining" : "Over budget",
        value:  formatBalance(Math.abs(rem), p.ctx?.target),
        accent: rem >= 0 ? "green" : "red",
      });
    }
    return (
      <ProgressWidget
        currentAmount={targetAmount != null ? currentAmount : null}
        targetAmount={targetAmount}
        currency={p.ctx?.target}
        currentLabel="Spent so far"
        targetLabel="Budget"
        progressLabel="of budget used"
        mode="spending"
        theme="orange"
        stats={stats}
        deadline={deadline}
        deadlineLabel="Departure"
        emptyHeadline="Trip budget not configured"
        emptySubline="Set a total budget in Settings to start tracking your trip spending."
      />
    );
  },

  "trip_savings": (p) => {
    const cfg           = p.config ?? {};
    const targetAmount  = cfgNum(cfg.totalBudget) ?? null;
    const deadline      = cfgStr(cfg.departureDate);
    // Live balance from shared savings/checking accounts — MC1 QA Q4:
    // converted into the reporting currency so the sum is honest across
    // mixed-currency accounts; the config target is Space-native already.
    const { sum: currentAmount, estimated } = sumAccounts(p.accounts, p.ctx, "savings", "checking");
    const est = estimated ? "≈ " : "";
    const stats: ProgressStat[] = [];
    if (targetAmount != null) {
      const remaining = targetAmount - currentAmount;
      if (remaining > 0) {
        stats.push({
          label:  "Still needed",
          value:  `${est}${formatBalance(remaining, p.ctx?.target)}`,
          accent: "orange",
        });
      } else {
        stats.push({ label: "Status", value: "Goal reached! ✓", accent: "green" });
      }
    }
    return (
      <ProgressWidget
        currentAmount={currentAmount}
        targetAmount={targetAmount}
        currency={p.ctx?.target}
        currentLabel="Saved (from shared accounts)"
        targetLabel="Goal"
        progressLabel="funded"
        mode="savings"
        theme="blue"
        stats={stats}
        deadline={deadline}
        deadlineLabel="Departure"
        emptyHeadline="Trip savings target not configured"
        emptySubline="Set a savings goal in Settings to track your trip progress."
      />
    );
  },

  "emergency_fund_progress": (p) => {
    const cfg            = p.config ?? {};
    const targetMonths   = cfgNum(cfg.targetMonths)   ?? 6;
    const monthlyExp     = cfgNum(cfg.monthlyExpenses) ?? null;
    const targetAmount   = monthlyExp != null ? targetMonths * monthlyExp : null;
    // MC1 QA Q4 — converted savings vs. a Space-native expense figure keeps
    // the months-covered ratio in one currency.
    const { sum: currentAmount } = sumAccounts(p.accounts, p.ctx, "savings");
    const monthsCovered  = monthlyExp != null && monthlyExp > 0
      ? currentAmount / monthlyExp
      : null;
    const stats: ProgressStat[] = [];
    if (monthsCovered != null) {
      stats.push({
        label:  "Months covered",
        value:  monthsCovered.toFixed(1),
        accent: monthsCovered >= targetMonths ? "green" : "orange",
      });
    }
    stats.push({
      label:  "Target",
      value:  `${targetMonths} months`,
      accent: "default",
    });
    return (
      <ProgressWidget
        currentAmount={currentAmount}
        targetAmount={targetAmount}
        currency={p.ctx?.target}
        currentLabel="Current savings balance"
        targetLabel={`${targetMonths}-month target`}
        progressLabel="funded"
        mode="savings"
        theme="green"
        stats={stats}
        emptyHeadline="Emergency fund target not configured"
        emptySubline="Add your monthly expenses in Settings to calculate how much you need."
      />
    );
  },

  "retirement_progress": (p) => {
    const cfg            = p.config ?? {};
    const targetAmount   = cfgNum(cfg.targetAmount)       ?? null;
    const retirementAge  = cfgNum(cfg.retirementAge)      ?? null;
    const currentAge     = cfgNum(cfg.currentAge)         ?? null;
    const expectedReturn = cfgNum(cfg.expectedReturn)     ?? 7;
    const annualContrib  = cfgNum(cfg.annualContribution) ?? 0;
    // Live investment account balances — MC1 QA Q4: converted, so the FV
    // projection (a planner aggregate) is computed and labeled in the
    // Space's reporting currency.
    const { sum: currentAmount, estimated } = sumAccounts(p.accounts, p.ctx, "investment");
    const yearsLeft      = retirementAge != null && currentAge != null
      ? Math.max(0, retirementAge - currentAge)
      : null;
    const stats: ProgressStat[] = [];
    if (yearsLeft != null) {
      stats.push({ label: "Years to retirement", value: String(yearsLeft), accent: "default" });
    }
    if (yearsLeft != null && yearsLeft > 0) {
      const projected = projectFV(currentAmount, annualContrib, expectedReturn, yearsLeft);
      const onTrack   = targetAmount != null && projected >= targetAmount;
      stats.push({
        label:  "Projected at retirement",
        value:  `${estimated ? "≈ " : ""}${formatBalance(projected, p.ctx?.target)}`,
        accent: onTrack ? "green" : targetAmount != null ? "orange" : "default",
      });
    }
    return (
      <ProgressWidget
        currentAmount={currentAmount}
        targetAmount={targetAmount}
        currency={p.ctx?.target}
        currentLabel="Current investments"
        targetLabel="Retirement target"
        progressLabel="of goal"
        mode="savings"
        theme="purple"
        stats={stats}
        emptyHeadline="Retirement target not configured"
        emptySubline="Set a retirement target in Settings to track your investment progress."
      />
    );
  },
};
