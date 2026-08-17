/**
 * lib/ai/prompts/assessment-serializer.ts
 *
 * Serializes a deterministic FinancialAssessment (from lib/ai/intelligence)
 * into the === FINANCIAL ASSESSMENT === system-prompt block. Pure function:
 * assessment in, text out. No DB, no I/O, no financial computation — every
 * figure is read from the pre-computed assessment.
 *
 * Extracted verbatim from app/api/ai/chat/route.ts (AI-ARCH).
 */

import type { FinancialAssessment } from '@/lib/ai/intelligence';
import { fmtMoney } from './format';

// REVIEW-3 C-8 — thresholds are IMPORTED from the one constants module, not
// mirrored. The local copies drifted-by-design ("_NOTE" suffixes) and one of
// them was even compared against a different quantity than the engine compares
// (span vs row count); a mirror that nothing enforces is a fork in waiting.
import { MARKET_RETURN_THRESHOLD } from '@/lib/ai/intelligence/annotations/constants';

/** Return a one-sentence LLM instruction based on the current priority. */
function priorityGuidance(assessment: FinancialAssessment): string {
  switch (assessment.currentStatePriority) {
    case 'DATA_QUALITY':
      return 'Note that transaction history is partial. Describe balances, liquidity, and debt figures confidently. Do not make income or cash flow statements.';
    case 'LIQUIDITY':
      return assessment.liquidity.classification === 'CRITICAL'
        ? 'Liquidity is critically low — lead with the coverage gap and near-term implications.'
        : 'Lead with the liquidity position and what it means for the user\'s financial flexibility.';
    case 'DEBT':
      return assessment.debt.classification === 'CRITICAL'
        ? 'High-APR debt is urgent — lead with the monthly interest cost and recommended payoff priority.'
        : 'High-APR debt is the most actionable item — discuss the interest burden and payoff options.';
    case 'CASH_FLOW':
      if (
        assessment.cashFlow.deficitCause === 'INTENTIONAL_DEBT_PAYOFF' ||
        assessment.cashFlow.deficitCause === 'MIXED'
      ) {
        return 'Affirm the intentional debt payoff strategy. Note any liquidity constraint if coverage is below 3 months.';
      }
      if (assessment.cashFlow.deficitCause === 'DEBT_DRIVEN') {
        // REVIEW-3 C-3 — debt payments explain the deficit and the canonical net
        // is non-negative: never frame this as overspending.
        return 'The cash deficit is driven by debt payments, not overspending — discuss whether the paydown pace is intentional and suggest recording it as a goal.';
      }
      return 'Spending may be exceeding income — identify the specific expense categories driving the gap.';
    case 'GOALS':
      return 'A goal may need attention — discuss its status and recommend the next action.';
    case 'GOALS_GOOD':
      return 'Financial position looks healthy — affirm progress and highlight the next milestone.';
    default:
      return 'Provide an overall financial assessment.';
  }
}

/**
 * Serialize a FinancialAssessment into the === FINANCIAL ASSESSMENT === prompt block.
 *
 * v2 structure (order is deliberate):
 *   1.  INTERPRETED STATE       — priority + leading instruction, so LLM reads intent first.
 *   2.  DATA QUALITY            — completeness + confidence before any numbers.
 *   3.  CASH FLOW               — confidence + warnings before deficit framing.
 *   4.  DEBT                    — confidence + balances + APR state.
 *   5.  LIQUIDITY               — confidence + coverage + space-scope warning.
 *   6.  CAPITAL ALLOCATION      — 2.1: allocation context + evidence + primary/ignored domains.
 *   7.  DEBT STRATEGY           — 2.2: avalanche/snowball candidates + urgency.
 *   8.  SPENDING OPPORTUNITIES  — 2.3: category breakdown + discretionary total (conditional).
 *   8B. SPENDING TRENDS        — 2.3B: deterministic MoM / rolling trends (conditional).
 *   9.  GOAL ALIGNMENT          — 2.4: per-goal alignment status (conditional).
 *   10. INVESTMENT READINESS    — 2.5: readiness context (conditional).
 *   11. RISK & OPPORTUNITY      — 2.6: top-3 aggregated risks + opportunities (conditional).
 *   12. ADVISOR FLAGS           — typed heuristics for calibration.
 *   13. PRIORITIES              — ranked deterministic hints (not recommendations).
 */
