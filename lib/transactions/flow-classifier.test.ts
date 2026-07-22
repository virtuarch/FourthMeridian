/**
 * lib/transactions/flow-classifier.test.ts
 *
 * FlowType P1 — classifier behavior tests + equivalence harness (pure, no DB).
 *
 * The project has no test runner (no jest/vitest). This file is a standalone,
 * dependency-free script runnable with the already-installed `tsx`, mirroring
 * lib/ai/assemblers/transactions.kd17.test.ts:
 *
 *     npx tsx lib/transactions/flow-classifier.test.ts
 *
 * Exits 0 when all cases pass and 1 on the first failure. It imports ONLY
 * lib/transactions/flow-classifier.ts, which is Prisma-free, so this suite runs
 * without `prisma generate`.
 *
 * Three layers of checks:
 *   1. Behavior matrix — classifyFlow() output per doctrine
 *      (FLOWTYPE_FOUNDATION_INVESTIGATION.md §5 / checklist §3).
 *   2. Assembler-partition equivalence — proves that routing the four inline
 *      buckets in lib/ai/assemblers/transactions.ts:282-317 through the
 *      classifier reproduces the SAME bucket for every banking category × sign.
 *      This is the primary "existing partition behavior is unchanged" proof.
 *   3. SPENDING_EXCLUDED probe — reports whether the classifier reproduces
 *      annotations.ts:755 byte-for-byte. It does over the banking-category
 *      domain that surface actually uses, but NOT over the full enum (the
 *      classifier is intentionally more granular for investment categories),
 *      so the annotations.ts reroute is deliberately NOT taken in P1.
 */

import {
  classifyFlow,
  isExcludedFromSpending,
  type FlowType,
  type FlowDirection,
} from './flow-classifier';

