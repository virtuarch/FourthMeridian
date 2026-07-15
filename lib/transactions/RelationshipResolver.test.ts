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
  matchTransferCandidate,
  type RelationshipTransaction,
} from './RelationshipResolver';

function tx(over: Partial<RelationshipTransaction> = {}): RelationshipTransaction {
  return {
    id: 'row_1',
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

/** A transfer leg: flowType TRANSFER + a currency, on a named account. */
function leg(over: Partial<RelationshipTransaction> = {}): RelationshipTransaction {
  return tx({ flowType: 'TRANSFER', currency: 'USD', plaidTransactionId: null, ...over });
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

// ── reserved (refundCandidate still unratified); a non-transfer row never matches ─
test('refundCandidate stays null; a REFUND row is not transfer-like so no transferCandidate', () => {
  const r = resolveTransactionRelationships(tx({ flowType: 'REFUND', amount: 12.5 }), [tx({ id: 'purchase', amount: -12.5 })]);
  assert.equal(r.refundCandidate, null);
  assert.equal(r.transferCandidate, null);
});

// ── TI4 Slice 1 — deterministic owned-account transfer matching ────────────────
test('checking → savings: unique opposite leg resolves to the counterparty account', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const sav = leg({ id: 'sav', financialAccountId: 'fa_sav', amount: 500 });
  const m = matchTransferCandidate(chk, [sav]);
  assert.equal(m.status, 'RESOLVED');
  assert.equal(m.counterpartyAccountId, 'fa_sav');
  assert.equal(m.transactionId, 'sav');
  assert.equal(m.confidence, 1);
  assert.equal(m.reason, 'DETERMINISTIC_UNIQUE');
});

test('savings → checking: matching is symmetric (opposite direction resolves too)', () => {
  const sav = leg({ id: 'sav', financialAccountId: 'fa_sav', amount: 500 });
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const m = matchTransferCandidate(sav, [chk]);
  assert.equal(m.status, 'RESOLVED');
  assert.equal(m.counterpartyAccountId, 'fa_chk');
});

test('within window (±2 days) resolves; a cent-level amount difference still matches', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500.00, date: new Date('2026-06-01') });
  const sav = leg({ id: 'sav', financialAccountId: 'fa_sav', amount: 500.004, date: new Date('2026-06-03') });
  const m = matchTransferCandidate(chk, [sav]);
  assert.equal(m.status, 'RESOLVED');
  assert.equal(m.counterpartyAccountId, 'fa_sav');
});

test('same absolute amount but SAME direction does not match', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const other = leg({ id: 'other', financialAccountId: 'fa_sav', amount: -500 }); // same sign
  assert.equal(matchTransferCandidate(chk, [other]).status, 'NONE');
});

test('different currencies do not match', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500, currency: 'USD' });
  const eur = leg({ id: 'eur', financialAccountId: 'fa_sav', amount: 500, currency: 'EUR' });
  assert.equal(matchTransferCandidate(chk, [eur]).status, 'NONE');
});

test('a candidate outside the date window does not match', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500, date: new Date('2026-06-01') });
  const far = leg({ id: 'far', financialAccountId: 'fa_sav', amount: 500, date: new Date('2026-06-05') }); // +4d
  assert.equal(matchTransferCandidate(chk, [far]).status, 'NONE');
});

test('same account is never its own counterparty', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const sameAcct = leg({ id: 'x', financialAccountId: 'fa_chk', amount: 500 });
  assert.equal(matchTransferCandidate(chk, [sameAcct]).status, 'NONE');
});

test('multiple equal candidates across DIFFERENT accounts → AMBIGUOUS (refused, not guessed)', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const sav = leg({ id: 'sav', financialAccountId: 'fa_sav', amount: 500 });
  const brk = leg({ id: 'brk', financialAccountId: 'fa_brk', amount: 500 });
  const m = matchTransferCandidate(chk, [sav, brk]);
  assert.equal(m.status, 'AMBIGUOUS');
  assert.equal(m.counterpartyAccountId, null);
  assert.equal(m.reason, 'AMBIGUOUS_MULTIPLE_ACCOUNTS');
});

test('multiple equal candidates within ONE account → account is certain (leg id null)', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const savA = leg({ id: 'savA', financialAccountId: 'fa_sav', amount: 500 });
  const savB = leg({ id: 'savB', financialAccountId: 'fa_sav', amount: 500 });
  const m = matchTransferCandidate(chk, [savA, savB]);
  assert.equal(m.status, 'RESOLVED');
  assert.equal(m.counterpartyAccountId, 'fa_sav');
  assert.equal(m.transactionId, null); // account certain, exact leg is not
});

test('a tombstoned candidate leg is never paired', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const dead = leg({ id: 'dead', financialAccountId: 'fa_sav', amount: 500, deletedAt: new Date('2026-06-02') });
  assert.equal(matchTransferCandidate(chk, [dead]).status, 'NONE');
});

test('a non-transfer target is NOT transfer-like', () => {
  const spend = leg({ id: 's', flowType: 'SPENDING', financialAccountId: 'fa_chk', amount: -500 });
  const sav = leg({ id: 'sav', financialAccountId: 'fa_sav', amount: 500 });
  const m = matchTransferCandidate(spend, [sav]);
  assert.equal(m.status, 'NONE');
  assert.equal(m.reason, 'NOT_TRANSFER_LIKE');
});

test('resolveTransactionRelationships surfaces a RESOLVED match but hides AMBIGUOUS as null', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const sav = leg({ id: 'sav', financialAccountId: 'fa_sav', amount: 500 });
  const brk = leg({ id: 'brk', financialAccountId: 'fa_brk', amount: 500 });
  assert.equal(resolveTransactionRelationships(chk, [sav]).transferCandidate?.counterpartyAccountId, 'fa_sav');
  assert.equal(resolveTransactionRelationships(chk, [sav, brk]).transferCandidate, null); // ambiguous → null
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
