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
    // V27-TRUTH-2 — the canonical authority's required leg facts. Defaults are the
    // benign case: one owner, settled, no movement form.
    ownerUserId: 'user_1',
    settlementState: 'POSTED',
    pfcDetailed: null,
    ...over,
  };
}

/** Account types for the matcher context. Tests override per case. */
const CTX = {
  accountTypeById: new Map<string, string>([
    ['fa_1', 'checking'], ['fa_2', 'savings'], ['fa_3', 'debt'],
    ['fa_a', 'checking'], ['fa_b', 'savings'], ['fa_c', 'debt'],
    ['fa_chk', 'checking'], ['fa_sav', 'savings'], ['fa_brk', 'investment'],
  ]),
};

/** A transfer leg: flowType TRANSFER + a currency, on a named account. */
function leg(over: Partial<RelationshipTransaction> = {}): RelationshipTransaction {
  return tx({ flowType: 'TRANSFER', currency: 'USD', plaidTransactionId: null, ...over });
}

// ── pending → posted ──────────────────────────────────────────────────────────
test('POSTED_FROM_PENDING: target ref matches a (tombstoned) pending row by plaidTransactionId', () => {
  const posted  = tx({ id: 'posted', plaidTransactionId: 'plaid_posted', pendingTransactionRef: 'plaid_pending', pending: false });
  const pending = tx({ id: 'pending', plaidTransactionId: 'plaid_pending', pending: true, deletedAt: new Date('2026-06-02') });
  const r = resolveTransactionRelationships(posted, [pending], CTX);
  assert.deepEqual(r.pendingPosted, { role: 'POSTED_FROM_PENDING', transactionId: 'pending' });
});

test('PENDING_AWAITING_POST: target is pending and a posted successor points back', () => {
  const pending = tx({ id: 'pending', plaidTransactionId: 'plaid_pending', pending: true });
  const posted  = tx({ id: 'posted', plaidTransactionId: 'plaid_posted', pendingTransactionRef: 'plaid_pending', pending: false });
  const r = resolveTransactionRelationships(pending, [posted], CTX);
  assert.deepEqual(r.pendingPosted, { role: 'PENDING_AWAITING_POST', transactionId: 'posted' });
});

test('pendingPosted is null when no counterpart / ref is absent', () => {
  assert.equal(resolveTransactionRelationships(tx(), [tx({ id: 'other' })], CTX).pendingPosted, null);
  const posted = tx({ pendingTransactionRef: 'nonexistent' });
  assert.equal(resolveTransactionRelationships(posted, [tx({ id: 'x', plaidTransactionId: 'different' })], CTX).pendingPosted, null);
});

// ── duplicate (exact fingerprint) ─────────────────────────────────────────────
test('duplicate: exact fingerprint match (account+date+amount+pending+normalized merchant)', () => {
  const a = tx({ id: 'a' });
  const b = tx({ id: 'b', plaidTransactionId: 'plaid_2', merchant: '  blue bottle   coffee ' }); // case/space differ
  const r = resolveTransactionRelationships(a, [b], CTX);
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
  const r = resolveTransactionRelationships(a, candidates, CTX);
  assert.equal(r.duplicate, null);
});

test('duplicate returns null when candidate list is empty', () => {
  assert.equal(resolveTransactionRelationships(tx(), [], CTX).duplicate, null);
});

test('a pending row and its posted successor are NOT flagged as duplicates', () => {
  // They differ in `pending` and the pending row is tombstoned — both exclusions apply.
  const posted  = tx({ id: 'posted', plaidTransactionId: 'plaid_posted', pendingTransactionRef: 'plaid_pending', pending: false });
  const pending = tx({ id: 'pending', plaidTransactionId: 'plaid_pending', pending: true, deletedAt: new Date() });
  assert.equal(resolveTransactionRelationships(posted, [pending], CTX).duplicate, null);
});

// ── reserved (refundCandidate still unratified); a non-transfer row never matches ─
test('refundCandidate stays null; a REFUND row is not transfer-like so no transferCandidate', () => {
  const r = resolveTransactionRelationships(tx({ flowType: 'REFUND', amount: 12.5 }), [tx({ id: 'purchase', amount: -12.5 })], CTX);
  assert.equal(r.refundCandidate, null);
  assert.equal(r.transferCandidate, null);
});

