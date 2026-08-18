/**
 * lib/ai/intelligence/spending-trends-net.test.ts
 *
 * P1-4 — N3 net correctness, updated for REVIEW-3 C-3. Pins the
 * trend/annotation "net" metric to THE canonical economic net — income −
 * clampEconomicSpend(gross expense, refunds), the same clamp authority the Cash
 * Flow workspace and the assembler's headline netCashFlow use — and guards it
 * against drifting back into either retired formula: the refund-blind
 * `income − expense − debt` (P1-4's original defect) or the fourth-definition
 * `income + refund − expense − debtPayments` (which subtracted debt payments
 * and let the Brief's deficit verdict contradict the Cash Flow workspace).
 * Asserts parity between the trend net and the assembler net formula on real
 * assembled data (buildMonthlyBreakdown output), so a future edit cannot
 * re-open the gap.
 *
 * No test framework — standalone tsx script, inline assertions, exit 0/1
 * (house pattern, mirrors transactions.kd17.test.ts). Importing annotations /
 * the assembler transitively constructs the Prisma client but issues NO query;
 * the generated client must exist (`npx prisma generate`).
 *
 *     npx tsx lib/ai/intelligence/spending-trends-net.test.ts
 */

import { TransactionCategory } from '@prisma/client';

import { metricValue, computeSpendingTrends } from './annotations';
import { buildMonthlyBreakdown } from '../assemblers/transactions';
import { classifyFlow } from '../../transactions/flow-classifier';
import type {
  MonthlyBreakdownEntry,
  TransactionsSummaryData,
} from '@/lib/ai/types';

// ── Tiny harness ──────────────────────────────────────────────────────────────

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failures += 1;
    console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

/**
 * The canonical net cash flow — REVIEW-3 C-3: the assembler's headline
 * netCashFlow is now THE canonical economic net (income − clamped spend, the
 * same clampEconomicSpend the Cash Flow workspace uses). Debt payments are
 * movement toward a goal, not cash flow, and are EXCLUDED; the after-paydown
 * position ships separately as netAfterDebtPayments.
 */
function canonicalNet(f: {
  incomeTotal: number; refundTotal: number; expenseTotal: number; debtPaymentTotal: number;
}): number {
  return f.incomeTotal - Math.max(0, f.expenseTotal - f.refundTotal);
}

function mkMonth(over: Partial<MonthlyBreakdownEntry> & { month: string }): MonthlyBreakdownEntry {
  return {
    incomeTotal: 0, expenseTotal: 0, refundTotal: 0, debtPaymentTotal: 0,
    transferTotal: 0, transactionCount: 0, estimated: false, byCategory: [],
    ...over,
  };
}

// ── 1. metricValue net is refund-inclusive, refunds materially change it ──────

{
  // income 4000, spending 3000 (gross), refunds 800, debt 200.
  const m = mkMonth({
    month: '2026-05', incomeTotal: 4000, expenseTotal: 3000, refundTotal: 800, debtPaymentTotal: 200,
  });

  const net           = metricValue(m, 'net');
  const refundBlind   = m.incomeTotal - m.expenseTotal; // a refund-blind figure would be wrong
  const debtSubtracted = m.incomeTotal + m.refundTotal - m.expenseTotal - m.debtPaymentTotal; // the old 4th definition
  const canonical     = canonicalNet(m);

  check('net equals the canonical economic net (income − clamp(expense − refund))',
    approx(net, canonical) && approx(net, 1800), `got ${net}, expected 1800`);

  check('refunds MATERIALLY change the net — refund-blind figure is wrong',
    approx(refundBlind, 1000) && !approx(net, refundBlind) && approx(net - refundBlind, m.refundTotal),
    `net=${net}, refundBlind=${refundBlind}, refundTotal=${m.refundTotal}`);

  check('debt payments do NOT enter the canonical net (the retired 4th definition subtracted them)',
    !approx(net, debtSubtracted) && approx(debtSubtracted, net - m.debtPaymentTotal),
    `net=${net}, retiredFormula=${debtSubtracted}`);

  // income / expense metrics untouched by the fix.
  check('income metric is incomeTotal (unchanged)',  approx(metricValue(m, 'income'), 4000));
  check('expense metric is expenseTotal (unchanged)', approx(metricValue(m, 'expense'), 3000));
}

// ── 2. Parity with the assembler net formula on REAL assembled data ───────────
// Build rows, run the exported pure buildMonthlyBreakdown (the same aggregation
// the assembler uses), then assert the trend net equals the assembler's window
// net formula applied to that month's own fields. A refund row is included so
// the +refundTotal term is genuinely exercised, and a transfer row is included
// to prove transfers never touch net.

