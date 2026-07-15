/**
 * lib/transactions/serialize.golden.test.ts
 *
 * TI-1 golden test — proves the canonical serializers
 * (lib/transactions/serialize.ts) produce BYTE-IDENTICAL output to the
 * inline row→DTO mappings they replaced in lib/data/transactions.ts.
 *
 * The reference mappers below mirror the row→DTO mappings in
 * lib/data/transactions.ts (getTransactions/getDebtTransactions shared one
 * shape; getInvestmentTransactions the other). They are frozen here as the
 * reference implementation: if the serializer ever diverges — a field
 * added/removed/reordered, a fallback changed — the JSON comparison fails.
 * Deliberate future extensions must update this reference consciously.
 * (PCS-3B: the account-id fallback was simplified from
 * `accountId ?? financialAccountId` to `financialAccountId` when the legacy
 * `Account` model was retired.)
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
    accountId:   r.financialAccountId,
    date:        r.date.toISOString().split("T")[0],
    merchant:    r.merchant,
    // MI M6 read cutover — CONSCIOUS extension (see module header): resolved
    // presentation is additive, raw `merchant` above is preserved. Same key
    // order + fallbacks as serializeTransactionRow.
    merchantDisplayName: r.resolvedMerchant?.displayName ?? r.merchant,
    merchantLogoUrl:     r.resolvedMerchant?.logoUrl ?? null,
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
    // Cash Flow liquidity axis — CONSCIOUS extension (like MI M6 above and the
    // `currency` drift fix below): the counterparty's owned-account id, PRE-GATED
    // by the data layer (KD-15). Same key position + `?? null` fallback as
    // serializeTransactionRow, so byte-identity holds.
    counterpartyAccountId:    r.counterpartyAccountId ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function legacyInvestmentMapper(r: any) {
  return {
    id:          r.id,
    accountId:   r.financialAccountId,
    date:        r.date.toISOString().split("T")[0],
    ticker:      r.merchant,
    description: r.description ?? "",
    category:    r.category,
    amount:      r.amount,
  };
}

// ---------------------------------------------------------------------------
// Fixtures — every branch of every fallback: null vs present
// description/currency/flow fields, pending, negative amounts.
// ---------------------------------------------------------------------------

const fixtures: TransactionRowLike[] = [
  // Fully-populated canonical (Plaid-synced) row.
  {
    id: 'tx_full',
    financialAccountId: 'fa_1',
    date: new Date('2026-06-14T00:00:00.000Z'),
    merchant: 'SQ *BLUE BOTTLE #442',
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
    // Cash Flow liquidity axis — a visible, pre-gated counterparty id (data layer
    // sets this only when the counterparty account is shared to the Space).
    counterpartyAccountId: 'fa_cp',
    // MI M6 — a resolved Merchant (raw descriptor above is preserved).
    resolvedMerchant: { displayName: 'Blue Bottle', logoUrl: 'https://logos/bb.png' },
  },
  // Null-heavy row (pre-provenance residue) on a canonical FinancialAccount.
  {
    id: 'tx_nulls',
    financialAccountId: 'fa_nulls',
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
    financialAccountId: 'fa_inv_div',
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
check('accountId is the FinancialAccount id', full.accountId === 'fa_1');
check('date renders as YYYY-MM-DD', full.date === '2026-06-14');

const nullsRow = serializeTransactionRow(fixtures[1]);
check('accountId is the FinancialAccount id (null-heavy row)', nullsRow.accountId === 'fa_nulls');
check('null description → undefined (key omitted from JSON)',
  nullsRow.description === undefined &&
    !Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(nullsRow)), 'description'));
check('null currency → null (key PRESENT in JSON as null)',
  nullsRow.currency === null &&
    Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(nullsRow)), 'currency'));

const sparse = serializeTransactionRow(fixtures[2]);
check('absent optional fields → null flow metadata (not undefined)',
  sparse.flowType === null && sparse.flowDirection === null &&
    sparse.classificationConfidence === null && sparse.classifierVersion === null);

// Cash Flow liquidity axis — counterpartyAccountId serializes (present value is
// emitted; absent → null, never undefined). The DATA LAYER is responsible for
// KD-15 gating (proven in counterparty-visibility.test.ts); the serializer only
// faithfully emits the pre-gated value.
check('present counterpartyAccountId is emitted', full.counterpartyAccountId === 'fa_cp');
check('absent counterpartyAccountId → null (key PRESENT in JSON as null)',
  sparse.counterpartyAccountId === null &&
    Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(sparse)), 'counterpartyAccountId'));

const div = serializeInvestmentTransactionRow(investmentFixtures[1]);
check('investment null description → empty string (not undefined)',
  div.description === '');
check('investment ticker sourced from merchant column', div.ticker === 'SCHD');

// ---------------------------------------------------------------------------
// 3b. MI M6 read cutover — resolved presentation (additive; raw preserved)
// ---------------------------------------------------------------------------

const resolved = serializeTransactionRow(fixtures[0]);
check('resolved row: merchantDisplayName is the Merchant displayName',
  resolved.merchantDisplayName === 'Blue Bottle');
check('resolved row: merchantLogoUrl is the Merchant logo',
  resolved.merchantLogoUrl === 'https://logos/bb.png');
check('resolved row: RAW merchant descriptor is preserved',
  resolved.merchant === 'SQ *BLUE BOTTLE #442');

const unresolved = serializeTransactionRow(fixtures[1]); // no resolvedMerchant
check('unresolved row: merchantDisplayName falls back to raw merchant',
  unresolved.merchantDisplayName === 'PAYROLL DEPOSIT');
check('unresolved row: merchantLogoUrl falls back to null (icon)',
  unresolved.merchantLogoUrl === null);

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
