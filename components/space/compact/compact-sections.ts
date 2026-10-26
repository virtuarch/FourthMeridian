/**
 * components/space/compact/compact-sections.ts  (COMPACT DASHBOARD — pure rules)
 *
 * Which existing sections each compact (<1024px) category tab shows. Pure, so
 * the truth tables are provable without rendering a workspace. The workspaces
 * apply them as `max-lg:hidden` (display:none below lg only); at ≥1024px every
 * section renders exactly as before, whatever the tab.
 */

import type { AssetsSlice } from "@/lib/wealth/wealth-mode";
import { classifyDebt } from "@/components/space/widgets/debt/debt-ledger-util";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";

export interface AssetsCompactVisibility {
  /** Composition + "What moved it" — whole-Assets analytics. */
  composition: boolean;
  cash: boolean;
  investments: boolean;
  /** Real assets: their own section, grouped under Investments for navigation only. */
  realAssets: boolean;
}

/** Assets tabs = the existing slice: All · Cash · Investments. */
export function assetsCompactVisibility(slice: AssetsSlice): AssetsCompactVisibility {
  return {
    composition: slice === "all",
    cash: slice === "all" || slice === "cash",
    investments: slice === "all" || slice === "investments",
    realAssets: slice === "all" || slice === "investments",
  };
}

// ── Debt: All · Credit · Loans ────────────────────────────────────────────────

/**
 * What the compact Debt categories show. Credit and Loans are the EXISTING
 * liability classes (debt-ledger-util.ts `classifyDebt`: "cards" / "loans");
 * "other" (no recognized subtype — never inferred from a credit limit) is listed under All only.
 *
 * Shared analytics — computed over ALL debts together and not separable without
 * a new calculation — stay in All and are NEVER shown on a category tab:
 *   debt balance history (total liabilities series), interest cost (every debt's
 *   APR), the payoff planner (every balance), and the derived credit-health
 *   signals (they include all-debt facts such as "N debts with no APR").
 * Shown on Credit because they are inherently about revolving credit and list
 * their accounts by name (not a category total): credit utilization, the credit
 * score, credit limits.
 */
export type DebtLedgerClass = "cards" | "loans";

export interface DebtCompactVisibility {
  history: boolean;
  /** The full liabilities ledger (all classes). */
  ledger: boolean;
  /** The compact per-class account list, when a category is selected. */
  ledgerClass: DebtLedgerClass | null;
  costRisk: boolean;
  utilization: boolean;
  interestCost: boolean;
  payoff: boolean;
  creditHealth: boolean;
  creditSignals: boolean;
  /** Say that shared analytics live under All. */
  sharedNote: boolean;
}

export function debtCompactVisibility(section: "all" | "credit" | "loans"): DebtCompactVisibility {
  if (section === "credit") {
    return { history: false, ledger: false, ledgerClass: "cards", costRisk: true, utilization: true, interestCost: false, payoff: false, creditHealth: true, creditSignals: false, sharedNote: true };
  }
  if (section === "loans") {
    return { history: false, ledger: false, ledgerClass: "loans", costRisk: false, utilization: false, interestCost: false, payoff: false, creditHealth: false, creditSignals: false, sharedNote: true };
  }
  return { history: true, ledger: true, ledgerClass: null, costRisk: true, utilization: true, interestCost: true, payoff: true, creditHealth: true, creditSignals: true, sharedNote: false };
}

/** The note a category tab carries, so a shared figure is never mistaken for a category one. */
export const DEBT_SHARED_NOTE =
  "Debt history, interest cost, payoff planning and credit signals cover all your debts together — see All.";

/** How many liability accounts each EXISTING class holds (classifyDebt), for the compact counts. */
export function debtClassCounts(accounts: readonly DebtPerspectiveAccount[]): { cards: number; loans: number; other: number } {
  const counts = { cards: 0, loans: 0, other: 0 };
  for (const a of accounts) if (a.type === "debt") counts[classifyDebt(a)]++;
  return counts;
}
