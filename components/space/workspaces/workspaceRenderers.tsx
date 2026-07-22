"use client";

/**
 * components/space/workspaces/workspaceRenderers.tsx  (SD-2 closeout)
 *
 * The renderer-implementation authority for the financial Perspective workspaces.
 * `WORKSPACE_REGISTRY` (lib/perspectives.ts) owns the SEMANTIC identity — id,
 * routing, dataNeeds, capabilities, envelope metadata — and stays React-free
 * (it is imported by other pure lib modules). This file is the COMPONENT-layer
 * companion: `id → (ctx) => JSX`. A parity test (lib/perspectives/virtual-sections.test.ts)
 * binds the two so a registry perspective can never exist without a renderer, nor
 * a renderer without a registry id.
 *
 * Extracted verbatim from SpaceDashboard's former host-local `workspaceRenderers`
 * map — same components, same props, same behavior. The host builds ONE
 * WorkspaceRenderCtx and calls WORKSPACE_RENDERERS[activePerspectiveId]?.(ctx);
 * it no longer defines which component renders. Data fetching, lensResults, and
 * shell-time ownership are unchanged and remain the host's — this is renderer
 * ownership extraction only.
 */

import React from "react";
import { WealthWorkspace } from "@/components/space/widgets/wealth/WealthWorkspace";
import { CashFlowWorkspace } from "@/components/space/widgets/cashflow/CashFlowWorkspace";
import { LiquidityWorkspace } from "@/components/space/widgets/liquidity/LiquidityWorkspace";
import { InvestmentsWorkspace } from "@/components/space/widgets/investments/InvestmentsWorkspace";
import { DebtWorkspace } from "@/components/space/widgets/debt/DebtWorkspace";
import type { WealthMetricKey } from "@/components/space/widgets/wealth/WealthTrendChart";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import type { LensResult } from "@/lib/perspective-engine/types";
import type { CashFlowPeriod } from "@/lib/transactions/cash-flow";
import type { ConversionContext } from "@/lib/money/types";
import type { TransactionsCoverage } from "@/lib/transactions/coverage-note";
import type { SpaceAccount } from "@/lib/space/dashboard-types";
import type { Snapshot, Transaction } from "@/types";

/**
 * The union of everything the former per-lens renderer closures captured — a flat
 * bag the host materializes once from useSpaceData + useSpaceNavigation + the shell
 * time state + its props. NOT a DTO hierarchy; just the render inputs.
 */
export interface WorkspaceRenderCtx {
  // Identity / props
  spaceId:                 string;
  /** Resolved snapshot-stamp currency (host's `snapshotCurrency ?? displayCurrency`). */
  snapshotCurrency:        string;
  ficoScore?:              number | null;
  ficoUpdatedAt?:          string;
  perspectiveTargetCurrency?: string;
  /** The Space's monthly-expense baseline (emergency_fund_progress config), or null.
   *  Drives the Liquidity Hero's honest Coverage stat; absent ⇒ no coverage shown. */
  liquidityMonthlyExpenses?: number | null;

  // Shared data (useSpaceData)
  accounts:                SpaceAccount[];
  snapshots:               Snapshot[] | null;
  snapshotsBackfilling:    boolean;
  transactions:            Transaction[] | null;
  /** TX-2A — the transaction population's coverage state (truncated + cap). Lets
   *  the transaction-derived workspaces surface an honest "history incomplete" note
   *  when the TX-2 read was capped; null/complete ⇒ no indicator. */
  transactionsMeta:        TransactionsCoverage | null;
  widgetCtx?:              ConversionContext;
  txCtx?:                  ConversionContext;

  // Shell time
  asOf:                    string;
  /** Raw shell compareTo (Wealth's full window). */
  compareTo:               string | null;
  /** compareTo clamped to a strictly-earlier window (Debt/Investments/Liquidity —
   *  those historical routes 400 on compareTo >= asOf). Identical clamp for all three. */
  historicalCompareTo:     string | null;
  today:                   string;

  // Per-lens activation (true when that lens is the engaged Perspective)
  debtActive:              boolean;
  liquidityActive:         boolean;
  investmentsActive:       boolean;

