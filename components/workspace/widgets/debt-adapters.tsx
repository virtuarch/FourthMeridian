"use client";

/**
 * components/workspace/widgets/debt-adapters.tsx
 *
 * Shared debt widget logic consumed by both WorkspaceDashboard (workspace compositor)
 * and DebtClient (personal Credit tab).
 *
 * Exports:
 *   debtColor              — color scale helper (deep red → light orange-red)
 *   renderDebtBreakdownChart — renders BreakdownWidget for a debt account list
 *   renderDebtPayoffCalculator — renders DebtPayoffSection for a debt account list
 *
 * Rule: No personal-dashboard-specific or workspace-specific logic here.
 * Both callers pass normalized account arrays; adapters are purely presentational.
 */

import { BreakdownWidget, type BreakdownItem, type BreakdownViewMode } from "@/components/workspace/widgets/BreakdownWidget";
import { DebtPayoffSection, type DebtPayoffAccount } from "@/components/workspace/sections/DebtPayoffSection";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

// ─── Color scale ──────────────────────────────────────────────────────────────

/**
 * Debt color scale: index 0 (largest) = deep red, last = light orange-red.
 * Used both in the breakdown donut and in the payoff planner per-account rows.
 *
 * @param i - Account index in a balance-descending sorted array
 * @param n - Total number of accounts
 */
export function debtColor(i: number, n: number): string {
  const t = n > 1 ? i / (n - 1) : 0;
  const r = Math.round(185 + (249 - 185) * t);
  const g = Math.round(28  + (115 - 28)  * t);
  const b = Math.round(28  + (22  - 28)  * t);
  return `rgb(${r},${g},${b})`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function formatBalance(amount: number, currency = DEFAULT_DISPLAY_CURRENCY) {
  return new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

// ─── Shared account shape ─────────────────────────────────────────────────────

/**
 * Minimum account shape required by both debt adapters.
 * Structurally compatible with:
 *   - WorkspaceDashboard's WorkspaceAccount (workspace compositor)
 *   - Account from types/index.ts (personal dashboard)
 *
 * Only fields actually used by the adapters are required.
 */
export interface DebtAdapterAccount {
  id:              string;
  name:            string;
  type:            string;
  institution:     string;
  balance:         number;
  currency:        string;
  interestRate?:   number;
  minimumPayment?: number;
}

// ─── Debt Breakdown Chart ─────────────────────────────────────────────────────

/**
 * Renders a BreakdownWidget (donut or bar) for the supplied debt accounts.
 *
 * @param accounts   - All accounts passed to the section; non-debt are ignored
 * @param viewMode   - "donut" | "bar" | "list" (default: "donut")
 * @param emptyText  - Optional override for the empty-state subtitle
 */
export function renderDebtBreakdownChart(
  accounts:  DebtAdapterAccount[],
  viewMode?: BreakdownViewMode,
  emptyText?: string,
): React.ReactElement {
  const sorted = [...accounts.filter((a) => a.type === "debt")]
    .sort((a, b) => b.balance - a.balance);
  const n            = sorted.length;
  const totalMinPmt  = sorted.reduce((s, a) => s + (a.minimumPayment ?? 0), 0);

  const items: BreakdownItem[] = sorted.map((a, i) => ({
    id:    a.id,
    label: a.name,
    value: a.balance,
    color: debtColor(i, n),
    meta:  a.institution || undefined,
    meta2: [
      a.interestRate   != null ? `${a.interestRate.toFixed(2)}% APR`        : null,
      a.minimumPayment != null ? `${formatBalance(a.minimumPayment)}/mo min` : null,
    ].filter(Boolean).join(" · ") || undefined,
  }));

  return (
    <BreakdownWidget
      items={items}
      viewMode={viewMode ?? "donut"}
      itemNoun="account"
      footer={totalMinPmt > 0 ? (
        <div className="text-center">
          <p className="text-[11px] text-gray-500">Minimum monthly payments</p>
          <p className="text-sm font-semibold text-white mt-0.5">
            {formatBalance(totalMinPmt)}
            <span className="text-[10px] text-gray-600 ml-0.5">/mo</span>
          </p>
        </div>
      ) : undefined}
      emptyHeadline="No debt accounts yet"
      emptySubline={
        emptyText ??
        "Add or share your debt accounts to see your debt breakdown."
      }
    />
  );
}

// ─── Debt Payoff Calculator ───────────────────────────────────────────────────

/**
 * Renders the DebtPayoffSection (interactive amortization planner).
 *
 * @param accounts          - All accounts; non-debt are ignored by DebtPayoffSection
 * @param fullscreen        - Whether to render in expanded modal mode
 * @param onCloseFullscreen - Callback when user closes the fullscreen view
 */
export function renderDebtPayoffCalculator(
  accounts:           DebtPayoffAccount[],
  fullscreen?:        boolean,
  onCloseFullscreen?: () => void,
): React.ReactElement {
  return (
    <DebtPayoffSection
      accounts={accounts}
      fullscreen={fullscreen}
      onCloseFullscreen={onCloseFullscreen}
    />
  );
}
