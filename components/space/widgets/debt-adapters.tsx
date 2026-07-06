"use client";

/**
 * components/space/widgets/debt-adapters.tsx
 *
 * Shared debt widget logic consumed by both SpaceDashboard (space compositor)
 * and DebtClient (personal Credit tab).
 *
 * Exports:
 *   debtColor              — color scale helper (deep red → light orange-red)
 *   renderDebtBreakdownChart — renders BreakdownWidget for a debt account list
 *   renderDebtPayoffCalculator — renders DebtPayoffSection for a debt account list
 *
 * Rule: No personal-dashboard-specific or space-specific logic here.
 * Both callers pass normalized account arrays; adapters are purely presentational.
 */

import { BreakdownWidget, type BreakdownItem, type BreakdownViewMode } from "@/components/space/widgets/BreakdownWidget";
import { DebtPayoffSection, type DebtPayoffAccount } from "@/components/space/sections/DebtPayoffSection";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import type { ConversionContext } from "@/lib/money/types";

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
 *   - SpaceDashboard's SpaceAccount (space compositor)
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
 * @param ctx        - MC1 QA Q4 — optional conversion context. Present ⇒ slice
 *                     values and the min-payment footer convert into ctx.target
 *                     (a donut over mixed native currencies has dishonest
 *                     proportions) and labels follow; per-account meta stays
 *                     native. Absent ⇒ today's behavior byte-for-byte.
 */
export function renderDebtBreakdownChart(
  accounts:  DebtAdapterAccount[],
  viewMode?: BreakdownViewMode,
  emptyText?: string,
  ctx?:      ConversionContext,
): React.ReactElement {
  const inDisp = (amount: number, currency: string | null | undefined): { amount: number; estimated: boolean } => {
    if (!ctx) return { amount, estimated: false };
    const c = convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx);
    return { amount: c.amount, estimated: c.estimated };
  };

  const converted = accounts
    .filter((a) => a.type === "debt")
    .map((a) => ({ a, bal: inDisp(a.balance, a.currency) }));
  // Sort by the display-currency value so colour ranking matches the visual share.
  const sorted = [...converted].sort((x, y) => y.bal.amount - x.bal.amount);
  const n = sorted.length;

  const minConv     = sorted.map(({ a }) => inDisp(a.minimumPayment ?? 0, a.currency));
  const totalMinPmt = minConv.reduce((s, c) => s + c.amount, 0);
  const minTainted  = minConv.some((c) => c.estimated);

  const items: BreakdownItem[] = sorted.map(({ a, bal }, i) => ({
    id:    a.id,
    label: a.name,
    value: bal.amount,
    color: debtColor(i, n),
    meta:  a.institution || undefined,
    meta2: [
      a.interestRate   != null ? `${a.interestRate.toFixed(2)}% APR`        : null,
      // Itemized meta stays native — the row's own currency labels its own amount.
      a.minimumPayment != null ? `${formatBalance(a.minimumPayment, a.currency)}/mo min` : null,
    ].filter(Boolean).join(" · ") || undefined,
  }));

  return (
    <BreakdownWidget
      items={items}
      viewMode={viewMode ?? "donut"}
      itemNoun="account"
      // Only supplied alongside a context so the context-less default
      // formatter (and all-USD pixels) are untouched; lib/format's
      // formatCurrency matches the widget's default exactly.
      {...(ctx ? { formatValue: (v: number) => formatCurrency(v, ctx.target) } : {})}
      footer={totalMinPmt > 0 ? (
        <div className="text-center">
          <p className="text-[11px] text-[var(--text-muted)]">Minimum monthly payments</p>
          <p className="text-sm font-semibold text-white mt-0.5">
            {minTainted ? "≈ " : ""}{formatBalance(totalMinPmt, ctx?.target)}
            <span className="text-[10px] text-[var(--text-faint)] ml-0.5">/mo</span>
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
 * @param ctx               - MC1 QA Q4 — optional conversion context, passed
 *                            through to the planner (aggregates convert +
 *                            labels follow; absent ⇒ today's behavior).
 */
export function renderDebtPayoffCalculator(
  accounts:           DebtPayoffAccount[],
  fullscreen?:        boolean,
  onCloseFullscreen?: () => void,
  ctx?:               ConversionContext,
): React.ReactElement {
  return (
    <DebtPayoffSection
      accounts={accounts}
      fullscreen={fullscreen}
      onCloseFullscreen={onCloseFullscreen}
      ctx={ctx}
    />
  );
}
