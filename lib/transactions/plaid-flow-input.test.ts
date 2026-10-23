/**
 * lib/transactions/plaid-flow-input.test.ts
 *
 * FlowType P2 — Plaid import-fidelity mapper + shadow accumulator tests
 * (pure, no DB). Standalone `tsx` script, exit 0/1, mirroring the P1 suite:
 *
 *     npx tsx lib/transactions/plaid-flow-input.test.ts
 *
 * Imports only lib/transactions/plaid-flow-input.ts (which imports the
 * Prisma-free classifier and structural Plaid types), so it runs without
 * `prisma generate`.
 *
 * Covers: PFC extraction, captured-metadata sidecar, the account_numbers
 * deny-list, null-safety, classifier-through-mapper wiring, and the pure
 * shadow accumulator.
 *
 * Also hosts two merged suites:
 *   - plaid-flow-input.ti2.test.ts (TI2-2): the metadata-capture extension is
 *     safe and behavior-neutral — approved TI2A fields are captured from the
 *     Plaid payload, deny-listed PII is NEVER present in the captured object,
 *     no location is captured, and FlowType classification is unchanged by the
 *     new capture.
 *   - plaid-flow-write.test.ts (FlowType P3 Phase B): buildFlowWriteFields()
 *     produces the exact Transaction flow columns Phase B persists — identity
 *     enum mapping (runtime totality), counterparty null by design,
 *     classifierVersion wiring, pfc/merchant pass-through, and the all-null
 *     failure object. The COMPILE-time enum parity guard lives in
 *     plaid-flow-input.ts (Record<classifierUnion, PrismaEnum>); that suite
 *     adds the runtime coverage that every classifier value maps to a defined,
 *     equal string.
 */

import {
  buildPlaidFlowInput,
  buildFlowWriteFields,
  createShadowStats,
  accumulateShadow,
  summarizeShadow,
  NULL_FLOW_WRITE_FIELDS,
  type CapturedPlaidMetadata,
} from "./plaid-flow-input";
import {
  classifyFlow,
  FLOW_CLASSIFIER_VERSION,
  type FlowClassification,
  type FlowType,
  type FlowDirection,
  type FlowReason,
} from "./flow-classifier";

