/**
 * lib/transactions/category-spend-authority.test.ts
 * FM-AUDIT-003 / 004 / 005 / 006 / 007 — THE canonical category-spending authority.
 *
 * S1 will transform category spending rates. It can only build on ONE definition
 * of "what this category cost", produced by ONE primitive, over categories the
 * ledger can actually identify. This suite pins:
 *
 *   A. direction — economicSideOf: membership by flow verdict, direction by sign;
 *      a $3 fee and its $3 rebate are $3 charged and $3 reversed, never $6 spent.
 *   B. conservation — Σ gross − Σ refunds === Σ net − Σ refundsUnapplied ===
 *      headline spendGross − refunds, over a population with every flow kind.
 *   C. membership — transfers, card payments, income, investment activity and
 *      residue never enter; a card credit is a refund, never income; a spending
 *      row carrying a structural label lands on Other.
 *   D. UI ↔ AI parity — the Cash Flow ledger and the AI assembler's monthly lines,
 *      fed the same rows, agree per category on gross / refunds / net, and the AI
 *      lines reconcile EXACTLY with its expenseTotal / refundTotal.
 *   E. vocabulary — every enum value classified; every category bank sync can
 *      produce is measurable; no category it cannot produce is.
 *   F. unsupported ≠ measured zero — the real `measure_flows` tool refuses
 *      Groceries / Medical / Transport (and structural labels) instead of
 *      returning $0.00, and advertises only measurable categories.
 *   G. liquidity agrees — a fee rebate into checking is Cash In, not Cash Out.
 *
 * Standalone tsx script: exits 0/1. No DB (the tool refuses before any read).
 */

import { TransactionCategory } from '@prisma/client';
import type { Transaction } from '@/types';
import {
  economicSideOf, foldEconomicRow, foldCategorySpend, categorySpendLedger, economicTotals,
  clampEconomicSpend, type EconomicAccumulator, type CategoryLedgerRow,
} from '@/lib/transactions/cash-flow';
import {
  CATEGORY_VOCABULARY, MEASURABLE_SPEND_CATEGORIES, UNSUPPORTED_SPEND_CATEGORIES, resolveSpendCategory,
  spendCategoryKey, categoryDefinition, isTransformableSpendCategory, TRANSFORMABLE_SPEND_CATEGORIES,
} from '@/lib/transactions/category-vocabulary';
import { mapPlaidCategory } from '@/lib/transactions/plaid-category';
import { classifyFlow } from '@/lib/transactions/flow-classifier';

delete process.env.DATABASE_URL;

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
process.on('unhandledRejection', (err) => {
  if (/Prisma/.test((err as { constructor?: { name?: string } })?.constructor?.name ?? '')) return;
  console.error('  ✗ unexpected unhandled rejection:', String(err));
  process.exit(1);
});
const approx = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** A UI DTO row. */
let seq = 0;
function tx(category: string, flowType: string | null, amount: number, date = '2026-06-10'): Transaction {
  return { id: `t${++seq}`, date, economicDate: date, amount, currency: 'USD', category, flowType,
    pending: false, accountId: 'chk', financialAccountId: 'chk' } as unknown as Transaction;
}