// ── TI4 Slice 1 — deterministic owned-account transfer matching ────────────────
test('checking → savings: unique opposite leg resolves to the counterparty account', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const sav = leg({ id: 'sav', financialAccountId: 'fa_sav', amount: 500 });
  const m = matchTransferCandidate(chk, [sav], CTX);
  assert.equal(m.status, 'RESOLVED');
  assert.equal(m.counterpartyAccountId, 'fa_sav');
  assert.equal(m.transactionId, 'sav');
  assert.equal(m.confidence, 1);
  assert.equal(m.reason, 'DETERMINISTIC_UNIQUE');
});

test('savings → checking: matching is symmetric (opposite direction resolves too)', () => {
  const sav = leg({ id: 'sav', financialAccountId: 'fa_sav', amount: 500 });
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const m = matchTransferCandidate(sav, [chk], CTX);
  assert.equal(m.status, 'RESOLVED');
  assert.equal(m.counterpartyAccountId, 'fa_chk');
});

test('within window (±2 days) resolves; a cent-level amount difference still matches', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500.00, date: new Date('2026-06-01') });
  const sav = leg({ id: 'sav', financialAccountId: 'fa_sav', amount: 500.004, date: new Date('2026-06-03') });
  const m = matchTransferCandidate(chk, [sav], CTX);
  assert.equal(m.status, 'RESOLVED');
  assert.equal(m.counterpartyAccountId, 'fa_sav');
});

test('same absolute amount but SAME direction does not match', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const other = leg({ id: 'other', financialAccountId: 'fa_sav', amount: -500 }); // same sign
  assert.equal(matchTransferCandidate(chk, [other], CTX).status, 'NONE');
});

test('different currencies do not match', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500, currency: 'USD' });
  const eur = leg({ id: 'eur', financialAccountId: 'fa_sav', amount: 500, currency: 'EUR' });
  assert.equal(matchTransferCandidate(chk, [eur], CTX).status, 'NONE');
});

test('a candidate outside the date window does not match', () => {
  // V27-L4D — the window widened from 2 to 5 days (evidence-derived; see
  // lib/transactions/transfer-maturation.ts). The INVARIANT is unchanged — a leg
  // outside the window does not match — so the fixture moves to a genuinely
  // outside distance rather than the assertion being weakened.
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500, date: new Date('2026-06-01') });
  const far = leg({ id: 'far', financialAccountId: 'fa_sav', amount: 500, date: new Date('2026-06-08') }); // +7d
  assert.equal(matchTransferCandidate(chk, [far], CTX).status, 'NONE');
});

test('V27-L4D: a 3-day skew DOES match — the real Chase→Amex-HYSA distance', () => {
  // The live case the old 2-day window could never see: destination posted
  // 2026-07-31, source pending 2026-08-03.
  const source = leg({ id: 'src', financialAccountId: 'fa_chk', amount: -4000, date: new Date('2026-08-03') });
  const dest   = leg({ id: 'dst', financialAccountId: 'fa_hysa', amount: 4000, date: new Date('2026-07-31') });
  const r = matchTransferCandidate(source, [dest], CTX);
  assert.equal(r.status, 'RESOLVED');
  assert.equal(r.counterpartyAccountId, 'fa_hysa');
});

test('V27-L4D: destination BEFORE source is supported (distance is absolute)', () => {
  const source = leg({ id: 'src', financialAccountId: 'fa_chk', amount: -4000, date: new Date('2026-08-03') });
  const before = leg({ id: 'b', financialAccountId: 'fa_hysa', amount: 4000, date: new Date('2026-07-31') });
  const after  = leg({ id: 'a', financialAccountId: 'fa_hysa', amount: 4000, date: new Date('2026-08-06') });
  assert.equal(matchTransferCandidate(source, [before], CTX).status, 'RESOLVED');
  assert.equal(matchTransferCandidate(source, [after], CTX).status, 'RESOLVED');
});

