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
import { formatCurrency } from "@/lib/currency";
import { convertMoney } from "@/lib/money/convert";
import { amountOwed, hasOutstandingDebt } from "@/lib/debt/balance-semantics";
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
// formatBalance now comes from the single lib/currency authority (SEC-3).

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
}

// ─── Debt Breakdown Chart ─────────────────────────────────────────────────────

/**
 * Renders a BreakdownWidget (donut or bar) for the supplied debt accounts.
 *
 * @param accounts   - All accounts passed to the section; non-debt are ignored
 * @param viewMode   - "donut" | "bar" | "list" (default: "donut")
 * @param emptyText  - Optional override for the empty-state subtitle
 * @param ctx        - MC1 QA Q4 — optional conversion context. Present ⇒ slice
 *                     values convert into ctx.target (a donut over mixed
 *                     native currencies has dishonest proportions) and labels
 *                     follow. Absent ⇒ native amounts, no currency claim.
 *
 * Minimum payments are not surfaced here: the debt experience is driven by
 * balance + APR + the payment the user chooses.
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
    // V25-FINAL-1 — unavailable conversion excluded (0) from the donut, never native.
    return { amount: c.amount ?? 0, estimated: c.estimated };
  };

  // V25-SIDE-1 — a donut/bar of DEBT is a magnitude surface: slices are amount
  // OWED (never a raw signed balance, which would render a credit as a negative
  // slice), and accounts owing nothing carry no slice. They remain visible as
  // rows in LiabilitiesLedger — this chart is not the membership surface.
  const converted = accounts
    .filter((a) => a.type === "debt")
    .map((a) => {
      const conv = inDisp(a.balance, a.currency);
      return { a, bal: { amount: amountOwed(conv.amount), estimated: conv.estimated }, owes: hasOutstandingDebt(conv.amount) };
    })
    .filter((x) => x.owes);
  // Sort by the display-currency value so colour ranking matches the visual share.
  const sorted = [...converted].sort((x, y) => y.bal.amount - x.bal.amount);
  const n = sorted.length;

  const items: BreakdownItem[] = sorted.map(({ a, bal }, i) => ({
    id:    a.id,
    label: a.name,
    value: bal.amount,
    color: debtColor(i, n),
    meta:  a.institution || undefined,
    meta2: a.interestRate != null ? `${a.interestRate.toFixed(2)}% APR` : undefined,
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
 * @param today             - The host's "today" (YYYY-MM-DD): the schedule's
 *                            start date. Absent ⇒ the planner reads the clock.
 * @param onAddApr          - Takes the user to the ONE APR editing surface (the
 *                            Interest cost widget) from the planner's estimate
 *                            notice. Absent ⇒ the prompt is plain text.
 */
export function renderDebtPayoffCalculator(
  accounts:           DebtPayoffAccount[],
  fullscreen?:        boolean,
  onCloseFullscreen?: () => void,
  ctx?:               ConversionContext,
  today?:             string,
  onAddApr?:          () => void,
): React.ReactElement {
  return (
    <DebtPayoffSection
      today={today}
      onAddApr={onAddApr}
      accounts={accounts}
      fullscreen={fullscreen}
      onCloseFullscreen={onCloseFullscreen}
      ctx={ctx}
    />
  );
}