{
  type Row = {
    date: Date; merchant: string; category: TransactionCategory; amount: number;
    pending: boolean; currency: string | null;
    flowType: ReturnType<typeof classifyFlow>['flowType'] | null;
    flowDirection: ReturnType<typeof classifyFlow>['flowDirection'] | null;
  };
  function row(day: number, category: TransactionCategory, amount: number, merchant = 'Test'): Row {
    const c = classifyFlow({ category, amount });
    return {
      date: new Date(`2026-05-${String(day).padStart(2, '0')}T00:00:00.000Z`),
      merchant, category, amount, pending: false, currency: 'USD',
      flowType: c.flowType, flowDirection: c.flowDirection,
    };
  }

  const rows: Row[] = [
    row(2,  TransactionCategory.Income,   +5000.00, 'Payroll'),   // INCOME
    row(5,  TransactionCategory.Dining,   -320.00),               // SPENDING
    row(6,  TransactionCategory.Shopping, -680.00),               // SPENDING
    row(7,  TransactionCategory.Shopping, +150.00, 'Return'),     // REFUND (positive in a spend category)
    row(9,  TransactionCategory.Payment,  -400.00),               // DEBT_PAYMENT (source leg)
    row(9,  TransactionCategory.Transfer, -900.00),               // TRANSFER — must not affect net
  ];

  const months = buildMonthlyBreakdown(rows, [], '2026-05-01', '2026-05-31', null);
  const may = months.find((m) => m.month === '2026-05');

  check('assembled month exists with a non-zero refund term (exercises the fixed +refundTotal)',
    may !== undefined && may.refundTotal > 0, `refundTotal=${may?.refundTotal}`);

  if (may) {
    check('trend net === assembler net formula on the SAME assembled month',
      approx(metricValue(may, 'net'), canonicalNet(may)),
      `trend=${metricValue(may, 'net')}, assembler=${canonicalNet(may)}`);

    // Concrete value: 5000 − max(0, (320+680) − 150) = 4150. Transfer AND the
    // debt-payment leg excluded (both are movement, not cash flow).
    check('trend net has the expected concrete value (transfers and debt payments excluded)',
      approx(metricValue(may, 'net'), 4150), `got ${metricValue(may, 'net')}`);
  }
}

// ── 3. The fix propagates through computeSpendingTrends (public entry) ─────────
// Two complete months identical except for refunds. The month-over-month delta
// of `net` must move by the refund difference — proving the refund-inclusive
// net reaches the trend surface, not just the private helper.

{
  const base = {
    windowDays: 90, startDate: '2026-04-01', endDate: '2026-06-30',
    transactionCount: 40, truncated: false, coverageStartDate: '2026-04-01', fetchLimit: 5000,
    incomeTotal: 0, expenseTotal: 0, refundTotal: 0, debtPaymentTotal: 0, transferTotal: 0,
    netCashFlow: 0, estimated: false,
    pendingCreditCount: 0, pendingCreditTotal: 0, pendingDebitCount: 0, pendingDebitTotal: 0,
    unclassifiedCount: 0, adjustmentCount: 0,
    needsClassification: {
      count: 0, unknownInflowCount: 0, unknownInflowTotal: 0,
      unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0,
      counterpartyResolution: 'PERSISTED_AND_READ_TIME' as const,
    },
    byCategory: [], largestIncome: null, largestExpense: null,
  };

  // April: income 4000, expense 3000, NO refund  → net 1000.
  // May:   income 4000, expense 3000, refund 500 → net 1500 (refund-inclusive).
  const txn: TransactionsSummaryData = {
    ...base,
    monthlyBreakdown: [
      mkMonth({ month: '2026-04', incomeTotal: 4000, expenseTotal: 3000, refundTotal: 0 }),
      mkMonth({ month: '2026-05', incomeTotal: 4000, expenseTotal: 3000, refundTotal: 500 }),
    ],
  };

  const trends  = computeSpendingTrends(txn);
  const netTrend = trends.metricTrends.find((t) => t.metric === 'net');

  check('computeSpendingTrends surfaces a net MoM delta of the refund difference (+500)',
    netTrend?.momDeltaAbs !== null && netTrend !== undefined && approx(netTrend.momDeltaAbs!, 500),
    `momDeltaAbs=${netTrend?.momDeltaAbs}, expected 500`);

  check('net trend direction RISING (refund lifted the later month)',
    netTrend?.direction === 'RISING', `direction=${netTrend?.direction}`);
}

// ── Exit ──────────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll spending-trends-net checks passed.');
