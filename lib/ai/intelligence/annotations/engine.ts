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
  DeficitReasonCode,
  DebtRateClassification,
  ClassificationReason,
  DebtReasonCode,
  LiquidityReasonCode,
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
  // W2 — DEBT_FRACTION_DOMINANT / DEBT_FRACTION_PARTIAL no longer imported:
  // their only consumers were the deleted intent rungs of the deficit ladder.
} from './constants';
import { computeAverageMonthlyDebtPayments, computeAverageMonthlyIncome, computeAverageMonthlySpending, computeMonthlySpendingBasis, computeDebtStrategy, computeSpendingOpportunities, computeSpendingTrends, getAcctsData, getSnapData, getTxnData } from './metrics';
import { deriveHeuristics, derivePriorities } from './rules';
import {
  computeDebtBurden, gradeDebtRate, gradeLiquidityCoverage, liquidityReason, ungradedDebtReason,
} from './classification-reason';
import { computeCapitalAllocation, computeInvestmentReadiness, computeRiskOpportunities, computeTrajectory } from './engines';
import type { SpaceContext_AI } from '@/lib/ai/types';
import { MATERIAL_UNIDENTIFIED_INFLOW_SHARE, deriveUnidentifiedInflowShare } from '@/lib/ai/types';
import { amountOwed, hasOutstandingDebt } from '@/lib/debt/balance-semantics';
import { computeDebtAggregate, type DebtAggregateRow } from '@/lib/debt/aggregates';
import { resolveExpenseBaseline } from '@/lib/liquidity/expense-baseline';

