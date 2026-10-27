/**
 * lib/ai/conversation/tools/transactions.nature.test.ts   (v2.7-P0)
 *
 * `get_transactions` flow membership and row explanation come from THE resolved-
 * nature contract (lib/transactions/resolved-nature.ts), not the stored column — so
 * a historical, unrepaired Chase → Amex HYSA leg (stored DEBT_PAYMENT) is a
 * transfer, never a card payment, and the AI is told so in plain words.
 *
 * Pure: the filter and lookup are exercised directly; no DB, no model.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/conversation/tools/transactions.nature.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction } from '@/types';
import { accountTypeLookupOf, filterByResolvedFlow, RESOLVED_FLOW_MEMBERSHIP } from './transactions';
import { NATURE_DESCRIPTION, natureEvidenceFromRow, resolveTransactionNature } from '@/lib/transactions/resolved-nature';

const accountTypeOf = accountTypeLookupOf([
  { id: 'chaseChk', type: 'checking' }, { id: 'schwabChk', type: 'checking' }, { id: 'amexChk', type: 'checking' },
  { id: 'amexHysa', type: 'savings' }, { id: 'chaseCard', type: 'debt' }, { id: 'autoLoan', type: 'debt' },
] as never);

let n = 0;
const tx = (accountId: string, amount: number, over: Partial<Transaction>): Transaction => ({
  id: `t${++n}`, accountId, date: '2026-10-24', amount, merchant: 'RAW', category: 'Transfer' as Transaction['category'],
  pending: false, flowAuthority: 'CLASSIFIER', ...over,
} as Transaction);
const DP = 'DEBT_PAYMENT' as Transaction['flowType'];
const TR = 'TRANSFER' as Transaction['flowType'];

/** The READ population for both resolved flows: every stored DEBT_PAYMENT / TRANSFER row in the window. */
const WINDOW: Transaction[] = [
  tx('chaseChk', -1500, { id: 'hysaUnpaired', flowType: DP, category: 'Payment' as Transaction['category'], transferMaturity: 'SAVINGS_TRANSFER', pending: true }),
  tx('chaseChk', -125.41, { id: 'hysaPaired', flowType: DP, category: 'Payment' as Transaction['category'], transferMaturity: 'SAVINGS_TRANSFER', counterpartyAccountId: 'amexHysa' }),
  tx('chaseChk', -747.26, { id: 'amexChk', flowType: DP, category: 'Payment' as Transaction['category'], transferMaturity: 'CASH_TRANSFER', counterpartyAccountId: 'amexChk' }),
  tx('chaseChk', -1500, { id: 'schwab', flowType: TR, transferMaturity: 'CASH_TRANSFER', counterpartyAccountId: 'schwabChk' }),
  tx('chaseChk', -300, { id: 'cardCash', flowType: DP, category: 'Payment' as Transaction['category'], transferMaturity: 'DEBT_PAYMENT', counterpartyAccountId: 'chaseCard' }),
  tx('chaseCard', 300, { id: 'cardLeg', flowType: DP, category: 'Payment' as Transaction['category'], counterpartyAccountId: 'chaseChk' }),
  tx('chaseChk', -450, { id: 'loanCash', flowType: DP, category: 'Payment' as Transaction['category'], counterpartyAccountId: 'autoLoan' }),
  tx('chaseChk', -150, { id: 'apple', flowType: TR, transferMaturity: 'EXTERNAL_PERSON_TRANSFER' }),
  tx('chaseChk', -900, { id: 'unattested', flowType: DP, category: 'Payment' as Transaction['category'] }),
  tx('chaseChk', -125.41, { id: 'userPayment', flowType: DP, category: 'Payment' as Transaction['category'], categorySource: 'USER_OVERRIDE', transferMaturity: 'SAVINGS_TRANSFER', counterpartyAccountId: 'amexHysa' }),
];

const ids = (rows: Transaction[]) => rows.map((r) => r.id).sort();

test('card_payments = liability payments only (card + loan legs, and a human "Payment")', () => {
  assert.deepEqual(ids(filterByResolvedFlow(WINDOW, 'card_payments', accountTypeOf)),
    ['cardCash', 'cardLeg', 'loanCash', 'userPayment']);
});

test('transfers = every other movement, INCLUDING the historical unrepaired Amex pulls', () => {
  assert.deepEqual(ids(filterByResolvedFlow(WINDOW, 'transfers', accountTypeOf)),
    ['amexChk', 'apple', 'hysaPaired', 'hysaUnpaired', 'schwab', 'unattested']);
});

test('the two flows partition the read population exactly — nothing counted twice, nothing dropped', () => {
  const a = filterByResolvedFlow(WINDOW, 'card_payments', accountTypeOf);
  const b = filterByResolvedFlow(WINDOW, 'transfers', accountTypeOf);
  assert.equal(a.length + b.length, WINDOW.length);
  assert.equal(new Set([...a, ...b].map((r) => r.id)).size, WINDOW.length);
});

test('count === list: the count the tool reports is the length of the very list it filters (one predicate)', () => {
  for (const flow of Object.keys(RESOLVED_FLOW_MEMBERSHIP)) {
    const list = filterByResolvedFlow(WINDOW, flow, accountTypeOf);
    const counted = WINDOW.filter((r) => RESOLVED_FLOW_MEMBERSHIP[flow](resolveTransactionNature(natureEvidenceFromRow(r, accountTypeOf)))).length;
    assert.equal(list.length, counted, flow);
  }
});

test('the AI explanation of each row (natureNote) never calls an internal transfer a debt payment', () => {
  for (const id of ['hysaUnpaired', 'hysaPaired', 'amexChk', 'schwab']) {
    const r = WINDOW.find((x) => x.id === id)!;
    const nature = resolveTransactionNature(natureEvidenceFromRow(r, accountTypeOf)).nature;
    const note = NATURE_DESCRIPTION[nature];
    assert.match(note, /^Moved between your own accounts/, id);
    assert.ok(!/lowers what is owed|paid down|toward a card/i.test(note), id);
  }
  const card = resolveTransactionNature(natureEvidenceFromRow(WINDOW.find((x) => x.id === 'cardCash')!, accountTypeOf)).nature;
  assert.match(NATURE_DESCRIPTION[card], /lowers what is owed/);
  const amb = resolveTransactionNature(natureEvidenceFromRow(WINDOW.find((x) => x.id === 'unattested')!, accountTypeOf)).nature;
  assert.match(NATURE_DESCRIPTION[amb], /purpose is not established/);
});

test('without an account lookup nothing is invented: unattested legs stay unclassified, never a payment', () => {
  const noTypes = () => undefined;
  const cards = filterByResolvedFlow(WINDOW, 'card_payments', noTypes).map((r) => r.id).sort();
  // Only rows whose evidence ITSELF attests a liability destination survive.
  assert.deepEqual(cards, ['cardCash', 'userPayment']);
});
