/**
 * lib/ai/intelligence/annotations/engine.ts
 *
 * computeAssessment — the orchestrator. Wires the deterministic engines into a
 * single FinancialAssessment over an assembled SpaceContext_AI.
 *
 * AI-ARCH Part 5: extracted from the former lib/ai/intelligence/annotations.ts
 * god-module (byte-identical bodies). Public surface re-exported via ./index.
 */

import type {
  CompletenessLevel,
  ConfidenceLevel,
  CashFlowReliability,
  DeficitCauseClassification,
  DebtHealthClassification,
  LiquidityCoverageClassification,
  CurrentStatePriority,
  AprCompleteness,
  DataQualitySection,
  CashFlowSection,
  DebtSection,
  LiquiditySection,
  FinancialAssessment,
  UngradedSection,
} from './types';
import {
  SNAPSHOT_LOW_THRESHOLD,
  SNAPSHOT_HIGH_THRESHOLD,
  TXN_COUNT_MINIMUM,
  INCOME_PLAUS_RATIO_LOW,
  INCOME_TXN_HIGH_THRESHOLD,
  APR_CRITICAL_THRESHOLD,
  APR_WARNING_THRESHOLD,
  LIQUIDITY_CRITICAL_MONTHS,
  LIQUIDITY_WARNING_MONTHS,
  LIQUIDITY_EXCELLENT_MONTHS,
  DEBT_FRACTION_DOMINANT,
  DEBT_FRACTION_PARTIAL,
} from './constants';
import { computeAverageMonthlySpending, computeDebtStrategy, computeSpendingOpportunities, computeSpendingTrends, getAcctsData, getGoalsData, getSnapData, getTxnData } from './metrics';
import { deriveHeuristics, derivePriorities } from './rules';
import { computeCapitalAllocation, computeGoalAlignment, computeInvestmentReadiness, computeRiskOpportunities } from './engines';
import type { SpaceContext_AI } from '@/lib/ai/types';
import { MATERIAL_UNIDENTIFIED_INFLOW_SHARE, deriveUnidentifiedInflowShare } from '@/lib/ai/types';
import { amountOwed, hasOutstandingDebt } from '@/lib/debt/balance-semantics';
import { computeDebtAggregate, type DebtAggregateRow } from '@/lib/debt/aggregates';
import { resolveExpenseBaseline } from '@/lib/liquidity/expense-baseline';

