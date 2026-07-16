"use client";

/**
 * components/space/sections/SpaceSections.tsx  (SD-7)
 *
 * The Space dashboard SECTION SUBSYSTEM, extracted verbatim from SpaceDashboard.
 * This is the shared composition machinery every section-backed destination mounts:
 *   • SectionCard / SortableSectionCard — the per-section card frame + drag wrapper
 *   • SectionRegistry — section key → renderer map (+ its renderers)
 *   • the section renderers (AccountsCard, ActivityCard, ContextualCard,
 *     NetWorthChartSection, AllocationSection) and their helpers/formatters
 * Moved so the host stops owning page composition and the standard Workspaces
 * (Overview / Accounts / Activity / Goals) can import ONE SectionCard/SectionRegistry
 * instead of the host owning them inline. Architecture-only: the code is byte-for-byte
 * the host's, only relocated. OverviewSetupCard + AddGoalModal stay with their own
 * destinations (Overview / Goals), not here — they are not section renderers.
 *
 * SEC-1: the Goals card (the `goals_progress` renderer) is a self-contained
 * feature, not section machinery — it now lives in ./goals/GoalsCard.tsx and is
 * imported into the registry entry below (single goal-list authority preserved).
 */

import React, { useState } from "react";
import { LayoutDashboard, Landmark, CreditCard, TrendingUp, ChevronDown, ChevronUp, GripVertical, Maximize2 } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getWidgetMeta } from "@/lib/widget-registry";
import { AssetValueWidget, type AssetValueConfig } from "@/components/space/widgets/AssetValueWidget";
import { ProgressWidget, type ProgressStat } from "@/components/space/widgets/ProgressWidget";
import { type BreakdownViewMode } from "@/components/space/widgets/BreakdownWidget";
import { SummaryWidget } from "@/components/space/widgets/SummaryWidget";
// Unified Space Widget Layout (slice 1) — Personal Overview lede widgets, now
// section-backed (net_worth_chart + allocation).
import { NetWorthChart, type Interval } from "@/components/charts/NetWorthChart";
import { NetWorthChartModal } from "@/components/charts/NetWorthChartModal";
import { RebuildHistoryButton } from "@/components/dashboard/RebuildHistoryButton";
import { AllocationChart } from "@/components/charts/AllocationChart";
import { classifyAccounts } from "@/lib/account-classifier";
import { formatBalance } from "@/lib/currency";
import { simulatePayoff } from "@/components/space/sections/DebtPayoffSection";
import { GoalsCard } from "@/components/space/sections/goals/GoalsCard";
import { renderDebtBreakdownChart, renderDebtPayoffCalculator } from "@/components/space/widgets/debt-adapters";
import { renderWealthAccountCards, renderInstitutionAllocation, renderWealthAllocationChart, renderWealthConcentration } from "@/components/space/widgets/wealth-adapters";
import { renderLiquidityLadder, renderAccessibleCash, renderEmergencyFundReadiness, renderLiquidityConcentration } from "@/components/space/widgets/liquidity-adapters";
import { renderCashFlowSummary, renderCashFlowHistory, renderIncomeVsSpending, renderCashFlowByCategory, renderIncomeBySource, renderDebtPayments } from "@/components/space/widgets/cash-flow-adapters";
import { renderDebtByAccount, renderDebtCost, CreditUtilizationWidget, renderDebtHistory, renderCreditScore, renderDebtCompleteInfo } from "@/components/space/widgets/debt-perspective-adapters";
import { renderGoalProgress, renderGoalOnTrack, renderGoalRequiredPace, renderGoalFundingGap } from "@/components/space/widgets/goals-perspective-adapters";
import { DEFAULT_CASH_FLOW_PERIOD, periodLabel, type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import type { CashFlowPerspective } from "@/lib/transactions/cash-flow-projection";
import { AccountsPerspective } from "@/components/space/widgets/accounts/AccountsPerspective";
import { TimelineWidget } from "@/components/space/widgets/TimelineWidget";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot, Transaction } from "@/types";
import type { DashboardSection, SpaceAccount, SpaceGoal } from "@/lib/space/dashboard-types";

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking:   "Checking",
  savings:    "Savings",
  investment: "Investment",
  crypto:     "Crypto",
  debt:       "Debt",
  other:      "Other",
};

