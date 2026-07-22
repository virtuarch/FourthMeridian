/**
 * lib/transactions/transaction-facts.test.ts
 *
 * TI2-3 — pure builder tests. Deterministic, no DB.
 *   npx tsx --test lib/transactions/transaction-facts.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTransactionFacts,
  NULL_TRANSACTION_FACTS,
  TI_FACTS_VERSION,
  type TransactionFactsInput,
} from './transaction-facts';
import type { CapturedPlaidMetadata } from './plaid-flow-input';

function captured(over: Partial<CapturedPlaidMetadata> = {}): CapturedPlaidMetadata {
  return { pfcConfidenceLevel: null, merchantEntityId: null, counterparties: [], ...over };
}

function input(over: Partial<TransactionFactsInput> = {}): TransactionFactsInput {
  return { captured: captured(), pending: false, rowCurrency: 'USD', accountCurrency: 'USD', ...over };
}

// ── paymentChannel ────────────────────────────────────────────────────────────
test('paymentChannel maps online / in store / other; absent→null; unknown→UNKNOWN', () => {
  assert.equal(buildTransactionFacts(input({ captured: captured({ paymentChannel: 'online' }) })).paymentChannel, 'ONLINE');
  assert.equal(buildTransactionFacts(input({ captured: captured({ paymentChannel: 'in store' }) })).paymentChannel, 'IN_STORE');
  assert.equal(buildTransactionFacts(input({ captured: captured({ paymentChannel: 'other' }) })).paymentChannel, 'OTHER');
  assert.equal(buildTransactionFacts(input()).paymentChannel, null);
  assert.equal(buildTransactionFacts(input({ captured: captured({ paymentChannel: 'weird' }) })).paymentChannel, 'UNKNOWN');
});

// ── settlementState ───────────────────────────────────────────────────────────
test('settlementState from pending only', () => {
  assert.equal(buildTransactionFacts(input({ pending: true })).settlementState, 'PENDING');
  assert.equal(buildTransactionFacts(input({ pending: false })).settlementState, 'POSTED');
});

// ── fxApplied ─────────────────────────────────────────────────────────────────
test('fxApplied true / false / null', () => {
  assert.equal(buildTransactionFacts(input({ rowCurrency: 'USD', accountCurrency: 'USD' })).fxApplied, false);
  assert.equal(buildTransactionFacts(input({ rowCurrency: 'EUR', accountCurrency: 'USD' })).fxApplied, true);
  assert.equal(buildTransactionFacts(input({ rowCurrency: null, accountCurrency: 'USD' })).fxApplied, null);
  assert.equal(buildTransactionFacts(input({ rowCurrency: 'USD', accountCurrency: null })).fxApplied, null);
});

// ── authorizedAt passthrough ──────────────────────────────────────────────────
test('authorizedAt parses YYYY-MM-DD; malformed/absent → null', () => {
  const d = buildTransactionFacts(input({ captured: captured({ authorizedDate: '2026-05-31' }) })).authorizedAt;
  assert.ok(d instanceof Date);
  assert.equal(d!.toISOString(), '2026-05-31T00:00:00.000Z');
  assert.equal(buildTransactionFacts(input()).authorizedAt, null);
  assert.equal(buildTransactionFacts(input({ captured: captured({ authorizedDate: 'not-a-date' }) })).authorizedAt, null);
});

// ── counterpartyType ──────────────────────────────────────────────────────────
test('counterpartyType maps provider subset; none→null; unknown→UNKNOWN', () => {
  const cp = (type: string) => captured({ counterparties: [{ name: 'x', entityId: null, type, website: null, logoUrl: null, confidenceLevel: null }] });
  assert.equal(buildTransactionFacts(input({ captured: cp('merchant') })).counterpartyType, 'MERCHANT');
  assert.equal(buildTransactionFacts(input({ captured: cp('financial_institution') })).counterpartyType, 'FINANCIAL_INSTITUTION');
  assert.equal(buildTransactionFacts(input({ captured: cp('income_source') })).counterpartyType, 'INCOME_SOURCE');
  assert.equal(buildTransactionFacts(input()).counterpartyType, null);
  assert.equal(buildTransactionFacts(input({ captured: cp('spaceship') })).counterpartyType, 'UNKNOWN');
});

// ── paymentMethod precedence ──────────────────────────────────────────────────
test('paymentMethod precedence: check > explicit instrument > internal > card > UNKNOWN', () => {
  // 1. check number wins over everything
  assert.equal(buildTransactionFacts(input({ captured: captured({ checkNumber: '4021', paymentMetaMethod: 'ACH', paymentChannel: 'in store' }) })).paymentMethod, 'CHECK');
  // 2. explicit instruments
  assert.equal(buildTransactionFacts(input({ captured: captured({ paymentMetaMethod: 'ACH' }) })).paymentMethod, 'ACH');
  assert.equal(buildTransactionFacts(input({ captured: captured({ paymentMetaMethod: 'wire' }) })).paymentMethod, 'WIRE');
  assert.equal(buildTransactionFacts(input({ captured: captured({ transactionCode: 'direct debit' }) })).paymentMethod, 'ACH');
  assert.equal(buildTransactionFacts(input({ captured: captured({ transactionCode: 'atm' }) })).paymentMethod, 'CASH');
  // 3. internal transfer only with clear flow context
  assert.equal(buildTransactionFacts(input({ flowType: 'TRANSFER', flowDirection: 'INTERNAL' })).paymentMethod, 'INTERNAL_TRANSFER');
  assert.equal(buildTransactionFacts(input({ flowType: 'DEBT_PAYMENT', flowDirection: 'INTERNAL' })).paymentMethod, 'INTERNAL_TRANSFER');
  // a transfer that is NOT internal must not become INTERNAL_TRANSFER
  assert.notEqual(buildTransactionFacts(input({ flowType: 'TRANSFER', flowDirection: 'OUTFLOW' })).paymentMethod, 'INTERNAL_TRANSFER');
  // 4. card signals
  assert.equal(buildTransactionFacts(input({ captured: captured({ transactionCode: 'purchase' }) })).paymentMethod, 'CARD');
  assert.equal(buildTransactionFacts(input({ captured: captured({ paymentChannel: 'in store' }) })).paymentMethod, 'CARD');
  assert.equal(buildTransactionFacts(input({ captured: captured({ paymentMetaMethod: 'credit card' }) })).paymentMethod, 'CARD');
});

test('paymentMethod is UNKNOWN when no signal supports a guess (online alone is not enough)', () => {
  assert.equal(buildTransactionFacts(input()).paymentMethod, 'UNKNOWN');
  assert.equal(buildTransactionFacts(input({ captured: captured({ paymentChannel: 'online' }) })).paymentMethod, 'UNKNOWN');
});

// ── pendingTransactionRef passthrough ─────────────────────────────────────────
test('pendingTransactionRef passes through unchanged; absent → null', () => {
  assert.equal(buildTransactionFacts(input({ captured: captured({ pendingTransactionRef: 'pend_9' }) })).pendingTransactionRef, 'pend_9');
  assert.equal(buildTransactionFacts(input()).pendingTransactionRef, null);
});

// ── version stamping + NULL constant + determinism ────────────────────────────
test('tiFactsVersion is always stamped', () => {
  assert.equal(buildTransactionFacts(input()).tiFactsVersion, TI_FACTS_VERSION);
});

test('NULL_TRANSACTION_FACTS is all-null (including version)', () => {
  assert.deepEqual(NULL_TRANSACTION_FACTS, {
    paymentChannel: null, paymentMethod: null, settlementState: null, authorizedAt: null,
    counterpartyType: null, fxApplied: null, pendingTransactionRef: null, tiFactsVersion: null,
  });
});

test('builder is deterministic (same input → identical output)', () => {
  const i = input({ captured: captured({ paymentChannel: 'in store', authorizedDate: '2026-01-02', pendingTransactionRef: 'p1' }), pending: true, rowCurrency: 'EUR', accountCurrency: 'USD' });
  assert.deepEqual(buildTransactionFacts(i), buildTransactionFacts(i));
});