test('V27-L4C: a DEBT_PAYMENT leg is admitted as a transfer candidate', () => {
  // The source leg is stored as DEBT_PAYMENT — the classification that excluded
  // it from its own repair. Admission is not resolution: what it MEANS is then
  // decided by the destination account type, in transfer-maturation.
  const source = leg({ id: 'src', financialAccountId: 'fa_chk', amount: -4000, flowType: 'DEBT_PAYMENT' });
  const dest   = leg({ id: 'dst', financialAccountId: 'fa_hysa', amount: 4000, flowType: 'TRANSFER' });
  const r = matchTransferCandidate(source, [dest], CTX);
  assert.equal(r.status, 'RESOLVED');
  assert.equal(r.counterpartyAccountId, 'fa_hysa');
});

test('V27-L4C: SPENDING is still never a transfer leg', () => {
  const spend = leg({ id: 's', financialAccountId: 'fa_chk', amount: -500, flowType: 'SPENDING' });
  const dest  = leg({ id: 'd', financialAccountId: 'fa_sav', amount: 500, flowType: 'TRANSFER' });
  assert.equal(matchTransferCandidate(spend, [dest], CTX).status, 'NONE');
  const target = leg({ id: 't', financialAccountId: 'fa_chk', amount: -500, flowType: 'TRANSFER' });
  const spendCandidate = leg({ id: 'sc', financialAccountId: 'fa_sav', amount: 500, flowType: 'SPENDING' });
  assert.equal(matchTransferCandidate(target, [spendCandidate], CTX).status, 'NONE');
});

test('same account is never its own counterparty', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const sameAcct = leg({ id: 'x', financialAccountId: 'fa_chk', amount: 500 });
  assert.equal(matchTransferCandidate(chk, [sameAcct], CTX).status, 'NONE');
});

test('multiple equal candidates across DIFFERENT accounts → AMBIGUOUS (refused, not guessed)', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const sav = leg({ id: 'sav', financialAccountId: 'fa_sav', amount: 500 });
  const brk = leg({ id: 'brk', financialAccountId: 'fa_brk', amount: 500 });
  const m = matchTransferCandidate(chk, [sav, brk], CTX);
  assert.equal(m.status, 'AMBIGUOUS');
  assert.equal(m.counterpartyAccountId, null);
  assert.equal(m.reason, 'AMBIGUOUS_MULTIPLE_ACCOUNTS');
});

test('multiple equal candidates within ONE account → NOT account-certain (V27-TRUTH-2)', () => {
  // This test asserted RESOLVED with a null leg id. That was the one-directional
  // reading: "one destination ACCOUNT" was treated as certainty even though the
  // PAIRING was not unique. The canonical authority now requires mutual
  // uniqueness, so two rival legs — even in the same account — refuse the id.
  // The destination TYPE survives and is surfaced; the account is not invented.
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const savA = leg({ id: 'savA', financialAccountId: 'fa_sav', amount: 500 });
  const savB = leg({ id: 'savB', financialAccountId: 'fa_sav', amount: 500 });
  const m = matchTransferCandidate(chk, [savA, savB], CTX);
  assert.equal(m.status, 'AMBIGUOUS');
  assert.equal(m.counterpartyAccountId, null);
  assert.equal(m.transactionId, null);
  // One ACCOUNT, rival legs — the more precise refusal of the two.
  assert.equal(m.reason, 'NOT_MUTUALLY_UNIQUE');
  assert.equal(m.destinationAccountType, 'savings');
  assert.equal(m.maturity, 'SAVINGS_TRANSFER');
});

test('a MUTUALLY unique pairing still resolves (the veto is not a blanket refusal)', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const sav = leg({ id: 'sav', financialAccountId: 'fa_sav', amount: 500 });
  const m = matchTransferCandidate(chk, [sav], CTX);
  assert.equal(m.status, 'RESOLVED');
  assert.equal(m.counterpartyAccountId, 'fa_sav');
  assert.equal(m.transactionId, 'sav');
  assert.equal(m.evidenceLevel, 'ACCOUNT_CERTAIN');
});