// ─── Section cards ────────────────────────────────────────────────────────────


function AccountsCard({ accounts }: { accounts: SpaceAccount[] }) {
  if (accounts.length === 0) {
    return (
      <div className="text-center py-4">
        <Landmark size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">No accounts shared yet</p>
        <p className="text-xs text-[var(--text-faint)] mt-0.5">Share accounts from the Spaces page.</p>
      </div>
    );
  }

  const grouped = accounts.reduce<Record<string, SpaceAccount[]>>((acc, a) => {
    (acc[a.type] ??= []).push(a);
    return acc;
  }, {});

  return (
    <div className="space-y-3">
      {Object.entries(grouped).map(([type, items]) => (
        <div key={type}>
          <p className="text-[10px] font-semibold text-[var(--text-faint)] uppercase tracking-widest mb-1">
            {ACCOUNT_TYPE_LABELS[type] ?? type}
          </p>
          <div className="space-y-1">
            {items.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-[var(--surface-inset)]">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{a.name}</p>
                  <p className="text-xs text-[var(--text-muted)] truncate">{a.institution}</p>
                </div>
                <p className="text-sm font-medium text-white shrink-0">
                  {formatBalance(a.balance, a.currency)}
                </p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

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
function ContextualCard({ sectionKey, label }: { sectionKey: string; label: string }) {
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
// Runtime compositor contract (implemented progressively):
//
//   section row
//     → WIDGET_REGISTRY entry  (lib/widget-registry.ts)
//     → component              (entries below)
//     → widget meta            (entry.meta)
//     → data contract          (entry.meta.requires)
//     → render
//
// Phase 1 (current): SectionRegistry maps key → render fn.
//                    WIDGET_REGISTRY knows metadata + implementation status.
// Phase 2:           SectionRegistry entries are co-located with components;
//                    this map is auto-built from the registry.
// Phase 3:           SpaceDashboard becomes a pure compositor — it reads
//                    WIDGET_REGISTRY and dispatches to components generically.
//
// Keys without an entry here fall back to ContextualCard.
// Keys with implemented:false in WIDGET_REGISTRY also fall back to ContextualCard.

type SectionRenderProps = {
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
  /**
   * UX-PER-3 Goals — the Space's goals for the Goals workspace ("Am I on
   * track?"). Host-fetched when the workspace opens; null = loading. Only the
   * Goals widgets read this.
   */
  goals?:                SpaceGoal[] | null;
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
function toDisplay(
  amount:   number,
  currency: string | null | undefined,
  ctx?:     ConversionContext,
): { amount: number; estimated: boolean } {
  if (!ctx) return { amount, estimated: false };
  const c = convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx);
  return { amount: c.amount, estimated: c.estimated };
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

const renderNetWorth = (p: SectionRenderProps): React.ReactElement => {
  // MC1 QA Q4 — aggregates convert into the Space's reporting currency
  // (map-then-reduce keeps the taint); labels follow via ctx.target.
  const assetConv = p.accounts.filter((a) => a.type !== "debt").map((a) => toDisplay(a.balance, a.currency, p.ctx));
  const debtConv  = p.accounts.filter((a) => a.type === "debt").map((a) => toDisplay(a.balance, a.currency, p.ctx));
  const assets = assetConv.reduce((s, c) => s + c.amount, 0);
  const debt   = debtConv.reduce((s, c) => s + c.amount, 0);
  const net    = assets - debt;
  const est    = assetConv.some((c) => c.estimated) || debtConv.some((c) => c.estimated) ? "≈ " : "";
  return (
    <SummaryWidget
      primary={p.accounts.length > 0 ? {
        value: `${est}${formatBalance(net, p.ctx?.target)}`,
        label: "Net worth across all shared accounts",
        color: net >= 0 ? "white" : "red",
        size:  "3xl",
      } : undefined}
      stats={p.accounts.length > 0 ? [
        { label: "Total assets", value: `${est}${formatBalance(assets, p.ctx?.target)}`, accent: "green" },
        { label: "Total debt",   value: `${est}${formatBalance(debt, p.ctx?.target)}`,   accent: "red"   },
      ] : undefined}
      emptyHeadline="No accounts shared yet"
      emptySubline="Share accounts on the Spaces page to see net worth."
      emptyIcon={<LayoutDashboard size={22} className="text-[var(--text-faint)]" />}
    />
  );
};

const renderDebtSummary = (p: SectionRenderProps): React.ReactElement => {
  const debts = p.accounts.filter((a) => a.type === "debt");
  // MC1 QA Q4 — headline total converts (labels follow); per-account rows
  // below stay native (itemized doctrine, already labeled with a.currency).
  const conv  = debts.map((a) => toDisplay(a.balance, a.currency, p.ctx));
  const total = conv.reduce((s, c) => s + c.amount, 0);
  const est   = conv.some((c) => c.estimated) ? "≈ " : "";
  return (
    <SummaryWidget
      primary={debts.length > 0 ? {
        value: `${est}${formatBalance(total, p.ctx?.target)}`,
        label: "Total outstanding debt",
        color: "red",
        size:  "2xl",
      } : undefined}
      rows={debts.map((a) => ({
        id:         a.id,
        label:      a.name,
        sublabel:   a.institution || undefined,
        value:      formatBalance(a.balance, a.currency),
        valueColor: "red" as const,
      }))}
      emptyHeadline="No debt accounts shared"
      emptySubline="Share debt accounts from the Spaces page."
      emptyIcon={<CreditCard size={22} className="text-[var(--text-faint)]" />}
    />
  );
};

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

// ── Unified Space Widget Layout (slice 1) — Overview lede sections ───────────
// Formerly hardcoded in PersonalHero; now section-backed so they order/drag/
// persist like any widget. Body-only: SectionCard supplies the card chrome +
// title (the section label). Currency conversion follows the host's ctx
// (ctx.target = the display / "view as" currency); the chart also needs the
// snapshot stamp currency as the "from" side.

function NetWorthChartSection({
  snapshots,
  ctx,
  snapshotCurrency,
  spaceId,
  spaceType,
  accounts,
}: {
  snapshots?:        Snapshot[] | null;
  ctx?:              ConversionContext;
  snapshotCurrency?: string;
  spaceId?:          string;
  spaceType?:        string;
  accounts?:         SpaceAccount[];
}): React.ReactElement {
  const [chartInterval, setChartInterval] = useState<Interval>("1M");
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div className="flex justify-end items-center gap-1 mb-1">
        {/* Wealth-timeline amendment (Phase 2) — personal-space only; SHARED
            approval is Phase 3. */}
        {spaceType === "PERSONAL" && spaceId && accounts && accounts.length > 0 && (
          <RebuildHistoryButton spaceId={spaceId} accounts={accounts} />
        )}
        <button
          onClick={() => setExpanded(true)}
          aria-label="Expand chart"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors touch-manipulation"
        >
          <Maximize2 size={14} />
        </button>
      </div>
      <NetWorthChart
        snapshots={snapshots ?? []}
        interval={chartInterval}
        onIntervalChange={setChartInterval}
        ctx={ctx}
        snapshotCurrency={snapshotCurrency}
        fill
      />
      {expanded && (
        <NetWorthChartModal
          snapshots={snapshots ?? []}
          initialInterval={chartInterval}
          initialSeries="netWorth"
          ctx={ctx}
          snapshotCurrency={snapshotCurrency}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}

function AllocationSection({
  accounts,
  ctx,
}: {
  accounts: SpaceAccount[];
  ctx?:     ConversionContext;
}): React.ReactElement {
  // classifyAccounts accepts SpaceAccount[] and converts through ctx when
  // present (identical math for all-USD Spaces).
  const c = classifyAccounts(accounts, ctx);
  return (
    <AllocationChart
      cash={c.totalLiquid}
      investments={c.totalInvestments}
      crypto={c.totalDigitalAssets}
      debt={c.totalLiabilities}
      realAssets={c.totalRealAssets}
      size="responsive"
    />
  );
}

export const SectionRegistry: Record<string, (p: SectionRenderProps) => React.ReactElement> = {
  "net_worth":              renderNetWorth,
  "net_worth_chart":        (p) => <NetWorthChartSection snapshots={p.snapshots} ctx={p.ctx} snapshotCurrency={p.snapshotCurrency} spaceId={p.spaceId} spaceType={p.spaceType} accounts={p.accounts} />,
  "allocation":             (p) => <AllocationSection accounts={p.accounts} ctx={p.ctx} />,
  // ── Wealth Perspective (UX-PER-3) — assets-only analytical widgets ──────────
  // EXPERIMENT (UX): temporarily render "Wealth by Account" as a two-column
  // account-card grid instead of ranked bars. Reversible — restore
  // renderWealthByAccount to end the experiment. renderWealthByAccount and its
  // widget key/registry entry are intentionally left untouched.
  "wealth_by_account":       (p) => renderWealthAccountCards(p.accounts, p.ctx),
  "institution_allocation":  (p) => renderInstitutionAllocation(p.accounts, p.ctx),
  // EXPERIMENT (UX): temporarily render "Asset Allocation" as a multi-mode chart
  // (treemap default / donut / strip). Donut mode reuses renderAssetAllocation
  // verbatim. Reversible — restore renderAssetAllocation to end the experiment.
  "asset_allocation":        (p) => renderWealthAllocationChart(p.accounts, p.ctx),
  "wealth_concentration":    (p) => renderWealthConcentration(p.accounts, p.ctx),
  // ── Liquidity Perspective (UX-PER-3) — access/readiness widgets ─────────────
  "liquidity_ladder":        (p) => renderLiquidityLadder(p.accounts, p.ctx),
  "accessible_cash":         (p) => renderAccessibleCash(p.accounts, p.ctx),
  "emergency_fund_readiness":(p) => renderEmergencyFundReadiness(p.accounts, p.ctx),
  "liquidity_concentration": (p) => renderLiquidityConcentration(p.accounts, p.ctx),
  // ── Cash Flow Perspective (UX-PER-3) — movement over time (FlowType-aware) ──
  "cash_flow_summary":       (p) => renderCashFlowSummary(p.transactions, p.period ?? DEFAULT_CASH_FLOW_PERIOD, p.txCtx, p.accounts, p.perspective, p.onPerspectiveChange),
  "cash_flow_history":       (p) => renderCashFlowHistory(p.transactions, p.period ?? DEFAULT_CASH_FLOW_PERIOD, p.txCtx, p.onSelectPeriod, p.accounts, p.perspective, p.filterId, p.onPerspectiveChange),
  "income_vs_spending":      (p) => renderIncomeVsSpending(p.transactions, p.period ?? DEFAULT_CASH_FLOW_PERIOD, p.txCtx),
  "cash_flow_by_category":   (p) => renderCashFlowByCategory(p.transactions, p.period ?? DEFAULT_CASH_FLOW_PERIOD, p.txCtx),
  "income_by_source":        (p) => renderIncomeBySource(p.transactions, p.period ?? DEFAULT_CASH_FLOW_PERIOD, p.txCtx, p.accounts, p.perspective),
  "debt_payments":           (p) => renderDebtPayments(p.transactions, p.period ?? DEFAULT_CASH_FLOW_PERIOD, p.txCtx, p.accounts),
  // ── Debt Perspective (UX-PER-3) — liabilities-only (shape/cost/risk) ────────
  "debt_by_account":         (p) => renderDebtByAccount(p.accounts, p.ctx),
  "debt_cost":               (p) => renderDebtCost(p.accounts, p.ctx),
  "credit_utilization":      (p) => <CreditUtilizationWidget accounts={p.accounts} ctx={p.ctx} />,
  "debt_history":            (p) => renderDebtHistory(p.snapshots, p.ctx),
  "credit_score":            (p) => renderCreditScore(p.ficoScore, p.ficoUpdatedAt),
  "debt_complete_info":      (p) => renderDebtCompleteInfo(p.accounts),
  // debt_payoff_calculator is already registered above (reused from the Debt tab).
  // ── Goals Perspective (UX-PER-3) — trajectory vs target ─────────────────────
  "goal_progress":           (p) => renderGoalProgress(p.goals, p.ctx),
  "goal_on_track":           (p) => renderGoalOnTrack(p.goals),
  "goal_required_pace":      (p) => renderGoalRequiredPace(p.goals, p.ctx),
  "goal_funding_gap":        (p) => renderGoalFundingGap(p.goals, p.ctx),
  "net_worth_section":      renderNetWorth,       // deprecated alias — seeded pre-v2
  "accounts_overview":      (p) => <AccountsPerspective spaceId={p.spaceId} accounts={p.accounts} />,
  "business_accounts":      (p) => <AccountsCard accounts={p.accounts} />,
  "debt_summary":           renderDebtSummary,
  "debt_payoff_tracker":    renderDebtSummary,    // TODO: Progress/Timeline hybrid when payoff simulation is ready
  "mortgage_tracker":       renderDebtSummary,
  "auto_loan_tracker":      renderDebtSummary,
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

// ─── Section renderer ─────────────────────────────────────────────────────────

// Solid/frosted, non-collapsible cards. Two families use this treatment:
//  - the Overview lede widgets (formerly PersonalHero cards A/B/C), and
//  - the Wealth Perspective's analytical widgets (UX-PER-3),
// so the workspace reads as intentional analytical cards, not the faint
// ~5%-opacity SectionCard surface. Keyed by section key; any Space rendering
// these exact keys gets the treatment.
const SOLID_LEDE_KEYS = new Set([
  "net_worth", "net_worth_chart", "allocation",
  "wealth_by_account", "institution_allocation", "asset_allocation", "wealth_concentration",
  "liquidity_ladder", "accessible_cash", "emergency_fund_readiness", "liquidity_concentration",
  "cash_flow_summary", "cash_flow_history", "income_vs_spending", "cash_flow_by_category", "income_by_source", "debt_payments",
  "debt_by_account", "debt_cost", "credit_utilization", "debt_payoff_snapshot",
  "debt_history", "credit_score", "debt_complete_info", "debt_payoff_calculator",
  "goal_progress", "goal_on_track", "goal_required_pace", "goal_funding_gap",
]);

export function SectionCard({
  section,
  accounts,
  spaceId,
  spaceType,
  category,
  canManage,
  onAddGoal,
  ctx,
  perspective,
  filterId,
  onPerspectiveChange,
  snapshots,
  snapshotCurrency,
  transactions,
  txCtx,
  period,
  onSelectPeriod,
  ficoScore,
  ficoUpdatedAt,
  goals,
}: {
  section:     DashboardSection;
  accounts:    SpaceAccount[];
  spaceId: string;
  spaceType:   string;
  category:    string;
  canManage:   boolean;
  onAddGoal?:  () => void;
  /** MC1 QA Q4 — see SectionRenderProps.ctx. */
  ctx?:        ConversionContext;
  /** Unified Space Widget Layout (slice 1) — see SectionRenderProps.snapshots. */
  snapshots?:        Snapshot[] | null;
  snapshotCurrency?: string;
  /** UX-PER-3 Cash Flow — see SectionRenderProps.transactions/txCtx/period. */
  transactions?:     Transaction[] | null;
  txCtx?:            ConversionContext;
  period?:           CashFlowPeriod;
  onSelectPeriod?:   (period: CashFlowPeriod) => void;
  perspective?:          CashFlowPerspective;
  filterId?:             string;
  onPerspectiveChange?:  (perspective: CashFlowPerspective, filterId: string) => void;
  // (SectionRenderProps mirror — perspective threaded to Cash Flow widgets)
  /** UX-PER-3 Debt — see SectionRenderProps.ficoScore/ficoUpdatedAt. */
  ficoScore?:        number | null;
  ficoUpdatedAt?:    string;
  /** UX-PER-3 Goals — see SectionRenderProps.goals. */
  goals?:            SpaceGoal[] | null;
}) {
  const [collapsed,        setCollapsed]        = useState(false);
  const [payoffFullscreen, setPayoffFullscreen] = useState(false);
  const isDebtSpace = category === "DEBT_PAYOFF";

  // Scroll-position preservation now lives in DebtPayoffSection's shared
  // useBodyScrollLock (doctrine §14), so the former manual scrollY save/restore
  // workaround here is redundant and has been removed.
  function openPayoffFullscreen() {
    setPayoffFullscreen(true);
  }

  function closePayoffFullscreen() {
    setPayoffFullscreen(false);
  }

  // Override stale section labels for existing seeded debt spaces
  const displayLabel = isDebtSpace && section.key === "cash_flow"    ? "Debt Breakdown"
                     : isDebtSpace && section.key === "savings_rate" ? "Payoff Planner"
                     : section.label;

  // Debt Breakdown and Activity feed are never collapsible
  const isDebtBreakdown = (isDebtSpace && section.key === "cash_flow") || section.key === "debt_breakdown_chart" || section.key === "recent_activity";
  // Payoff Planner shows a summary when collapsed
  const isDebtPayoff    = (isDebtSpace && section.key === "savings_rate") || section.key === "debt_payoff_calculator";
  // Overview lede widgets: solid/frosted card, not collapsible (see SOLID_LEDE_KEYS).
  const isSolidLede     = SOLID_LEDE_KEYS.has(section.key);

  // ── Payoff summary for collapsed state ─────────────────────────────────────
  let payoffSummary: string | null = null;
  if (isDebtPayoff) {
    // MC1 QA Q4 — the collapsed summary simulates over aggregates, so the
    // sums (and APR weights) use display-currency amounts; the resulting
    // copy is time-only, so no label change is involved.
    const debtAccs = accounts.filter((a) => a.type === "debt");
    const balConv  = debtAccs.map((a) => toDisplay(a.balance, a.currency, ctx));
    const totalBal = balConv.reduce((s, c) => s + c.amount, 0);
    const totalMin = debtAccs
      .map((a) => toDisplay(a.minimumPayment ?? 0, a.currency, ctx))
      .reduce((s, c) => s + c.amount, 0);
    if (totalBal > 0 && totalMin > 0) {
      const avgApr      = debtAccs.reduce((s, a, i) => s + (a.interestRate ?? 0) * balConv[i].amount, 0) / totalBal;
      const monthlyRate = avgApr / 100 / 12;
      const result      = simulatePayoff(totalBal, monthlyRate, totalMin);
      if (result) {
        const yrs = Math.floor(result.months / 12);
        const mos = result.months % 12;
        const timeStr = yrs > 0 && mos > 0
          ? `${yrs} year${yrs !== 1 ? "s" : ""} and ${mos} month${mos !== 1 ? "s" : ""}`
          : yrs > 0
          ? `${yrs} year${yrs !== 1 ? "s" : ""}`
          : `${mos} month${mos !== 1 ? "s" : ""}`;
        payoffSummary = `At your minimum monthly payments, you could be debt-free in approximately ${timeStr}. Expand to simulate different payoff timelines.`;
      } else {
        payoffSummary = "Your minimum payments may not be enough to cover the interest charges. Expand to build a realistic payoff plan.";
      }
    } else if (totalBal > 0) {
      payoffSummary = "Expand to simulate your debt payoff timeline.";
    }
  }

  function renderBody() {
    // Legacy key overrides — DEBT_PAYOFF spaces seeded before v2 section keys were stable
    // TODO: one-time migration to rename these rows to their canonical keys, then remove these guards
    if (isDebtSpace && section.key === "cash_flow") {
      // Legacy: DEBT_PAYOFF spaces seeded before v2 used "cash_flow" for the debt breakdown.
      // TODO: one-time migration to rename these rows to debt_breakdown_chart, then remove this guard.
      return renderDebtBreakdownChart(
        accounts,
        "donut",
        "Share your debt accounts from Manage → Add Accounts to see your debt breakdown.",
        ctx,
      );
    }
    if (isDebtSpace && section.key === "savings_rate") return renderDebtPayoffCalculator(accounts, payoffFullscreen, closePayoffFullscreen, ctx);

    const render = SectionRegistry[section.key];
    if (render) return render({ accounts, spaceId, spaceType, canManage, onAddGoal, payoffFullscreen, closePayoffFullscreen, config: section.config, ctx, snapshots, snapshotCurrency, transactions, txCtx, period, onSelectPeriod, perspective, filterId, onPerspectiveChange, ficoScore, ficoUpdatedAt, goals });
    return <ContextualCard sectionKey={section.key} label={section.label} />;
  }

  // ── Solid Overview lede (Net Worth / chart / allocation) — frosted card,
  //    NOT collapsible. Preserves the pre-section-backed PersonalHero card
  //    treatment (GlassPanel) so these never use the faint SectionCard fill,
  //    and keeps the drag handle legible. Left padding leaves room for the
  //    Edit-Layout grip that overlays the card's top-left corner. */
  if (isSolidLede) {
    // Phase 7 — the Cash Flow Summary header names the active analytical time
    // slice, read from the SAME authoritative `period` every widget consumes
    // (no separate period logic here). Other lede widgets keep their bare label.
    const headerLabel = section.key === "cash_flow_summary" && period
      ? `${displayLabel} · ${periodLabel(period)}`
      : displayLabel;
    return (
      <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4">
        <p className="text-sm font-semibold text-[var(--text-primary)] px-1 mb-2">{headerLabel}</p>
        {renderBody()}
      </GlassPanel>
    );
  }

  // ── Non-collapsible header (Debt Breakdown) ─────────────────────────────────
  if (isDebtBreakdown) {
    return (
      <div className="bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-2xl overflow-hidden">
        <div className="px-4 py-3">
          <p className="text-sm font-semibold text-white">{displayLabel}</p>
        </div>
        <div className="px-4 pb-4 pt-0">
          {renderBody()}
        </div>
      </div>
    );
  }

  // ── Collapsible header (all others) ────────────────────────────────────────
  return (
    <div className="bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-2xl overflow-hidden">
      <div className="flex items-start px-4 py-3">
        {/* Title + collapsed summary — clicking toggles collapse */}
        <button
          type="button"
          onClick={() => setCollapsed((p) => !p)}
          className="flex-1 text-left min-w-0 hover:opacity-80 transition-opacity"
        >
          <p className="text-sm font-semibold text-white">{displayLabel}</p>
          {collapsed && payoffSummary && (
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5 leading-snug">{payoffSummary}</p>
          )}
        </button>

        {/* Right-side controls */}
        <div className="flex items-center gap-2 shrink-0 ml-3 mt-0.5">
          {isDebtPayoff && !collapsed && (
            <button
              type="button"
              onClick={openPayoffFullscreen}
              className="text-[11px] font-medium text-[var(--accent-info)] hover:text-[var(--accent-info)] transition-colors"
            >
              Expand
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((p) => !p)}
            className="text-[var(--text-faint)] hover:text-[var(--text-secondary)] transition-colors"
          >
            {collapsed
              ? <ChevronDown size={14} />
              : <ChevronUp   size={14} />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="px-4 pb-4 pt-0">
          {renderBody()}
        </div>
      )}
    </div>
  );
}

// ─── Visible-surface reorder (UX-CUST-1A) ───────────────────────────────────────

/**
 * SortableSectionCard — wraps the *existing* SectionCard rendering path with a
 * drag handle so section cards can be reordered directly on the visible
 * dashboard while Edit Layout mode is active. It does not alter SectionCard;
 * the card renders unchanged as children.
 *
 * Layout: this only mounts inside the Edit-Layout SortableContext, so it always
 * insets the card into a left gutter (`pl-8`) and drops the grip into that
 * gutter (`left-0`). That way the handle never overlaps the card's title/content
 * for ANY section type, and reverts to full width the moment Edit Layout exits
 * (this wrapper is no longer rendered).
 *
 * Module-level (not created during render) so the React Compiler doesn't flag
 * it. Tab-scoping is structural: the single SortableContext that mounts this
 * only ever contains the active tab's visible cards, so a card can never be
 * dropped into another tab.
 */
export function SortableSectionCard({
  section,
  children,
}: {
  section:  DashboardSection;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: section.id });

  const style: React.CSSProperties = {
    transform:  CSS.Transform.toString(transform),
    transition,
    opacity:    isDragging ? 0.6 : 1,
    zIndex:     isDragging ? 20 : undefined,
    position:   "relative",
  };

  return (
    <div ref={setNodeRef} style={style} className="relative pl-8 touch-none">
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${section.label}`}
        className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--modal-surface)] border border-[var(--border-hairline-strong)] shadow-sm cursor-grab active:cursor-grabbing transition-colors touch-none"
      >
        <GripVertical size={14} />
      </button>
      {children}
    </div>
  );
}
