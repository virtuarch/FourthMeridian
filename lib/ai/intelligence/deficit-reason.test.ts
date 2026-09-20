/**
 * lib/ai/intelligence/deficit-reason.test.ts   (post-M1 integration)
 *
 * `deficitCause` NEVER TRAVELS AS A BARE LABEL. It carries the rung that fired and
 * the debt-service operands, so a reader can see that a card payment settling
 * purchases already counted as spending was not subtracted a second time — and
 * the two other places that added every debt payment to spending no longer do.
 *
 *   npx tsx lib/ai/intelligence/deficit-reason.test.ts
 */
import assert from 'node:assert/strict';
import { computeAssessment } from '@/lib/ai/intelligence';
import { FinanceDomains, type SpaceContext_AI, type TransactionsSummaryData } from '@/lib/ai/types';

let n = 0;
const ok = (name: string) => { n++; console.log(`  ✓ ${name}`); };
const month = (m: string, income: number, expense: number, debt: number) => ({
  month: m, incomeTotal: income, expenseTotal: expense, refundTotal: 0, debtPaymentTotal: debt,
  transferTotal: 0, transactionCount: 30, estimated: false, byCategory: [] });
const txn = (o: { income: number; spending: number; payments: number; charges: number; proceeds?: number }) => {
  const net = o.income - o.spending;
  const paydown = Math.max(0, o.payments - o.charges - (o.proceeds ?? 0));
  return {
    windowDays: 90, startDate: '2026-06-01', endDate: '2026-08-29', transactionCount: 90, truncated: false,
    incomeTotal: o.income, expenseTotal: o.spending, refundTotal: 0, debtPaymentTotal: o.payments,
    netCashFlow: net, netAfterDebtPayments: net - paydown,
    debtService: { payments: o.payments, newChargesOnLiabilities: o.charges, debtProceeds: o.proceeds ?? 0,
      netPaydown: paydown, netNewBorrowing: Math.max(0, o.charges + (o.proceeds ?? 0) - o.payments) },
    byCategory: [{ category: 'Income', total: o.income, count: 6 }],
    monthlyBreakdown: [month('2026-06', o.income / 3, o.spending / 3, o.payments / 3),
      month('2026-07', o.income / 3, o.spending / 3, o.payments / 3), month('2026-08', o.income / 3, o.spending / 3, o.payments / 3)],
  } as unknown as TransactionsSummaryData;
};
const assess = (t: TransactionsSummaryData) => computeAssessment({ space: { name: 't', reportingCurrency: 'USD' },
  domains: { [FinanceDomains.TRANSACTIONS_SUMMARY]: { data: t },
    [FinanceDomains.SNAPSHOT_HISTORY]: { data: { snapshotCount: 400, spanDays: 399, history: [], latest: null } } } } as unknown as SpaceContext_AI).cashFlow;

// A household that puts all its spending on a card and pays the card in full.
const fullPayer = assess(txn({ income: 30000, spending: 18000, payments: 18000, charges: 18000 }));
assert.equal(fullPayer.deficitCause, 'NOT_APPLICABLE');
assert.equal(fullPayer.deficitReason.scope, 'CASH_NET_AFTER_DEBT_PAYDOWN');
assert.equal(fullPayer.deficitReason.reasonCode, 'NET_AFTER_PAYDOWN_NOT_NEGATIVE');
assert.equal(fullPayer.deficitReason.reasonMetrics.netPaydown, 0);
assert.equal(fullPayer.deficitReason.reasonMetrics.netAfterDebtPaydown, 12000);
ok('full-pay card user: no deficit, and the reason shows payments 18,000 settled charges 18,000 ⇒ net paydown 0');

// Paying down an old balance faster than the economic net allows.
const payingDown = assess(txn({ income: 30000, spending: 24000, payments: 20000, charges: 8000 }));
assert.equal(payingDown.deficitCause, 'DEBT_DRIVEN');
assert.equal(payingDown.deficitReason.reasonCode, 'PAYDOWN_EXCEEDS_ECONOMIC_NET');
const m = payingDown.deficitReason.reasonMetrics;
assert.equal(m.netPaydown, 12000);
assert.equal(m.netAfterDebtPaydown, (m.economicNet as number) - (m.netPaydown as number));
ok('genuine paydown beyond the surplus: DEBT_DRIVEN, and the verdict reproduces from its own operands');

// Overspending financed on a card: new borrowing never improves the net.
const financed = assess(txn({ income: 20000, spending: 26000, payments: 3000, charges: 12000 }));
assert.equal(financed.deficitCause, 'POSSIBLE_OVERSPENDING');
assert.equal(financed.deficitReason.reasonCode, 'ECONOMIC_NET_NEGATIVE');
assert.equal(financed.deficitReason.reasonMetrics.netPaydown, 0);
ok('overspending financed on a card still reads as overspending; borrowing is not a surplus');

// A hand-built payload without the assembler's field falls back to the SAME definition.
const bare = txn({ income: 30000, spending: 18000, payments: 18000, charges: 18000 }) as unknown as Record<string, unknown>;
delete bare.netAfterDebtPayments;
assert.equal(assess(bare as unknown as TransactionsSummaryData).deficitCause, 'NOT_APPLICABLE');
ok('no `netAfterDebtPayments` on the payload ⇒ economic net − NET paydown, never − every debt payment');

// The income-plausibility ratio no longer counts card-funded spending twice.
import { readFileSync } from 'node:fs';
const src = readFileSync('lib/ai/intelligence/annotations/engine.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
assert.ok(!/expenseTotal\s*\+\s*debtPaymentTotal/.test(src), 'totalOutflows must not add every debt payment to spending');
assert.ok(!/netCashFlow\s*-\s*debtPaymentTotal/.test(src), 'no fallback may subtract every debt payment from the economic net');
ok('source: neither retired subtraction survives in the engine');

console.log(`deficit-reason: ${n} checks passed`);
