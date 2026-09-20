/**
 * lib/ai/intelligence/monthly-income-basis.test.ts   (M1)
 *
 * THE ASSESSMENT'S MONTHLY INCOME IS A COMPLETE-MONTH MEAN — the same month
 * population as the monthly expense figure printed beside it.
 *
 * It was `incomeTotal / windowDays × 30`: a 90-day window normalised by days,
 * next to spending averaged over whole calendar months. Two bases under one
 * label, and on a window holding seven biweekly paychecks the day-normalised
 * figure was higher than any month actually delivered. This pins the basis, and
 * that the two figures the Brief prints now share one population.
 *
 *   npx tsx lib/ai/intelligence/monthly-income-basis.test.ts
 */

import assert from 'node:assert/strict';
import { computeAssessment } from '@/lib/ai/intelligence';
import {
  computeAverageMonthlyIncome, computeAverageMonthlySpending, reliableMonths,
} from '@/lib/ai/intelligence/annotations/metrics';
import { FinanceDomains, type SpaceContext_AI, type TransactionsSummaryData } from '@/lib/ai/types';

const month = (m: string, income: number, expense: number, extra: Record<string, unknown> = {}) => ({
  month: m, incomeTotal: income, expenseTotal: expense, refundTotal: 0, debtPaymentTotal: 0,
  transferTotal: 0, transactionCount: 20, estimated: false, byCategory: [], ...extra });

// A 90-day window, 06-17..09-14: two partial months around two whole ones, and
// July holding THREE biweekly paychecks.
const MONTHS = [
  month('2026-06', 5000, 1500, { partial: true }),
  month('2026-07', 15000, 4000),
  month('2026-08', 10000, 5000),
  month('2026-09', 5000, 2000, { partial: true }),
];
const txn = {
  windowDays: 90, startDate: '2026-06-17', endDate: '2026-09-14', transactionCount: 80,
  truncated: false, incomeTotal: 35000, expenseTotal: 12500, debtPaymentTotal: 0,
  netCashFlow: 22500, netAfterDebtPayments: 22500,
  byCategory: [{ category: 'Income', total: 35000, count: 7 }], monthlyBreakdown: MONTHS,
} as unknown as TransactionsSummaryData;

let n = 0;
const ok = (name: string) => { n++; console.log(`  ✓ ${name}`); };

// 1. The helper.
assert.equal(computeAverageMonthlyIncome(txn), 12500, 'mean of the two WHOLE months: (15000 + 10000) / 2');
ok('monthly income = mean of reliable months: (15,000 + 10,000) / 2 = 12,500');
assert.notEqual(computeAverageMonthlyIncome(txn), Math.round((35000 / 90 * 30) * 100) / 100,
  'the day-normalised figure (11,666.67) must not come back');
ok('…not the day-normalised 35,000 / 90 × 30 = 11,666.67');
assert.equal(reliableMonths(txn).length, 2);
assert.equal(computeAverageMonthlySpending(txn), 4500);
ok('income and spending average the SAME two months (4,500 spending beside it)');

assert.equal(computeAverageMonthlyIncome(null), null);
assert.equal(computeAverageMonthlyIncome({ ...txn, monthlyBreakdown: [MONTHS[0], MONTHS[3]] } as TransactionsSummaryData), null,
  'a window with no complete month has no monthly income — it is not extrapolated from a partial one');
ok('no complete month ⇒ null, never an extrapolation of a partial month');
assert.equal(computeAverageMonthlyIncome({ ...txn,
  monthlyBreakdown: [MONTHS[1], { ...MONTHS[2], truncated: true }] } as unknown as TransactionsSummaryData), 15000,
  'a month truncated by the fetch cap is not reliable and is left out, exactly as for spending');
ok('a fetch-cap-truncated month is excluded, exactly as it is for spending');

// 2. The assessment carries it.
const ctx = { space: { name: 't', reportingCurrency: 'USD' },
  domains: { [FinanceDomains.TRANSACTIONS_SUMMARY]: { data: txn } } } as unknown as SpaceContext_AI;
const a = computeAssessment(ctx);
assert.equal(a.cashFlow.impliedMonthlyIncome, 12500);
assert.equal(a.cashFlow.estimatedMonthlyExpenses, 4500);
ok('computeAssessment reports 12,500 income beside 4,500 expenses — one month population');

console.log(`monthly-income-basis: ${n} checks passed`);