  // Perspective-engine results (host-owned loader)
  lensResults:             Record<string, LensResult> | null;

  // Cash Flow period + Wealth chart metric
  cashFlowPeriod:          CashFlowPeriod;
  chartMetric:             WealthMetricKey;

  // Callbacks
  onMetricChange:          (m: WealthMetricKey) => void;
  onSwitchLens:            (id: string) => void;
  onEnvelopeChange:        (env: PerspectiveEnvelope) => void;
  onSelectCashFlowPeriod:  (p: CashFlowPeriod) => void;
  onOpenCashFlow:          () => void;
}

/**
 * id → render implementation. Keys are exactly the financial Perspective ids that
 * own an inline workspace (registry `kind: "perspective"`, `status: "available"`,
 * no routed-modal). The registry↔renderer parity test enforces this set.
 */
export const WORKSPACE_RENDERERS: Record<string, (ctx: WorkspaceRenderCtx) => React.ReactNode> = {
  wealth: (ctx) => (
    <WealthWorkspace
      snapshots={ctx.snapshots}
      snapshotCurrency={ctx.snapshotCurrency}
      asOf={ctx.asOf}
      compareTo={ctx.compareTo}
      accounts={ctx.accounts}
      ctx={ctx.widgetCtx}
      metric={ctx.chartMetric}
      onMetricChange={ctx.onMetricChange}
      onSwitchLens={ctx.onSwitchLens}
      onEnvelopeChange={ctx.onEnvelopeChange}
      backfillInProgress={ctx.snapshotsBackfilling}
    />
  ),
  cashFlow: (ctx) => (
    <CashFlowWorkspace
      transactions={ctx.transactions}
      transactionsMeta={ctx.transactionsMeta}
      txCtx={ctx.txCtx}
      accounts={ctx.accounts}
      period={ctx.cashFlowPeriod}
      asOf={ctx.asOf}
      compareTo={ctx.historicalCompareTo}
      onSelectPeriod={ctx.onSelectCashFlowPeriod}
      onEnvelopeChange={ctx.onEnvelopeChange}
    />
  ),
  liquidity: (ctx) => (
    <LiquidityWorkspace
      spaceId={ctx.spaceId}
      asOf={ctx.asOf}
      compareTo={ctx.historicalCompareTo}
      today={ctx.today}
      active={ctx.liquidityActive}
      accounts={ctx.accounts}
      ctx={ctx.widgetCtx}
      snapshots={ctx.snapshots}
      snapshotCurrency={ctx.snapshotCurrency}
      monthlyExpenses={ctx.liquidityMonthlyExpenses}
      presentLens={ctx.lensResults?.["liquidity"] ?? null}
      transactions={ctx.transactions}
      transactionsMeta={ctx.transactionsMeta}
      txCtx={ctx.txCtx}
      period={ctx.cashFlowPeriod}
      onOpenCashFlow={ctx.onOpenCashFlow}
      onEnvelopeChange={ctx.onEnvelopeChange}
    />
  ),
  investments: (ctx) => (
    <InvestmentsWorkspace
      spaceId={ctx.spaceId}
      asOf={ctx.asOf}
      compareTo={ctx.historicalCompareTo}
      active={ctx.investmentsActive}
      today={ctx.today}
      accounts={ctx.accounts}
      ctx={ctx.widgetCtx}
      onEnvelopeChange={ctx.onEnvelopeChange}
    />
  ),
  debt: (ctx) => (
    <DebtWorkspace
      spaceId={ctx.spaceId}
      asOf={ctx.asOf}
      compareTo={ctx.historicalCompareTo}
      today={ctx.today}
      active={ctx.debtActive}
      accounts={ctx.accounts}
      ctx={ctx.widgetCtx}
      snapshots={ctx.snapshots}
      snapshotCurrency={ctx.snapshotCurrency}
      ficoScore={ctx.ficoScore}
      ficoUpdatedAt={ctx.ficoUpdatedAt}
      presentLens={ctx.lensResults?.["debt"] ?? null}
      targetCurrency={ctx.perspectiveTargetCurrency}
      onEnvelopeChange={ctx.onEnvelopeChange}
    />
  ),
};
