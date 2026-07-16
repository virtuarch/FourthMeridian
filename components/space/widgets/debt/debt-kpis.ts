/**
 * components/space/widgets/debt/debt-kpis.ts
 *
 * S2 — pure KPI math for the Debt Perspective workspace (plan §3.4). Restates the
 * sums the landed renderers already compute — total owed + minimum payments,
 * `renderDebtCost` (Σ balance × APR/12 over rated rows), and `creditUtilization`
 * (revolving level thresholds) — in ONE pure helper so the KPI strip agrees
 * byte-for-byte with the panels beneath it.
 *
 * Sourced STRICTLY from the client `accounts` array — the same rows every panel
 * renders — NEVER from the lens (plan §1.4: the lens may see DebtProfile-merged
 * terms the client payload lacks; a strip sourced from the lens could contradict
 * the bars directly beneath it). No historical/as-of read of any kind.
 *
 * Currency: every sum converts into the display currency via the adapters'
 * `inDisp` conversion-and-taint pattern (debt-perspective-adapters.tsx:55–58);
 * any unresolvable rate marks the whole result `estimated` (the `≈` prefix). A
 * mixed-currency utilization ratio is dishonest without conversion, so balances
 * AND limits convert before the aggregate ratio.
 */

import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { utilizationLevel, type UtilizationLevel } from "@/lib/accounts/credit-utilization";
import type { ConversionContext } from "@/lib/money/types";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";

export interface DebtKpis {
  /** Σ converted debt balances (type === "debt", balance > 0). */
  totalDebt: number;
  /** Σ balance × APR/100/12 over rated rows. */
  estMonthlyInterest: number;
  /** Debts (balance > 0) carrying a positive APR. */
  ratedCount: number;
  /** Debts (balance > 0) without a usable APR (excluded from est. interest). */
  unratedCount: number;
  /** Aggregate revolving utilization %, or null when no credit limits are on file. */
  utilizationPct: number | null;
  /** Level of `utilizationPct` per the landed thresholds, or null. */
  utilizationLevel: UtilizationLevel | null;
  /** Σ converted minimum payments (missing ones treated as 0). */
  minPayments: number;
  /** Debts (balance > 0) without a minimum payment on file. */
  missingMinCount: number;
  /** True when any converted amount above was FX-estimated (⇒ `≈` prefix). */
  estimated: boolean;
}

/** Convert a native amount into the display currency, tracking FX taint (the
 *  adapters' pattern). Context-less ⇒ pass-through, never estimated. */
function inDisp(
  amount: number,
  currency: string | null | undefined,
  ctx?: ConversionContext,
): { amount: number; estimated: boolean } {
  if (!ctx) return { amount, estimated: false };
  const c = convertMoney({ amount, currency: currency ?? null }, yesterdayUTCISO(), ctx);
  return { amount: c.amount, estimated: c.estimated };
}

/**
 * Compute the four honest KPI figures from the SAME client accounts array the
 * panels render. Pure and deterministic (FX rate anchored to `yesterdayUTCISO`).
 */
