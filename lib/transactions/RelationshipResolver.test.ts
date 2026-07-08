/**
 * lib/transactions/RelationshipResolver.test.ts
 *
 * TI4 foundation — pure resolver tests. No DB, no Prisma runtime.
 *   npx tsx --test lib/transactions/RelationshipResolver.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveTransactionRelationships,
  type RelationshipTransaction,
} from './RelationshipResolver';

function tx(over: Partial<RelationshipTransaction> = {}): RelationshipTransaction {
  return {
    id: 'row_1',
    accountId: null,
    financialAccountId: 'fa_1',
    plaidTransactionId: 'plaid_1',
    pendingTransactionRef: null,
    date: new Date('2026-06-01'),
    amount: -12.5,
    merchant: 'Blue Bottle Coffee',
    pending: false,
    deletedAt: null,
    ...over,
  };
}

// ── pending → posted ──────────────────────────────────────────────────────────
test('POSTED_FROM_PENDING: target ref matches a (tombstoned) pending row by plaidTransactionId', () => {
  const posted  = tx({ id: 'posted', plaidTransactionId: 'plaid_posted', pendingTransactionRef: 'plaid_pending', pending: false });
  const pending = tx({ id: 'pending', plaidTransactionId: 'plaid_pending', pending: true, deletedAt: new Date('2026-06-02') });
  const r = resolveTransactionRelationships(posted, [pending]);
  assert.deepEqual(r.pendingPosted, { role: 'POSTED_FROM_PENDING', transactionId: 'pending' });
});

test('PENDING_AWAITING_POST: target is pending and a posted successor points back', () => {
  const pending = tx({ id: 'pending', plaidTransactionId: 'plaid_pending', pending: true });
  const posted  = tx({ id: 'posted', plaidTransactionId: 'plaid_posted', pendingTransactionRef: 'plaid_pending', pending: false });
  const r = resolveTransactionRelationships(pending, [posted]);
  assert.deepEqual(r.pendingPosted, { role: 'PENDING_AWAITING_POST', transactionId: 'posted' });
});

test('pendingPosted is null when no counterpart / ref is absent', () => {
  assert.equal(resolveTransactionRelationships(tx(), [tx({ id: 'other' })]).pendingPosted, null);
  const posted = tx({ pendingTransactionRef: 'nonexistent' });
  assert.equal(resolveTransactionRelationships(posted, [tx({ id: 'x', plaidTransactionId: 'different' })]).pendingPosted, null);
});

// ── duplicate (exact fingerprint) ─────────────────────────────────────────────
test('duplicate: exact fingerprint match (account+date+amount+pending+normalized merchant)', () => {
  const a = tx({ id: 'a' });
  const b = tx({ id: 'b', plaidTransactionId: 'plaid_2', merchant: '  blue bottle   coffee ' }); // case/space differ
  const r = resolveTransactionRelationships(a, [b]);
  assert.deepEqual(r.duplicate, { transactionIds: ['b'] });
});

test('duplicate excludes self, tombstoned, different account/amount/merchant/pending', () => {
  const a = tx({ id: 'a' });
  const candidates = [
    tx({ id: 'a' }),                                               // self — excluded by id !== tx.id
    tx({ id: 'tombstoned', plaidTransactionId: 'p2', deletedAt: new Date() }),
    tx({ id: 'other-account', plaidTransactionId: 'p3', financialAccountId: 'fa_2' }),
    tx({ id: 'other-amount', plaidTransactionId: 'p4', amount: -99 }),
    tx({ id: 'other-merchant', plaidTransactionId: 'p5', merchant: 'Starbucks' }),
    tx({ id: 'other-pending', plaidTransactionId: 'p6', pending: true }),
  ];
  const r = resolveTransactionRelationships(a, candidates);
  assert.equal(r.duplicate, null);
});

test('duplicate returns null when candidate list is empty', () => {
  assert.equal(resolveTransactionRelationships(tx(), []).duplicate, null);
});

test('a pending row and its posted successor are NOT flagged as duplicates', () => {
  // They differ in `pending` and the pending row is tombstoned — both exclusions apply.
  const posted  = tx({ id: 'posted', plaidTransactionId: 'plaid_posted', pendingTransactionRef: 'plaid_pending', pending: false });
  const pending = tx({ id: 'pending', plaidTransactionId: 'plaid_pending', pending: true, deletedAt: new Date() });
  assert.equal(resolveTransactionRelationships(posted, [pending]).duplicate, null);
});

// ── reserved (unratified heuristics) ──────────────────────────────────────────
test('refundCandidate and transferCandidate are always null in this slice', () => {
  const r = resolveTransactionRelationships(tx({ flowType: 'REFUND', amount: 12.5 }), [tx({ id: 'purchase', amount: -12.5 })]);
  assert.equal(r.refundCandidate, null);
  assert.equal(r.transferCandidate, null);
});

// ── contract & determinism ────────────────────────────────────────────────────
test('output shape is exactly the four keys', () => {
  const r = resolveTransactionRelationships(tx(), []);
  assert.deepEqual(Object.keys(r).sort(), ['duplicate', 'pendingPosted', 'refundCandidate', 'transferCandidate']);
});

test('resolver is deterministic and does not mutate inputs', () => {
  const target = tx();
  const candidates = [tx({ id: 'b', plaidTransactionId: 'p2' })];
  const snapshot = JSON.stringify({ target, candidates });
  const r1 = resolveTransactionRelationships(target, candidates);
  const r2 = resolveTransactionRelationships(target, candidates);
  assert.deepEqual(r1, r2);
  assert.equal(JSON.stringify({ target, candidates }), snapshot); // inputs untouched
});
