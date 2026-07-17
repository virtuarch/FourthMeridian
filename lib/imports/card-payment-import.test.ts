/**
 * lib/imports/card-payment-import.test.ts
 *
 * CCPAY-2C-4 — proves FILE IMPORTS participate in the ONE card-payment rescue.
 *
 * Before this slice the rescue existed only on the Plaid sync seam, so a
 * CSV-imported card-payment leg persisted as category=Other → flowType=REFUND.
 * Unlike a Plaid row it is never re-synced, so it stayed wrong permanently.
 *
 * This drives the REAL chain, not a reproduction of it:
 *
 *   CSV text → parseCsvText → detectColumns → normalizeRow   (lib/imports/csv.ts)
 *            → resolveLiabilityPaymentCategory                (the shared authority)
 *            → classifyFlow                                   (the canonical classifier)
 *
 * The only piece not exercised here is the route's DB plumbing; the route calls
 * exactly this sequence with exactly these arguments (see the CCPAY-2C-4 comment
 * at app/api/accounts/[id]/import/route.ts, and the same call in preview/route.ts).
 * The precedent for testing this route's DB-bound logic through its pure parts is
 * lib/imports/transaction-facts-import.test.ts.
 *
 *     npx tsx --test lib/imports/card-payment-import.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsvText, detectColumns, normalizeRow, type CsvColumnMap } from './csv';
import { resolveLiabilityPaymentCategory } from '../transactions/liability-payment';
import { classifyFlow } from '../transactions/flow-classifier';

const CARD = { accountType: 'debt', debtSubtype: null };
const CHECKING = { accountType: 'checking', debtSubtype: null };

/** The exact sequence both import routes run per row. */
function importRow(csv: string, acct: { accountType: string; debtSubtype: string | null }) {
  const parsed = parseCsvText(csv);
  const columns = detectColumns(parsed.headers);
  assert.ok(!('error' in columns), `column detection failed: ${JSON.stringify(columns)}`);
  const row = normalizeRow(parsed.rows[0], columns as CsvColumnMap, 'creditPositive', 1);
  const category = resolveLiabilityPaymentCategory(row.category, 'Payment', {
    ...acct,
    amount:      row.amount as number,
    merchant:    row.merchant,
    description: row.description,
  });
  // The classifier is descriptor-blind (CCPAY-2C-5): the descriptor's role is
  // already spent above, in resolveLiabilityPaymentCategory. Files carry no
  // provider taxonomy either, so category + sign + account tier is genuinely all
  // the flow layer gets from an import.
  const flow = classifyFlow({
    category,
    amount:      row.amount as number,
    accountType: acct.accountType,
    debtSubtype: acct.debtSubtype,
    pfcPrimary:  null,
    pfcDetailed: null,
  });
  return { row, category, flow };
}

// ── The defect this slice fixes ──────────────────────────────────────────────

test('a card-payment leg imported from CSV becomes DEBT_PAYMENT, not REFUND', () => {
  const { row, category, flow } = importRow(
    `Date,Description,Amount\n2026-07-16,PAYMENT-THANK YOU,5000.00\n`, CARD);
  // The importer itself has no idea what this is — no Category column exists.
  assert.equal(row.category, 'Other', 'precondition: mapCategory yields Other');
  assert.equal(row.amount, 5000);
  // The rescue supplies the missing meaning.
  assert.equal(category, 'Payment');
  assert.equal(flow.flowType, 'DEBT_PAYMENT');
  assert.equal(flow.flowDirection, 'INFLOW');
});

test('the same leg WITHOUT the rescue would be REFUND (the bug, pinned)', () => {
  const parsed = parseCsvText(`Date,Description,Amount\n2026-07-16,PAYMENT-THANK YOU,5000.00\n`);
  const columns = detectColumns(parsed.headers) as CsvColumnMap;
  const row = normalizeRow(parsed.rows[0], columns, 'creditPositive', 1);
  // Feeding the RAW category straight to the classifier — the pre-2C-4 behavior.
  const unrescued = classifyFlow({ category: row.category, amount: row.amount as number, accountType: 'debt' });
  assert.equal(unrescued.flowType, 'REFUND',
    'if this is no longer REFUND the rescue is being applied somewhere unexpected');
});

// ── Descriptor format invariance, through the real parser ────────────────────

for (const descriptor of [
  'PAYMENT-THANK YOU',           // Chase pending (real)
  'Payment Thank You-Mobile',    // Chase posted (real)
  'MOBILE PAYMENT - THANK YOU',  // Amex posted (real)
  'PAYMENT.THANK.YOU',
  'PAYMENT_THANK_YOU',
  'PAYMENT THANK YOU',
]) {
  test(`CSV descriptor variant is rescued: ${descriptor}`, () => {
    const { category, flow } = importRow(
      `Date,Description,Amount\n2026-07-16,${descriptor},1200.00\n`, CARD);
    assert.equal(category, 'Payment');
    assert.equal(flow.flowType, 'DEBT_PAYMENT');
  });
}

