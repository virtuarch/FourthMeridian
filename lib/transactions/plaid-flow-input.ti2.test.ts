/**
 * lib/transactions/plaid-flow-input.ti2.test.ts
 *
 * TI2-2 — proves the metadata-capture extension is safe and behavior-neutral:
 *   - approved TI2A fields are captured from the Plaid payload,
 *   - deny-listed PII is NEVER present in the captured object,
 *   - no location is captured,
 *   - existing FlowType classification is unchanged by the new capture.
 *
 * Pure, no DB — runnable under `tsx`:  npx tsx --test lib/transactions/plaid-flow-input.ti2.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlaidFlowInput } from './plaid-flow-input';
import { classifyFlow } from './flow-classifier';

// A Plaid transaction carrying BOTH approved fields and every deny-listed field,
// so the deny-list assertion is meaningful. Typed loosely like the sibling suite.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function plaidTxn(over: Record<string, any> = {}): any {
  return {
    transaction_id: 'txn_1',
    account_id:     'acc_1',
    name:           'RAW BANK DESCRIPTOR',
    merchant_name:  'Blue Bottle Coffee',
    amount:         4.5,
    date:           '2026-06-01',
    pending:        false,
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
  };
}

const CTX = { category: 'Dining', amount: -4.5, accountType: 'depository', debtSubtype: null };

test('TI2-2 captures the approved TI2A-safe fields', () => {
  const { captured } = buildPlaidFlowInput(plaidTxn(), CTX);
  assert.equal(captured.paymentChannel, 'in store');
  assert.equal(captured.authorizedDate, '2026-05-31');
  assert.equal(captured.pendingTransactionRef, 'pend_txn_9');
  assert.equal(captured.transactionCode, 'purchase');
  assert.equal(captured.paymentMetaMethod, 'ACH');
  assert.equal(captured.checkNumber, '4021');
  assert.equal(captured.counterparties[0].type, 'merchant'); // counterpartyType source
});

test('TI2-2 captures honest nulls when Plaid omits the fields', () => {
  const bare = plaidTxn({
    payment_channel: undefined, authorized_date: undefined, pending_transaction_id: undefined,
    transaction_code: undefined, check_number: undefined, payment_meta: undefined,
  });
  const { captured } = buildPlaidFlowInput(bare, CTX);
  assert.equal(captured.paymentChannel, null);
  assert.equal(captured.authorizedDate, null);
  assert.equal(captured.pendingTransactionRef, null);
  assert.equal(captured.transactionCode, null);
  assert.equal(captured.paymentMetaMethod, null);
  assert.equal(captured.checkNumber, null);
});

test('TI2-2 NEVER captures deny-listed PII (identity, account numbers, phone, owner)', () => {
  const { captured } = buildPlaidFlowInput(plaidTxn(), CTX);
  const blob = JSON.stringify(captured);
  for (const secret of [
    'PAYER_SECRET', 'PAYEE_SECRET', 'BOO_SECRET', 'PPD_SECRET', 'REF_SECRET',
    'ACCOUNT_OWNER_SECRET', 'ACCTNUM_SECRET', 'PHONE_SECRET',
  ]) {
    assert.ok(!blob.includes(secret), `deny-listed value leaked into capture: ${secret}`);
  }
  // The captured counterparty must carry neither account_numbers nor phone_number keys.
  assert.ok(!Object.prototype.hasOwnProperty.call(captured.counterparties[0], 'account_numbers'));
  assert.ok(!Object.prototype.hasOwnProperty.call(captured.counterparties[0], 'phone_number'));
});

test('TI2-2 captures NO location (precise or coarse)', () => {
  const { captured } = buildPlaidFlowInput(plaidTxn(), CTX);
  const blob = JSON.stringify(captured);
  for (const loc of ['ADDR_SECRET', 'STORE_SECRET', 'CITY_SECRET', '40.1', '-74.2']) {
    assert.ok(!blob.includes(loc), `location leaked into capture: ${loc}`);
  }
});

test('TI2-2 does not change FlowType classification (behavior-neutral)', () => {
  // Same account context, with and without the new provider fields present.
  const withMeta = buildPlaidFlowInput(plaidTxn(), CTX);
  const withoutMeta = buildPlaidFlowInput(
    plaidTxn({ payment_channel: undefined, authorized_date: undefined, pending_transaction_id: undefined, transaction_code: undefined, check_number: undefined, payment_meta: undefined }),
    CTX,
  );
  assert.deepEqual(classifyFlow(withMeta.input), classifyFlow(withoutMeta.input));
  // The classifier input itself is untouched by TI2-2 (capture is a separate sidecar).
  assert.deepEqual(withMeta.input, withoutMeta.input);
});
