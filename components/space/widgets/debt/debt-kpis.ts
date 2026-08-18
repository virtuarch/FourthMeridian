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
import { computeDebtAggregate, type DebtAggregateRow } from "@/lib/debt/aggregates";
import { yesterdayUTCISO } from "@/lib/fx/config";
import { utilizationLevel, isRevolvingLine, type UtilizationLevel } from "@/lib/accounts/credit-utilization";
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

  // ── Total owed, rated/unrated split, minimums ───────────────────────────────
  // v2.6-DEBT-1 — one authority for the three aggregate questions. The minimums
  // are converted here (the display currency is this widget's context) and the
  // membership rule is applied there.
  const agg = computeDebtAggregate(
    debts.map((x): DebtAggregateRow => {
      let min: number | null = null;
      if (x.a.minimumPayment != null) {
        const m = inDisp(x.a.minimumPayment, x.a.currency, ctx);
        mark(m);
        min = m.amount;
      }
      // `x.bal` is already the converted amount OWED; the authority re-applies
      // `amountOwed`, which is idempotent on a non-negative figure.
      return { balance: x.bal, apr: x.a.interestRate ?? null, minimumPayment: min };
    }),
  );

  const totalDebt = agg.totalOwed;

  // ── Est. Interest / month (rated, INDEBTED rows only) ───────────────────────
  // A DIFFERENT question from the blended rate: what does this debt COST per
  // month. It stays here because it is a sum of money, not a rate — and a 0%
  // row contributes exactly 0, so the population needs no `> 0` guard to agree
  // with the rated split above.
  const owing = debts.filter((x) => x.owes);
  const estMonthlyInterest = owing.reduce(
    (s, x) => s + (x.a.interestRate != null ? x.bal * (x.a.interestRate / 100) / 12 : 0),
    0,
  );
  const accountCount = debts.length;
  const owingCount = owing.length;
  const settledCount = debts.filter((x) => x.state === "settled").length;
  const creditCount = debts.filter((x) => x.state === "credit").length;
  // v2.6-DEBT-1 — "rated" now means AN APR IS ON FILE, not "an APR above zero".
  // A 0% promotional balance used to be counted as a data gap and reported by
  // debt-signals as "missing an APR", which is a false claim about the user's data.
  const ratedCount = agg.ratedCount;
  const unratedCount = agg.unratedCount;

  // ── Aggregate Utilization (converted balances ÷ converted limits) ───────────
  // Mixed-currency ratios are dishonest, so both sides convert before the ratio.
  // REVIEW-3 C-4 — membership via the canonical revolving-line predicate: a
  // loan carrying a provider limit no longer inflates the Space's utilization
  // while the Credit page excludes it.
  const revolving = debts.filter((x) => isRevolvingLine(x.a));
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
  // missing minimum on one is not a data gap worth reporting. Both rules now
  // live in the aggregate authority (v2.6-DEBT-1).
  const minPayments = agg.minimumPayment;
  const missingMinCount = agg.missingMinimumCount;

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

  // v2.6-DEBT-1 — this function's body WAS a transcription of
  // DebtPayoffSection.tsx:195–219, kept in sync by a comment. Both now call the
  // aggregate authority, so "in sync" is a property of the code rather than a
  // promise in a docstring. V25-SIDE-1's no-cross-account-netting rule moved
  // with it and is enforced there (`amountOwed` per row, never a raw sum).
  const debts = accounts.filter((a) => a.type === "debt");
  const rows = debts.map((a): DebtAggregateRow => {
    const bal = inDisp(a.balance, a.currency, ctx);
    mark(bal);
    let min: number | null = null;
    if (a.minimumPayment != null) {
      const m = inDisp(a.minimumPayment, a.currency, ctx);
      mark(m);
      min = m.amount;
    }
    return { balance: bal.amount, apr: a.interestRate ?? null, minimumPayment: min };
  });

  const agg = computeDebtAggregate(rows);

  return {
    total:       agg.totalOwed,
    monthlyRate: agg.monthlyRate,
    minPayment:  agg.minimumPayment,
    estimated,
  };
}