export function computeDebtKpis(
  accounts: DebtPerspectiveAccount[],
  ctx?: ConversionContext,
): DebtKpis {
  let estimated = false;
  const mark = (c: { estimated: boolean }) => { if (c.estimated) estimated = true; };

  // Debt rows with a positive converted balance — the adapters' own filter.
  const debts = accounts
    .filter((a) => a.type === "debt")
    .map((a) => {
      const bal = inDisp(a.balance, a.currency, ctx);
      mark(bal);
      return { a, bal: bal.amount };
    })
    .filter((x) => x.bal > 0);

  // ── Total Debt ──────────────────────────────────────────────────────────────
  const totalDebt = debts.reduce((s, x) => s + x.bal, 0);

  // ── Est. Interest / month (rated rows only) ─────────────────────────────────
  const rated = debts.filter((x) => x.a.interestRate != null && (x.a.interestRate as number) > 0);
  const estMonthlyInterest = rated.reduce(
    (s, x) => s + x.bal * ((x.a.interestRate as number) / 100) / 12,
    0,
  );
  const ratedCount = rated.length;
  const unratedCount = debts.length - ratedCount;

  // ── Aggregate Utilization (converted balances ÷ converted limits) ───────────
  // Mixed-currency ratios are dishonest, so both sides convert before the ratio.
  const revolving = debts.filter((x) => x.a.creditLimit != null && (x.a.creditLimit as number) > 0);
  let utilizationPct: number | null = null;
  let level: UtilizationLevel | null = null;
  if (revolving.length > 0) {
    let sumBal = 0;
    let sumLimit = 0;
    for (const x of revolving) {
      const bal = inDisp(Math.max(0, x.a.balance), x.a.currency, ctx);
      const lim = inDisp(x.a.creditLimit as number, x.a.currency, ctx);
      mark(bal); mark(lim);
      sumBal += bal.amount;
      sumLimit += lim.amount;
    }
    if (sumLimit > 0) {
      utilizationPct = (sumBal / sumLimit) * 100;
      level = utilizationLevel(utilizationPct);
    }
  }

  // ── Minimum payments ────────────────────────────────────────────────────────
  let minPayments = 0;
  let missingMinCount = 0;
  for (const x of debts) {
    if (x.a.minimumPayment == null) { missingMinCount++; continue; }
    const min = inDisp(x.a.minimumPayment, x.a.currency, ctx);
    mark(min);
    minPayments += min.amount;
  }

  return {
    totalDebt,
    estMonthlyInterest,
    ratedCount,
    unratedCount,
    utilizationPct,
    utilizationLevel: level,
    minPayments,
    missingMinCount,
    estimated,
  };
}

/** The aggregate inputs the interactive planner feeds simulatePayoff. */
export interface DebtPayoffAggregate {
  /** Σ converted debt balances (ALL debt rows — the planner does not drop 0-balance rows). */
  total: number;
  /** Blended monthly rate: weightedApr/100/12; 0 when no rates are known. */
  monthlyRate: number;
  /** Σ converted minimum payments (missing ones treated as 0). */
  minPayment: number;
  /** True when any converted amount was FX-estimated. */
  estimated: boolean;
}

/**
 * Derive the planner's blended aggregate ({total, monthlyRate, minPayment})
 * from the client accounts array, mirroring DebtPayoffSection's all-selected
 * default EXACTLY (DebtPayoffSection.tsx:195–219): total over every debt row,
 * a balance-weighted APR over rows with a rate AND a positive native balance,
 * and Σ minimum payments. Sharing this one derivation is how the scenario strip
 * and the "minimums may not cover interest" signal stay pinned to the planner
 * (plan risk §5).
 */
export function computePayoffAggregate(
  accounts: DebtPerspectiveAccount[],
  ctx?: ConversionContext,
): DebtPayoffAggregate {
  let estimated = false;
  const mark = (c: { estimated: boolean }) => { if (c.estimated) estimated = true; };

  const debts = accounts.filter((a) => a.type === "debt");
  const conv = debts.map((a) => {
    const bal = inDisp(a.balance, a.currency, ctx);
    mark(bal);
    return { a, bal: bal.amount };
  });

  const total = conv.reduce((s, r) => s + r.bal, 0);

  const withRate = conv.filter((r) => r.a.interestRate != null && r.a.balance > 0);
  const weightedApr = withRate.length > 0
    ? withRate.reduce((s, r) => s + (r.a.interestRate as number) * r.bal, 0)
      / withRate.reduce((s, r) => s + r.bal, 0)
    : null;
  const monthlyRate = weightedApr != null ? (weightedApr / 100) / 12 : 0;

  let minPayment = 0;
  for (const a of debts) {
    const min = inDisp(a.minimumPayment ?? 0, a.currency, ctx);
    mark(min);
    minPayment += min.amount;
  }

  return { total, monthlyRate, minPayment, estimated };
}