export function computeAssessment(ctx: SpaceContext_AI): FinancialAssessment {
  const txn   = getTxnData(ctx);
  const snap  = getSnapData(ctx);
  const accts = getAcctsData(ctx);
  const goals = getGoalsData(ctx);

  // ── Raw inputs (with safe defaults for absent domains) ───────────────────

  const snapshotCount    = snap?.snapshotCount    ?? 0;
  const windowDays       = txn?.windowDays         ?? 90;
  const transactionCount = txn?.transactionCount   ?? 0;
  const incomeTotal      = txn?.incomeTotal        ?? 0;
  const expenseTotal     = txn?.expenseTotal       ?? 0;
  const debtPaymentTotal = txn?.debtPaymentTotal   ?? 0;
  // REVIEW-3 C-3 — netCashFlow is now THE canonical economic net (income −
  // clamped spend; debt payments excluded). The after-paydown position is its
  // own named figure; the `??` keeps fixtures that predate the field working.
  const netCashFlow          = txn?.netCashFlow    ?? 0;
  const netAfterDebtPayments = txn?.netAfterDebtPayments ?? (netCashFlow - debtPaymentTotal);
  const totalLiquid      = accts?.totalLiquid      ?? 0;
  const totalLiabilities = accts?.totalLiabilities ?? 0;

  const incomeEntry          = txn?.byCategory.find((c) => c.category === 'Income');
  const incomeTransactionCount = incomeEntry?.count ?? 0;

  const totalOutflows    = expenseTotal + debtPaymentTotal;
  const incomePlausRatio = totalOutflows > 0 ? incomeTotal / totalOutflows : 1;

  // ── Step 1: Data quality ─────────────────────────────────────────────────

  const transactionHistoryCompleteness: CompletenessLevel = (() => {
    if (transactionCount === 0 || snapshotCount < SNAPSHOT_LOW_THRESHOLD) return 'LOW';
    if (snapshotCount < SNAPSHOT_HIGH_THRESHOLD || transactionCount < TXN_COUNT_MINIMUM) return 'MEDIUM';
    return 'HIGH';
  })();

  // TI2-W2 — unidentified-inflow share (null when no in-window income). Guarded
  // divide (deriveUnidentifiedInflowShare) so a zero-income window is null, never
  // NaN/Infinity. Defensive against fixtures predating the W1 aggregate block.
  const unidentifiedInflowShare = txn ? deriveUnidentifiedInflowShare(txn) : null;
  const unidentifiedInflowMaterial =
    unidentifiedInflowShare !== null && unidentifiedInflowShare >= MATERIAL_UNIDENTIFIED_INFLOW_SHARE;

  const incomeConfidence: ConfidenceLevel = (() => {
    const base: ConfidenceLevel = (() => {
      if (transactionHistoryCompleteness === 'LOW' || incomeTransactionCount === 0) return 'LOW';
      if (snapshotCount < SNAPSHOT_HIGH_THRESHOLD) {
        if (incomeTransactionCount <= 1 || incomePlausRatio < INCOME_PLAUS_RATIO_LOW) return 'LOW';
        return 'MEDIUM';
      }
      if (incomeTransactionCount <= 1 && incomePlausRatio < INCOME_PLAUS_RATIO_LOW) return 'LOW';
      if (incomeTransactionCount >= INCOME_TXN_HIGH_THRESHOLD && incomePlausRatio >= INCOME_PLAUS_RATIO_LOW) return 'HIGH';
      return 'MEDIUM';
    })();
    // TI2-W2 downgrade: a material unidentified-inflow share caps confidence at
    // MEDIUM. This lets an honesty fact the row-count proxy cannot see pull a
    // window down from HIGH — three unidentified deposits pass the count test but
    // should not read as high-confidence income.
    if (base === 'HIGH' && unidentifiedInflowMaterial) return 'MEDIUM';
    return base;
  })();

  const dataQuality: DataQualitySection = {
    transactionHistoryCompleteness,
    // v2.6-WINDOW-1 — the MEASURED calendar span, not the row count.
    // `snapshotSpanDays` held `snapshotCount`, and the prompt serializer renders
    // it as "N-day history in 90-day window" — so the model was told a row count
    // was a duration. The thresholds above deliberately keep reading
    // `snapshotCount`: they gate on data DENSITY, which is a different question.
    snapshotSpanDays: snap?.spanDays ?? 0,
    incomeConfidence,
    incomeTransactionCount,
    unidentifiedInflowShare,
  };

  // ── Step 2: Cash flow ────────────────────────────────────────────────────

  const impliedMonthlyIncome: number | null = txn && windowDays > 0
    ? Math.round((incomeTotal / windowDays * 30) * 100) / 100
    : null;

  // KD-10: authoritative monthly spending (reliable-month average). Replaces the
  // window-normalized estimate that competed with the prompt context block.
  const estimatedMonthlyExpenses: number | null = computeAverageMonthlySpending(txn);

  const estimatedMonthlyDebtPayments: number | null = txn && windowDays > 0 && debtPaymentTotal > 0
    ? Math.round((debtPaymentTotal / windowDays * 30) * 100) / 100
    : null;

  const hasActiveDebtGoal = (goals?.goals ?? []).some(
    (g) => g.status === 'ACTIVE' && g.goalType === 'DEBT_REDUCTION',
  );

  // REVIEW-3 C-3 — graded on the CANONICAL figures. The trigger is the full cash
  // deficit (net after debt payments < 0); the OVERSPENDING claim specifically
  // requires the canonical economic net to be negative — that is the exact
  // number the Cash Flow workspace renders, so "you spent more than you took in"
  // can no longer contradict a surplus on screen. A deficit that debt payments
  // fully explain is INTENTIONAL_DEBT_PAYOFF / MIXED with an active goal, and
  // DEBT_DRIVEN without one — named, never mislabelled as overspending.
  const deficitCause: DeficitCauseClassification = (() => {
    if (netAfterDebtPayments >= 0)  return 'NOT_APPLICABLE';
    if (incomeConfidence === 'LOW') return 'LOW_INCOME_SAMPLE';
    const deficit      = Math.abs(netAfterDebtPayments);
    const debtFraction = deficit > 0 ? debtPaymentTotal / deficit : 0;
    if (debtFraction >= DEBT_FRACTION_DOMINANT && hasActiveDebtGoal) return 'INTENTIONAL_DEBT_PAYOFF';
    if (debtFraction >= DEBT_FRACTION_PARTIAL && hasActiveDebtGoal)  return 'MIXED';
    if (netCashFlow < 0) return 'POSSIBLE_OVERSPENDING';
    return 'DEBT_DRIVEN';
  })();

  const cashFlowReliability: CashFlowReliability =
    incomeConfidence === 'LOW'    ? 'UNRELIABLE' :
    incomeConfidence === 'MEDIUM' ? 'PARTIAL'    :
    'RELIABLE';

  const cashFlow: CashFlowSection = {
    reliability:                  cashFlowReliability,
    confidence:                   incomeConfidence,
    deficitCause,
    transactionCompleteness:      transactionHistoryCompleteness,
    impliedMonthlyIncome,
    estimatedMonthlyExpenses,
    estimatedMonthlyDebtPayments,
    incomeTransactionCount,
    incompleteIncomeWarning:      incomeConfidence === 'LOW',
  };

  // ── Step 3: Debt ─────────────────────────────────────────────────────────

  let debtSection: DebtSection;

  if (!accts) {
    debtSection = {
      classification:        'INSUFFICIENT_DATA',
      confidence:            'LOW',
      totalLiabilities:      0,
      monthlyInterestBurden: null,
      aprCompleteness:       'NONE',
      hasNullAPR:            false,
      hasBalanceOnlyDebt:    false,
      aprGapAccountNames:    [],
    };
  } else if (totalLiabilities === 0) {
    debtSection = {
      classification:        'NO_DEBT',
      confidence:            'HIGH',
      totalLiabilities:      0,
      monthlyInterestBurden: null,
      aprCompleteness:       'FULL', // vacuously: no debt accounts to be incomplete
      hasNullAPR:            false,
      hasBalanceOnlyDebt:    false,
      aprGapAccountNames:    [],
    };
  } else if (accts.accounts === undefined) {
    // v2.6-BRIEF-1 — the per-account list was WITHHELD, not empty.
    //
    // `AccountsSectionData.accounts` is optional and its own doc says
    // "omitted when scopeHint === 'brief'". This branch used to read
    // `accts.accounts ?? []`, which collapsed WITHHELD and NONE into the same
    // empty set — so a real liability with its account list truncated away was
    // graded from zero debt accounts: no APR found, weighted average 0, verdict
    // HEALTHY at HIGH confidence. Measured on a $20,000 liability
    // (lib/ai/intelligence/brief-scope-adequacy.test.ts).
    //
    // That is a conclusion drawn from ABSENCE — the mirror image of the rule
    // v2.6-DEBT-1 established for admission ("absence of contradiction is not
    // evidence"). The engine may only grade debt it was actually shown.
    // `totalLiabilities` is still reported: the AMOUNT is a fact the payload
    // does carry; only the GRADE is unknowable.
    debtSection = {
      classification:        'INSUFFICIENT_DATA',
      confidence:            'LOW',
      totalLiabilities,
      monthlyInterestBurden: null,
      aprCompleteness:       'NONE',
      hasNullAPR:            true,
      hasBalanceOnlyDebt:    false,
      aprGapAccountNames:    [],
    };
  } else {
    const debtAccounts = accts.accounts.filter((a) => a.type === 'debt');

    let interestBurden    = 0;
    // v2.6-DEBT-1 — the rows this section weights, handed to the ONE aggregate
    // authority below instead of being reduced inline. The APR was previously
    // back-derived here as `interestBurden * 12 / totalDebtWithAPR`, which is
    // the same number `computeDebtStrategy` computed from the same population
    // and rounded differently — one figure, two values, in one engine.
    const aprRows: DebtAggregateRow[] = [];
    let hasNullAPR        = false;
    let fullVisDebtCount  = 0;
    let fullVisWithAPR    = 0;

    const hasBalanceOnlyDebt = debtAccounts.some((a) => a.visibilityLevel === 'BALANCE_ONLY');

    for (const acct of debtAccounts) {
      if (acct.visibilityLevel === 'BALANCE_ONLY') {
        // APR is structurally inaccessible — counts as missing for classification.
        hasNullAPR = true;
        continue;
      }
      // FULL-visibility debt account
      fullVisDebtCount++;
      if (acct.apr == null) {
        hasNullAPR = true;
      } else {
        fullVisWithAPR++;
        // V25-FINAL-1 — only accounts with a reporting-currency value can enter the
        // cross-account interest-burden sum; an unconvertible balance (null) is
        // excluded (disclosed via totalsUnconverted) rather than summed as a fake 0.
        // V25-SIDE-1 — only real outstanding debt accrues interest. A credit
        // balance previously entered here via Math.abs and generated phantom
        // interest burden on money the issuer owes the USER.
        if (acct.reportingBalance !== null && hasOutstandingDebt(acct.reportingBalance)) {
          // P2-7D — reporting-currency balance: monthlyInterestBurden and the
          // APR-weighting denominator sum across accounts, so mixed-currency
          // native balances would be an invalid sum. APR stays dimensionless.
          const balance   = amountOwed(acct.reportingBalance);
          // A 0% row accrues nothing, so it adds nothing here — but it IS a
          // known rate and belongs in the blended-rate population below.
          interestBurden += balance * acct.apr / 100 / 12;
          aprRows.push({ balance, apr: acct.apr, minimumPayment: null });
        }
      }
    }

    // APR completeness across FULL-visibility debt accounts only.
    const aprCompleteness: AprCompleteness =
      fullVisDebtCount === 0         ? 'NONE'    :
      fullVisWithAPR === 0           ? 'NONE'    :
      fullVisWithAPR === fullVisDebtCount ? 'FULL' :
      'PARTIAL';

    // APR gap account names (FULL-visibility only — privacy enforced by assembler).
    const aprGapAccountNames: string[] = (accts.knowledgeGaps ?? [])
      .filter((g) => g.field === 'apr')
      .map((g) => g.accountName);

    // Debt health classification.
    let debtHealthClassification: DebtHealthClassification;
    if (hasNullAPR) {
      debtHealthClassification = 'INSUFFICIENT_DATA';
    } else {
      // No rated row that owes ⇒ no blended rate. `?? 0` preserves the previous
      // behaviour exactly: with nothing to weight, the rate thresholds below
      // cannot fire and the classification falls to IMPROVING / HEALTHY on the
      // liabilities trend, which is the honest read when no interest is accruing.
      const weightedAvgAPR = computeDebtAggregate(aprRows).weightedApr ?? 0;
      const history = snap?.history ?? [];
      const isLiabilitiesDeclining =
        history.length >= 7 &&
        history[history.length - 1].liabilities < history[0].liabilities;

      if (weightedAvgAPR > APR_CRITICAL_THRESHOLD) {
        debtHealthClassification = 'CRITICAL';
      } else if (weightedAvgAPR > APR_WARNING_THRESHOLD) {
        debtHealthClassification = 'WARNING';
      } else if (isLiabilitiesDeclining) {
        debtHealthClassification = 'IMPROVING';
      } else {
        debtHealthClassification = 'HEALTHY';
      }
    }

    // Debt confidence: how reliable is the classification?
    // Balance data is always reliable; the uncertainty is APR completeness.
    const debtConfidence: ConfidenceLevel =
      debtHealthClassification !== 'INSUFFICIENT_DATA' ? 'HIGH' :
      aprCompleteness === 'PARTIAL'                    ? 'MEDIUM' :
      'LOW';

    debtSection = {
      classification:        debtHealthClassification,
      confidence:            debtConfidence,
      totalLiabilities,
      monthlyInterestBurden: interestBurden > 0
        ? Math.round(interestBurden * 100) / 100
        : null,
      aprCompleteness,
      hasNullAPR,
      hasBalanceOnlyDebt,
      aprGapAccountNames,
    };
  }

  // ── Step 4: Liquidity ────────────────────────────────────────────────────

  const liquidAccountCount: number = accts?.counts.liquid ?? 0;
  const hasAccountsDomain:  boolean = accts !== null;
  const noLiquidAccountsInSpace = hasAccountsDomain && liquidAccountCount === 0;

  // KD-10: same authoritative value as cash flow — one source of truth. Coverage
  // below divides liquid cash by this figure, so both stay consistent.
  const estimatedMonthlyExpense: number | null = computeAverageMonthlySpending(txn);

  let liquidityCoverageMonths: number | null = null;
  let liquidityCoverageClassification: LiquidityCoverageClassification;

  // v2.6-ASSESS-1 — A ZERO BASELINE IS NOT INFINITE RUNWAY.
  //
  // The guard was `estimatedMonthlyExpense === null`, and `computeAverageMonthlySpending`
  // returns null only when NO reliable month exists. A Space with reliable months
  // and no spending in them returns 0 — a true measurement — and 0 went straight
  // into the divide.
  //
  // Measured on the live corpus: 5 of 9 Spaces had liquid accounts and a $0.00
  // measured baseline, so each was graded:
  //
  //     Coverage: Infinity months → EXCELLENT     [confidence: HIGH]
  //     1. [HIGH] READY_TO_INVEST — conditions support investing
  //
  // and a Space with zero cash AND zero spending produced NaN, which fails every
  // `<` comparison and therefore also fell through to EXCELLENT. The engine was
  // manufacturing a HIGH-confidence investment recommendation out of an absence
  // of evidence — the same error this arc removed from debt admission
  // (v2.6-DEBT-1: "absence of contradiction is not evidence"), here producing a
  // FINDING rather than a membership.
  //
  // It also serialized incoherently: `JSON.stringify(Infinity)` is `null`, so a
  // consumer received `{ coverageMonths: null, classification: "EXCELLENT" }` —
  // an object contradicting itself, with the null looking like an honest refusal.
  //
  // Dividing by zero does not yield a large number; it yields no number. Nothing
  // is known about how long this cash lasts, so the authority says so.
  // v2.6-ASSESS-2 — the baseline is chosen by THE authority, not here.
  //
  // The product divided by the user's DECLARED figure and this engine by the
  // MEASURED one, so "months of expenses covered" had two answers under one set
  // of words — and neither surface said which it had used. `resolveExpenseBaseline`
  // owns the precedence (declared outranks measured, a non-positive figure is a
  // refusal) and reports WHICH rung answered, so a consumer can disclose it.
  const baseline = resolveExpenseBaseline({
    declared: txn?.declaredMonthlyExpenses,
    measured: estimatedMonthlyExpense,
  });

  if (liquidAccountCount === 0 || baseline === null) {
    liquidityCoverageClassification = 'UNKNOWN';
  } else {
    const months = totalLiquid / baseline.amount;
    // Belt to the braces above: `totalLiquid` is summed by an assembler, and a
    // non-finite input must never become a grade. Every comparison below is `<`,
    // which NaN fails silently — so an unguarded NaN lands on 'EXCELLENT', the
    // most favourable verdict available, by falling through every check.
    if (!Number.isFinite(months)) {
      liquidityCoverageClassification = 'UNKNOWN';
    } else {
      liquidityCoverageMonths = Math.round(months * 100) / 100;
      liquidityCoverageClassification =
        liquidityCoverageMonths < LIQUIDITY_CRITICAL_MONTHS  ? 'CRITICAL' :
        liquidityCoverageMonths < LIQUIDITY_WARNING_MONTHS   ? 'WARNING'  :
        liquidityCoverageMonths < LIQUIDITY_EXCELLENT_MONTHS ? 'SAFE'     :
        'EXCELLENT';
    }
  }

  // Liquidity confidence: balance data is always reliable when accounts are
  // present — but a confidence describes the CLASSIFICATION, and there is no
  // such thing as a HIGH-confidence UNKNOWN. The old shape reported
  // "EXCELLENT [confidence: HIGH]" off a zero baseline; reporting
  // "UNKNOWN [confidence: HIGH]" instead would fix the grade and keep the lie.
  const liquidityConfidence: ConfidenceLevel =
    !hasAccountsDomain                                 ? 'LOW'    :
    noLiquidAccountsInSpace                            ? 'MEDIUM' : // accounts present but liquid ones missing from Space
    liquidityCoverageClassification === 'UNKNOWN'      ? 'LOW'    : // no baseline ⇒ nothing was classified
    'HIGH';

  const liquidity: LiquiditySection = {
    classification:          liquidityCoverageClassification,
    confidence:              liquidityConfidence,
    liquidCashTotal:         totalLiquid,
    liquidAccountCount,
    coverageMonths:          liquidityCoverageMonths,
    // v2.6-ASSESS-2 — the figure actually divided by, and which rung supplied
    // it. Reporting the measured figure while having divided by the declared one
    // would be a new way to be wrong about the same number.
    estimatedMonthlyExpense: baseline?.amount ?? estimatedMonthlyExpense,
    estimatedMonthlyExpenseBasis: baseline?.basis ?? null,
    noLiquidAccountsInSpace,
    hasAccountsDomain,
  };

  // ── Step 5: Current state priority ──────────────────────────────────────

  const currentStatePriority: CurrentStatePriority = (() => {
    if (
      transactionHistoryCompleteness === 'LOW' ||
      incomeConfidence === 'LOW'
    ) return 'DATA_QUALITY';

    if (liquidityCoverageClassification === 'CRITICAL') return 'LIQUIDITY';
    if (debtSection.classification === 'CRITICAL')      return 'DEBT';

    if (deficitCause === 'POSSIBLE_OVERSPENDING') return 'CASH_FLOW';
    if (debtSection.classification === 'WARNING') return 'DEBT';

    if (deficitCause === 'INTENTIONAL_DEBT_PAYOFF' || deficitCause === 'MIXED' || deficitCause === 'DEBT_DRIVEN') return 'CASH_FLOW';

    return 'LIQUIDITY';
  })();

  // ── Step 6: Debt Strategy (2.2) ─────────────────────────────────────────

  const debtStrategy = computeDebtStrategy(accts, debtSection);

  // ── Step 7: Capital Allocation (2.1) ────────────────────────────────────
  // Must follow debtStrategy — uses its weightedAvgApr output.

  const capitalAllocation = computeCapitalAllocation(liquidity, debtSection, cashFlow, debtStrategy);

  // ── Step 8: Spending Opportunities (2.3) ────────────────────────────────

  const spendingOpportunities = computeSpendingOpportunities(txn, dataQuality);

  // ── Step 8B: Spending Trends (2.3B) ─────────────────────────────────────
  // Deterministic MoM / rolling trends from monthlyBreakdown complete months.

  const spendingTrends = computeSpendingTrends(txn);

  // ── Step 9: Goal Alignment (2.4) ────────────────────────────────────────

  const goalAlignment = computeGoalAlignment(goals, cashFlow, debtSection, txn, snap);

  // ── Step 10: Investment Readiness (2.5) ─────────────────────────────────

  const investmentReadiness = computeInvestmentReadiness(liquidity, debtSection, debtStrategy, ctx);

  // ── Step 11: Risk & Opportunity (2.6) ────────────────────────────────────
  // Aggregates the sections above — must run after all of them are computed.

  const riskOpportunities = computeRiskOpportunities(
    dataQuality,
    cashFlow,
    debtSection,
    liquidity,
    debtStrategy,
    spendingOpportunities,
    goalAlignment,
    investmentReadiness,
    txn, // TI2-W2 — amount-based INCOMPLETE_INCOME_DATA wording
    ctx.space.reportingCurrency, // REVIEW-3 C-6 — money in evidence strings
  );

  // ── Step 12: Heuristics and priorities ──────────────────────────────────

  const advisorHeuristics = deriveHeuristics(dataQuality, cashFlow, debtSection, liquidity);
  const priorities        = derivePriorities(dataQuality, cashFlow, debtSection, liquidity);

  // ── Step 13: Declared insufficiency (REVIEW-3 C-7, audit E3) ─────────────
  // scopeHint silently changed what this authority could decide: 'brief' omits
  // the per-account list (debt forced INSUFFICIENT_DATA) and its 30-day rolling
  // window almost never contains a complete calendar month (liquidity UNKNOWN
  // ~30 days in 31). The scope behaviour itself is unchanged; what changes is
  // that every withheld grade is now DECLARED, with a reason a consumer can
  // read — so the Brief can say what was withheld or stay silent knowingly,
  // instead of implying a grade the evidence cannot carry.
  const ungraded: UngradedSection[] = [];
  if (debtSection.classification === 'INSUFFICIENT_DATA') {
    if (!accts) {
      ungraded.push({
        section: 'debt', verdict: 'INSUFFICIENT_DATA', reason: 'ACCOUNTS_DOMAIN_ABSENT',
        detail:  'No accounts domain was assembled — debt cannot be graded.',
      });
    } else if (accts.accounts === undefined) {
      ungraded.push({
        section: 'debt', verdict: 'INSUFFICIENT_DATA', reason: 'ACCOUNT_LIST_WITHHELD_BY_SCOPE',
        detail:  'The per-account list was withheld by the brief scope, so liabilities exist but their rates cannot be graded.',
      });
    } else {
      ungraded.push({
        section: 'debt', verdict: 'INSUFFICIENT_DATA', reason: 'APR_MISSING',
        detail:  'One or more debt accounts carry no APR (missing input or balance-only visibility).',
      });
    }
  }
  if (liquidity.classification === 'UNKNOWN') {
    ungraded.push(
      noLiquidAccountsInSpace || liquidAccountCount === 0
        ? {
            section: 'liquidity', verdict: 'UNKNOWN', reason: 'NO_LIQUID_ACCOUNTS_IN_SPACE',
            detail:  'No checking or savings accounts are linked to this Space, so coverage cannot be computed.',
          }
        : {
            section: 'liquidity', verdict: 'UNKNOWN', reason: 'NO_EXPENSE_BASELINE_IN_WINDOW',
            detail:  `No expense baseline: no declared monthly figure and no complete calendar month in the ${windowDays}-day analysis window.`,
          },
    );
  }
  if (cashFlow.reliability === 'UNRELIABLE') {
    ungraded.push({
      section: 'cashFlow', verdict: 'UNRELIABLE', reason: 'LOW_INCOME_CONFIDENCE',
      detail:  'Income confidence is LOW — cash-flow verdicts over this window would be data artifacts.',
    });
  }

  return {
    dataQuality,
    cashFlow,
    debt:                  debtSection,
    liquidity,
    capitalAllocation,
    debtStrategy,
    spendingOpportunities,
    spendingTrends,
    goalAlignment,
    investmentReadiness,
    riskOpportunities,
    currentStatePriority,
    advisorHeuristics,
    priorities,
    ungraded,
  };
}


