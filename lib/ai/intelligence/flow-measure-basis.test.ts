/**
 * lib/ai/intelligence/flow-measure-basis.test.ts   (post-M1 D1 · D2 · D3)
 *
 * THE ASSESSMENT'S FLOW FIGURES SHARE ONE MONTH POPULATION, AND ITS DEFICIT
 * VERDICT DOES NOT COUNT CARD-FUNDED SPENDING TWICE.
 *
 *   D1  estimatedMonthlyDebtPayments is a complete-month mean, like the income
 *       and expense figures beside it — not a window total normalised by days.
 *   D2  every category `monthlyEquivalent` is the same kind of mean, because it
 *       FEEDS CLASSIFICATION (opportunity impact, REVIEW_MIN_MONTHLY); with no
 *       reliable month the section REFUSES and nothing is graded from it.
 *   D3  deficitCause is graded on the economic net and on that net after NET
 *       debt paydown. A household that pays its cards in full is never
 *       DEBT_DRIVEN; one that really pays debt down faster than its surplus is.
 *
 * Pure and synthetic. Every assertion is a relation or a verdict over a
 * fixture household — no live value is pinned. The D3 households are built
 * from LEDGER ROWS through the same two authorities the assembler uses
 * (`economicTotals`, `computeDebtService`), so the verdicts are tested end to
 * end from rows, not from hand-typed nets.
 *
 *   npx tsx lib/ai/intelligence/flow-measure-basis.test.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { computeAssessment } from '@/lib/ai/intelligence';
import {
  computeAverageMonthlyDebtPayments, computeAverageMonthlyIncome, computeAverageMonthlySpending,
  computeSpendingOpportunities, meanPerReliableMonth, reliableMonths,
} from '@/lib/ai/intelligence/annotations/metrics';
import {
  OPP_DISCRETIONARY_HIGH_MONTHLY, OPP_DISCRETIONARY_MED_MONTHLY, REVIEW_MIN_MONTHLY,
} from '@/lib/ai/intelligence/annotations/constants';
import type { DataQualitySection } from '@/lib/ai/intelligence/annotations/types';
import { FinanceDomains, type SpaceContext_AI, type TransactionsSummaryData, type MonthlyBreakdownEntry } from '@/lib/ai/types';
import { computeDebtService, netAfterDebtPaydown } from '@/lib/transactions/debt-service';
import { economicTotals } from '@/lib/transactions/cash-flow';
import { tierResolver, type LiquidityTx } from '@/lib/transactions/liquidity';

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${!cond && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!cond) failures++;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

// ── Fixtures ────────────────────────────────────────────────────────────────

type Cat = { category: string; total: number; count: number };
const month = (m: string, o: Partial<MonthlyBreakdownEntry> & { cats?: Cat[] } = {}): MonthlyBreakdownEntry => ({
  month: m, incomeTotal: 0, expenseTotal: 0, refundTotal: 0, debtPaymentTotal: 0, transferTotal: 0,
  transactionCount: 20, estimated: false, byCategory: o.cats ?? [], ...o,
} as MonthlyBreakdownEntry);

const mkTxn = (over: Partial<TransactionsSummaryData>): TransactionsSummaryData => ({
  windowDays: 90, startDate: '2026-06-17', endDate: '2026-09-14', transactionCount: 80, truncated: false,
  incomeTotal: 0, expenseTotal: 0, refundTotal: 0, debtPaymentTotal: 0, transferTotal: 0,
  netCashFlow: 0, netAfterDebtPayments: 0, estimated: false,
  byCategory: [{ category: 'Income', total: 0, count: 8 }], monthlyBreakdown: [],
  ...over,
} as unknown as TransactionsSummaryData);

const mkCtx = (txn: TransactionsSummaryData, snapshotCount = 60): SpaceContext_AI => ({
  space: { name: 't', reportingCurrency: 'USD' },
  domains: {
    [FinanceDomains.TRANSACTIONS_SUMMARY]: { data: txn },
    [FinanceDomains.SNAPSHOT_HISTORY]: { data: { snapshotCount, history: [] } },
  },
} as unknown as SpaceContext_AI);

const DQ = { transactionHistoryCompleteness: 'HIGH' } as DataQualitySection;

// ═════════════════════════════════════════════════════════════════════════════
console.log('D1. MONTHLY DEBT PAYMENTS — a complete-month mean, on the shared month population');
{
  // Two clipped months around two whole ones; payments are lumpy on purpose.
  const MONTHS = [
    month('2026-06', { debtPaymentTotal: 900,  incomeTotal: 5000,  expenseTotal: 1500, partial: true }),
    month('2026-07', { debtPaymentTotal: 9000, incomeTotal: 15000, expenseTotal: 4000 }),
    month('2026-08', { debtPaymentTotal: 6000, incomeTotal: 10000, expenseTotal: 5000 }),
    month('2026-09', { debtPaymentTotal: 5100, incomeTotal: 5000,  expenseTotal: 2000, partial: true }),
  ];
  const windowTotal = MONTHS.reduce((s, m) => s + m.debtPaymentTotal, 0);
  const txn = mkTxn({ monthlyBreakdown: MONTHS, debtPaymentTotal: windowTotal, incomeTotal: 35000, expenseTotal: 12500,
    netCashFlow: 22500, netAfterDebtPayments: 22500 });

  const whole = reliableMonths(txn);
  const expected = r2(whole.reduce((s, m) => s + m.debtPaymentTotal, 0) / whole.length);
  check('it is the mean of the WHOLE months only', computeAverageMonthlyDebtPayments(txn) === expected && expected === 7500);
  check('…and NOT the window total normalised by days', computeAverageMonthlyDebtPayments(txn) !== r2(windowTotal / 90 * 30));
  check('income, spending and debt payments average the SAME months',
    whole.length === 2 && computeAverageMonthlyIncome(txn) === 12500 && computeAverageMonthlySpending(txn) === 4500);

  const a = computeAssessment(mkCtx(txn));
  check('computeAssessment carries it under the UNCHANGED field name', a.cashFlow.estimatedMonthlyDebtPayments === 7500);
  check('…beside income and expenses on the same basis',
    a.cashFlow.impliedMonthlyIncome === 12500 && a.cashFlow.estimatedMonthlyExpenses === 4500);

  check('partial months never enter: moving money between the two clipped months changes nothing',
    computeAverageMonthlyDebtPayments({ ...txn, monthlyBreakdown: [
      { ...MONTHS[0], debtPaymentTotal: 0 }, MONTHS[1], MONTHS[2], { ...MONTHS[3], debtPaymentTotal: 6000 }] } as TransactionsSummaryData) === 7500);
  check('a fetch-cap-TRUNCATED month is not reliable and is left out, exactly as for spending',
    computeAverageMonthlyDebtPayments({ ...txn, monthlyBreakdown: [MONTHS[1], { ...MONTHS[2], truncated: true }] } as TransactionsSummaryData) === 9000);

  // No reliable month ⇒ refusal.
  const noWhole = { ...txn, monthlyBreakdown: [MONTHS[0], MONTHS[3]] } as TransactionsSummaryData;
  check('NO RELIABLE MONTH ⇒ null — never extrapolated from a partial month, however much was paid in it',
    computeAverageMonthlyDebtPayments(noWhole) === null && computeAssessment(mkCtx(noWhole)).cashFlow.estimatedMonthlyDebtPayments === null);
  check('no transactions domain ⇒ null', computeAverageMonthlyDebtPayments(null) === null);

  // No debt payments at all.
  const none = { ...txn, debtPaymentTotal: 0, monthlyBreakdown: MONTHS.map((m) => ({ ...m, debtPaymentTotal: 0 })) } as TransactionsSummaryData;
  check('NO DEBT PAYMENTS in the reliable months ⇒ 0 (a measurement), distinct from null (unknown)',
    computeAverageMonthlyDebtPayments(none) === 0 && computeAssessment(mkCtx(none)).cashFlow.estimatedMonthlyDebtPayments === 0);
  const onlyInPartials = { ...txn, monthlyBreakdown: [MONTHS[0], { ...MONTHS[1], debtPaymentTotal: 0 }, { ...MONTHS[2], debtPaymentTotal: 0 }, MONTHS[3]] } as TransactionsSummaryData;
  check('payments only in clipped months ⇒ 0 for the whole months — the window total is not smeared over them',
    computeAverageMonthlyDebtPayments(onlyInPartials) === 0 && onlyInPartials.debtPaymentTotal > 0);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nD2. CATEGORY monthlyEquivalent — the same mean, and it drives classification');
{
  const JUL: Cat[] = [{ category: 'Travel', total: 2400, count: 6 }, { category: 'Dining', total: 300, count: 20 },
    { category: 'Other', total: 30, count: 2 }, { category: 'Income', total: 0, count: 3 }, { category: 'Payment', total: 5000, count: 2 }];
  const AUG: Cat[] = [{ category: 'Dining', total: 500, count: 25 }, { category: 'Groceries', total: 800, count: 9 },
    { category: 'Other', total: 20, count: 1 }];
  const MONTHS = [
    month('2026-06', { partial: true, cats: [{ category: 'Shopping', total: 9000, count: 3 }] }), // a big clipped month
    month('2026-07', { expenseTotal: 2730, cats: JUL }),
    month('2026-08', { expenseTotal: 1320, cats: AUG }),
    month('2026-09', { partial: true, cats: [{ category: 'Travel', total: 4000, count: 2 }] }),
  ];
  // The WINDOW-level list (what the old formula read) — includes the clipped months.
  const WINDOW: Cat[] = [{ category: 'Shopping', total: 9000, count: 3 }, { category: 'Travel', total: 6400, count: 8 },
    { category: 'Dining', total: 800, count: 45 }, { category: 'Groceries', total: 800, count: 9 },
    { category: 'Other', total: 50, count: 3 }, { category: 'Income', total: 0, count: 8 }];
  const txn = mkTxn({ monthlyBreakdown: MONTHS, byCategory: WINDOW, expenseTotal: 17050 });
  const so = computeSpendingOpportunities(txn, DQ);
  const by = (c: string) => so.topCategories.find((x) => x.category === c);

  check('the section names the months it is a mean over', JSON.stringify(so.monthsAnalyzed) === JSON.stringify(['2026-07', '2026-08']));
  check('a category present in both whole months: (300 + 500) / 2', by('Dining')?.monthlyEquivalent === 400);
  check('a category ABSENT from one whole month counts that month as zero — the denominator is the population, not its appearances',
    by('Travel')?.monthlyEquivalent === 1200 && by('Groceries')?.monthlyEquivalent === 400);
  check('…and its row count is over the same months', by('Travel')?.transactionCount === 6 && by('Dining')?.transactionCount === 45);
  check('a category seen ONLY in clipped months is not ranked at all (Shopping: 9,000 in a partial month)', by('Shopping') === undefined);
  check('none of the figures is the window total normalised by days',
    so.topCategories.every((c) => c.monthlyEquivalent !== r2((WINDOW.find((w) => w.category === c.category)!.total) / 90 * 30)));
  check('non-spending categories stay out (Income, Payment)', by('Income') === undefined && by('Payment') === undefined);
  check('the spending categories reconcile with the expense mean of the same months',
    r2(so.topCategories.reduce((s, c) => s + c.monthlyEquivalent, 0)) === computeAverageMonthlySpending(txn));
  check('ranking, the top reduction opportunity and the discretionary total all read the month basis',
    so.topCategories[0].category === 'Travel' && so.topReductionOpportunity?.category === 'Travel' && so.discretionaryTotal === 1600);
  check('every figure is THE helper\'s figure (one normalisation)', so.topCategories.every((c) =>
    c.monthlyEquivalent === meanPerReliableMonth(txn, (m) => m.byCategory.find((x) => x.category === c.category)?.total ?? 0)));

  // It feeds classification: REVIEW_MIN_MONTHLY.
  check('REVIEW_NEEDED reads the month mean: Other averages 25/mo ≥ the floor ⇒ surfaced',
    by('Other')?.monthlyEquivalent === 25 && 25 >= REVIEW_MIN_MONTHLY && so.categoriesNeedingReview.includes('Other'));
  const belowFloor = computeSpendingOpportunities(mkTxn({ monthlyBreakdown: [
    month('2026-07', { cats: [{ category: 'Other', total: 30, count: 1 }] }), month('2026-08', { cats: [] }),
    month('2026-09', { partial: true, cats: [{ category: 'Other', total: 5000, count: 9 }] })] }), DQ);
  check('…and a category whose money sits in a CLIPPED month cannot cross the floor on it (30 / 2 = 15 < floor)',
    belowFloor.categoriesNeedingReview.length === 0 && belowFloor.topCategories[0]?.monthlyEquivalent === 15);

  // It feeds classification: the opportunity impact rungs (engines.ts).
  const impactOf = (cats: Cat[][], partialCats: Cat[] = []) => {
    const t = mkTxn({ monthlyBreakdown: [
      month('2026-06', { partial: true, cats: partialCats }), ...cats.map((c, i) => month(`2026-0${7 + i}`, { cats: c }))] });
    return computeAssessment(mkCtx(t)).riskOpportunities.opportunities.find((o) => o.code === 'CUT_TOP_DISCRETIONARY_CATEGORY')?.impact ?? null;
  };
  const dining = (total: number): Cat[] => [{ category: 'Dining', total, count: 5 }];
  check('impact HIGH at the month mean ≥ the high rung', impactOf([dining(OPP_DISCRETIONARY_HIGH_MONTHLY), dining(OPP_DISCRETIONARY_HIGH_MONTHLY)]) === 'high');
  check('impact MEDIUM between the rungs', impactOf([dining(OPP_DISCRETIONARY_MED_MONTHLY), dining(OPP_DISCRETIONARY_MED_MONTHLY + 50)]) === 'medium');
  check('impact LOW below the medium rung', impactOf([dining(40), dining(60)]) === 'low');
  check('a clipped month cannot move the rung: 50/mo in whole months stays LOW beside 9,000 in a partial one',
    impactOf([dining(50), dining(50)], dining(9000)) === 'low');
  check('a zero month pulls the mean down: 500 then nothing ⇒ 250 ⇒ MEDIUM, not HIGH', impactOf([dining(500), []]) === 'medium');

  // Refusal.
  const noWhole = mkTxn({ byCategory: WINDOW, monthlyBreakdown: [MONTHS[0], MONTHS[3]] });
  const refused = computeSpendingOpportunities(noWhole, DQ);
  check('NO RELIABLE MONTH ⇒ the section REFUSES: no categories, no top opportunity, discretionary total null (never 0)',
    refused.monthsAnalyzed.length === 0 && refused.topCategories.length === 0 && refused.topReductionOpportunity === null &&
    refused.discretionaryTotal === null && refused.categoriesNeedingReview.length === 0);
  check('…while still saying rows exist (the gap is a complete month, not data)', refused.hasTransactionData === true);
  const codes = computeAssessment(mkCtx(noWhole)).riskOpportunities.opportunities.map((o) => o.code);
  check('…and NOTHING is graded from it: no cut-category and no review opportunity, at any impact',
    !codes.includes('CUT_TOP_DISCRETIONARY_CATEGORY') && !codes.includes('REVIEW_OTHER_CATEGORY'), codes);
  const empty = computeSpendingOpportunities(null, DQ);
  check('no transactions domain ⇒ the same refusal shape, flagged as no data',
    empty.hasTransactionData === false && empty.discretionaryTotal === null && empty.monthsAnalyzed.length === 0);

  // Transport-shape invariance (the former W4 residual).
  const briefShaped = mkTxn({ monthlyBreakdown: MONTHS, byCategory: WINDOW.slice(0, 2), expenseTotal: 17050 });
  check('the window-level byCategory list (which the brief transport caps) no longer reaches this section',
    JSON.stringify(computeSpendingOpportunities(briefShaped, DQ)) === JSON.stringify(so));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nD3. deficitCause — graded from LEDGER ROWS through the canonical authorities');
{
  const TIERS = tierResolver([{ id: 'chk', type: 'checking' }, { id: 'card', type: 'debt' }, { id: 'loan', type: 'debt' }]);
  let seq = 0;
  const row = (own: string, amount: number, flowType: string, cp: string | null = null): LiquidityTx => ({
    id: `r${++seq}`, accountId: own, financialAccountId: own, counterpartyAccountId: cp, amount, flowType,
    incomeClass: flowType === 'INCOME' ? 'EARNED_INCOME' : null, currency: 'USD', date: '2026-07-10',
    merchant: 'm', category: 'Other', pending: false } as unknown as LiquidityTx);
  const income = (n: number) => row('chk', n, 'INCOME');
  const buy = (own: string, n: number) => row(own, -n, 'SPENDING');
  const pay = (to: string, n: number) => [row('chk', -n, 'DEBT_PAYMENT', to), row(to, n, 'DEBT_PAYMENT', 'chk')];

  /** Rows → the two nets, exactly as the assembler derives them → the verdict. */
  const grade = (rows: LiquidityTx[], opts: { incomeRows?: number; snapshots?: number } = {}) => {
    const eco = economicTotals(rows);
    const svc = computeDebtService(rows, TIERS, (r) => Math.abs(r.amount));
    const txn = mkTxn({
      incomeTotal: eco.income, expenseTotal: eco.spend, debtPaymentTotal: svc.payments, debtService: svc,
      netCashFlow: eco.net, netAfterDebtPayments: netAfterDebtPaydown(eco.net, svc),
      byCategory: [{ category: 'Income', total: 0, count: opts.incomeRows ?? 8 }],
    });
    const a = computeAssessment(mkCtx(txn, opts.snapshots ?? 60));
    return { cause: a.cashFlow.deficitCause, priorities: a.priorities.map((p) => p.code + ':' + p.severity), eco, svc, a };
  };

  const fullPay = grade([income(10_000), buy('card', 6_000), buy('chk', 1_500), ...pay('card', 6_000)]);
  check('FULL-PAY CARD USER: a surplus, cards settled in full ⇒ NOT_APPLICABLE',
    fullPay.cause === 'NOT_APPLICABLE' && fullPay.eco.net > 0, fullPay.cause);
  check('…the payments exceed the economic surplus — the exact shape that used to be graded DEBT_DRIVEN',
    fullPay.svc.payments > fullPay.eco.net);
  check('…and no CASH_FLOW priority is raised for it', !fullPay.priorities.some((p) => p.startsWith('CASH_FLOW')), fullPay.priorities);

  const heavyCard = grade([income(10_000), buy('card', 9_500), ...pay('card', 9_500)]);
  check('however large the card volume, settlement alone never creates a deficit', heavyCard.cause === 'NOT_APPLICABLE');

  const sameWindow = grade([income(5_000), buy('card', 4_999), ...pay('card', 4_999)]);
  check('CARD PURCHASE + ITS SETTLEMENT in one window: spending is counted once ⇒ a $1 surplus is still a surplus',
    sameWindow.cause === 'NOT_APPLICABLE');

  const paydown = grade([income(6_000), buy('chk', 4_000), ...pay('card', 5_000)]);
  check('GENUINE PRINCIPAL REDUCTION beyond the surplus ⇒ DEBT_DRIVEN (income covered spending; cash went to reducing debt)',
    paydown.cause === 'DEBT_DRIVEN' && paydown.eco.net > 0 && paydown.svc.netPaydown > paydown.eco.net);
  check('…raised as INFO, never as overspending', paydown.priorities.includes('CASH_FLOW:info') && !paydown.priorities.includes('CASH_FLOW:warning'));

  const affordable = grade([income(6_000), buy('chk', 3_000), ...pay('loan', 2_000)]);
  check('paydown the surplus covers is no deficit', affordable.cause === 'NOT_APPLICABLE' && affordable.svc.netPaydown === 2_000);

  const revolving = grade([income(5_000), buy('card', 3_000), buy('chk', 1_000), ...pay('card', 500)]);
  check('REVOLVING USER with a surplus: carrying a balance is not a deficit, and borrowing is not credited',
    revolving.cause === 'NOT_APPLICABLE' && revolving.svc.netNewBorrowing === 2_500);

  const financed = grade([income(3_000), buy('card', 5_000), ...pay('card', 200)]);
  check('OVERSPENDING FINANCED ON A CARD still reads as overspending — new debt cannot hide it',
    financed.cause === 'POSSIBLE_OVERSPENDING' && financed.eco.net < 0);
  check('…and is never relabelled DEBT_DRIVEN', financed.cause !== 'DEBT_DRIVEN' && financed.priorities.includes('CASH_FLOW:warning'));

  const interestFee = grade([income(4_000), row('card', -60, 'INTEREST'), row('card', -40, 'FEE'), ...pay('card', 100)]);
  check('INTEREST / FEES on a card are spending once; paying them is settlement ⇒ no deficit',
    interestFee.cause === 'NOT_APPLICABLE' && interestFee.eco.spend === 100 && interestFee.svc.netPaydown === 0);

  const mixed = grade([income(8_000), buy('chk', 2_000), buy('card', 3_000), ...pay('card', 3_000),
    row('loan', -200, 'INTEREST'), ...pay('loan', 3_500)]);
  check('MIXED ACCOUNTS: only the loan principal is paydown (3,300), and it exceeds the 2,800 surplus ⇒ DEBT_DRIVEN',
    mixed.svc.netPaydown === 3_300 && mixed.eco.net === 2_800 && mixed.cause === 'DEBT_DRIVEN');

  const noDebt = grade([income(4_000), buy('chk', 1_000)]);
  check('NO DEBT PAYMENTS: surplus ⇒ NOT_APPLICABLE', noDebt.cause === 'NOT_APPLICABLE' && noDebt.svc.payments === 0);
  const noDebtOver = grade([income(1_000), buy('chk', 4_000)]);
  check('NO DEBT PAYMENTS: deficit ⇒ POSSIBLE_OVERSPENDING', noDebtOver.cause === 'POSSIBLE_OVERSPENDING');

  const thinIncome = grade([income(6_000), buy('chk', 4_000), ...pay('card', 5_000)], { incomeRows: 0 });
  check('a deficit over a LOW income sample stays a data artifact, whatever the debt service', thinIncome.cause === 'LOW_INCOME_SAMPLE');

  // The ladder's two inputs, stated as the invariant every row set must satisfy.
  for (const g of [fullPay, heavyCard, sameWindow, paydown, affordable, revolving, financed, interestFee, mixed, noDebt, noDebtOver]) {
    const after = netAfterDebtPaydown(g.eco.net, g.svc);
    const expected = after >= 0 ? 'NOT_APPLICABLE' : g.eco.net < 0 ? 'POSSIBLE_OVERSPENDING' : 'DEBT_DRIVEN';
    if (g.cause !== expected) check('verdict = f(economic net, net after NET paydown)', false, { got: g.cause, expected });
  }
  check('every household above: verdict = f(economic net, economic net − NET paydown), and nothing else', true);
  check('DEBT_DRIVEN ⇒ the economic net is ≥ 0 AND real paydown exceeds it (both must hold)',
    [paydown, mixed].every((g) => g.eco.net >= 0 && g.svc.netPaydown > g.eco.net));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nSOURCE — one month-normalisation, and no day-normalisation anywhere in the assessment');
{
  const DIR = join(process.cwd(), 'lib', 'ai', 'intelligence', 'annotations');
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  check('the scan sees the whole directory', files.includes('engine.ts') && files.includes('metrics.ts') && files.includes('engines.ts'), files);

  for (const f of files) {
    const code = stripComments(readFileSync(join(DIR, f), 'utf8'));
    check(`${f}: nothing is divided by windowDays`, !/\/\s*\(?\s*(txn\??\.)?windowDays/.test(code));
    check(`${f}: no "× 30" / "÷ 30" / 30.4x / 365÷12 month normalisation`,
      !/[*/]\s*30(\.\d+)?\b/.test(code) && !/\b30(\.\d+)?\s*[*]/.test(code) && !/365(\.25)?\s*\/\s*12/.test(code));
  }

  const metrics = stripComments(readFileSync(join(DIR, 'metrics.ts'), 'utf8'));
  check('metrics.ts divides by a month count in exactly ONE place — meanPerReliableMonth',
    (metrics.match(/\/\s*months\.length/g) ?? []).length === 1 &&
    /export function meanPerReliableMonth[\s\S]{0,400}\/\s*months\.length/.test(metrics));
  for (const fn of ['computeAverageMonthlySpending', 'computeAverageMonthlyIncome', 'computeAverageMonthlyDebtPayments']) {
    check(`${fn} is the helper over one field`, new RegExp(`export function ${fn}\\([\\s\\S]{0,120}return meanPerReliableMonth\\(`).test(metrics));
  }
  check('the category figure goes through the helper too', /const monthlyEquivalent = meanPerReliableMonth\(/.test(metrics));

  const engine = stripComments(readFileSync(join(DIR, 'engine.ts'), 'utf8'));
  check('the engine takes monthly debt payments from the helper-backed mean',
    /estimatedMonthlyDebtPayments: number \| null = computeAverageMonthlyDebtPayments\(txn\)/.test(engine));
  check('the engine still grades deficitCause on the two named nets',
    /if \(netAfterDebtPayments >= 0\)\s+return 'NOT_APPLICABLE'/.test(engine) && /if \(netCashFlow < 0\) return 'POSSIBLE_OVERSPENDING'/.test(engine));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nflow-measure-basis: all checks passed');
