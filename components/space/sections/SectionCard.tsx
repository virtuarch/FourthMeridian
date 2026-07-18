"use client";

/**
 * components/space/sections/SectionCard.tsx  (SEC-2)
 *
 * The per-section CARD CHROME + drag wrapper — the frame that mounts a section's
 * body and decides how it presents (solid Overview lede, non-collapsible Debt
 * Breakdown, or the default collapsible card), plus the debt-space legacy-key
 * overrides and the collapsed payoff summary. Split out of the former
 * SpaceSections.tsx so card presentation lives apart from the renderer catalog
 * (./SectionRegistry.tsx). One-way dependency: this consumes the registry's
 * dispatch map + ContextualCard fallback + toDisplay helper; the registry knows
 * nothing about the card. Byte-identical to the former inline definitions.
 */

import React, { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { simulatePayoff } from "@/components/space/sections/DebtPayoffSection";
import { renderDebtBreakdownChart, renderDebtPayoffCalculator } from "@/components/space/widgets/debt-adapters";
import { periodLabel, type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import type { CashFlowPerspective } from "@/lib/transactions/cash-flow-projection";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot, Transaction } from "@/types";
import type { DashboardSection, SpaceAccount, SpaceGoal } from "@/lib/space/dashboard-types";
import { SectionRegistry, ContextualCard, toDisplay } from "./SectionRegistry";

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
  // M3 Design Lab convergence — the Overview lede blocks render CARD-LESS (no
  // box) for the editorial, airy feel of the Design Lab. `net_worth` is fully
  // bare (its SummaryWidget hero variant supplies its own uppercase eyebrow);
  // `net_worth_chart` keeps a quiet uppercase label above a card-less chart
  // (the Design Lab's "BALANCE HISTORY" treatment). Presentation only — the
  // sections, their data, and their ordering are unchanged.
  const isBareLede      = section.key === "net_worth" || section.key === "net_worth_chart";
  const bareLedeLabel   = section.key === "net_worth_chart"; // net_worth's eyebrow lives in its widget

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
  // ── Card-less Overview lede (Net Worth + Balance history) — M3 convergence ──
  if (isBareLede) {
    return (
      <div className="px-1 py-1">
        {bareLedeLabel && (
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] mb-4" style={{ color: "var(--text-faint)" }}>
            {displayLabel}
          </p>
        )}
        {renderBody()}
      </div>
    );
  }

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