test('a CASH movement never receives an account counterparty (V27-TRUTH-2)', () => {
  // The live ATM withdrawal: a perfectly-matched opposite leg exists, and the
  // read path must still refuse, exactly as the repair boundary does.
  const atm = leg({ id: 'atm', financialAccountId: 'fa_chk', amount: -500, pfcDetailed: 'TRANSFER_OUT_WITHDRAWAL' });
  const card = leg({ id: 'card', financialAccountId: 'fa_sav', amount: 500 });
  const m = matchTransferCandidate(atm, [card], CTX);
  assert.equal(m.status, 'NONE');
  assert.equal(m.counterpartyAccountId, null);
  assert.equal(m.reason, 'CASH_MOVEMENT_NO_COUNTERPARTY');
  assert.equal(m.maturity, 'CASH_MOVEMENT');
});

test('a superseded (tombstoned) leg is dropped by the authority, not by this module', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const dead = leg({ id: 'dead', financialAccountId: 'fa_sav', amount: 500, deletedAt: new Date('2026-06-02'), pending: true, settlementState: 'PENDING' });
  const m = matchTransferCandidate(chk, [dead], CTX);
  assert.equal(m.status, 'NONE');
  assert.equal(m.reason, 'NO_CANDIDATE');
});

test('legs belonging to DIFFERENT owners never pair', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500, ownerUserId: 'user_1' });
  const other = leg({ id: 'other', financialAccountId: 'fa_sav', amount: 500, ownerUserId: 'user_2' });
  assert.equal(matchTransferCandidate(chk, [other], CTX).status, 'NONE');
});

test('a tombstoned candidate leg is never paired', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const dead = leg({ id: 'dead', financialAccountId: 'fa_sav', amount: 500, deletedAt: new Date('2026-06-02') });
  assert.equal(matchTransferCandidate(chk, [dead], CTX).status, 'NONE');
});

test('a non-transfer target is NOT transfer-like', () => {
  const spend = leg({ id: 's', flowType: 'SPENDING', financialAccountId: 'fa_chk', amount: -500 });
  const sav = leg({ id: 'sav', financialAccountId: 'fa_sav', amount: 500 });
  const m = matchTransferCandidate(spend, [sav], CTX);
  assert.equal(m.status, 'NONE');
  assert.equal(m.reason, 'NOT_TRANSFER_LIKE');
});

test('resolveTransactionRelationships surfaces a RESOLVED match but hides AMBIGUOUS as null', () => {
  const chk = leg({ id: 'chk', financialAccountId: 'fa_chk', amount: -500 });
  const sav = leg({ id: 'sav', financialAccountId: 'fa_sav', amount: 500 });
  const brk = leg({ id: 'brk', financialAccountId: 'fa_brk', amount: 500 });
  assert.equal(resolveTransactionRelationships(chk, [sav], CTX).transferCandidate?.counterpartyAccountId, 'fa_sav');
  assert.equal(resolveTransactionRelationships(chk, [sav, brk], CTX).transferCandidate, null); // ambiguous → null
});

// ── contract & determinism ────────────────────────────────────────────────────
test('output shape is exactly the five keys', () => {
  const r = resolveTransactionRelationships(tx(), [], CTX);
  // V27-TRUTH-2 adds `transferAssessment` — the FULL outcome including refusals,
  // so a surface can state what is known without reading a fabricated id.
  assert.deepEqual(Object.keys(r).sort(), ['duplicate', 'pendingPosted', 'refundCandidate', 'transferAssessment', 'transferCandidate']);
  assert.equal(r.transferCandidate, null);
  assert.equal(r.transferAssessment.counterpartyAccountId, null);
});

test('resolver is deterministic and does not mutate inputs', () => {
  const target = tx();
  const candidates = [tx({ id: 'b', plaidTransactionId: 'p2' })];
  const snapshot = JSON.stringify({ target, candidates });
  const r1 = resolveTransactionRelationships(target, candidates, CTX);
  const r2 = resolveTransactionRelationships(target, candidates, CTX);
  assert.deepEqual(r1, r2);
  assert.equal(JSON.stringify({ target, candidates }), snapshot); // inputs untouched
});
