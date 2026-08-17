/**
 * lib/ai/fold-enrolment.test.ts   (REVIEW-3 C — the AI-side fold enrolment guard)
 *
 * The AI transactions assembler used to be a parallel financial authority: it
 * re-implemented the income/spend/refund economic fold THREE times (window,
 * monthly, income-source), read a non-existent `incomeClass` column off a raw
 * Prisma row, defined a FOURTH "net cash flow" formula, and proxied "paid
 * toward debt" as `isDebtPayment && amount < 0`. This guard is the companion to
 * lib/transactions/cash-flow-fold-authority.test.ts, scoped to the AI layer
 * (kept as a SEPARATE file so the two slices' merge surfaces stay disjoint —
 * coordinate note in the REVIEW-3 plan).
 *
 * Two halves (house pattern):
 *   1. BEHAVIOURAL parity — the assembler's exported pure folds produce the
 *      same economic answer as economicTotals (the canonical economic-only
 *      entry point over foldEconomicRow + clampEconomicSpend).
 *   2. SOURCE-SCAN invariants — the assembler cannot re-fork the fold, the
 *      income taxonomy, the net definition, or the debt-payment membership.
 *
 *     npx tsx lib/ai/fold-enrolment.test.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { buildMonthlyBreakdown } from './assemblers/transactions';
import { economicTotals, clampEconomicSpend } from '@/lib/transactions/cash-flow';
import type { Transaction } from '@/types';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`[PASS] ${name}`); return; }
  failures += 1;
  console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
}
const cents = (v: number) => Math.round(v * 100);

// ── 1. Behavioural parity: the monthly fold IS the canonical economic fold ────
// The same logical rows are fed to (a) the assembler's exported pure monthly
// fold and (b) economicTotals, the canonical economic-only entry point. If the
// assembler ever re-inlines its own branch or clamp, the two answers diverge
// and this harness catches it behaviourally — not just by source shape.

{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mrow = (id: string, dateISO: string, amount: number, flowType: string, category: string): any => ({
    id, date: new Date(`${dateISO}T00:00:00Z`), merchant: 'M', category, amount,
    pending: false, currency: 'USD', flowType, flowDirection: null,
  });
  const dto = (id: string, dateISO: string, amount: number, flowType: string, incomeClass?: string): Transaction =>
    ({ id, accountId: 'a', date: dateISO, merchant: 'M', category: 'Other', amount,
       pending: false, currency: 'USD', flowType, flowDirection: null,
       classificationConfidence: null, classificationReason: null, classifierVersion: null,
       counterpartyAccountId: null, merchantDisplayName: 'M', merchantLogoUrl: null,
       ...(incomeClass ? { incomeClass } : {}),
     } as unknown as Transaction);

  // Mixed month: income, spending, fee, interest, refund, a NOT_INCOME issuer
  // credit, a debt payment (authority-counted), and a transfer.
  const rows = [
    mrow('t1', '2026-05-02', +5000.0, 'INCOME',       'Income'),
    mrow('t2', '2026-05-03', -320.0,  'SPENDING',     'Dining'),
    mrow('t3', '2026-05-04', -40.0,   'FEE',          'Other'),
    mrow('t4', '2026-05-05', -12.5,   'INTEREST',     'Interest'),
    mrow('t5', '2026-05-06', +150.0,  'REFUND',       'Shopping'),
    mrow('t6', '2026-05-07', +280.45, 'INCOME',       'Income'),   // NOT_INCOME (issuer credit)
    mrow('t7', '2026-05-08', -400.0,  'DEBT_PAYMENT', 'Payment'),  // counted cash leg
    mrow('t8', '2026-05-09', -900.0,  'TRANSFER',     'Transfer'),
  ];
  const incomeClassOf = (id: string) => (id === 't6' ? 'NOT_INCOME' : id === 't1' ? 'EARNED_INCOME' : null);

  const months = buildMonthlyBreakdown(rows, [], '2026-05-01', '2026-05-31', null, undefined, {
    debtCountedIds: new Set(['t7']),
    incomeClassOf,
  });
  const may = months.find((m) => m.month === '2026-05');

  const eco = economicTotals([
    dto('t1', '2026-05-02', +5000.0, 'INCOME', 'EARNED_INCOME'),
    dto('t2', '2026-05-03', -320.0,  'SPENDING'),
    dto('t3', '2026-05-04', -40.0,   'FEE'),
    dto('t4', '2026-05-05', -12.5,   'INTEREST'),
    dto('t5', '2026-05-06', +150.0,  'REFUND'),
    dto('t6', '2026-05-07', +280.45, 'INCOME', 'NOT_INCOME'),
    dto('t7', '2026-05-08', -400.0,  'DEBT_PAYMENT'),
    dto('t8', '2026-05-09', -900.0,  'TRANSFER'),
  ]);

  check('monthly fold exists for the fixture month', may !== undefined);
  if (may) {
    check('monthly income == economicTotals income (NOT_INCOME excluded by the shared fold)',
      cents(may.incomeTotal) === cents(eco.income), `${may.incomeTotal} vs ${eco.income}`);
    check('monthly gross expense == economicTotals spendGross population (spend = clamp(gross − refunds))',
      cents(clampEconomicSpend(may.expenseTotal, may.refundTotal)) === cents(eco.spend),
      `${may.expenseTotal}/${may.refundTotal} vs spend ${eco.spend}`);
    check('monthly refunds == economicTotals refunds',
      cents(may.refundTotal) === cents(eco.refunds), `${may.refundTotal} vs ${eco.refunds}`);
    check('canonical net from monthly fields == economicTotals net',
      cents(may.incomeTotal - clampEconomicSpend(may.expenseTotal, may.refundTotal)) === cents(eco.net));
    check('authority-counted debt payment disclosed under debtPaymentTotal, once',
      cents(may.debtPaymentTotal) === cents(400));
    check('transfer disclosed under transferTotal, never economic',
      cents(may.transferTotal) === cents(900));
  }

  // Legacy fixture path (no authority) stays byte-compatible: positive-only
  // income, amt<0 debt proxy — the KD-17 golden fixtures depend on this.
  const legacy = buildMonthlyBreakdown(rows, [], '2026-05-01', '2026-05-31', null);
  const lmay = legacy.find((m) => m.month === '2026-05');
  check('fixture path (no authority): NOT_INCOME row stays included (legacy behaviour preserved)',
    lmay !== undefined && cents(lmay.incomeTotal) === cents(5280.45), String(lmay?.incomeTotal));
  check('fixture path (no authority): amt<0 debt proxy preserved',
    lmay !== undefined && cents(lmay.debtPaymentTotal) === cents(400));
}

// ── 2. Source-scan invariants — the AI assembler stays enrolled ───────────────

const read = (rel: string[]) => readFileSync(join(process.cwd(), ...rel), 'utf8');
const assembler = read(['lib', 'ai', 'assemblers', 'transactions.ts']);
const metrics   = read(['lib', 'ai', 'intelligence', 'annotations', 'metrics.ts']);
const engine    = read(['lib', 'ai', 'intelligence', 'annotations', 'engine.ts']);

check('INVARIANT: assembler folds via the shared foldEconomicRow',
  /foldEconomicRow\(/.test(assembler));
check('INVARIANT: assembler clamps via the shared clampEconomicSpend',
  /clampEconomicSpend\(/.test(assembler));
check('INVARIANT: no re-inlined window accumulators (incomeTotal/expenseTotal/refundTotal +=)',
  !/incomeTotal\s*\+=/.test(assembler) && !/expenseTotal\s*\+=/.test(assembler) && !/refundTotal\s*\+=/.test(assembler));
check('INVARIANT: the retired fourth net definition is gone (income + refund − expense − debtPayments)',
  !/incomeTotal\s*\+\s*refundTotal\s*-\s*expenseTotal\s*-\s*debtPaymentTotal/.test(assembler));
check('INVARIANT: income classification comes from the canonical taxonomy (attributeIncome)',
  /attributeIncome\(/.test(assembler));
// Comments may cite the old defect verbatim; only CODE lines are scanned here.
const assemblerCode = assembler.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
check('INVARIANT: the phantom-column cast is gone — incomeClass is never read off a raw Prisma row',
  !/as \{\s*incomeClass\?:/.test(assemblerCode));
check('INVARIANT: debt-payment membership is the debt-payment authority\'s (selectDebtPaymentCashLegs)',
  /selectDebtPaymentCashLegs\(/.test(assembler));
check('INVARIANT: the trend/annotation net delegates the clamp to clampEconomicSpend',
  /clampEconomicSpend\(/.test(metrics));
check('INVARIANT: the trend net no longer subtracts debt payments (the retired formula)',
  !/m\.incomeTotal\s*\+\s*m\.refundTotal\s*-\s*m\.expenseTotal\s*-\s*m\.debtPaymentTotal/.test(metrics));
check('INVARIANT: deficitCause grades on the canonical net + the named after-paydown figure',
  /netAfterDebtPayments/.test(engine) && /DEBT_DRIVEN/.test(engine));

// ── Exit ──────────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll fold-enrolment checks passed.');
// Explicit exit (house pattern, mirrors transactions.golden.test.ts): importing
// the assembler transitively constructs the Prisma client; in an environment
// without the platform query engine a floating engine-resolution rejection
// would otherwise land after the assertions and fail a fully-passing run.
process.exit(0);