// ── CSV descriptor SHAPES (the two column layouts csv.ts can produce) ────────

test('Payee-only file: descriptor lands in merchant, description is null — still rescued', () => {
  const { row, category, flow } = importRow(
    `Date,Payee,Amount\n2026-07-16,PAYMENT-THANK YOU,5000.00\n`, CARD);
  assert.equal(row.merchant, 'PAYMENT-THANK YOU');
  assert.equal(row.description, null, 'precondition: a Payee-only file leaves description null');
  assert.equal(category, 'Payment');
  assert.equal(flow.flowType, 'DEBT_PAYMENT');
});

test('Description-only file: csv.ts duplicates the value into both fields — still rescued', () => {
  const { row, category } = importRow(
    `Date,Description,Amount\n2026-07-16,PAYMENT-THANK YOU,5000.00\n`, CARD);
  assert.equal(row.merchant, row.description, 'precondition: csv.ts:473-474 duplicates');
  assert.equal(category, 'Payment');
});

test('Merchant + Description file: descriptor only in description is still found', () => {
  // The enrichment shape: a clean merchant with the raw descriptor beside it.
  const { row, category, flow } = importRow(
    `Date,Merchant,Description,Amount\n2026-07-16,Chase Card Services,PAYMENT-THANK YOU,5000.00\n`, CARD);
  assert.equal(row.merchant, 'Chase Card Services');
  assert.equal(row.description, 'PAYMENT-THANK YOU');
  assert.equal(category, 'Payment', 'combined merchant+description evidence contract');
  assert.equal(flow.flowType, 'DEBT_PAYMENT');
});

// ── Debit/Credit column pair — the sign convention that matters most ─────────

test('Debit/Credit pair: a payment in the Credit column is positive and rescued', () => {
  const { row, category, flow } = importRow(
    `Date,Description,Debit,Credit\n2026-07-16,PAYMENT-THANK YOU,,5000.00\n`, CARD);
  assert.equal(row.amount, 5000, 'credit − debit ⇒ positive');
  assert.equal(category, 'Payment');
  assert.equal(flow.flowType, 'DEBT_PAYMENT');
});

test('Debit/Credit pair: a card PURCHASE is negative and never rescued', () => {
  const { row, category, flow } = importRow(
    `Date,Description,Debit,Credit\n2026-07-16,Whole Foods,88.40,\n`, CARD);
  assert.equal(row.amount, -88.4);
  assert.equal(category, 'Other');
  assert.equal(flow.flowType, 'SPENDING');
});

test('a wrong signConvention causes a MISS, never a false DEBT_PAYMENT', () => {
  // debitPositive negates the column: the payment credit arrives as -5000.
  const parsed = parseCsvText(`Date,Description,Amount\n2026-07-16,PAYMENT-THANK YOU,5000.00\n`);
  const columns = detectColumns(parsed.headers) as CsvColumnMap;
  const row = normalizeRow(parsed.rows[0], columns, 'debitPositive', 1);
  assert.equal(row.amount, -5000);
  const category = resolveLiabilityPaymentCategory(row.category, 'Payment', {
    ...CARD, amount: row.amount as number, merchant: row.merchant, description: row.description,
  });
  assert.equal(category, 'Other', 'the liability+inflow guard rejects it — a miss, not a false payment');
});

// ── Guards reach the import path ─────────────────────────────────────────────

test('the same descriptor on a DEPOSITORY account is never rescued', () => {
  const { category, flow } = importRow(
    `Date,Description,Amount\n2026-07-16,PAYMENT-THANK YOU,5000.00\n`, CHECKING);
  assert.equal(category, 'Other');
  assert.notEqual(flow.flowType, 'DEBT_PAYMENT');
});

test('real refunds/credits on a liability inflow are NOT rescued', () => {
  // Real rows from the live corpus — positive, on a card, and not payments.
  for (const [merchant, amount] of [
    ['Amazon SA', '49.01'], ['POINTS FOR AMEX TRVL', '684.46'],
    ['TSA Global Entry Fee Credit', '120.00'], ['AplPay TARGET', '108.89'],
  ] as const) {
    const { category } = importRow(`Date,Description,Amount\n2026-07-16,${merchant},${amount}\n`, CARD);
    assert.equal(category, 'Other', `${merchant} must not be rescued`);
  }
});

test('a decided Category column is never overwritten (rescue-only)', () => {
  // Even with a payment descriptor on a liability inflow, an explicit category wins.
  const { row, category } = importRow(
    `Date,Description,Amount,Category\n2026-07-16,PAYMENT-THANK YOU,5000.00,Travel\n`, CARD);
  assert.equal(row.category, 'Travel', 'precondition: the file declared a category');
  assert.equal(category, 'Travel', 'rescue-only: it may only promote from Other');
});
