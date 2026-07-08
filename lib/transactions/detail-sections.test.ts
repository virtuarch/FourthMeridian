/**
 * lib/transactions/detail-sections.test.ts
 *
 * TI5-3B — pure tests for the detail-section projection.
 *   npx tsx --test lib/transactions/detail-sections.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTransactionDetailSections } from './detail-sections';
import type { TransactionDetail } from '@/types';

function detail(over: Partial<TransactionDetail> = {}): TransactionDetail {
  const base = {
    id: 't1', accountId: 'a1', date: '2026-06-01',
    merchant: 'BLUE BOTTLE', merchantDisplayName: 'Blue Bottle Coffee', merchantLogoUrl: null,
    category: 'Dining', amount: -12.5, pending: false, currency: 'USD',
    flowType: 'SPENDING', flowDirection: 'OUTFLOW',
    classificationConfidence: 0.8, classificationReason: 'PLAID_PFC_PRIMARY', classifierVersion: 1,
    pfcPrimary: 'FOOD_AND_DRINK', pfcDetailed: 'FOOD_AND_DRINK_COFFEE', pfcConfidenceLevel: 'HIGH',
    createdAt: '2026-06-01T10:00:00.000Z',
    paymentChannel: null, paymentMethod: null, settlementState: 'POSTED',
    authorizedAt: null, counterpartyType: null, fxApplied: null,
    pendingTransactionRef: null, tiFactsVersion: 1,
    account: { id: 'a1', name: 'Everyday Checking', institution: 'Chase', mask: '1234', type: 'checking', legacy: false },
    provenance: { source: 'plaid' },
    counterparty: null,
    reporting: null,
    relationships: { pendingPosted: null, duplicate: null, refundCandidate: null, transferCandidate: null },
  };
  return { ...base, ...over } as unknown as TransactionDetail;
}

const find = (secs: ReturnType<typeof buildTransactionDetailSections>, title: string) => secs.find((s) => s.title === title);

test('Summary always renders merchant/amount/date/category; flow when present', () => {
  const secs = buildTransactionDetailSections(detail());
  const s = find(secs, 'Summary')!;
  const labels = s.rows!.map((r) => r.label);
  assert.deepEqual(labels, ['Merchant', 'Amount', 'Date', 'Category', 'Flow']);
  assert.equal(s.rows!.find((r) => r.label === 'Amount')!.value, '−$12.50');
  assert.equal(s.rows!.find((r) => r.label === 'Flow')!.value, 'Spending · Outflow');
});

test('null facts are hidden; Flow row absent when flowType null', () => {
  const secs = buildTransactionDetailSections(detail({ flowType: null, flowDirection: null }));
  const s = find(secs, 'Summary')!;
  assert.ok(!s.rows!.some((r) => r.label === 'Flow'));
});

test('Account shows mask formatted; omits mask when null', () => {
  assert.equal(find(buildTransactionDetailSections(detail()), 'Account')!.rows!.find((r) => r.label === 'Mask')!.value, '••••1234');
  const noMask = detail({ account: { id: 'a1', name: 'A', institution: 'B', mask: null, type: 'checking', legacy: false } });
  assert.ok(!find(buildTransactionDetailSections(noMask), 'Account')!.rows!.some((r) => r.label === 'Mask'));
});

test('Transaction Intelligence: supported facts render; section omitted when all null', () => {
  const rich = detail({ paymentChannel: 'IN_STORE', paymentMethod: 'CARD', counterpartyType: 'MERCHANT', authorizedAt: '2026-05-31', fxApplied: true });
  const ti = find(buildTransactionDetailSections(rich), 'Transaction Intelligence')!;
  const map = Object.fromEntries(ti.rows!.map((r) => [r.label, r.value]));
  assert.equal(map['Payment channel'], 'In store');
  assert.equal(map['Payment method'], 'Card');
  assert.equal(map['Counterparty'], 'Merchant');
  assert.equal(map['Authorized'], '2026-05-31');
  assert.equal(map['Posted'], '2026-06-01');
  assert.equal(map['Foreign exchange'], 'Yes');
  // Section omitted entirely when every TI fact is null (only settlementState null too).
  const bare = detail({ settlementState: null });
  assert.equal(find(buildTransactionDetailSections(bare), 'Transaction Intelligence'), undefined);
});

test('fxApplied false/null is not shown; tiFactsVersion never shown', () => {
  const ti = find(buildTransactionDetailSections(detail({ paymentChannel: 'ONLINE', fxApplied: false })), 'Transaction Intelligence')!;
  assert.ok(!ti.rows!.some((r) => r.label === 'Foreign exchange'));
  for (const s of buildTransactionDetailSections(detail({ paymentChannel: 'ONLINE' }))) {
    assert.ok(!s.rows?.some((r) => /version/i.test(r.label)));
  }
});

test('pendingPosted wording — no amount claim', () => {
  const posted = detail({ authorizedAt: '2026-05-30', relationships: { pendingPosted: { role: 'POSTED_FROM_PENDING', transactionId: 'x' }, duplicate: null, refundCandidate: null, transferCandidate: null } });
  const notes = find(buildTransactionDetailSections(posted), 'Relationship Intelligence')!.notes!;
  assert.equal(notes[0], 'Posted from a pending transaction. Authorized 2026-05-30, posted 2026-06-01.');
  assert.ok(!/amount/i.test(notes.join(' ')));
  const pending = detail({ relationships: { pendingPosted: { role: 'PENDING_AWAITING_POST', transactionId: 'x' }, duplicate: null, refundCandidate: null, transferCandidate: null } });
  assert.equal(find(buildTransactionDetailSections(pending), 'Relationship Intelligence')!.notes![0], 'A posted version of this pending transaction exists.');
});

test('duplicate wording is hedged, counts, pluralizes', () => {
  const one = detail({ relationships: { pendingPosted: null, duplicate: { transactionIds: ['a'] }, refundCandidate: null, transferCandidate: null } });
  assert.equal(find(buildTransactionDetailSections(one), 'Relationship Intelligence')!.notes![0], 'Possible duplicate — appears to match 1 other transaction on 2026-06-01.');
  const two = detail({ relationships: { pendingPosted: null, duplicate: { transactionIds: ['a', 'b'] }, refundCandidate: null, transferCandidate: null } });
  const note = find(buildTransactionDetailSections(two), 'Relationship Intelligence')!.notes![0];
  assert.match(note, /Possible duplicate/);
  assert.match(note, /2 other transactions/);
  assert.ok(!/\bduplicate\b(?!.*possible)/i.test(note.replace('Possible duplicate', ''))); // never a bare certain "duplicate"
});

test('refundCandidate / transferCandidate (null) never render a section', () => {
  assert.equal(find(buildTransactionDetailSections(detail()), 'Relationship Intelligence'), undefined);
});

test('Provenance: source always; import fields when import', () => {
  assert.equal(find(buildTransactionDetailSections(detail()), 'Provenance')!.rows!.find((r) => r.label === 'Source')!.value, 'Plaid');
  const imp = detail({ provenance: { source: 'import', importSource: 'CSV', importFilename: 'jan.csv', importedAt: '2026-06-02T00:00:00.000Z' } });
  const rows = find(buildTransactionDetailSections(imp), 'Provenance')!.rows!;
  assert.equal(rows.find((r) => r.label === 'Import')!.value, 'Csv');
  assert.equal(rows.find((r) => r.label === 'File')!.value, 'jan.csv');
  assert.equal(rows.find((r) => r.label === 'Imported')!.value, '2026-06-02');
});

test('Reporting section omitted when null; present when set', () => {
  assert.equal(find(buildTransactionDetailSections(detail()), 'Reporting'), undefined);
  const rep = detail({ reporting: { amount: 11.2, currency: 'EUR', estimated: true, rate: 0.9, effectiveDateISO: '2026-06-01' } });
  const rows = find(buildTransactionDetailSections(rep), 'Reporting')!.rows!;
  assert.match(rows.find((r) => r.label === 'Reporting amount')!.value, /€11\.20.*est/);
});

test('no section is ever empty', () => {
  for (const s of buildTransactionDetailSections(detail())) {
    assert.ok((s.rows?.length ?? 0) > 0 || (s.notes?.length ?? 0) > 0, `${s.title} is empty`);
  }
});