// ── Tiny assert harness ───────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// Minimal structural Plaid-transaction factory (only the fields we read).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function plaidTxn(over: Record<string, any> = {}): any {
  return {
    transaction_id: "txn_1",
    account_id:     "acc_1",
    name:           "RAW BANK DESCRIPTOR",
    merchant_name:  "Blue Bottle Coffee",
    amount:         4.5,
    date:           "2026-06-01",
    pending:        false,
    personal_finance_category: {
      primary:          "FOOD_AND_DRINK",
      detailed:         "FOOD_AND_DRINK_COFFEE",
      confidence_level: "VERY_HIGH",
    },
    merchant_entity_id: "ent_bluebottle",
    counterparties: [],
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PFC + field extraction
// ─────────────────────────────────────────────────────────────────────────────

{
  const { input, captured } = buildPlaidFlowInput(plaidTxn(), {
    category: "Dining", amount: -4.5, accountType: "checking", debtSubtype: null,
  });
  check("pfcPrimary extracted",  input.pfcPrimary === "FOOD_AND_DRINK");
  check("pfcDetailed extracted", input.pfcDetailed === "FOOD_AND_DRINK_COFFEE");
  check("confidence captured",   captured.pfcConfidenceLevel === "VERY_HIGH");
  check("merchantEntityId captured", captured.merchantEntityId === "ent_bluebottle");
  check("category passed through", input.category === "Dining");
  check("amount passed through (not re-flipped)", input.amount === -4.5, `got ${input.amount}`);
  check("accountType passed", input.accountType === "checking");
}

// CCPAY-2C-5 — the "merchant = merchant_name, falling back to name" assertions
// that lived here are gone with the field. buildPlaidFlowInput no longer reads
// merchant_name/name at all: the classifier is descriptor-blind by contract, and
// the descriptor's classification role is spent one layer up in the category
// rescue (lib/transactions/liability-payment.ts). A sparse txn with no
// merchant_name must still build cleanly, which the null-safety block below pins.

// ─────────────────────────────────────────────────────────────────────────────
// 2. Deny-list: account_numbers must never survive capture
// ─────────────────────────────────────────────────────────────────────────────

{
  const txn = plaidTxn({
    counterparties: [
      {
        name: "Chase", entity_id: "ent_chase", type: "financial_institution",
        website: "chase.com", logo_url: "https://x/chase.png", confidence_level: "HIGH",
        account_numbers: { account: "1234567890", routing: "021000021" },
      },
    ],
  });
  const { captured } = buildPlaidFlowInput(txn, { category: "Payment", amount: -300 });
  check("counterparty captured", captured.counterparties.length === 1);
  check("counterparty name kept", captured.counterparties[0].name === "Chase");
  check("counterparty type stringified", captured.counterparties[0].type === "financial_institution");
  check("counterparty confidence kept", captured.counterparties[0].confidenceLevel === "HIGH");
  // The deny-list guarantee: no account/routing number anywhere in the captured struct.
  const serialized = JSON.stringify(captured);
  check("no account_numbers key", !serialized.includes("account_numbers"));
  check("no account number value", !serialized.includes("1234567890"));
  check("no routing number value", !serialized.includes("021000021"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  check("no account_numbers on object", (captured.counterparties[0] as any).account_numbers === undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Null-safety — no throws on sparse payloads
// ─────────────────────────────────────────────────────────────────────────────

for (const over of [
  { personal_finance_category: null, counterparties: undefined, merchant_name: null, merchant_entity_id: null },
  { personal_finance_category: undefined },
  { counterparties: null },
]) {
  let threw = false;
  let result;
  try { result = buildPlaidFlowInput(plaidTxn(over), { category: "Other", amount: -1 }); } catch { threw = true; }
  check(`never throws on sparse ${JSON.stringify(over)}`, !threw);
  if (result) {
    check("sparse: pfc null-safe", result.input.pfcPrimary === null || typeof result.input.pfcPrimary === "string");
    check("sparse: counterparties array", Array.isArray(result.captured.counterparties));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Classifier-through-mapper wiring (P1 doctrine reached via PFC)
// ─────────────────────────────────────────────────────────────────────────────

{
  const { input } = buildPlaidFlowInput(
    plaidTxn({ personal_finance_category: { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD", confidence_level: "HIGH" } }),
    { category: "Payment", amount: -300 },
  );
  check("PFC LOAN_PAYMENTS → DEBT_PAYMENT", classifyFlow(input).flowType === "DEBT_PAYMENT");
}
{
  const { input } = buildPlaidFlowInput(
    plaidTxn({ personal_finance_category: { primary: "TRANSFER_IN", detailed: "TRANSFER_IN_ACCOUNT_TRANSFER", confidence_level: "HIGH" } }),
    { category: "Transfer", amount: 500 },
  );
  const c = classifyFlow(input);
  check("PFC TRANSFER_IN → TRANSFER/INFLOW", c.flowType === "TRANSFER" && c.flowDirection === "INFLOW");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Shadow accumulator (pure, non-PII)
// ─────────────────────────────────────────────────────────────────────────────

{
  const acc = createShadowStats();
  const rows: { category: string; amount: number }[] = [
    { category: "Dining",   amount: -20 },  // SPENDING → expense (legacy expense) ✓
    { category: "Income",   amount: 4200 }, // INCOME → income ✓
    { category: "Transfer", amount: -500 }, // TRANSFER → transfer ✓
    { category: "Payment",  amount: -300 }, // DEBT_PAYMENT → debtPayment ✓
    { category: "Dining",   amount: 15 },   // REFUND → none; legacy none ✓
  ];
  for (const r of rows) accumulateShadow(acc, classifyFlow(r), r.category, r.amount);

  check("accumulator total", acc.total === 5);
  check("accumulator counts flowType", (acc.byFlowType["SPENDING"] ?? 0) === 1 && (acc.byFlowType["REFUND"] ?? 0) === 1);
  check("accumulator counts reason", Object.keys(acc.byReason).length > 0);
  check("legacy comparisons counted", acc.legacyBucketComparisons === 5);
  check("full agreement on banking rows", acc.legacyBucketAgreements === 5, `got ${acc.legacyBucketAgreements}`);
  check("unknown count", acc.unknown === 0);

  const summary = summarizeShadow(acc);
  check("summary is non-PII (no merchant/counterparty tokens)",
    !/Blue Bottle|Chase|021000021|1234567890/.test(summary));
  check("summary reports agreement", summary.includes("legacyBucketAgreement=5/5"));
  check("summary reports 100%", summary.includes("(100%)"), summary);
}

// UNKNOWN is counted, never hidden
{
  const acc = createShadowStats();
  accumulateShadow(acc, classifyFlow({ category: "Zzz", amount: -10 }), "Zzz", -10);
  check("unknown tallied", acc.unknown === 1 && (acc.byFlowType["UNKNOWN"] ?? 0) === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// ── merged from lib/transactions/plaid-flow-input.ti2.test.ts (TI2-2) ────────
// The metadata-capture extension is safe and behavior-neutral.
// ─────────────────────────────────────────────────────────────────────────────

// A Plaid transaction carrying BOTH approved fields and every deny-listed field,
// so the deny-list assertion is meaningful. Layered on plaidTxn above.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ti2Txn(over: Record<string, any> = {}): any {
  return plaidTxn({
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE', confidence_level: 'VERY_HIGH' },
    // ── Approved TI2A-safe fields ──
    payment_channel:        'in store',
    authorized_date:        '2026-05-31',
    pending_transaction_id: 'pend_txn_9',
    transaction_code:       'purchase',
    check_number:           '4021',
    payment_meta: {
      payment_method:  'ACH',              // approved (safe) — the ONLY field read
      // ── Deny-listed identity fields (must never be captured) ──
      payer:           'PAYER_SECRET',
      payee:           'PAYEE_SECRET',
      by_order_of:     'BOO_SECRET',
      ppd_id:          'PPD_SECRET',
      reference_number:'REF_SECRET',
      payment_processor: 'proc',
      reason:          'r',
    },
    // ── Deny-listed elsewhere ──
    account_owner: 'ACCOUNT_OWNER_SECRET',
    location: { address: 'ADDR_SECRET', lat: 40.1, lon: -74.2, store_number: 'STORE_SECRET', city: 'CITY_SECRET', region: 'RE', postal_code: '00000', country: 'US' },
    counterparties: [
      { name: 'Blue Bottle', entity_id: 'ent_bb', type: 'merchant', website: 'bluebottle.com', logo_url: null, confidence_level: 'HIGH', account_numbers: 'ACCTNUM_SECRET', phone_number: 'PHONE_SECRET' },
    ],
    merchant_entity_id: 'ent_bb',
    ...over,
  });
}

const TI2_CTX = { category: 'Dining', amount: -4.5, accountType: 'depository', debtSubtype: null };

// TI2-2 captures the approved TI2A-safe fields
{
  const { captured } = buildPlaidFlowInput(ti2Txn(), TI2_CTX);
  check("TI2-2: paymentChannel captured", captured.paymentChannel === 'in store');
  check("TI2-2: authorizedDate captured", captured.authorizedDate === '2026-05-31');
  check("TI2-2: pendingTransactionRef captured", captured.pendingTransactionRef === 'pend_txn_9');
  check("TI2-2: transactionCode captured", captured.transactionCode === 'purchase');
  check("TI2-2: paymentMetaMethod captured", captured.paymentMetaMethod === 'ACH');
  check("TI2-2: checkNumber captured", captured.checkNumber === '4021');
  check("TI2-2: counterparty type captured (counterpartyType source)", captured.counterparties[0].type === 'merchant');
}

// TI2-2 captures honest nulls when Plaid omits the fields
{
  const bare = ti2Txn({
    payment_channel: undefined, authorized_date: undefined, pending_transaction_id: undefined,
    transaction_code: undefined, check_number: undefined, payment_meta: undefined,
  });
  const { captured } = buildPlaidFlowInput(bare, TI2_CTX);
  check("TI2-2: absent paymentChannel → null", captured.paymentChannel === null);
  check("TI2-2: absent authorizedDate → null", captured.authorizedDate === null);
  check("TI2-2: absent pendingTransactionRef → null", captured.pendingTransactionRef === null);
  check("TI2-2: absent transactionCode → null", captured.transactionCode === null);
  check("TI2-2: absent paymentMetaMethod → null", captured.paymentMetaMethod === null);
  check("TI2-2: absent checkNumber → null", captured.checkNumber === null);
}

// TI2-2 NEVER captures deny-listed PII (identity, account numbers, phone, owner)
{
  const { captured } = buildPlaidFlowInput(ti2Txn(), TI2_CTX);
  const blob = JSON.stringify(captured);
  for (const secret of [
    'PAYER_SECRET', 'PAYEE_SECRET', 'BOO_SECRET', 'PPD_SECRET', 'REF_SECRET',
    'ACCOUNT_OWNER_SECRET', 'ACCTNUM_SECRET', 'PHONE_SECRET',
  ]) {
    check(`TI2-2: deny-listed value never leaks into capture: ${secret}`, !blob.includes(secret));
  }
  // The captured counterparty must carry neither account_numbers nor phone_number keys.
  check("TI2-2: no account_numbers key on captured counterparty",
    !Object.prototype.hasOwnProperty.call(captured.counterparties[0], 'account_numbers'));
  check("TI2-2: no phone_number key on captured counterparty",
    !Object.prototype.hasOwnProperty.call(captured.counterparties[0], 'phone_number'));
}

// TI2-2 captures NO location (precise or coarse)
{
  const { captured } = buildPlaidFlowInput(ti2Txn(), TI2_CTX);
  const blob = JSON.stringify(captured);
  for (const loc of ['ADDR_SECRET', 'STORE_SECRET', 'CITY_SECRET', '40.1', '-74.2']) {
    check(`TI2-2: location never leaks into capture: ${loc}`, !blob.includes(loc));
  }
}

// TI2-2 does not change FlowType classification (behavior-neutral)
{
  // Same account context, with and without the new provider fields present.
  const withMeta = buildPlaidFlowInput(ti2Txn(), TI2_CTX);
  const withoutMeta = buildPlaidFlowInput(
    ti2Txn({ payment_channel: undefined, authorized_date: undefined, pending_transaction_id: undefined, transaction_code: undefined, check_number: undefined, payment_meta: undefined }),
    TI2_CTX,
  );
  check("TI2-2: classification unchanged by capture",
    JSON.stringify(classifyFlow(withMeta.input)) === JSON.stringify(classifyFlow(withoutMeta.input)));
  // The classifier input itself is untouched by TI2-2 (capture is a separate sidecar).
  check("TI2-2: classifier input untouched by capture sidecar",
    JSON.stringify(withMeta.input) === JSON.stringify(withoutMeta.input));
}

// ─────────────────────────────────────────────────────────────────────────────
// ── merged from lib/transactions/plaid-flow-write.test.ts (FlowType P3
//    Phase B write-fields builder) ─────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const NO_META: CapturedPlaidMetadata = {
  pfcConfidenceLevel: null,
  merchantEntityId:   null,
  counterparties:     [],
};

// W1. Shape + wiring from a real classification
{
  const input = {
    category: "Payment", amount: -300, accountType: "checking", debtSubtype: null,
    pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD",
  };
  const captured: CapturedPlaidMetadata = {
    pfcConfidenceLevel: "HIGH", merchantEntityId: "ent_chase", counterparties: [],
  };
  const classification = classifyFlow(input);
  const w = buildFlowWriteFields(classification, input, captured, FLOW_CLASSIFIER_VERSION);

  check("flowType wired", w.flowType === classification.flowType, `${w.flowType}`);
  check("flowDirection wired", w.flowDirection === classification.flowDirection);
  check("confidence wired", w.classificationConfidence === classification.confidence);
  check("reason wired", w.classificationReason === classification.reason);
  // Asserts the constant is WIRED THROUGH, not a specific integer — pinning the
  // literal here just made every version bump edit two files (CCPAY-2F drift).
  check("classifierVersion wired", w.classifierVersion === FLOW_CLASSIFIER_VERSION);
  check("counterpartyAccountId is null (Phase B)", w.counterpartyAccountId === null);
  check("pfcPrimary pass-through", w.pfcPrimary === "LOAN_PAYMENTS");
  check("pfcDetailed pass-through", w.pfcDetailed === "LOAN_PAYMENTS_CREDIT_CARD");
  check("pfcConfidenceLevel from captured", w.pfcConfidenceLevel === "HIGH");
  check("merchantEntityId from captured", w.merchantEntityId === "ent_chase");
  // v2.6-OWN-1 — the builder names its author on every field-set it returns, so
  // no classifier write site can produce a flow value without an owner.
  check("flowAuthority stamped CLASSIFIER", w.flowAuthority === "CLASSIFIER");
  check("exactly 11 keys", Object.keys(w).length === 11, `${Object.keys(w).length}`);
}

// pfc fields null when Plaid supplied none
{
  const input = { category: "Dining", amount: -20, pfcPrimary: null, pfcDetailed: null };
  const w = buildFlowWriteFields(classifyFlow(input), input, NO_META, FLOW_CLASSIFIER_VERSION);
  check("null pfc → null columns", w.pfcPrimary === null && w.pfcDetailed === null && w.pfcConfidenceLevel === null);
  check("null merchant entity", w.merchantEntityId === null);
  check("flowType still defined", w.flowType === "SPENDING");
}

// W2. Runtime enum-map totality — every classifier value maps to an equal string

const ALL_FLOW_TYPES: FlowType[] = [
  "SPENDING", "INCOME", "REFUND", "DEBT_PAYMENT", "TRANSFER",
  "INVESTMENT", "FEE", "INTEREST", "ADJUSTMENT", "UNKNOWN",
];
const ALL_DIRECTIONS: FlowDirection[] = ["INFLOW", "OUTFLOW", "INTERNAL", "UNKNOWN"];
const ALL_REASONS: FlowReason[] = [
  "PLAID_PFC_DETAILED", "PLAID_PFC_PRIMARY", "CATEGORY_FLOW_VALUE",
  "CATEGORY_INVESTMENT_VALUE", "ACCOUNT_TYPE_CONTEXT", "SIGN_DEFAULT_SPENDING",
  "SIGN_DEFAULT_INFLOW", "AMBIGUOUS_UNKNOWN",
];

const baseInput = { category: "Other", amount: -1 };
for (const ft of ALL_FLOW_TYPES) {
  const c: FlowClassification = { flowType: ft, flowDirection: "OUTFLOW", confidence: 0.5, reason: "AMBIGUOUS_UNKNOWN" };
  const w = buildFlowWriteFields(c, baseInput, NO_META, 1);
  check(`flowType map total: ${ft}`, w.flowType === ft, `got ${w.flowType}`);
}
for (const d of ALL_DIRECTIONS) {
  const c: FlowClassification = { flowType: "UNKNOWN", flowDirection: d, confidence: 0.2, reason: "AMBIGUOUS_UNKNOWN" };
  const w = buildFlowWriteFields(c, baseInput, NO_META, 1);
  check(`direction map total: ${d}`, w.flowDirection === d, `got ${w.flowDirection}`);
}
for (const r of ALL_REASONS) {
  const c: FlowClassification = { flowType: "UNKNOWN", flowDirection: "UNKNOWN", confidence: 0.2, reason: r };
  const w = buildFlowWriteFields(c, baseInput, NO_META, 1);
  check(`reason map total: ${r}`, w.classificationReason === r, `got ${w.classificationReason}`);
}

// W3. NULL_FLOW_WRITE_FIELDS — the classification-failure fallback

check("NULL fallback has 11 keys", Object.keys(NULL_FLOW_WRITE_FIELDS).length === 11);
// v2.6-OWN-1 — including flowAuthority: classification FAILED, so nobody
// classified the row and nobody claims it. This keeps the coupling invariant
// (flowType null ⟺ flowAuthority null) true on the failure path too.
check("NULL fallback all null", Object.values(NULL_FLOW_WRITE_FIELDS).every((v) => v === null));
check("NULL fallback is UNOWNED", NULL_FLOW_WRITE_FIELDS.flowAuthority === null);

// ── Report ────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\nFlowType P2 plaid-flow-input: ${failures.length} FAILURE(S) (${passed} passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`FlowType P2 plaid-flow-input: all ${passed} checks passed.`);
process.exit(0);