// ── Tiny assert harness ───────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function expectFlow(
  name: string,
  input: Parameters<typeof classifyFlow>[0],
  wantType: FlowType,
  wantDir?: FlowDirection,
): void {
  const c = classifyFlow(input);
  check(`${name}: flowType`, c.flowType === wantType, `got ${c.flowType}, want ${wantType}`);
  if (wantDir) {
    check(`${name}: flowDirection`, c.flowDirection === wantDir, `got ${c.flowDirection}, want ${wantDir}`);
  }
  check(`${name}: confidence in [0,1]`, c.confidence >= 0 && c.confidence <= 1, `got ${c.confidence}`);
  check(`${name}: reason present`, typeof c.reason === 'string' && c.reason.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Behavior matrix (checklist §3 / §5)
// ─────────────────────────────────────────────────────────────────────────────

// Flow-value categories
expectFlow('Transfer out',     { category: 'Transfer', amount: -500 }, 'TRANSFER', 'OUTFLOW');
expectFlow('Transfer in',      { category: 'Transfer', amount:  500 }, 'TRANSFER', 'INFLOW');
expectFlow('Payment source',   { category: 'Payment',  amount: -300 }, 'DEBT_PAYMENT', 'INTERNAL');
expectFlow('Payment dest leg', { category: 'Payment',  amount:  300, debtSubtype: 'credit_card' }, 'DEBT_PAYMENT', 'INFLOW');
expectFlow('Income',           { category: 'Income',   amount: 4200 }, 'INCOME', 'INFLOW');
expectFlow('Fee',              { category: 'Fee',      amount:  -35 }, 'FEE', 'OUTFLOW');

// Interest polarity depends on account context
expectFlow('Interest on debt acct',    { category: 'Interest', amount: -40, accountType: 'debt' },     'INTEREST', 'OUTFLOW');
expectFlow('Interest earned savings',  { category: 'Interest', amount:  12, accountType: 'savings' }, 'INCOME',   'INFLOW');
expectFlow('Interest earned no acct',  { category: 'Interest', amount:  12 },                          'INCOME',   'INFLOW');
expectFlow('Interest charged no acct', { category: 'Interest', amount: -40 },                          'INTEREST', 'OUTFLOW');

// Investment security activity
expectFlow('Buy',      { category: 'Buy',      amount: -1000 }, 'INVESTMENT', 'INTERNAL');
expectFlow('Sell',     { category: 'Sell',     amount:  1000 }, 'INVESTMENT', 'INTERNAL');
expectFlow('Split',    { category: 'Split',    amount:     0 }, 'INVESTMENT', 'INTERNAL');
expectFlow('Dividend', { category: 'Dividend', amount:    50 }, 'INCOME',     'INFLOW');

// GENUINE spend categories: sign decides SPENDING vs REFUND. `Other` is
// deliberately EXCLUDED here — SR-1 gives its positive side different semantics
// (asserted immediately below), because `Other` is the "no info" sentinel, not a
// real spend category.
for (const cat of ['Groceries', 'Dining', 'Shopping', 'Travel', 'Subscriptions', 'Utilities']) {
  expectFlow(`${cat} debit`,  { category: cat, amount: -80 }, 'SPENDING', 'OUTFLOW');
  expectFlow(`${cat} credit`, { category: cat, amount:  80 }, 'REFUND',   'INFLOW');
}

// ── SR-1 — the fabricated-refund correction ─────────────────────────────────
// `Other` is the catch-all "provider told us nothing" sentinel. A NEGATIVE Other
// is still a cost (SPENDING); a POSITIVE Other is NOT a manufactured refund — it
// is an unclassified inflow (the honesty valve), never REFUND.
expectFlow('SR-1: Other debit is still SPENDING',       { category: 'Other', amount: -80 }, 'SPENDING', 'OUTFLOW');
expectFlow('SR-1: Other credit is UNKNOWN, not REFUND', { category: 'Other', amount:  80 }, 'UNKNOWN',  'INFLOW');
check('SR-1: Other credit reason is AMBIGUOUS_UNKNOWN (not SIGN_DEFAULT_INFLOW)',
  classifyFlow({ category: 'Other', amount: 80 }).reason === 'AMBIGUOUS_UNKNOWN');
check('SR-1: Other credit is NEVER REFUND (pending paycheck root cause)',
  classifyFlow({ category: 'Other', amount: 5286.63 }).flowType !== 'REFUND');
// The pending-payroll shape verbatim (Other / OTHER_OTHER / positive): the
// unrecognized PFC falls through, and Other-positive resolves UNKNOWN — never the
// old REFUND → INCOME fabrication. (Descriptor rescue to INCOME happens upstream.)
expectFlow('SR-1: pending Vectrus payroll shape (Other/OTHER_OTHER/+) → UNKNOWN',
  { category: 'Other', amount: 5286.63, pfcPrimary: 'OTHER', pfcDetailed: 'OTHER_OTHER' },
  'UNKNOWN', 'INFLOW');
// Zero-amount Other is unchanged — a non-economic ADJUSTMENT, not the UNKNOWN valve.
expectFlow('SR-1: Other zero-amount stays ADJUSTMENT', { category: 'Other', amount: 0 }, 'ADJUSTMENT', 'UNKNOWN');

// Refund must never read as income (the Banking totalCredit bug's root)
check('Refund is not INCOME', classifyFlow({ category: 'Dining', amount: 25 }).flowType === 'REFUND');

// Plaid PFC precedence (dormant path — only when caller supplies PFC in memory)
expectFlow('PFC TRANSFER_IN',  { category: 'Other', amount:  500, pfcPrimary: 'TRANSFER_IN'  }, 'TRANSFER', 'INFLOW');
expectFlow('PFC TRANSFER_OUT', { category: 'Other', amount: -500, pfcPrimary: 'TRANSFER_OUT' }, 'TRANSFER', 'OUTFLOW');
expectFlow('PFC LOAN_PAYMENTS',{ category: 'Other', amount: -300, pfcPrimary: 'LOAN_PAYMENTS' }, 'DEBT_PAYMENT');
expectFlow('PFC BANK_FEES',    { category: 'Other', amount:  -12, pfcPrimary: 'BANK_FEES'    }, 'FEE');
expectFlow('PFC INCOME',       { category: 'Other', amount: 4200, pfcPrimary: 'INCOME'       }, 'INCOME', 'INFLOW');
expectFlow('PFC detailed INTEREST charged', { category: 'Other', amount: -40, pfcDetailed: 'BANK_FEES_INTEREST_CHARGE' }, 'INTEREST');
expectFlow('PFC spend primary refund',      { category: 'Other', amount:  25, pfcPrimary: 'FOOD_AND_DRINK' }, 'REFUND', 'INFLOW');
{
  const c = classifyFlow({ category: 'Other', amount: 500, pfcPrimary: 'TRANSFER_IN' });
  check('PFC overrides category', c.reason === 'PLAID_PFC_PRIMARY', `reason=${c.reason}`);
}

// Confidence tiers
check('flow-value category is high confidence', classifyFlow({ category: 'Transfer', amount: -1 }).confidence === 1.0);
check('sign-default spending is 0.5',           classifyFlow({ category: 'Dining',   amount: -1 }).confidence === 0.5);
check('unknown category is low confidence',     classifyFlow({ category: 'Zzz',      amount: -1 }).confidence <= 0.3);

// UNKNOWN valve — unmappable category, never forced to SPENDING
expectFlow('Unknown category debit', { category: 'Zzz', amount: -10 }, 'UNKNOWN', 'OUTFLOW');
expectFlow('Zero-amount spend row',  { category: 'Groceries', amount: 0 }, 'ADJUSTMENT', 'UNKNOWN');

// Determinism & never-throws
{
  const a = classifyFlow({ category: 'Dining', amount: -42 });
  const b = classifyFlow({ category: 'Dining', amount: -42 });
  check('deterministic', JSON.stringify(a) === JSON.stringify(b));
}
for (const bad of [
  { category: '', amount: NaN },
  { category: 'Other', amount: 0 },
  { category: 'Other', amount: -0 },
  { category: ' garbage', amount: 999999 },
] as Parameters<typeof classifyFlow>[0][]) {
  let threw = false;
  try { classifyFlow(bad); } catch { threw = true; }
  check(`never throws on ${JSON.stringify(bad)}`, !threw);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Assembler-partition equivalence harness
//
// Reference: lib/ai/assemblers/transactions.ts:282-317 (main loop) and the
// identical monthly loop :749-767. The assembler query only ever fetches the 11
// BANKING_CATEGORIES (:83-95), so equivalence is asserted over exactly that set.
// ─────────────────────────────────────────────────────────────────────────────

type Bucket = 'income' | 'expense' | 'debtPayment' | 'transfer' | 'none';

const BANKING_CATEGORIES = [
  'Income', 'Transfer', 'Groceries', 'Dining', 'Shopping', 'Travel',
  'Subscriptions', 'Utilities', 'Interest', 'Payment', 'Other',
];

// Verbatim reproduction of the inline partition (transactions.ts:290-314).
const INCOME_CATEGORIES = new Set(['Income', 'Interest']);
function assemblerBucketInline(category: string, amount: number): Bucket {
  if (category === 'Transfer') return 'transfer';
  if (category === 'Payment')  return amount < 0 ? 'debtPayment' : 'none';
  if (INCOME_CATEGORIES.has(category) && amount > 0) return 'income';
  if (amount < 0) return 'expense';
  return 'none';
}

// The documented fold that maps the (finer) classifier output back onto the
// assembler's four coarse buckets. The assembler lumps INTEREST inflows into
// income and INTEREST/FEE outflows into expense; the fold makes that explicit.
function assemblerBucketViaClassifier(category: string, amount: number): Bucket {
  const c = classifyFlow({ category, amount });
  if (c.flowType === 'TRANSFER')     return 'transfer';
  if (c.flowType === 'DEBT_PAYMENT') return amount < 0 ? 'debtPayment' : 'none';
  if ((c.flowType === 'INCOME' || c.flowType === 'INTEREST') && amount > 0) return 'income';
  if (amount < 0) return 'expense';
  return 'none';
}

let equivalenceMismatch = 0;
for (const category of BANKING_CATEGORIES) {
  for (const amount of [-137.42, -0.01, 0, 0.01, 8400]) {
    const inline = assemblerBucketInline(category, amount);
    const viaClf = assemblerBucketViaClassifier(category, amount);
    const ok = inline === viaClf;
    if (!ok) equivalenceMismatch++;
    check(
      `equivalence: ${category} @ ${amount}`,
      ok,
      `inline=${inline} classifier=${viaClf}`,
    );
  }
}
check('assembler partition FULLY reproducible over banking categories', equivalenceMismatch === 0);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Legacy exclusion-set parity probe (the annotations.ts gate)
//
// annotations.ts only ever passes BANKING category names into
// classifySpendingCategory (its byCategory rollup is banking-only). Over that
// real domain the classifier reproduces the legacy set exactly. Over the FULL
// enum it deliberately diverges (investment categories are excluded by the
// classifier but were not by the legacy set). P5 Slice 5 rerouted the gate
// through isExcludedFromSpending, and Slice 7 deleted the hand-written legacy
// set — the local copy below is the historical fixture this harness keeps
// proving parity against.
// ─────────────────────────────────────────────────────────────────────────────

const SPENDING_EXCLUDED = new Set(['Income', 'Interest', 'Transfer', 'Payment']);

// (a) Byte-identical over the banking-category domain annotations actually uses.
let bankingDomainMismatch = 0;
for (const category of BANKING_CATEGORIES) {
  const legacy = SPENDING_EXCLUDED.has(category);
  // annotations calls with category only; probe with a debit sentinel.
  const viaClf = isExcludedFromSpending(classifyFlow({ category, amount: -1 }));
  if (legacy !== viaClf) bankingDomainMismatch++;
  check(`SPENDING_EXCLUDED banking-domain: ${category}`, legacy === viaClf, `legacy=${legacy} classifier=${viaClf}`);
}
check('SPENDING_EXCLUDED reproduced over banking domain', bankingDomainMismatch === 0);

// (b) Document (assert) the whole-enum divergence — the deliberate granular
// improvement (investment categories + Fee excluded) shipped with Slice 5.
const wholeEnumDiverges =
  isExcludedFromSpending(classifyFlow({ category: 'Buy', amount: -1 })) !== SPENDING_EXCLUDED.has('Buy');
check('whole-enum NOT byte-identical (investment categories) — deliberate Slice 5 divergence', wholeEnumDiverges);

// ─────────────────────────────────────────────────────────────────────────────
// CF-4 — a liability-account TRANSFER_OUT_ACCOUNT_TRANSFER outflow is a PURCHASE,
// not a transfer (Plaid mislabels retail POS on cards, e.g. Harvey Nichols). Uses
// sanitized representative shapes from the real mislabeled rows.
// ─────────────────────────────────────────────────────────────────────────────

// The exact Harvey Nichols shape: debt account, outflow, Plaid TRANSFER_OUT /
// TRANSFER_OUT_ACCOUNT_TRANSFER → SPENDING (was TRANSFER before CF-4).
expectFlow('CF-4 card ACCOUNT_TRANSFER outflow → SPENDING (Harvey Nichols)',
  { category: 'Transfer', amount: -692.97, accountType: 'debt', debtSubtype: 'credit_card',
    pfcPrimary: 'TRANSFER_OUT', pfcDetailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER' },
  'SPENDING', 'OUTFLOW');
check('CF-4 uses ACCOUNT_TYPE_CONTEXT reason',
  classifyFlow({ category: 'Transfer', amount: -692.97, accountType: 'debt', debtSubtype: 'credit_card',
    pfcPrimary: 'TRANSFER_OUT', pfcDetailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER' }).reason === 'ACCOUNT_TYPE_CONTEXT');

// NOT over-reaching: a cash advance (TRANSFER_OUT_WITHDRAWAL, not ACCOUNT_TRANSFER)
// on a card stays TRANSFER — CF-4 must never swallow it.
expectFlow('CF-4 card cash advance stays TRANSFER',
  { category: 'Transfer', amount: -200, accountType: 'debt', debtSubtype: 'credit_card',
    pfcPrimary: 'TRANSFER_OUT', pfcDetailed: 'TRANSFER_OUT_WITHDRAWAL' },
  'TRANSFER', 'OUTFLOW');

// NOT on a liquid account: the same Apple-Cash-style ACCOUNT_TRANSFER on CHECKING
// is untouched (stays TRANSFER) — CF-4 is scoped to the liability tier only.
expectFlow('CF-4 checking ACCOUNT_TRANSFER unchanged (Apple Cash send)',
  { category: 'Transfer', amount: -101.47, accountType: 'checking',
    pfcPrimary: 'TRANSFER_OUT', pfcDetailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER' },
  'TRANSFER', 'OUTFLOW');

// NOT the inflow leg: money INTO a card tagged as a transfer stays TRANSFER
// (ambiguous payment vs refund — honesty valve, never fabricate SPENDING/REFUND).
expectFlow('CF-4 card ACCOUNT_TRANSFER inflow stays TRANSFER',
  { category: 'Transfer', amount: 250, accountType: 'debt', debtSubtype: 'credit_card',
    pfcPrimary: 'TRANSFER_IN', pfcDetailed: 'TRANSFER_IN_ACCOUNT_TRANSFER' },
  'TRANSFER', 'INFLOW');

// ─────────────────────────────────────────────────────────────────────────────
// CCPAY-2B — the structural negative-liability veto.
//
// Fixtures are the five REAL posted rows from the live corpus that CCPAY-1 found
// misclassified as DEBT_PAYMENT: every one is an ordinary card purchase that
// Plaid tagged with a LOAN_PAYMENTS PFC. $1,482.62 of real spending was being
// excluded from the spend ledger. These are adversarial fixtures drawn from
// production, not invented strings.
// ─────────────────────────────────────────────────────────────────────────────

// The veto fires regardless of which LOAN_PAYMENTS detailed Plaid invented.
expectFlow('CCPAY-2B: Qlub (restaurant app) tagged LOAN_PAYMENTS_CAR_PAYMENT',
  { category: 'Payment', amount: -387.24, accountType: 'debt',
    pfcPrimary: 'LOAN_PAYMENTS', pfcDetailed: 'LOAN_PAYMENTS_CAR_PAYMENT' },
  'SPENDING', 'OUTFLOW');

expectFlow('CCPAY-2B: Amex Travel booking tagged LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
  { category: 'Payment', amount: -506.98, accountType: 'debt',
    pfcPrimary: 'LOAN_PAYMENTS', pfcDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' },
  'SPENDING', 'OUTFLOW');

expectFlow('CCPAY-2B: DYNEFF fuel tagged LOAN_PAYMENTS_OTHER_PAYMENT',
  { category: 'Payment', amount: -107.41, accountType: 'debt',
    pfcPrimary: 'LOAN_PAYMENTS', pfcDetailed: 'LOAN_PAYMENTS_OTHER_PAYMENT' },
  'SPENDING', 'OUTFLOW');

// Purely structural: the veto holds with NO PFC at all (the CSV/manual path),
// and via the debtSubtype liability signal rather than accountType.
expectFlow('CCPAY-2B: liability outflow with no PFC is still vetoed',
  { category: 'Payment', amount: -50, accountType: 'debt' },
  'SPENDING', 'OUTFLOW');
expectFlow('CCPAY-2B: veto honors the debtSubtype liability signal',
  { category: 'Payment', amount: -50, accountType: 'other', debtSubtype: 'credit_card' },
  'SPENDING', 'OUTFLOW');
expectFlow('CCPAY-2B: veto fires even when a descriptor claims payment',
  { category: 'Payment', amount: -50, accountType: 'debt',
    pfcPrimary: 'LOAN_PAYMENTS', pfcDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' },
  'SPENDING', 'OUTFLOW');

// ── What the veto must NOT touch ─────────────────────────────────────────────
// The source leg: 116 real rows. Negative, but on a DEPOSITORY account.
expectFlow('CCPAY-2B: source leg on checking stays DEBT_PAYMENT',
  { category: 'Payment', amount: -5000, accountType: 'checking',
    pfcPrimary: 'LOAN_PAYMENTS', pfcDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' },
  'DEBT_PAYMENT', 'INTERNAL');
// Unknown account context must not be assumed to be a liability.
expectFlow('CCPAY-2B: negative with no account context stays DEBT_PAYMENT',
  { category: 'Payment', amount: -300 },
  'DEBT_PAYMENT', 'INTERNAL');
// The destination leg: 109 real rows. On a liability, but POSITIVE.
expectFlow('CCPAY-2B: destination leg on a liability stays DEBT_PAYMENT',
  { category: 'Payment', amount: 5587.31, accountType: 'debt',
    pfcPrimary: 'LOAN_DISBURSEMENTS', pfcDetailed: 'LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT' },
  'DEBT_PAYMENT', 'INFLOW');
// amount === 0 is not an outflow — the veto is `< 0`, not `<= 0`.
expectFlow('CCPAY-2B: zero-amount liability row is not vetoed',
  { category: 'Payment', amount: 0, accountType: 'debt' },
  'DEBT_PAYMENT');

// Interest/fee on a liability still resolve to their own kinds, not SPENDING:
// those branches run BEFORE the DEBT_PAYMENT paths and the veto never sees them.
expectFlow('CCPAY-2B: liability interest charge is INTEREST, not vetoed to SPENDING',
  { category: 'Interest', amount: -40, accountType: 'debt',
    pfcPrimary: 'BANK_FEES', pfcDetailed: 'BANK_FEES_INTEREST_CHARGE' },
  'INTEREST', 'OUTFLOW');

// ─────────────────────────────────────────────────────────────────────────────
// CCPAY-2C-5 — the classifier is DESCRIPTOR-BLIND by contract.
//
// Pinned at COMPILE time, not runtime: a runtime test cannot exercise a field
// that no longer type-checks. Each @ts-expect-error below asserts that handing
// the classifier a descriptor is a build error. If anyone re-adds merchant or
// description to FlowClassificationInput, the suppression becomes unused and
// tsc fails with "Unused '@ts-expect-error' directive" — this file breaks first,
// before the field can grow a caller.
//
// WHY the fields must not come back (both reasons are load-bearing):
//  1. The two builders populated them INCONSISTENTLY — buildPlaidFlowInput set
//     merchant but never description; buildFlowInputFromRow set both. A rule
//     added here would have silently no-op'd on the live Plaid path.
//  2. A descriptor means "this category is Payment"; flowType follows FROM
//     category. Resolving it here would leave category='Other' beside
//     flowType='DEBT_PAYMENT'. One decision must produce both columns.
//
// The descriptor's classification role lives in the category layer:
// lib/transactions/liability-payment.ts (resolveLiabilityPaymentCategory).
// ─────────────────────────────────────────────────────────────────────────────

// @ts-expect-error — descriptor-blind by contract: `merchant` is not an input.
classifyFlow({ category: 'Other', amount: 5000, merchant: 'PAYMENT-THANK YOU' });
// @ts-expect-error — descriptor-blind by contract: `description` is not an input.
classifyFlow({ category: 'Other', amount: 5000, description: 'PAYMENT-THANK YOU' });
check('CCPAY-2C-5: classifier compiles descriptor-blind (see @ts-expect-error above)', true);

// ── Report ────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\nFlowType P1 classifier: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`FlowType P1 classifier: all ${passed} checks passed.`);
console.log('  · assembler partition reproducible over banking categories (0 mismatches)');
console.log('  · legacy exclusion set reproduced over banking domain; whole-enum divergence confirmed (deliberate, live since Slice 5)');
process.exit(0);