export function computeAssessment(ctx: SpaceContext_AI): FinancialAssessment {
  const txn   = getTxnData(ctx);
  const snap  = getSnapData(ctx);
  const accts = getAcctsData(ctx);
  // W2 — the goals domain read was deleted with the Goals retirement.

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
  // The assembler always emits `netAfterDebtPayments`. A hand-built payload without
  // it falls back to the SAME definition (economic net − net paydown), never to the
  // retired `− debtPaymentTotal`, which counted card-funded spending twice.
  const netPaydown = txn?.debtService?.netPaydown ?? debtPaymentTotal;
  const netAfterDebtPayments = txn?.netAfterDebtPayments ?? (netCashFlow - netPaydown);
  const totalLiquid      = accts?.totalLiquid      ?? 0;
  const totalLiabilities = accts?.totalLiabilities ?? 0;

  const incomeEntry          = txn?.byCategory.find((c) => c.category === 'Income');
  const incomeTransactionCount = incomeEntry?.count ?? 0;

  // Outflows for the income-plausibility ratio: spending plus the cash that REDUCED
  // debt. Adding every debt payment counted purchases made on a card twice (once as
  // spending, once as the payment that settled them) and understated the ratio.
  const totalOutflows    = expenseTotal + netPaydown;
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

  // M1: the complete-month mean, on the SAME month population as the expense
  // figure beside it. The former `incomeTotal / windowDays × 30` normalised by
  // days while spending was a calendar-month mean — two bases under one label.
  const impliedMonthlyIncome: number | null = computeAverageMonthlyIncome(txn);

  // KD-10: authoritative monthly spending (reliable-month average). Replaces the
  // window-normalized estimate that competed with the prompt context block.
  // NET-BASELINE-1: NET economic spending, with the gross figure and the refund
  // effect carried beside it when material — one call, never re-derived here.
  const spendingBasis = computeMonthlySpendingBasis(txn);
  const estimatedMonthlyExpenses: number | null = spendingBasis?.net ?? null;

  // post-M1 D1 — the same complete-month mean, over the same months, as the two
  // figures above. This was the last day-normalised money figure in the
  // assessment (window total ÷ window days × a nominal month), printed beside two
  // complete-month means under one "monthly averages" label. OBSERVED historical
  // card-and-debt payment flow — not Σ stated minimums (lib/debt/aggregates.ts),
  // not the payoff planner's chosen payment (lib/debt/payoff.ts), not L1's
  // projected minimums (scenario-ledger.ts). Null = no reliable month; 0 = none
  // observed in the reliable months.
  const estimatedMonthlyDebtPayments: number | null = computeAverageMonthlyDebtPayments(txn);

  // REVIEW-3 C-3 — graded on the CANONICAL figures. The trigger is the deficit
  // after debt PAYDOWN (netAfterDebtPayments < 0); the OVERSPENDING claim
  // specifically requires the canonical economic net to be negative — that is
  // the exact number the Cash Flow workspace renders, so "you spent more than
  // you took in" can no longer contradict a surplus on screen.
  //
  // post-M1 D3 — `netAfterDebtPayments` is `netCashFlow − NET paydown`, no longer
  // `netCashFlow − debtPaymentTotal`. The economic net already contains every
  // purchase made ON a card; subtracting the payments that settle those
  // purchases counted the same consumption twice, and graded a household that
  // pays its cards in full DEBT_DRIVEN over a five-figure surplus. The ladder
  // below is unchanged — the DEFINITION moved, in the assembler, to the
  // debt-service decomposition (lib/transactions/debt-service.ts): payments
  // beyond the new charges they settle and the borrowing that funded them.
  // New borrowing is never credited (the figure is ≤ the economic net), so
  // overspending financed on a card still reads as overspending.
  //
  // W2 — the two goal-gated rungs (INTENTIONAL_DEBT_PAYOFF / MIXED, each
  // requiring an ACTIVE DEBT_REDUCTION goal) were DELETED with the Goals
  // retirement. They were the ladder's only INTENT claims; with the product's
  // only declaration mechanism gone, intent is never guessed from activity —
  // a deficit debt payments explain is DEBT_DRIVEN, a measured fact. For every
  // goal-less corpus (production today: zero goal rows) this ladder is
  // byte-identical to the pre-W2 one — no AI-facing verdict moves. Declared
  // intent's future home is debt planning/strategy, not this engine.
  // The classification AND the rung that produced it come from ONE comparison, so
  // the reason can never describe a rule other than the one that ran.
  const [deficitCause, deficitReasonCode]: [DeficitCauseClassification, DeficitReasonCode] =
    netAfterDebtPayments >= 0  ? ['NOT_APPLICABLE', 'NET_AFTER_PAYDOWN_NOT_NEGATIVE']
    : incomeConfidence === 'LOW' ? ['LOW_INCOME_SAMPLE', 'INCOME_SAMPLE_TOO_THIN_TO_GRADE']
    : netCashFlow < 0          ? ['POSSIBLE_OVERSPENDING', 'ECONOMIC_NET_NEGATIVE']
    : ['DEBT_DRIVEN', 'PAYDOWN_EXCEEDS_ECONOMIC_NET'];
  const money2 = (n: number) => Math.round(n * 100) / 100;
  const deficitReason: ClassificationReason<DeficitReasonCode> = {
    scope: 'CASH_NET_AFTER_DEBT_PAYDOWN',
    reasonCode: deficitReasonCode,
    reasonMetrics: {
      economicNet:             money2(netCashFlow),
      debtPayments:            money2(txn?.debtService?.payments ?? debtPaymentTotal),
      newChargesOnLiabilities: txn?.debtService ? money2(txn.debtService.newChargesOnLiabilities) : null,
      debtProceeds:            txn?.debtService ? money2(txn.debtService.debtProceeds) : null,
      netPaydown:              money2(netPaydown),
      netAfterDebtPaydown:     money2(netAfterDebtPayments),
      windowDays,
    },
    evidencePopulation: { kind: 'BANKING_ROWS', accounts: transactionCount, graded: transactionCount },
  };

  const cashFlowReliability: CashFlowReliability =
    incomeConfidence === 'LOW'    ? 'UNRELIABLE' :
    incomeConfidence === 'MEDIUM' ? 'PARTIAL'    :
    'RELIABLE';

  const cashFlow: CashFlowSection = {
    reliability:                  cashFlowReliability,
    confidence:                   incomeConfidence,
    deficitCause,
    deficitReason,
    transactionCompleteness:      transactionHistoryCompleteness,
    impliedMonthlyIncome,
    estimatedMonthlyExpenses,
    ...(spendingBasis?.material
      ? { monthlyExpensesGross: spendingBasis.gross, monthlyRefundEffect: spendingBasis.refundEffect } : {}),
    estimatedMonthlyDebtPayments,
    incomeTransactionCount,
    incompleteIncomeWarning:      incomeConfidence === 'LOW',
  };

  // ── Step 3: Debt ─────────────────────────────────────────────────────────

  // ⚠️ THE RATE, ITS REASON, AND — SEPARATELY — ITS BURDEN. What this step grades
  // is the contractual rate on the balance owed today (DebtRateClassification,
  // scope RATE_ON_OWED_BALANCE); every branch below records WHICH rung fired.
  // The burden (what that rate costs next to this user's income, expenses and
  // cash) needs the expense baseline Step 4 resolves, so it is attached right
  // after Step 4 — `debtCore` is the section minus that one field.
  let debtCore: Omit<DebtSection, 'burden'>;
  /** Reporting-currency owed across rated rows — the burden's and the reason's operand. */
  let ratedOwed = 0;

  if (!accts) {
    debtCore = {
      classification:        'INSUFFICIENT_DATA',
      confidence:            'LOW',
      reason:                ungradedDebtReason('ACCOUNTS_DOMAIN_ABSENT', { debtAccounts: 0, debtAccountsWithApr: 0 }),
      totalLiabilities:      0,
      monthlyInterestBurden: null,
      aprCompleteness:       'NONE',
      hasNullAPR:            false,
      hasBalanceOnlyDebt:    false,
      aprGapAccountNames:    [],
    };
  } else if (totalLiabilities === 0) {
    debtCore = {
      classification:        'NO_DEBT',
      confidence:            'HIGH',
      reason:                ungradedDebtReason('NO_LIABILITIES', {
        debtAccounts: accts.counts.liabilities, debtAccountsWithApr: 0 }),
      totalLiabilities:      0,
      monthlyInterestBurden: null,
      aprCompleteness:       'FULL', // vacuously: no debt accounts to be incomplete
      hasNullAPR:            false,
      hasBalanceOnlyDebt:    false,
      aprGapAccountNames:    [],
    };
  } else if (accts.accounts === undefined) {
    // v2.6-BRIEF-1 — the per-account list is ABSENT, not empty.
    //
    // This branch used to read `accts.accounts ?? []`, which collapsed ABSENT
    // and NONE into the same empty set — so a real liability with its account
    // list missing was graded from zero debt accounts: no APR found, weighted
    // average 0, verdict HEALTHY at HIGH confidence. Measured on a $20,000
    // liability (lib/ai/intelligence/brief-scope-adequacy.test.ts).
    //
    // That is a conclusion drawn from ABSENCE — the mirror image of the rule
    // v2.6-DEBT-1 established for admission ("absence of contradiction is not
    // evidence"). The engine may only grade debt it was actually shown.
    // `totalLiabilities` is still reported: the AMOUNT is a fact the payload
    // does carry; only the GRADE is unknowable.
    //
    // W3 — this can no longer be a SCOPE outcome: the assembler emits the list
    // at every scope hint (the brief carries the DEBT_ONLY subset — the exact
    // rows this grade requires). An undefined list now means a payload NOT
    // built by the assembler (fixture, hand-rolled context) — a genuine
    // payload gap, refused honestly below as ACCOUNT_LIST_ABSENT. The refusal
    // stands; only its attribution stopped being a payload-size choice.
    debtCore = {
      classification:        'INSUFFICIENT_DATA',
      confidence:            'LOW',
      reason:                ungradedDebtReason('ACCOUNT_LIST_ABSENT', {
        debtAccounts: accts.counts.liabilities, debtAccountsWithApr: 0 }),
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
          ratedOwed      += balance;
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

    // Debt RATE classification — and the rung that produced it.
    const population = { debtAccounts: debtAccounts.length, debtAccountsWithApr: fullVisWithAPR };
    let debtRateClassification: DebtRateClassification;
    let debtReason: ClassificationReason<DebtReasonCode>;
    if (hasNullAPR) {
      debtRateClassification = 'INSUFFICIENT_DATA';
      debtReason = ungradedDebtReason('APR_UNKNOWN', population);
    } else {
      // No rated row that owes ⇒ no blended rate (null). `gradeDebtRate` weighs a
      // null rate as 0 — the previous behaviour exactly: with nothing to weight,
      // the rate rungs cannot fire and the classification falls to IMPROVING /
      // HEALTHY on the liabilities trend, the honest read when no interest is
      // accruing. The reason echoes the null, never a 0% nobody measured.
      const weightedAvgAPR = computeDebtAggregate(aprRows).weightedApr;
      // W3 — IMPROVING now derives from the CANONICAL window authority
      // (`liabilitiesChange`, computed by canonicalWindowChange over the same
      // product-defined preset as `canonicalChange`), replacing the accidental
      // fetched-row window this rung carried (history[0] vs history[last] over
      // ≥7 rows — lib/ai/types.ts had already labelled those fields "an
      // ACCIDENTAL window"). A null change is a REFUSAL (history does not reach
      // the window's start) and cannot claim IMPROVING — same honesty rule as
      // canonicalChange. Corpora where the row-count window and the calendar
      // window disagree may flip this verdict: that movement is a CORRECTION,
      // the same class as v2.6-WINDOW-1.
      //
      // The ladder itself (rate rungs, then the trend tie-break) is
      // `gradeDebtRate` — the comparison and its reason come from one place, so
      // the reason cannot describe a rule other than the one that ran.
      const graded = gradeDebtRate({
        weightedAprPct:       weightedAvgAPR,
        ratedOwed,
        liabilitiesChangeAbs: snap?.liabilitiesChange?.abs ?? null,
        ...population,
      });
      debtRateClassification = graded.classification;
      debtReason             = graded.reason;
    }

    // Debt confidence: how reliable is the classification?
    // Balance data is always reliable; the uncertainty is APR completeness.
    const debtConfidence: ConfidenceLevel =
      debtRateClassification !== 'INSUFFICIENT_DATA' ? 'HIGH' :
      aprCompleteness === 'PARTIAL'                    ? 'MEDIUM' :
      'LOW';

    debtCore = {
      classification:        debtRateClassification,
      confidence:            debtConfidence,
      reason:                debtReason,
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
  let liquidityReasonCode: LiquidityReasonCode;

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
    liquidityReasonCode = liquidAccountCount === 0 ? 'NO_LIQUID_ACCOUNTS' : 'NO_EXPENSE_BASELINE';
  } else {
    const months = totalLiquid / baseline.amount;
    // Belt to the braces above: `totalLiquid` is summed by an assembler, and a
    // non-finite input must never become a grade. Every comparison below is `<`,
    // which NaN fails silently — so an unguarded NaN lands on 'EXCELLENT', the
    // most favourable verdict available, by falling through every check.
    if (!Number.isFinite(months)) {
      liquidityCoverageClassification = 'UNKNOWN';
      liquidityReasonCode = 'COVERAGE_NOT_FINITE';
    } else {
      liquidityCoverageMonths = Math.round(months * 100) / 100;
      // The same four rungs and thresholds as before; the ladder now also names
      // the rung it took (classification-reason.ts).
      const graded = gradeLiquidityCoverage(liquidityCoverageMonths);
      liquidityCoverageClassification = graded.classification;
      liquidityReasonCode             = graded.reasonCode;
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
    reason:                  liquidityReason({
      reasonCode:           liquidityReasonCode,
      coverageMonths:       liquidityCoverageMonths,
      liquid:               totalLiquid,
      monthlyExpenses:      baseline?.amount ?? null,
      monthlyExpensesBasis: baseline?.basis ?? null,
      liquidAccounts:       liquidAccountCount,
    }),
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

  // ── Step 3 (completion): the debt burden ────────────────────────────────
  // Attached here, not above, because it divides by the SAME expense baseline
  // liquidity coverage divided by (one authority chose it) and by liquid cash.
  // Facts with their operands — deliberately not a grade (types.ts, DebtBurden).
  const debtSection: DebtSection = {
    ...debtCore,
    burden: computeDebtBurden({
      ratedOwed,
      monthlyInterestIfCarried: debtCore.monthlyInterestBurden,
      totalLiabilities:         debtCore.totalLiabilities,
      monthlyIncome:            cashFlow.impliedMonthlyIncome,
      monthlyExpenses:          baseline?.amount ?? null,
      liquid:                   hasAccountsDomain && liquidAccountCount > 0 ? totalLiquid : null,
    }),
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

    if (deficitCause === 'DEBT_DRIVEN') return 'CASH_FLOW'; // W2 — intent causes deleted (Goals retired)

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
  // A2 — the significance of those directions. Consumes the trends section only.
  const trajectory     = computeTrajectory(spendingTrends);

  // ── Step 9: Goal Alignment (2.4) — DELETED (W2, Goals retired) ──────────
  // Step numbering is preserved for doc continuity with the engine list.

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
    investmentReadiness,
    txn, // TI2-W2 — amount-based INCOMPLETE_INCOME_DATA wording
    ctx.space.reportingCurrency, // REVIEW-3 C-6 — money in evidence strings
  );

  // ── Step 12: Heuristics and priorities ──────────────────────────────────

  const advisorHeuristics = deriveHeuristics(dataQuality, cashFlow, debtSection, liquidity);
  const priorities        = derivePriorities(dataQuality, cashFlow, debtSection, liquidity);

  // ── Step 13: Declared insufficiency (REVIEW-3 C-7, audit E3) ─────────────
  // C-7 found scopeHint silently changing what this authority could decide:
  // 'brief' omitted the per-account list (debt forced INSUFFICIENT_DATA) and
  // assessed a 30-day window that almost never contained a complete calendar
  // month (liquidity UNKNOWN ~30 days in 31). Both scope causes are since
  // CURED — W3 emits the assessment-required debt rows at every hint, W4 made
  // the assessment window scope-invariant (90 rolling days) — so a refusal
  // recorded here now names a GENUINE data gap, never a scope choice. The
  // declaration mechanism stays: every withheld grade is DECLARED with a
  // reason a consumer can read, so the Brief says what is missing or stays
  // silent knowingly, instead of implying a grade the evidence cannot carry.
  const ungraded: UngradedSection[] = [];
  if (debtSection.classification === 'INSUFFICIENT_DATA') {
    if (!accts) {
      ungraded.push({
        section: 'debt', verdict: 'INSUFFICIENT_DATA', reason: 'ACCOUNTS_DOMAIN_ABSENT',
        detail:  'No accounts domain was assembled — debt cannot be graded.',
      });
    } else if (accts.accounts === undefined) {
      ungraded.push({
        section: 'debt', verdict: 'INSUFFICIENT_DATA', reason: 'ACCOUNT_LIST_ABSENT',
        detail:  'The payload carries no per-account list, so liabilities exist but their rates cannot be graded. ' +
                 '(Not a scope choice: since W3 the assembler emits the assessment-required rows at every scope hint.)',
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
  // A2 — a withheld trajectory is DECLARED like every other refusal, so a
  // consumer never reads silence as "nothing changed".
  if (trajectory.classification === 'INSUFFICIENT_DATA') {
    ungraded.push({
      section: 'trajectory', verdict: 'INSUFFICIENT_DATA', reason: 'INSUFFICIENT_COMPLETE_MONTHS',
      detail:  `Fewer than two complete calendar months (${trajectory.completeMonthsAnalyzed}) — ` +
               'no month-over-month comparison exists. Direction is not inferred from one month, ' +
               'and partial months are never substituted to reach two.',
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
    trajectory,
    investmentReadiness,
    riskOpportunities,
    currentStatePriority,
    advisorHeuristics,
    priorities,
    ungraded,
  };
}


