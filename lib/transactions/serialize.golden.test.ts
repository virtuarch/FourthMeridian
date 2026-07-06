/**
 * lib/transactions/serialize.golden.test.ts
 *
 * TI-1 golden test — proves the canonical serializers
 * (lib/transactions/serialize.ts) produce BYTE-IDENTICAL output to the
 * inline row→DTO mappings they replaced in lib/data/transactions.ts.
 *
 * The legacy mappers below are copied VERBATIM from the pre-TI-1
 * lib/data/transactions.ts (getTransactions/getDebtTransactions shared one
 * shape; getInvestmentTransactions the other). They are frozen here as the
 * reference implementation: if the serializer ever diverges — a field
 * added/removed/reordered, a fallback changed — the JSON comparison fails.
 * Deliberate future extensions must update this reference consciously.
 *
 * Also pins the ONE deliberate behavior change TI-1 made: the account-modal
 * route (app/api/accounts/[id]/transactions) previously omitted `currency`
 * (drift); it now serializes through the shared serializer, so its payload
 * gains `currency`. That is asserted here as intentional.
 *
 * Standalone tsx script (house convention — no test framework):
 *     npx tsx lib/transactions/serialize.golden.test.ts
 * Exits 0 on pass, 1 on failure.
 */

import {
  serializeTransactionRow,
  serializeInvestmentTransactionRow,
  type TransactionRowLike,
} from './serialize';

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Legacy reference mappers — copied VERBATIM from pre-TI-1
// lib/data/transactions.ts. Do not "improve" these; they are the golden
// reference.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function legacyListMapper(r: any) {
  return {
    id:          r.id,
    accountId:   r.accountId ?? r.financialAccountId,
    date:        r.date.toISOString().split("T")[0],
    merchant:    r.merchant,
    description: r.description ?? undefined,
    category:    r.category,
    amount:      r.amount,
    pending:     r.pending,
    currency:    r.currency ?? null,
    flowType:                 r.flowType ?? null,
    flowDirection:            r.flowDirection ?? null,
    classificationConfidence: r.classificationConfidence ?? null,
    classificationReason:     r.classificationReason ?? null,
    classifierVersion:        r.classifierVersion ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function legacyInvestmentMapper(r: any) {
  return {
    id:          r.id,
    accountId:   r.accountId ?? r.financialAccountId,
    date:        r.date.toISOString().split("T")[0],
    ticker:      r.merchant,
    description: r.description ?? "",
    category:    r.category,
    amount:      r.amount,
  };
}

// ---------------------------------------------------------------------------
// Fixtures — every branch of every fallback: legacy vs canonical FK, null vs
// present description/currency/flow fields, pending, negative amounts.
// ---------------------------------------------------------------------------

const fixtures: TransactionRowLike[] = [
  // Fully-populated canonical (Plaid-synced) row.
  {
    id: 'tx_full',
    accountId: null,
    financialAccountId: 'fa_1',
    date: new Date('2026-06-14T00:00:00.000Z'),
    merchant: 'Blue Bottle Coffee',
    description: 'SQ *BLUE BOTTLE #442',
    category: 'Dining',
    amount: -15.33,
    pending: false,
    currency: 'USD',
    flowType: 'SPENDING',
    flowDirection: 'OUTFLOW',
    classificationConfidence: 0.95,
    classificationReason: 'PLAID_PFC_DETAILED',
    classifierVersion: 1,
  },
  // Legacy-FK row, null-heavy (pre-provenance residue).
  {
    id: 'tx_legacy_nulls',
    accountId: 'acct_legacy',
    financialAccountId: null,
    date: new Date('2024-01-02T00:00:00.000Z'),
    merchant: 'PAYROLL DEPOSIT',
    description: null,
    category: 'Income',
    amount: 2500,
    pending: false,
    currency: null,
    flowType: null,
    flowDirection: null,
    classificationConfidence: null,
    classificationReason: null,
    classifierVersion: null,
  },
  // Pending row with undefined optional fields (fields absent entirely —
  // exercises the `??` fallbacks the same way a narrow Prisma select would).
  {
    id: 'tx_pending_sparse',
    accountId: null,
    financialAccountId: 'fa_2',
    date: new Date('2026-07-05T00:00:00.000Z'),
    merchant: 'UBER *TRIP',
    description: 'UBER *TRIP HELP.UBER.COM',
    category: 'Travel',
    amount: -42.9,
    pending: true,
  },
  // Non-USD stamped row (MC1) with a refund flow.
  {
    id: 'tx_sar_refund',
    accountId: null,
    financialAccountId: 'fa_3',
    date: new Date('2026-05-30T00:00:00.000Z'),
    merchant: 'Careem',
    description: null,
    category: 'Travel',
    amount: 57.5,
    pending: false,
    currency: 'SAR',
    flowType: 'REFUND',
    flowDirection: 'INFLOW',
    classificationConfidence: 0.5,
    classificationReason: 'SIGN_DEFAULT_INFLOW',
    classifierVersion: 1,
  },
];

const investmentFixtures: TransactionRowLike[] = [
  // Buy with description.
  {
    id: 'tx_buy',
    accountId: null,
    financialAccountId: 'fa_inv',
    date: new Date('2026-03-10T00:00:00.000Z'),
    merchant: 'VOO',
    description: 'BUY 2.5 VANGUARD S&P 500 ETF',
    category: 'Buy',
    amount: -1250.75,
    pending: false,
  },
  // Dividend with null description (exercises the `?? ""` branch).
  {
    id: 'tx_div',
    accountId: 'acct_legacy_inv',
    financialAccountId: null,
    date: new Date('2026-04-01T00:00:00.000Z'),
    merchant: 'SCHD',
    description: null,
    category: 'Dividend',
    amount: 88.12,
    pending: false,
  },
];

// ---------------------------------------------------------------------------
// 1. Byte-identity — banking/debt list shape
// ---------------------------------------------------------------------------

for (const f of fixtures) {
  const legacy = JSON.stringify(legacyListMapper(f));
  const canon  = JSON.stringify(serializeTransactionRow(f));
  check(
    `list serialization byte-identical: ${f.id}`,
    legacy === canon,
    `legacy: ${legacy}\n        canon:  ${canon}`,
  );
}

// Array-level check too (the actual shape callers JSON-serialize).
check(
  'list serialization byte-identical over the full fixture array',
  JSON.stringify(fixtures.map(legacyListMapper)) ===
    JSON.stringify(fixtures.map(serializeTransactionRow)),
);

// ---------------------------------------------------------------------------
// 2. Byte-identity — investment list shape
// ---------------------------------------------------------------------------

for (const f of investmentFixtures) {
  const legacy = JSON.stringify(legacyInvestmentMapper(f));
  const canon  = JSON.stringify(serializeInvestmentTransactionRow(f));
  check(
    `investment serialization byte-identical: ${f.id}`,
    legacy === canon,
    `legacy: ${legacy}\n        canon:  ${canon}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Semantics pins — the fallbacks the mappings rely on
// ---------------------------------------------------------------------------

const full = serializeTransactionRow(fixtures[0]);
check('accountId normalizes to financialAccountId when legacy FK is null',
  full.accountId === 'fa_1');
check('date renders as YYYY-MM-DD', full.date === '2026-06-14');

const legacyRow = serializeTransactionRow(fixtures[1]);
check('accountId prefers the legacy FK when set', legacyRow.accountId === 'acct_legacy');
check('null description → undefined (key omitted from JSON)',
  legacyRow.description === undefined &&
    !Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(legacyRow)), 'description'));
check('null currency → null (key PRESENT in JSON as null)',
  legacyRow.currency === null &&
    Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(legacyRow)), 'currency'));

const sparse = serializeTransactionRow(fixtures[2]);
check('absent optional fields → null flow metadata (not undefined)',
  sparse.flowType === null && sparse.flowDirection === null &&
    sparse.classificationConfidence === null && sparse.classifierVersion === null);

const div = serializeInvestmentTransactionRow(investmentFixtures[1]);
check('investment null description → empty string (not undefined)',
  div.description === '');
check('investment ticker sourced from merchant column', div.ticker === 'SCHD');

// ---------------------------------------------------------------------------
// 4. The deliberate drift FIX — account-modal payload gains `currency`
// ---------------------------------------------------------------------------

// The pre-TI-1 account-modal route mapping omitted `currency`. The shared
// serializer includes it. This is the one intentional payload change of the
// extraction; pin it so it reads as a decision, not an accident.
check(
  'serializer output includes `currency` (the account-modal drift fix)',
  Object.prototype.hasOwnProperty.call(
    JSON.parse(JSON.stringify(serializeTransactionRow(fixtures[0]))), 'currency'),
);

// ---------------------------------------------------------------------------

console.log('');
if (failures === 0) {
  console.log('All TI-1 serializer golden cases passed.');
  process.exit(0);
} else {
  console.log(`${failures} failure(s).`);
  process.exit(1);
}
