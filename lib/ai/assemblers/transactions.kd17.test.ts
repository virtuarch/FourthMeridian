/**
 * lib/ai/assemblers/transactions.kd17.test.ts
 *
 * KD-17 regression tests — category rollup sign asymmetry (pure, no DB).
 *
 * The project has no test runner (no jest/vitest). This file is a standalone,
 * dependency-free script runnable with the already-installed `tsx`, mirroring
 * lib/ai/assemblers/transactions.privacy.test.ts:
 *
 *     npx tsx lib/ai/assemblers/transactions.kd17.test.ts
 *
 * Run from the repo root (source tripwires resolve paths from cwd).
 * Exits 0 when all cases pass and 1 on failure.
 *
 * Defect under test (docs/investigations/KD17_TRANSACTION_LEVEL_PROOF.md):
 * category totals used |Σ signed amounts| while expenseTotal summed debit rows
 * only, so positive rows in a spending category (January 2026: four credit-card
 * payment credits totaling +$9,500 categorized `Other`) inflated the category
 * line ($6,529.45) above total monthly spending ($5,848.70), while the
 * drilldown reported a third figure ($2,970.55).
 *
 * Three layers of checks:
 *   1. Rollup behavior — buildMonthlyBreakdown emits debit-only category
 *      totals with separate credit disclosure (January 2026 shape and edge
 *      shapes reproduced synthetically).
 *   2. Invariant behavior — checkSpendingCategoryInvariant trips on the
 *      defect's arithmetic and stays silent on valid payloads.
 *   3. Source tripwires — the serializer actually calls the invariant, and no
 *      signed-net accumulation can silently return to either rollup site.
 *
 * NOTE: importing the assembler transitively constructs the Prisma client
 * (lib/db). No query is issued — tests are pure — but the generated client
 * for this platform must exist (`npx prisma generate`), same as `next dev`.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { TransactionCategory } from '@prisma/client';

import {
  buildMonthlyBreakdown,
  checkSpendingCategoryInvariant,
} from './transactions';
// FlowType P5 Slice 4: fixture rows carry flowType/flowDirection, derived by
// the REAL classifier (pure import) — the same values the P4 backfill wrote,
// so synthetic rows match production data exactly.
import { classifyFlow } from '../../transactions/flow-classifier';

// ---------------------------------------------------------------------------
// Tiny harness (mirrors transactions.privacy.test.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Row factory
// ---------------------------------------------------------------------------

type Row = {
  date:     Date;
  merchant: string;
  category: TransactionCategory;
  amount:   number;
  pending:  boolean;
  // FlowType P5 Slice 4 — mirrors the assembler's TxnRow.
  flowType:      ReturnType<typeof classifyFlow>['flowType'] | null;
  flowDirection: ReturnType<typeof classifyFlow>['flowDirection'] | null;
};

function row(
  day: number,
  category: TransactionCategory,
  amount: number,
  merchant = 'Test',
  // Optional account context forwarded to the classifier (e.g. a debt
  // account's destination-side payment leg).
  ctx?: { accountType?: string; debtSubtype?: string },
): Row {
  const c = classifyFlow({ category, amount, ...ctx });
  return {
    date: new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`),
    merchant,
    category,
    amount,
    pending: false,
    flowType:      c.flowType,
    flowDirection: c.flowDirection,
  };
}

const JAN = { startIso: '2026-01-01', endIso: '2026-01-31' };

function janBreakdown(rows: Row[]) {
  const months = buildMonthlyBreakdown(rows, [], JAN.startIso, JAN.endIso, null);
  const jan = months.find((m) => m.month === '2026-01');
  if (!jan) throw new Error('2026-01 bucket missing');
  return jan;
}

const NON_SPENDING = new Set(['Income', 'Interest', 'Transfer', 'Payment']);

// ---------------------------------------------------------------------------
// 1. January 2026 shape — the audited defect, reproduced synthetically
//    (figures from docs/investigations/kd17-audit-output.md)
// ---------------------------------------------------------------------------

const janRows: Row[] = [
  // Other: 40 audited debits condensed to the same sum, plus the four causal
  // payment credits verbatim.
  row(16, TransactionCategory.Other, -1081.25, 'Western Governors Un'),
  row(26, TransactionCategory.Other, -852.73,  'Gathern'),
  row(27, TransactionCategory.Other, -284.26,  'Gathern'),
  row(10, TransactionCategory.Other, -752.31,  'Misc debits remainder'),
  row(1,  TransactionCategory.Other, +1500.00, 'Payment Thank You-Mobile'),
  row(4,  TransactionCategory.Other, +3500.00, 'Payment Thank You-Mobile'),
  row(16, TransactionCategory.Other, +500.00,  'Payment Thank You-Mobile'),
  row(30, TransactionCategory.Other, +4000.00, 'Payment Thank You-Mobile'),
  // Shopping: debit/credit mix (understatement direction pre-fix).
  row(5,  TransactionCategory.Shopping, -1119.01),
  row(6,  TransactionCategory.Shopping, +23.95, 'Return'),
  // Dining, Utilities: plain debits.
  row(7,  TransactionCategory.Dining,    -756.70),
  row(8,  TransactionCategory.Utilities, -192.06),
  // Interest: charges are debits (inside expenseTotal, name-filtered from the
  // categories line) + a small credit.
  row(9,  TransactionCategory.Interest, -810.38),
  row(9,  TransactionCategory.Interest, +5.20),
  // Non-spending flows.
  row(15, TransactionCategory.Income,   +17902.60),
  row(15, TransactionCategory.Payment,  -14500.00),
  row(15, TransactionCategory.Payment,  +4000.00),
  row(15, TransactionCategory.Transfer, -10295.56),
  row(15, TransactionCategory.Transfer, +5500.00),
];

{
  const jan = janBreakdown(janRows);
  const other    = jan.byCategory.find((c) => c.category === 'Other');
  const shopping = jan.byCategory.find((c) => c.category === 'Shopping');

  check('Jan-2026 shape: expenseTotal is $5,848.70 (unchanged by the fix)',
    approx(jan.expenseTotal, 5848.70), `got ${jan.expenseTotal}`);

  check('Jan-2026 shape: Other total is debit-only $2,970.55 — NOT the netted $6,529.45',
    other !== undefined && approx(other.total, 2970.55), `got ${other?.total}`);

  check('Jan-2026 shape: Other credits disclosed as creditTotal $9,500.00, never netted',
    other !== undefined && approx(other.creditTotal ?? 0, 9500.00), `got ${other?.creditTotal}`);

  check('Jan-2026 shape: Other.count still counts all rows (debits + credits)',
    other?.count === 8, `got ${other?.count}`);

  // Drilldown agreement: assembleDrilldown aggregates Σ|amount| over amount<0
  // rows of the category — recompute that population independently and demand
  // equality with the monthly line. Pre-fix these were $2,970.55 vs $6,529.45.
  const drilldownEquivalent = janRows
    .filter((r) => r.category === TransactionCategory.Other && r.amount < 0)
    .reduce((s, r) => s + Math.abs(r.amount), 0);
  check('Jan-2026 shape: monthly Other equals the drilldown (debits-only) population',
    other !== undefined && approx(other.total, drilldownEquivalent),
    `monthly ${other?.total} vs drilldown ${drilldownEquivalent}`);

  check('Jan-2026 shape: Shopping is $1,119.01 (credit no longer understates it to $1,095.06)',
    shopping !== undefined && approx(shopping.total, 1119.01) && approx(shopping.creditTotal ?? 0, 23.95),
    `got ${shopping?.total} / ${shopping?.creditTotal}`);

  const spendingCats = jan.byCategory.filter((c) => !NON_SPENDING.has(c.category));
  check('Jan-2026 shape: invariant holds post-fix (Σ spending categories ≤ expenseTotal)',
    checkSpendingCategoryInvariant(spendingCats, jan.expenseTotal, NON_SPENDING, '2026-01') === null);

  check('Jan-2026 shape: no spending category exceeds expenseTotal',
    spendingCats.every((c) => c.total <= jan.expenseTotal + 0.01));

  // Money totals other than category lines must be untouched by KD-17.
  check('Jan-2026 shape: income/debt/transfer totals unchanged by the fix',
    approx(jan.incomeTotal, 17907.80) && approx(jan.debtPaymentTotal, 14500.00) &&
    approx(jan.transferTotal, 15795.56),
    `got ${jan.incomeTotal} / ${jan.debtPaymentTotal} / ${jan.transferTotal}`);
}

// ---------------------------------------------------------------------------
// 2. Net-positive category month (credits > debits) — the headline defect class
// ---------------------------------------------------------------------------

{
  const jan = janBreakdown([
    row(3,  TransactionCategory.Other,  -100.00),
    row(5,  TransactionCategory.Other,  +6629.45, 'Big misclassified credit'),
    row(10, TransactionCategory.Dining, -50.00),
  ]);
  const other = jan.byCategory.find((c) => c.category === 'Other');
  check('Net-positive month: Other total is $100.00 (debits), not |net| $6,529.45',
    other !== undefined && approx(other.total, 100.00), `got ${other?.total}`);
  check('Net-positive month: credit carried in creditTotal ($6,629.45)',
    other !== undefined && approx(other.creditTotal ?? 0, 6629.45), `got ${other?.creditTotal}`);
  check('Net-positive month: expenseTotal counts debits only ($150.00)',
    approx(jan.expenseTotal, 150.00), `got ${jan.expenseTotal}`);
  const spendingCats = jan.byCategory.filter((c) => !NON_SPENDING.has(c.category));
  check('Net-positive month: invariant holds',
    checkSpendingCategoryInvariant(spendingCats, jan.expenseTotal, NON_SPENDING, '2026-01') === null);
}

// ---------------------------------------------------------------------------
// 3. Pure-credit category month (refund-only) — dropped, never phantom spending
// ---------------------------------------------------------------------------

{
  const jan = janBreakdown([
    row(3, TransactionCategory.Travel, +250.00, 'Airline refund'),
    row(4, TransactionCategory.Dining, -40.00),
  ]);
  check('Pure-credit month: refund-only Travel is DROPPED from byCategory (no phantom $250 spending)',
    jan.byCategory.find((c) => c.category === 'Travel') === undefined);
  check('Pure-credit month: expenseTotal unaffected by the credit ($40.00)',
    approx(jan.expenseTotal, 40.00), `got ${jan.expenseTotal}`);
}

// ---------------------------------------------------------------------------
// 4. Invariant behavior on hand-built payloads
// ---------------------------------------------------------------------------

{
  // The literal pre-fix January payload: Other 6529.45 vs expenseTotal 5848.70.
  const violation = checkSpendingCategoryInvariant(
    [{ category: 'Other', total: 6529.45 }],
    5848.70, NON_SPENDING, '2026-01',
  );
  check('Invariant: trips on the pre-fix January arithmetic',
    violation !== null && approx(violation.excess, 680.75) &&
    violation.scope === '2026-01',
    `got ${JSON.stringify(violation)}`);

  check('Invariant: silent at exact equality',
    checkSpendingCategoryInvariant(
      [{ category: 'Dining', total: 100 }, { category: 'Other', total: 50 }],
      150, NON_SPENDING, 'window') === null);

  check('Invariant: silent within one-cent tolerance',
    checkSpendingCategoryInvariant(
      [{ category: 'Dining', total: 100.01 }], 100.00, NON_SPENDING, 'window') === null);

  check('Invariant: trips just past tolerance',
    checkSpendingCategoryInvariant(
      [{ category: 'Dining', total: 100.02 }], 100.00, NON_SPENDING, 'window') !== null);

  check('Invariant: ignores non-spending categories by name',
    checkSpendingCategoryInvariant(
      [{ category: 'Income', total: 999999 }, { category: 'Dining', total: 10 }],
      10, NON_SPENDING, 'window') === null);
}

// ---------------------------------------------------------------------------
// 5. Source tripwires — the fix cannot silently regress
// ---------------------------------------------------------------------------

{
  const assemblerSrc = readFileSync(join(process.cwd(), 'lib/ai/assemblers/transactions.ts'), 'utf8');
  const routeSrc     = readFileSync(join(process.cwd(), 'app/api/ai/chat/route.ts'), 'utf8');

  check('Tripwire: no signed-net accumulation remains in the assembler',
    !/agg\.signed|Math\.abs\(signed\)|\{ signed: 0/.test(assemblerSrc),
    'a signed accumulator reappeared — the KD-17 defect class');

  check('Tripwire: both rollup sites aggregate debitTotal/creditTotal',
    (assemblerSrc.match(/debitTotal: 0, creditTotal: 0/g) ?? []).length >= 2);

  check('Tripwire: window-level byCategory keeps zero-total entries (annotations reads Income count)',
    /Zero-total entries are intentionally KEPT/.test(assemblerSrc));

  check('Tripwire: serializer calls the checked invariant for monthly AND window scopes',
    (routeSrc.match(/checkSpendingCategoryInvariant\(/g) ?? []).length >= 2);

  check('Tripwire: serializer fails loud outside production on violation',
    /NODE_ENV !== 'production'\) throw new Error\(msg\)/.test(routeSrc));

  check('Tripwire: drilldown still aggregates the debits-only population (lt: 0)',
    /amount: \{ lt: 0 \}/.test(assemblerSrc));
}

// ---------------------------------------------------------------------------
// 6. FlowType P5 Slice 4 — flow partition cases (D-1..D-4)
// ---------------------------------------------------------------------------

{
  const jan = janBreakdown([
    // D-1: rows the legacy category filter could never see.
    row(5,  TransactionCategory.Dividend, +120.50, 'Vanguard'),        // → INCOME
    row(6,  TransactionCategory.Fee,      -35.00,  'Wire fee'),        // → FEE
    // Existing banking flows.
    row(7,  TransactionCategory.Dining,   -60.00),                     // → SPENDING
    row(8,  TransactionCategory.Shopping, +25.00,  'Return'),          // → REFUND
    row(11, TransactionCategory.Interest, -12.34,  'Interest charge'), // → INTEREST
    // Both legs of a card payment: source (negative) + destination (positive
    // INFLOW on a credit-card account) — only the source leg may count.
    row(10, TransactionCategory.Payment,  -300.00, 'Card payment'),
    row(9,  TransactionCategory.Payment,  +300.00, 'Card payment',
        { accountType: 'debt', debtSubtype: 'credit_card' }),
  ]);

  check('Slice 4: dividend counts as income — and ONLY the dividend (refund is not income)',
    approx(jan.incomeTotal, 120.50), `got ${jan.incomeTotal}`);

  check('Slice 4: expenseTotal = SPENDING + FEE + INTEREST gross (60 + 35 + 12.34)',
    approx(jan.expenseTotal, 107.34), `got ${jan.expenseTotal}`);

  check('Slice 4: refund disclosed in refundTotal, never netted into expenseTotal',
    approx(jan.refundTotal, 25.00), `got ${jan.refundTotal}`);

  check('Slice 4: destination-side DEBT_PAYMENT inflow leg excluded (no double count)',
    approx(jan.debtPaymentTotal, 300.00), `got ${jan.debtPaymentTotal}`);

  check('Slice 4: Fee appears in byCategory as a debit line',
    approx(jan.byCategory.find((c) => c.category === 'Fee')?.total ?? 0, 35.00));

  check('Slice 4: credit-only Dividend month is dropped from monthly byCategory (no phantom spend)',
    jan.byCategory.find((c) => c.category === 'Dividend') === undefined);

  const spendingCats = jan.byCategory.filter((c) => !NON_SPENDING.has(c.category));
  check('Slice 4: KD-17 invariant holds under the flow partition',
    checkSpendingCategoryInvariant(spendingCats, jan.expenseTotal, NON_SPENDING, '2026-01') === null);
}

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} KD-17 case(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll KD-17 rollup/invariant/tripwire cases passed.');