export function serializeAssessmentBlock(
  assessment: FinancialAssessment,
  windowNote?: string | null,
  // REVIEW-3 C-6 — the Space's reporting currency; USD default for fixtures.
  reportingCurrency?: string,
): string {
  const money = (n: number) => fmtMoney(n, reportingCurrency);
  const {
    dataQuality, cashFlow, debt, liquidity,
    capitalAllocation, debtStrategy,
    spendingOpportunities, spendingTrends, goalAlignment, investmentReadiness,
    riskOpportunities,
  } = assessment;
  const lines: string[] = [];

  // ── 1. Interpreted state ──────────────────────────────────────────────────
  lines.push(`INTERPRETED STATE: ${assessment.currentStatePriority}`);
  lines.push(`  ${priorityGuidance(assessment)}`);
  lines.push('');

  // ── 2. Data quality ───────────────────────────────────────────────────────
  lines.push('DATA QUALITY');
  if (windowNote) {
    // Provenance (D6): the period + denominators every derived figure is bounded by.
    lines.push(`  Analysis period: ${windowNote}`);
  }
  // REVIEW-3 C-8 (KD-16) — no hard-coded "90-day window": the actual analysis
  // window is stated by the Analysis-period line above (from txn.windowDays via
  // analysisWindowNote); this line describes only what it measures — the
  // snapshot span and the income-row count.
  lines.push(
    `  Transaction completeness: ${dataQuality.transactionHistoryCompleteness}` +
    ` (${dataQuality.snapshotSpanDays}-day snapshot span;` +
    ` ${dataQuality.incomeTransactionCount} income transaction(s) captured)`,
  );
  lines.push(
    dataQuality.transactionHistoryCompleteness === 'HIGH'
      ? '  → Completeness is HIGH: you may say "based on complete transaction history for this window".'
      : '  → Completeness is not HIGH: say "based on partial transaction history" when presenting derived figures.',
  );
  lines.push(`  Income confidence: ${dataQuality.incomeConfidence}`);

  if (dataQuality.incomeConfidence === 'LOW') {
    lines.push('  ⚠ Income data is incomplete. Do not state cash flow is negative or income is insufficient as fact.');
    lines.push('    Account balances, debt balances, and liquid cash are always reliable — use them confidently.');
    lines.push('    Suggest the user connect all income accounts for a complete picture.');
  }

  lines.push('');

  // ── 3. Cash flow ──────────────────────────────────────────────────────────
  lines.push(`CASH FLOW  [confidence: ${cashFlow.confidence}]`);
  lines.push(`  Reliability: ${cashFlow.reliability}`);
  lines.push(`  Deficit cause: ${cashFlow.deficitCause}`);

  if (cashFlow.incompleteIncomeWarning) {
    lines.push('  ⚠ Do not treat apparent deficit as fact — income history is incomplete.');
  } else if (cashFlow.deficitCause === 'INTENTIONAL_DEBT_PAYOFF') {
    lines.push('  → Negative cash flow is intentional debt-reduction strategy — active debt goal confirms this.');
  } else if (cashFlow.deficitCause === 'MIXED') {
    lines.push('  → Deficit has both intentional debt payments and non-debt spending above income.');
  } else if (cashFlow.deficitCause === 'DEBT_DRIVEN') {
    lines.push('  → Cash deficit is driven by debt payments (canonical net is non-negative) — not overspending; no active payoff goal on record.');
  }

  if (cashFlow.impliedMonthlyIncome !== null) {
    const qualifier = dataQuality.incomeConfidence === 'LOW' ? ' (likely understated — partial data)' : '';
    lines.push(`  Implied monthly income: ${money(cashFlow.impliedMonthlyIncome)}/mo${qualifier}`);
  }
  if (cashFlow.estimatedMonthlyExpenses !== null) {
    // v2.6-ASSESS-2 — say that THIS one is measured spending.
    //
    // Cash flow reports what the user ACTUALLY SPENT; the liquidity block reports
    // the baseline coverage divides by, which may be the user's own declared
    // figure instead. They are different claims and can legitimately differ — but
    // both were printed as "Est. monthly expenses", so the moment a declared
    // baseline existed the model saw two lines with that label and two different
    // numbers, and nothing to tell it they were answering different questions.
    lines.push(`  Est. monthly spending: ${money(cashFlow.estimatedMonthlyExpenses)}/mo (measured)`);
  }
  if (cashFlow.estimatedMonthlyDebtPayments !== null) {
    lines.push(`  Est. monthly debt payments: ${money(cashFlow.estimatedMonthlyDebtPayments)}/mo`);
  }

  lines.push('');

  // ── 4. Debt ───────────────────────────────────────────────────────────────
  lines.push(`DEBT  [confidence: ${debt.confidence}]`);
  lines.push(`  Classification: ${debt.classification}`);
  lines.push(`  Total liabilities: ${money(debt.totalLiabilities)}`);

  if (debt.classification === 'INSUFFICIENT_DATA') {
    lines.push(`  APR completeness: ${debt.aprCompleteness}`);
    if (debt.aprGapAccountNames.length > 0) {
      lines.push(
        `  APR not entered for: ${debt.aprGapAccountNames.join(', ')} — ` +
        'enter in Fourth Meridian to enable full interest analysis.',
      );
    }
    if (debt.hasBalanceOnlyDebt) {
      lines.push(
        '  Some debt accounts are at balance-only visibility — APR is not accessible ' +
        'in this Space (structural limitation, not missing user input).',
      );
    }
  }

  if (debt.monthlyInterestBurden !== null) {
    const partial = debt.hasNullAPR ? ' (partial — APR missing for some accounts)' : '';
    lines.push(`  Monthly interest burden: ${money(debt.monthlyInterestBurden)}/mo${partial}`);
  } else if (debt.hasNullAPR && debt.totalLiabilities > 0) {
    lines.push('  Monthly interest burden: cannot be computed — APR missing.');
  }

  lines.push('');

  // ── 5. Liquidity ──────────────────────────────────────────────────────────
  lines.push(`LIQUIDITY  [confidence: ${liquidity.confidence}]`);

  if (!liquidity.hasAccountsDomain) {
    lines.push('  No accounts are linked to this Space — balance data is unavailable.');
  } else {
    lines.push(`  Liquid cash: ${money(liquidity.liquidCashTotal)} (${liquidity.liquidAccountCount} account(s))`);

    if (liquidity.noLiquidAccountsInSpace) {
      lines.push(
        '  ⚠ No checking or savings accounts are linked to this Space.' +
        ' Liquid balances may exist in other Spaces. Do not say the user has no liquid cash.',
      );
    }

    if (liquidity.estimatedMonthlyExpense !== null) {
      // v2.6-ASSESS-2 — say WHICH baseline this is. A declared figure is the
      // user's own statement and an average is our inference about it; the model
      // must not present one as the other, and "the figure you set" is a
      // different kind of claim from "your recent average".
      const basis =
        liquidity.estimatedMonthlyExpenseBasis === 'DECLARED' ? ' (the figure the user set)'
        : liquidity.estimatedMonthlyExpenseBasis === 'MEASURED' ? ' (measured — average of complete months)'
        : '';
      // The partial-data caveat applies only to a MEASURED figure. A declared one
      // is not derived from the window at all, so qualifying it by our data
      // coverage would misdescribe the user's own number.
      // REVIEW-3 C-8 — the "partial" qualifier mirrors the ENGINE's own
      // completeness verdict. The old test compared snapshotSpanDays (a
      // calendar SPAN) against SNAPSHOT_HIGH_THRESHOLD, the same constant
      // engine.ts compares a ROW COUNT to — a category error that made the
      // qualifier fire on a different condition than the grade it annotates.
      const partial =
        liquidity.estimatedMonthlyExpenseBasis === 'MEASURED' &&
        dataQuality.transactionHistoryCompleteness !== 'HIGH'
          ? ' (from partial expense data)'
          : '';
      lines.push(`  Est. monthly expenses: ${money(liquidity.estimatedMonthlyExpense)}/mo${basis}${partial}`);
    }

    if (liquidity.coverageMonths !== null) {
      lines.push(`  Coverage: ${liquidity.coverageMonths.toFixed(1)} months → ${liquidity.classification}`);
    } else {
      lines.push(`  Coverage: ${liquidity.classification}`);
    }
  }

  lines.push('');

  // ── 6. Capital Allocation (2.1) ───────────────────────────────────────────
  lines.push(`CAPITAL ALLOCATION  [confidence: ${capitalAllocation.confidence}]`);
  lines.push(`  Context: ${capitalAllocation.recommendation}`);

  if (capitalAllocation.primaryEvidence.length > 0) {
    lines.push(`  Driven by: ${capitalAllocation.primaryEvidence.join(', ')}`);
  }
  if (capitalAllocation.ignoredEvidence.length > 0) {
    lines.push(
      `  Note: ${capitalAllocation.ignoredEvidence.join(', ')} is NOT primary to this recommendation` +
      (capitalAllocation.ignoredEvidence.includes('cashFlow')
        ? ' — recommendation holds even if income data is incomplete'
        : ''),
    );
  }

  const ev = capitalAllocation.evidence;
  if (ev.weightedDebtApr !== null) {
    lines.push(`  Weighted debt APR: ${ev.weightedDebtApr.toFixed(2)}% vs ${MARKET_RETURN_THRESHOLD}% market reference`);
    if (ev.guaranteedReturnAdvantage !== null) {
      if (ev.guaranteedReturnAdvantage > 0) {
        lines.push(
          `  Paying down debt ≈ earning a guaranteed ${ev.weightedDebtApr.toFixed(2)}% return` +
          ` (${ev.guaranteedReturnAdvantage.toFixed(2)}% above ${MARKET_RETURN_THRESHOLD}% market reference)`,
        );
      } else {
        lines.push(
          `  Debt APR (${ev.weightedDebtApr.toFixed(2)}%) is below the ${MARKET_RETURN_THRESHOLD}% market reference — investing return context may apply`,
        );
      }
    }
  }
  if (ev.monthlyInterestBurden !== null) {
    lines.push(`  Monthly interest cost of carrying debt: ${money(ev.monthlyInterestBurden)}/mo`);
  }
  if (ev.liquidityMonths !== null) {
    lines.push(`  Liquid coverage: ${ev.liquidityMonths.toFixed(1)} months`);
  }
  if (capitalAllocation.missingAprPreventsComparison) {
    lines.push(`  ⚠ APR completeness: ${ev.aprCompleteness} — debt vs. investing comparison blocked`);
  }
  if (capitalAllocation.blockers.length > 0) {
    lines.push(`  Blockers: ${capitalAllocation.blockers.join('; ')}`);
  }

  lines.push('');

  // ── 7. Debt Strategy (2.2) ────────────────────────────────────────────────
  if (debt.totalLiabilities > 0) {
    lines.push(`DEBT STRATEGY  [confidence: ${debtStrategy.confidence}]`);
    lines.push(`  Payoff urgency: ${debtStrategy.payoffUrgency}`);

    if (debtStrategy.weightedAvgApr !== null) {
      lines.push(`  Weighted avg APR: ${debtStrategy.weightedAvgApr.toFixed(2)}%`);
    }
    if (debtStrategy.avalancheCandidate) {
      const c = debtStrategy.avalancheCandidate;
      lines.push(
        `  Avalanche target: ${c.accountName}` +
        ` (${c.apr!.toFixed(2)}% APR, ${money(c.balance)} balance)`,
      );
    }
    if (debtStrategy.snowballCandidate) {
      const c   = debtStrategy.snowballCandidate;
      const apr = c.apr != null ? `, ${c.apr.toFixed(2)}% APR` : ', APR unknown';
      lines.push(`  Snowball target: ${c.accountName} (${money(c.balance)} balance${apr})`);
    }
    if (debtStrategy.missingAprAccountNames.length > 0) {
      lines.push(`  APR missing for: ${debtStrategy.missingAprAccountNames.join(', ')}`);
    }
    if (debtStrategy.hasBalanceOnlyDebt) {
      lines.push('  Some debt accounts are balance-only — APR structurally inaccessible in this Space.');
    }
    if (!debtStrategy.avalancheCandidate && !debtStrategy.snowballCandidate) {
      lines.push('  No debt account detail available in this Space.');
    }

    lines.push('');
  }

  // ── 8. Spending Opportunities (2.3) ──────────────────────────────────────
  if (spendingOpportunities.hasTransactionData && spendingOpportunities.topCategories.length > 0) {
    lines.push(`SPENDING OPPORTUNITIES  [confidence: ${spendingOpportunities.confidence}]`);

    if (spendingOpportunities.topReductionOpportunity) {
      const top = spendingOpportunities.topReductionOpportunity;
      lines.push(`  Top reduction opportunity: ${top.category} (${money(top.monthlyEquivalent)}/mo, ${top.transactionCount} txn(s))`);
    }
    lines.push(`  Total discretionary spend: ${money(spendingOpportunities.discretionaryTotal)}/mo`);

    const displayCats = spendingOpportunities.topCategories.slice(0, 6);
    if (displayCats.length > 0) {
      lines.push('  By category:');
      for (const cat of displayCats) {
        lines.push(`    ${cat.category}: ${money(cat.monthlyEquivalent)}/mo [${cat.classification}]`);
      }
    }

    if (spendingOpportunities.categoriesNeedingReview.length > 0) {
      lines.push(`  Review needed: ${spendingOpportunities.categoriesNeedingReview.join(', ')}`);
    }
    lines.push('');
  }

  // ── 8B. Spending Trends (2.3B) ────────────────────────────────────────────
  // Deterministic month-over-month / rolling trends computed from COMPLETE
  // months only (partial months are excluded upstream). Facts only — the LLM
  // must not infer a trend where the direction is INSUFFICIENT_DATA.
  if (
    spendingTrends.completeMonthsAnalyzed > 0 ||
    spendingTrends.partialMonthsExcluded.length > 0
  ) {
    lines.push(`SPENDING TRENDS  [confidence: ${spendingTrends.confidence}]`);
    lines.push(
      `  Complete months analyzed: ${spendingTrends.completeMonthsAnalyzed}` +
      (spendingTrends.partialMonthsExcluded.length > 0
        ? ` (excluded partial month(s): ${spendingTrends.partialMonthsExcluded.join(', ')})`
        : ''),
    );

    for (const t of spendingTrends.metricTrends) {
      const label = t.metric.charAt(0).toUpperCase() + t.metric.slice(1);

      if (t.direction === 'INSUFFICIENT_DATA') {
        lines.push(
          `  ${label} [INSUFFICIENT_DATA]: fewer than 2 complete months — do not infer or state a trend.`,
        );
        continue;
      }

      const abs =
        t.momDeltaAbs !== null
          ? `${t.momDeltaAbs > 0 ? '+' : t.momDeltaAbs < 0 ? '−' : ''}${money(Math.abs(t.momDeltaAbs))}`
          : 'n/a';
      const pct =
        t.momDeltaPct !== null
          ? ` (${t.momDeltaPct > 0 ? '+' : ''}${t.momDeltaPct.toFixed(1)}%)`
          : '';
      const roll =
        t.rolling3moAvg !== null
          ? `; 3-mo avg ${money(t.rolling3moAvg)}`
          : '; 3-mo avg n/a (needs 3 complete months)';

      lines.push(
        `  ${label} [${t.direction}]: ${t.latestCompleteMonth} vs ${t.previousCompleteMonth} ${abs}${pct}${roll}`,
      );
    }

    lines.push(
      '  Use only these deterministic figures. Where a metric is INSUFFICIENT_DATA, do NOT ' +
      'infer, estimate, or narrate a trend for it. Partial / in-progress months are excluded ' +
      'and must never be compared against complete months.',
    );
    lines.push('');
  }

  // ── 9. Goal Alignment (2.4) ───────────────────────────────────────────────
  if (goalAlignment.hasGoalsDomain && goalAlignment.activeGoalCount > 0) {
    lines.push(`GOAL ALIGNMENT  [confidence: ${goalAlignment.confidence}]`);
    lines.push(
      `  Overall: ${goalAlignment.overallStatus}` +
      ` (${goalAlignment.alignedCount} aligned, ${goalAlignment.misalignedCount} misaligned,` +
      ` ${goalAlignment.blockedCount} insufficient data)`,
    );
    for (const g of goalAlignment.goalAlignments) {
      lines.push(`  ${g.goalName} [${g.goalType}]: ${g.status} — ${g.evidence}`);
      if (g.blocker) lines.push(`    ↳ Needs: ${g.blocker}`);
    }
    lines.push('');
  }

  // ── 10. Investment Readiness (2.5) ────────────────────────────────────────
  lines.push(`INVESTMENT READINESS  [confidence: ${investmentReadiness.confidence}]`);
  lines.push(`  Classification: ${investmentReadiness.classification}`);
  if (investmentReadiness.debtBeatsMarket !== null) {
    lines.push(
      `  Debt APR exceeds ${MARKET_RETURN_THRESHOLD}% market reference: ` +
      (investmentReadiness.debtBeatsMarket ? 'YES' : 'NO'),
    );
  }
  if (!investmentReadiness.holdingsDomainPresent) {
    lines.push('  No holdings data in this Space context — existing investments not visible here.');
  }
  if (investmentReadiness.blockers.length > 0) {
    lines.push(`  Blockers: ${investmentReadiness.blockers.join('; ')}`);
  }
  lines.push('');

  // ── 11. Risk & Opportunity (2.6) ──────────────────────────────────────────
  // Aggregated candidates only — top 3 of each to avoid bloating context.
  // These are inputs for the LLM to reason from, not final recommendations.
  if (riskOpportunities.risks.length > 0 || riskOpportunities.opportunities.length > 0) {
    lines.push(`RISK & OPPORTUNITY  [confidence: ${riskOpportunities.confidence}]`);

    if (riskOpportunities.risks.length > 0) {
      lines.push('  Top risks:');
      riskOpportunities.risks.slice(0, 3).forEach((r, i) => {
        lines.push(
          `    ${i + 1}. [${r.severity.toUpperCase()}] ${r.code} (confidence: ${r.confidence})` +
          ` — ${r.evidence} [${r.affectedSections.join(', ')}]`,
        );
      });
    }

    if (riskOpportunities.opportunities.length > 0) {
      lines.push('  Top opportunities:');
      riskOpportunities.opportunities.slice(0, 3).forEach((o, i) => {
        lines.push(
          `    ${i + 1}. [${o.impact.toUpperCase()}] ${o.code} (confidence: ${o.confidence})` +
          ` — ${o.evidence} [${o.affectedSections.join(', ')}]`,
        );
      });
    }

    lines.push('');
  }

  // ── 12. Advisor flags ──────────────────────────────────────────────────────
  if (assessment.advisorHeuristics.length > 0) {
    lines.push('ADVISOR FLAGS (deterministic — calibrate advice accordingly)');
    for (const flag of assessment.advisorHeuristics) {
      lines.push(`  • ${flag}`);
    }
    lines.push('');
  }

  // ── 13. Priorities ────────────────────────────────────────────────────────
  if (assessment.priorities.length > 0) {
    lines.push('PRIORITIES (ranked hints — not recommendations; LLM decides how to apply)');
    assessment.priorities.forEach((p, i) => {
      lines.push(`  ${i + 1}. [${p.severity.toUpperCase()}] ${p.code}: ${p.reason}`);
    });
  }

  return lines.join('\n');
}
