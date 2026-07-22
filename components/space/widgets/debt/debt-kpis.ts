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
import { amountOwed, hasOutstandingDebt, liabilityState } from "@/lib/debt/balance-semantics";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { utilizationLevel, type UtilizationLevel } from "@/lib/accounts/credit-utilization";
import type { ConversionContext } from "@/lib/money/types";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";

export interface DebtKpis {
  /** Σ converted amount OWED (`amountOwed`) over type === "debt" rows. Credit
   *  balances contribute 0 — never negative debt, never phantom debt. */
  totalDebt: number;
  /** Σ owed × APR/100/12 over rated rows. */
  estMonthlyInterest: number;
  /** V25-SIDE-1 — ALL debt accounts, structurally. Membership never depends on
   *  balance, so this is the number of rows the Liabilities ledger renders. */
  accountCount: number;
  /** Debt accounts carrying outstanding debt (`amountOwed > 0`). */
  owingCount: number;
  /** Debt accounts at exactly zero — paid off, still open. */
  settledCount: number;
  /** Debt accounts carrying an issuer credit (`creditBalance > 0`). */
  creditCount: number;
  /** INDEBTED accounts carrying a positive APR. Scoped to accounts that owe,
   *  because these two counts exist to explain the est.-interest figure — a
   *  paid-off card accrues nothing either way, so listing its missing APR as a
   *  gap would be noise. `accountCount` is the structural count. */
  ratedCount: number;
  /** Indebted accounts without a usable APR (excluded from est. interest). */
  unratedCount: number;
  /** Aggregate revolving utilization %, or null when no credit limits are on file. */
  utilizationPct: number | null;
  /** Level of `utilizationPct` per the landed thresholds, or null. */
  utilizationLevel: UtilizationLevel | null;
  /** Σ converted minimum payments over accounts that actually OWE (missing ones
   *  treated as 0). Nothing is due on a settled or credit-balance account. */
  minPayments: number;
  /** Debts WITH outstanding balance but no minimum payment on file. */
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
  // V25-FINAL-1 — unavailable conversion excluded (0) from the KPI sums, never a
  // native magnitude; `estimated` (true on a miss) discloses the KPIs are approximate.
  return { amount: c.amount ?? 0, estimated: c.estimated };
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

  // V25-SIDE-1 — MEMBERSHIP is structural; `bal` is the canonical amount OWED.
  // The former `.filter((x) => x.bal > 0)` dropped paid-off and credit-balance
  // cards out of every KPI. They are still debt accounts, so they stay in
  // `debts` (and in the counts below) and simply contribute zero owed.
  const debts = accounts
    .filter((a) => a.type === "debt")
    .map((a) => {
      const bal = inDisp(a.balance, a.currency, ctx);
      mark(bal);
      return {
        a,
        bal: amountOwed(bal.amount),
        owes: hasOutstandingDebt(bal.amount),
        state: liabilityState(bal.amount),
      };
    });

  // ── Total Debt ──────────────────────────────────────────────────────────────
  const totalDebt = debts.reduce((s, x) => s + x.bal, 0);

  // ── Est. Interest / month (rated, INDEBTED rows only) ───────────────────────
  // V25-SIDE-1 — the rated/unrated split explains the interest figure, so it is
  // scoped to accounts that actually owe. `accountCount` below is the structural
  // membership count and includes paid-off / credit-balance cards.
  const owing = debts.filter((x) => x.owes);
  const rated = owing.filter((x) => x.a.interestRate != null && (x.a.interestRate as number) > 0);
  const estMonthlyInterest = rated.reduce(
    (s, x) => s + x.bal * ((x.a.interestRate as number) / 100) / 12,
    0,
  );
  const accountCount = debts.length;
  const owingCount = owing.length;
  const settledCount = debts.filter((x) => x.state === "settled").length;
  const creditCount = debts.filter((x) => x.state === "credit").length;
  const ratedCount = rated.length;
  const unratedCount = owingCount - ratedCount;

  // ── Aggregate Utilization (converted balances ÷ converted limits) ───────────
  // Mixed-currency ratios are dishonest, so both sides convert before the ratio.
  const revolving = debts.filter((x) => x.a.creditLimit != null && (x.a.creditLimit as number) > 0);
  let utilizationPct: number | null = null;
  let level: UtilizationLevel | null = null;
  if (revolving.length > 0) {
    let sumBal = 0;
    let sumLimit = 0;
    for (const x of revolving) {
      // V25-SIDE-1 — numerator is amount OWED, so a credit balance contributes 0
      // used (never a negative numerator) while its limit still counts below.
      const bal = inDisp(amountOwed(x.a.balance), x.a.currency, ctx);
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
  // V25-SIDE-1 — nothing is DUE on a settled or credit-balance account, and a
  // missing minimum on one is not a data gap worth reporting.
  let minPayments = 0;
  let missingMinCount = 0;
  for (const x of debts) {
    if (!x.owes) continue;
    if (x.a.minimumPayment == null) { missingMinCount++; continue; }
    const min = inDisp(x.a.minimumPayment, x.a.currency, ctx);
    mark(min);
    minPayments += min.amount;
  }

  return {
    totalDebt,
    estMonthlyInterest,
    accountCount,
    owingCount,
    settledCount,
    creditCount,
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
  /** Σ converted amount OWED over ALL debt rows. Settled and credit-balance rows
   *  are retained as members but contribute 0 — issuer credits never net against
   *  another account's payoff obligation. */
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
    return { a, bal: amountOwed(bal.amount), owes: hasOutstandingDebt(bal.amount) };
  });

  // V25-SIDE-1 — NO CROSS-ACCOUNT NETTING. The former raw sum let a credit
  // balance on one card silently reduce the payoff obligation on an unrelated
  // card; an issuer credit is spendable only at that issuer, so it cannot
  // discharge someone else's debt. Each row contributes `amountOwed` or nothing.
  const total = conv.reduce((s, r) => s + r.bal, 0);

  const withRate = conv.filter((r) => r.a.interestRate != null && r.owes);
  const weightedApr = withRate.length > 0
    ? withRate.reduce((s, r) => s + (r.a.interestRate as number) * r.bal, 0)
      / withRate.reduce((s, r) => s + r.bal, 0)
    : null;
  const monthlyRate = weightedApr != null ? (weightedApr / 100) / 12 : 0;

  let minPayment = 0;
  for (const r of conv) {
    if (!r.owes) continue; // nothing due on a settled / credit-balance account
    const min = inDisp(r.a.minimumPayment ?? 0, r.a.currency, ctx);
    mark(min);
    minPayment += min.amount;
  }

  return { total, monthlyRate, minPayment, estimated };
}