async function main(): Promise<void> {
  // ── A. direction ─────────────────────────────────────────────────────────
  console.log('A. economicSideOf — membership by verdict, direction by sign');
  check('a cost-flow charge is SPEND', economicSideOf('FEE', -3) === 'SPEND' && economicSideOf('SPENDING', -1) === 'SPEND');
  check('a cost-flow credit (fee rebate, interest reversal) is CREDIT',
    economicSideOf('FEE', 3) === 'CREDIT' && economicSideOf('INTEREST', 0.35) === 'CREDIT');
  check('a REFUND credit is CREDIT', economicSideOf('REFUND', 500) === 'CREDIT');
  check('income is INCOME', economicSideOf('INCOME', 2000) === 'INCOME');
  check('transfers, card payments, investment activity, residue are NOT spending — whatever the sign',
    [-50, 50].every((a) => ['TRANSFER', 'DEBT_PAYMENT', 'INVESTMENT', 'ADJUSTMENT', 'UNKNOWN', null].every((f) => economicSideOf(f, a) === null)));
  const acc: EconomicAccumulator = { income: 0, spendGross: 0, refunds: 0 };
  for (const [flowType, amount] of [['FEE', -3], ['FEE', 3], ['SPENDING', -100]] as const) foldEconomicRow(acc, { flowType, amount });
  check('THE AUDIT CASE: −$3 fee, +$3 rebate, −$100 spend ⇒ charged $103, reversed $3, net $100 — never $106',
    acc.spendGross === 103 && acc.refunds === 3 && clampEconomicSpend(acc.spendGross, acc.refunds) === 100, JSON.stringify(acc));
  const i: EconomicAccumulator = { income: 0, spendGross: 0, refunds: 0 };
  foldEconomicRow(i, { flowType: 'INTEREST', amount: -45 }); foldEconomicRow(i, { flowType: 'INTEREST', amount: 45 });
  check('an interest charge and its full reversal net to $0', clampEconomicSpend(i.spendGross, i.refunds) === 0);
  const t = economicTotals([tx('Fee', 'FEE', -3), tx('Fee', 'FEE', 3), tx('Dining', 'SPENDING', -100)]);
  check('economicTotals (the headline) agrees: spend 100', t.spend === 100 && t.spendGross === 103 && t.refunds === 3, JSON.stringify(t));
  const fees = categorySpendLedger([tx('Fee', 'FEE', -3), tx('Fee', 'FEE', 3)]).find((l) => l.category === 'Fee');
  check('the Fee line: gross 3, refunds 3, net 0 (was gross 6 net 6)', fees?.gross === 3 && fees.refunds === 3 && fees.net === 0, JSON.stringify(fees));

  // ── B. conservation ──────────────────────────────────────────────────────
  console.log('B. conservation over every flow kind');
  const population: Transaction[] = [
    tx('Income', 'INCOME', 6000),
    tx('Dining', 'SPENDING', -120.5), tx('Dining', 'SPENDING', -45), tx('Dining', 'REFUND', 20),
    tx('Shopping', 'SPENDING', -692.97), tx('Shopping', 'REFUND', 900),                     // refund exceeds charges
    tx('Fee', 'FEE', -5), tx('Fee', 'FEE', 5),                                               // rebate
    tx('Interest', 'INTEREST', -61.2), tx('Interest', 'INTEREST', 0.35),                    // reversal
    tx('Payment', 'SPENDING', -80),                                                          // vetoed purchase (CCPAY-2B)
    tx('Transfer', 'SPENDING', -30),                                                         // CF-4 charge
    tx('Payment', 'DEBT_PAYMENT', -800), tx('Transfer', 'TRANSFER', -1000), tx('Shopping', 'TRANSFER', -60),
    tx('Buy', 'INVESTMENT', -500), tx('Other', 'UNKNOWN', 40), tx('Other', 'ADJUSTMENT', -7),
  ];
  const ledger = categorySpendLedger(population);
  const head = economicTotals(population);
  const sum = (k: 'gross' | 'refunds' | 'net' | 'refundsUnapplied') => ledger.reduce((n, l) => n + l[k], 0);
  check('Σ gross − Σ refunds === Σ net − Σ refundsUnapplied',
    approx(sum('gross') - sum('refunds'), sum('net') - sum('refundsUnapplied')));
  check('…=== the headline spendGross − refunds (lines reconcile with the headline BY CONSTRUCTION)',
    approx(sum('gross'), head.spendGross) && approx(sum('refunds'), head.refunds),
    `lines ${sum('gross')}/${sum('refunds')} vs head ${head.spendGross}/${head.refunds}`);
  check('Σ net − Σ refundsUnapplied === the headline spend when that is ≥ 0',
    approx(sum('net') - sum('refundsUnapplied'), head.spend));
  const shop = ledger.find((l) => l.category === 'Shopping')!;
  check('a line never costs less than nothing; the excess is disclosed as refundsUnapplied',
    shop.net === 0 && approx(shop.refundsUnapplied, 900 - 692.97));

  // ── C. membership ────────────────────────────────────────────────────────
  console.log('C. membership and line keys');
  check('a TRANSFER-flow row labelled Shopping never enters Shopping', approx(shop.gross, 692.97));
  check('no Payment / Transfer / Income / Buy spending line exists',
    !ledger.some((l) => ['Payment', 'Transfer', 'Income', 'Buy'].includes(l.category)));
  const other = ledger.find((l) => l.category === 'Other')!;
  check('spending rows carrying a structural label land on Other (80 + 30)', approx(other.gross, 110), JSON.stringify(other));
  check('…and residue (UNKNOWN / ADJUSTMENT) never does', other.count === 2);
  check('spendCategoryKey keeps spending labels and files structural ones under Other',
    spendCategoryKey('Dining') === 'Dining' && spendCategoryKey('Payment') === 'Other' && spendCategoryKey('Transfer') === 'Other'
      && spendCategoryKey(null) === 'Other');
  const cardCredit = classifyFlow({ category: 'Travel', amount: 250, accountType: 'debt', pfcPrimary: 'INCOME', pfcDetailed: 'INCOME_OTHER_INCOME' } as never);
  check('REFUND INVARIANT: a card credit is never income — it is a refund', cardCredit.flowType !== 'INCOME',
    `got ${cardCredit.flowType}`);
  const cc: EconomicAccumulator = { income: 0, spendGross: 0, refunds: 0 };
  foldEconomicRow(cc, { flowType: cardCredit.flowType, amount: 250 });
  check('…and it never folds into income', cc.income === 0);
  check('the ledger records every folded row id once (drill-down ≡ total)',
    ledger.reduce((n, l) => n + l.transactionIds.length, 0) === ledger.reduce((n, l) => n + l.count, 0));

  // ── D. UI ↔ AI parity ────────────────────────────────────────────────────
  console.log('D. UI ledger ≡ AI assembler lines');
  const { buildMonthlyBreakdown } = await import('@/lib/ai/assemblers/transactions');
  const aiRows = population.map((r) => ({ id: r.id, date: new Date(`${r.date}T12:00:00Z`), amount: r.amount,
    currency: 'USD', category: r.category as TransactionCategory, flowType: r.flowType as never }));
  const [june] = buildMonthlyBreakdown(aiRows, [], '2026-06-01', '2026-06-30', null);
  for (const l of ledger) {
    const ai = june.byCategory.find((c) => c.category === l.category);
    check(`${l.category}: AI gross ${ai?.total} / refunds ${ai?.refundTotal ?? 0} / net ${ai?.netTotal ?? ai?.total} ≡ UI ${l.gross} / ${l.refunds} / ${l.net}`,
      ai !== undefined && approx(ai.total, l.gross) && approx(ai.refundTotal ?? 0, l.refunds) && approx(ai.netTotal ?? ai.total, l.net));
  }
  check('the AI emits no line the UI does not', june.byCategory.every((c) => ledger.some((l) => l.category === c.category)));
  check('AI Σ line gross === expenseTotal, Σ line credits === refundTotal (exact reconciliation)',
    approx(june.byCategory.reduce((n, c) => n + c.total, 0), june.expenseTotal)
      && approx(june.byCategory.reduce((n, c) => n + (c.refundTotal ?? 0), 0), june.refundTotal));
  check('AI expenseTotal / refundTotal ≡ the UI headline', approx(june.expenseTotal, head.spendGross) && approx(june.refundTotal, head.refunds));

  // ── E. vocabulary ────────────────────────────────────────────────────────
  console.log('E. one vocabulary');
  check('every TransactionCategory is classified', Object.values(TransactionCategory).every((c) => categoryDefinition(c) !== null)
    && Object.keys(CATEGORY_VOCABULARY).length === Object.values(TransactionCategory).length);
  const PFC_PRIMARIES = ['INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS', 'BANK_FEES', 'ENTERTAINMENT',
    'FOOD_AND_DRINK', 'GENERAL_MERCHANDISE', 'HOME_IMPROVEMENT', 'MEDICAL', 'PERSONAL_CARE', 'GENERAL_SERVICES',
    'GOVERNMENT_AND_NON_PROFIT', 'TRANSPORTATION', 'TRAVEL', 'RENT_AND_UTILITIES', 'OTHER'];
  const produced = new Set<string>();
  for (const primary of PFC_PRIMARIES) {
    for (const detailed of [`${primary}_OTHER`, `${primary}_GROCERIES`, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'BANK_FEES_INTEREST_CHARGE']) {
      produced.add(mapPlaidCategory({ personal_finance_category: { primary, detailed }, merchant_name: null, name: 'x' } as never));
    }
  }
  for (const m of ['Netflix', 'Spotify', 'Uber', 'Amazon', 'Starbucks', 'Careem', 'Noon', 'Apple']) {
    produced.add(mapPlaidCategory({ personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'x' }, merchant_name: m, name: m } as never));
  }
  check('bank sync never produces an UNSUPPORTED category (groceries → Dining; medical → Other)',
    [...produced].every((c) => categoryDefinition(c)?.observability !== 'UNSUPPORTED'), [...produced].join(','));
  check('Plaid FOOD_AND_DRINK_GROCERIES maps to Dining — and the vocabulary SAYS Dining holds groceries',
    mapPlaidCategory({ personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' }, merchant_name: null, name: 'Whole Foods' } as never) === 'Dining'
      && /groceries/i.test(CATEGORY_VOCABULARY.Dining.meaning));
  check('every measurable category is one bank sync can actually produce',
    MEASURABLE_SPEND_CATEGORIES.every((c) => produced.has(c)), MEASURABLE_SPEND_CATEGORIES.filter((c) => !produced.has(c)).join(','));
  check('the unsupported set is exactly the categories nothing in bank sync writes',
    ['Groceries', 'Medical', 'Entertainment', 'Transport', 'PersonalCare', 'Services', 'Education'].every((c) => UNSUPPORTED_SPEND_CATEGORIES.includes(c))
      && UNSUPPORTED_SPEND_CATEGORIES.length === 7);

  // S1-0 — measurable is necessary, never sufficient, for a spending change.
  check('Interest is measurable but NOT transformable — its future belongs to the debt it is charged on',
    MEASURABLE_SPEND_CATEGORIES.includes('Interest') && !isTransformableSpendCategory('Interest')
      && /debt/.test(categoryDefinition('Interest')!.governedBy ?? ''));
  check('the transformable set is exactly the measurable set less Interest',
    JSON.stringify([...TRANSFORMABLE_SPEND_CATEGORIES].sort())
      === JSON.stringify(['Dining', 'Fee', 'Other', 'Shopping', 'Subscriptions', 'Travel', 'Utilities']),
    TRANSFORMABLE_SPEND_CATEGORIES.join(','));
  check('nothing unsupported or structural is transformable',
    [...UNSUPPORTED_SPEND_CATEGORIES, 'Income', 'Transfer', 'Payment', 'Buy', 'Sell', 'Dividend', 'Split']
      .every((c) => !isTransformableSpendCategory(c)));

  // ── F. unsupported ≠ measured zero ───────────────────────────────────────
  console.log('F. measure_flows refuses what the ledger cannot identify');
  check('Groceries resolves to an UNSUPPORTED refusal naming where groceries are',
    ((r) => !r.ok && r.reason === 'UNSUPPORTED' && /Dining/.test(r.unavailable))(resolveSpendCategory('groceries')));
  check('Payment resolves to NOT_SPENDING', ((r) => !r.ok && r.reason === 'NOT_SPENDING')(resolveSpendCategory('Payment')));
  check('Dining resolves, DERIVED, with its meaning', ((r) => r.ok && r.observability === 'DERIVED' && /groceries/.test(r.meaning))(resolveSpendCategory('dining')));
  const { findTool } = await import('@/lib/ai/conversation/tools');
  const mf = findTool('measure_flows')!;
  const ctx = { asOfISO: '2026-09-21', spaceId: 's', spaceCtx: {} } as never;
  for (const category of ['Groceries', 'Medical', 'Transport', 'Entertainment', 'Payment', 'Transfer', 'Income']) {
    const r = await mf.run({ measure: 'spending', period: { completeMonths: 3 }, category }, ctx) as Record<string, unknown>;
    check(`measure_flows(${category}) is REFUSED, not $0.00`, typeof r.unavailable === 'string' && r.total === undefined, JSON.stringify(r).slice(0, 160));
  }
  const desc = JSON.stringify(mf.parameters);
  check('measure_flows advertises every measurable category and states the meanings',
    MEASURABLE_SPEND_CATEGORIES.every((c) => desc.includes(c)) && /Dining includes groceries/.test(desc));
  check('…and names the unsupported ones only as NOT tracked',
    /Groceries, Medical, Entertainment, Transport, PersonalCare, Services, Education are NOT tracked/.test(desc));

  // ── G. liquidity agrees ──────────────────────────────────────────────────
  console.log('G. liquidity axis');
  const { classifyLiquidity } = await import('@/lib/transactions/liquidity');
  const liq = { tierOf: () => 'liquid' } as never;
  const rebate = classifyLiquidity({ ...tx('Fee', 'FEE', 5), amount: 5 } as never, liq);
  check('a fee rebate into checking is Cash In (REFUND), never Cash Out', rebate.effect === 'CASH_IN' && rebate.reason === 'REFUND', JSON.stringify(rebate));
  const fee = classifyLiquidity({ ...tx('Fee', 'FEE', -5) } as never, liq);
  check('…while the fee itself stays Cash Out (REAL_COST)', fee.effect === 'CASH_OUT' && fee.reason === 'REAL_COST');

  // ledger helper exported for S1 inherits the same rules on hand-built rows
  const direct: CategoryLedgerRow[] = [{ category: 'Groceries', flowType: 'SPENDING', amount: -10 }];
  check('a CSV-labelled Groceries row is still a (visible) line — the refusal is the MEASURE, not the data',
    foldCategorySpend(direct)[0]?.category === 'Groceries');

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall category-spend authority checks passed');
  process.exit(0);
}

main().catch((e) => { console.error('  ✗ crashed:', e instanceof Error ? e.stack : String(e)); process.exit(1); });
