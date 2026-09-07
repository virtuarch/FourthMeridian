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
import { HistoryExplorationSheet } from "@/components/history/HistoryExplorationSheet";
import { useHistoryExploration } from "@/components/history/useHistoryExploration";
import { WealthWorkspace } from "@/components/space/widgets/wealth/WealthWorkspace";
import { CashFlowWorkspace } from "@/components/space/widgets/cashflow/CashFlowWorkspace";
import type { AssetsSlice, WealthMode } from "@/lib/wealth/wealth-mode";
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
  /** v2.6-ASSESS-3 — the RESOLVED baseline (declared or measured) + its basis,
   *  or null when neither exists. Resolved server-side; never derived here. */
  liquidityExpenseBaseline?: import("@/lib/liquidity/expense-baseline").ExpenseBaseline | null;

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

  // OVERVIEW-CONSOLIDATION — per-MODE activation inside Net Worth (true when
  // that mode of the engaged Net Worth lens is open). Gates the embedded
  // historical fetches exactly as the retired peer lenses were gated.
  debtActive:              boolean;
  assetsActive:            boolean;

  // Perspective-engine results (host-owned loader)
  lensResults:             Record<string, LensResult> | null;

  // Cash Flow period + the Net Worth page subject / Assets slice (URL-synced)
  cashFlowPeriod:          CashFlowPeriod;
  wealthMode:              WealthMode;
  assetsSlice:             AssetsSlice;
  /** One-shot Assets section focus from a legacy lens deep link. */
  wealthFocus:             "cash" | "investments" | null;

  // Callbacks
  onModeChange:            (m: WealthMode) => void;
  onSliceChange:           (s: AssetsSlice) => void;
  onSwitchLens:            (id: string) => void;
  onEnvelopeChange:        (env: PerspectiveEnvelope) => void;
  onSelectCashFlowPeriod:  (p: CashFlowPeriod) => void;
  onOpenCashFlow:          () => void;
}

/**
 * id → render implementation. Keys are exactly the financial Perspective ids that
 * are OVERVIEW LENS DESTINATIONS with an inline workspace (registry `kind:
 * "perspective"`, `status: "available"`). Since the Overview consolidation that
 * is Net Worth (`wealth`) and Cash Flow; the registry↔renderer parity test
 * (lib/perspectives/overview-lenses.test.ts) enforces this set.
 */
/**
 * THE ONE exploration sheet, mounted ONCE for every workspace.
 *
 * Mounting it per workspace meant five mounts of one component, five chances for
 * one of them to drift, and — worse — a deep link that opened nothing whenever
 * the workspace behind it early-returned an empty state. The host always
 * renders, so the sheet always restores.
 *
 * Each workspace still chooses its OWN root when a point is clicked; only the
 * mount is shared. That is the whole design: one explorer, many entry points.
 */
export function WorkspaceExplorationHost({
  spaceId, asOf, children,
}: {
  spaceId: string;
  asOf: string;
  children: React.ReactNode;
}) {
  const exploration = useHistoryExploration();
  return (
    <>
      {children}
      <HistoryExplorationSheet
        spaceId={spaceId}
        open={exploration.open}
        root={exploration.root}
        nodeType={exploration.nodeType}
        nodeId={exploration.nodeId}
        dateISO={exploration.dateISO ?? asOf}
        fromISO={exploration.fromISO || asOf}
        toISO={exploration.toISO || asOf}
        onNavigate={exploration.navigate}
        onClose={exploration.close}
      />
    </>
  );
}

export const WORKSPACE_RENDERERS: Record<string, (ctx: WorkspaceRenderCtx) => React.ReactNode> = {
  // OVERVIEW-CONSOLIDATION — the Net Worth workspace hosts Total · Assets (Cash +
  // Investments embedded) · Debt. Liquidity / Investments / Debt are no longer
  // peer lenses with their own renderer entries; their workspaces render INSIDE
  // this one (see WealthWorkspace). The registry entries for those ids remain
  // (engine lenses, category lists, present-day verdicts) — they are just not
  // Overview destinations any more.
  wealth: (ctx) => (
    <WealthWorkspace
      spaceId={ctx.spaceId}
      snapshots={ctx.snapshots}
      snapshotCurrency={ctx.snapshotCurrency}
      asOf={ctx.asOf}
      compareTo={ctx.compareTo}
      historicalCompareTo={ctx.historicalCompareTo}
      today={ctx.today}
      accounts={ctx.accounts}
      ctx={ctx.widgetCtx}
      mode={ctx.wealthMode}
      onModeChange={ctx.onModeChange}
      slice={ctx.assetsSlice}
      onSliceChange={ctx.onSliceChange}
      focusSection={ctx.wealthFocus}
      active={ctx.assetsActive || ctx.debtActive}
      cash={{
        expenseBaseline:  ctx.liquidityExpenseBaseline,
        presentLens:      ctx.lensResults?.["liquidity"] ?? null,
        transactions:     ctx.transactions,
        transactionsMeta: ctx.transactionsMeta,
        txCtx:            ctx.txCtx,
        period:           ctx.cashFlowPeriod,
        onOpenCashFlow:   ctx.onOpenCashFlow,
      }}
      debt={{
        ficoScore:      ctx.ficoScore,
        ficoUpdatedAt:  ctx.ficoUpdatedAt,
        presentLens:    ctx.lensResults?.["debt"] ?? null,
        targetCurrency: ctx.perspectiveTargetCurrency,
      }}
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
};
