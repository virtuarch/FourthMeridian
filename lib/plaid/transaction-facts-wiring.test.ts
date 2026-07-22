/**
 * lib/plaid/transaction-facts-wiring.test.ts
 *
 * TI2-4 — proves the sync WRITE-MERGE contract that wires buildTransactionFacts
 * into syncTransactions.ts, without a DB (mirroring how FlowType P3 tested its
 * builder in isolation; there is no DB-level sync harness in this repo).
 *
 * The wiring in syncTransactions.ts is:
 *   baseFields = { ...core, ...factFields }          // factFields ride baseFields
 *   create:            { ...baseFields, category, plaidTransactionId, ...mi }
 *   modified-update:   { ...baseFields, deletedAt: null, ...mi }
 *   fingerprint-update:{ ...baseFields, plaidTransactionId, ...mi }
 * where `mi` carries ONLY category/flow/merchant columns. This suite reproduces
 * that merge and asserts the invariants that make the three paths correct.
 *
 *   npx tsx --test lib/plaid/transaction-facts-wiring.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTransactionFacts, NULL_TRANSACTION_FACTS } from '../transactions/transaction-facts';
import { buildFlowWriteFields, NULL_FLOW_WRITE_FIELDS, type CapturedPlaidMetadata } from '../transactions/plaid-flow-input';
import { classifyFlow } from '../transactions/flow-classifier';

const FACT_KEYS = [
  'paymentChannel', 'paymentMethod', 'settlementState', 'authorizedAt',
  'counterpartyType', 'fxApplied', 'pendingTransactionRef', 'tiFactsVersion',
];

function captured(over: Partial<CapturedPlaidMetadata> = {}): CapturedPlaidMetadata {
  return { pfcConfidenceLevel: null, merchantEntityId: null, counterparties: [], ...over };
}

// Reproduce the sync assembly for a card-in-store purchase row.
function assemble() {
  const cap = captured({ paymentChannel: 'in store', authorizedDate: '2026-06-01', pendingTransactionRef: 'pend_1' });
  const input = { category: 'Dining', amount: -12.5, accountType: 'depository', debtSubtype: null };
  const classification = classifyFlow(input);
  const flowFields = buildFlowWriteFields(classification, input, cap, 1);
  const factFields = buildTransactionFacts({
    captured: cap, pending: false, rowCurrency: 'USD', accountCurrency: 'USD',
    flowType: classification.flowType, flowDirection: classification.flowDirection,
  });
  const core = { financialAccountId: 'fa_1', date: new Date('2026-06-01'), merchant: 'Cafe', description: 'CAFE', amount: -12.5, pending: false, currency: 'USD' };
  const baseFields = { ...core, ...factFields };
  const miNormal = { category: 'Dining', ...flowFields, categorySource: 'PLAID_PFC' };
  const miFailureFallback = { category: 'Dining', ...flowFields }; // miData catch branch
  return { factFields, flowFields, baseFields, miNormal, miFailureFallback };
}

test('all three write payloads carry the TI fact fields', () => {
  const { baseFields, miNormal } = assemble();
  const createData = { ...baseFields, plaidTransactionId: 't1', ...miNormal };
  const updateData = { ...baseFields, deletedAt: null, ...miNormal };
  const fingerprintData = { ...baseFields, plaidTransactionId: 't1', ...miNormal };
  for (const data of [createData, updateData, fingerprintData]) {
    assert.equal((data as Record<string, unknown>).paymentChannel, 'IN_STORE');
    assert.equal((data as Record<string, unknown>).settlementState, 'POSTED');
    assert.equal((data as Record<string, unknown>).tiFactsVersion, 1);
    assert.equal((data as Record<string, unknown>).pendingTransactionRef, 'pend_1');
  }
});

test('TI facts still persist when Merchant Intelligence resolution fails', () => {
  const { baseFields, miFailureFallback } = assemble();
  // create with the MI-failure fallback `mi` (category+flow only, no MI columns)
  const data = { ...baseFields, plaidTransactionId: 't1', ...miFailureFallback } as Record<string, unknown>;
  assert.equal(data.paymentChannel, 'IN_STORE');
  assert.equal(data.tiFactsVersion, 1);
  assert.equal(data.settlementState, 'POSTED');
});

test('TI fact fields are DISJOINT from FlowType write fields', () => {
  const { factFields, flowFields } = assemble();
  const flowKeys = new Set(Object.keys(flowFields));
  for (const k of Object.keys(factFields)) {
    assert.ok(!flowKeys.has(k), `fact field ${k} collides with a flow field`);
  }
});

test('fact fields do not carry category/merchant (independent of MI, not recomputed in miData)', () => {
  const { factFields } = assemble();
  for (const forbidden of ['category', 'merchantId', 'categorySource', 'categoryRuleId', 'flowType']) {
    assert.ok(!(forbidden in factFields), `fact fields must not contain ${forbidden}`);
  }
});

test('fact fields contain EXACTLY the 8 approved columns — no raw metadata / PII keys', () => {
  const { factFields } = assemble();
  assert.deepEqual(Object.keys(factFields).sort(), [...FACT_KEYS].sort());
  const blob = JSON.stringify(factFields);
  for (const banned of ['providerMetadata', 'counterparties', 'payment_meta', 'account_owner', 'location', 'account_numbers', 'phone']) {
    assert.ok(!blob.includes(banned), `raw/PII key leaked into fact fields: ${banned}`);
  }
});

test('degradation objects mirror each other (facts null ⇔ flow null path)', () => {
  assert.equal(NULL_TRANSACTION_FACTS.tiFactsVersion, null);
  assert.equal(NULL_FLOW_WRITE_FIELDS.flowType, null);
});
