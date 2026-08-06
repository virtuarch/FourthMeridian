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
    account: { id: 'a1', name: 'Everyday Checking', institution: 'Chase', mask: '1234', type: 'checking' },
    provenance: { source: 'plaid' },
    counterparty: null,
    reporting: null,
    relationships: { pendingPosted: null, duplicate: null, refundCandidate: null, transferCandidate: null, transferAssessment: { status: 'NONE', transactionId: null, counterpartyAccountId: null, confidence: 0, reason: 'NO_CANDIDATE', destinationAccountType: null, maturity: 'UNRESOLVED_TRANSFER', evidenceLevel: 'NO_DESTINATION_EVIDENCE', persistableCounterparty: false, persistableLeg: false, unresolvedReason: null, admission: 'ADMITTED' } },
    needsClassification: false, needsClassificationReason: null,
  };
  return { ...base, ...over } as unknown as TransactionDetail;
}

const find = (secs: ReturnType<typeof buildTransactionDetailSections>, title: string) => secs.find((s) => s.title === title);

test('Summary always renders merchant/amount/date/category; flow when present', () => {
  const secs = buildTransactionDetailSections(detail());
  const s = find(secs, 'Summary')!;
  const labels = s.rows!.map((r) => r.label);
  // v2.6-TRUTH-7 — "What" is the canonical row nature, not humanize(flowType).
  assert.deepEqual(labels, ['Merchant', 'Amount', 'Date', 'Category', 'What']);
  assert.equal(s.rows!.find((r) => r.label === 'Amount')!.value, '−$12.50');
  assert.equal(s.rows!.find((r) => r.label === 'What')!.value, 'Spending · Outflow');
});

test('null facts are hidden; the nature row is absent when flowType is null', () => {
  const secs = buildTransactionDetailSections(detail({ flowType: null, flowDirection: null }));
  const s = find(secs, 'Summary')!;
  assert.ok(!s.rows!.some((r) => r.label === 'What'));
});

test('an issuer credit reads as one, and keeps its flow type beside it', () => {
  // The Microsoft row: flowType INCOME, taxonomy ISSUER_CREDIT, on a card.
  const secs = buildTransactionDetailSections(detail({
    flowType: 'INCOME', flowDirection: 'INFLOW', amount: 280.45,
    incomeClass: 'NOT_INCOME', incomeSubtype: 'ISSUER_CREDIT',
  } as never));
  const s = find(secs, 'Summary')!;
  assert.equal(s.rows!.find((r) => r.label === 'What')!.value, 'Issuer credit · Inflow');
  // The coarser persisted fact is kept, labelled as itself — never hidden.
  assert.equal(s.rows!.find((r) => r.label === 'Flow type')!.value, 'Income');
});

test('Account shows mask formatted; omits mask when null', () => {
  assert.equal(find(buildTransactionDetailSections(detail()), 'Account')!.rows!.find((r) => r.label === 'Mask')!.value, '••••1234');
  const noMask = detail({ account: { id: 'a1', name: 'A', institution: 'B', mask: null, type: 'checking' } });
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
  const posted = detail({ authorizedAt: '2026-05-30', relationships: { pendingPosted: { role: 'POSTED_FROM_PENDING', transactionId: 'x' }, duplicate: null, refundCandidate: null, transferCandidate: null, transferAssessment: { status: 'NONE', transactionId: null, counterpartyAccountId: null, confidence: 0, reason: 'NO_CANDIDATE', destinationAccountType: null, maturity: 'UNRESOLVED_TRANSFER', evidenceLevel: 'NO_DESTINATION_EVIDENCE', persistableCounterparty: false, persistableLeg: false, unresolvedReason: null, admission: 'ADMITTED' } } });
  const notes = find(buildTransactionDetailSections(posted), 'Relationship Intelligence')!.notes!;
  assert.equal(notes[0], 'Posted from a pending transaction. Authorized 2026-05-30, posted 2026-06-01.');
  assert.ok(!/amount/i.test(notes.join(' ')));
  const pending = detail({ relationships: { pendingPosted: { role: 'PENDING_AWAITING_POST', transactionId: 'x' }, duplicate: null, refundCandidate: null, transferCandidate: null, transferAssessment: { status: 'NONE', transactionId: null, counterpartyAccountId: null, confidence: 0, reason: 'NO_CANDIDATE', destinationAccountType: null, maturity: 'UNRESOLVED_TRANSFER', evidenceLevel: 'NO_DESTINATION_EVIDENCE', persistableCounterparty: false, persistableLeg: false, unresolvedReason: null, admission: 'ADMITTED' } } });
  assert.equal(find(buildTransactionDetailSections(pending), 'Relationship Intelligence')!.notes![0], 'A posted version of this pending transaction exists.');
});

test('duplicate wording is hedged, counts, pluralizes', () => {
  const one = detail({ relationships: { pendingPosted: null, duplicate: { transactionIds: ['a'] }, refundCandidate: null, transferCandidate: null, transferAssessment: { status: 'NONE', transactionId: null, counterpartyAccountId: null, confidence: 0, reason: 'NO_CANDIDATE', destinationAccountType: null, maturity: 'UNRESOLVED_TRANSFER', evidenceLevel: 'NO_DESTINATION_EVIDENCE', persistableCounterparty: false, persistableLeg: false, unresolvedReason: null, admission: 'ADMITTED' } } });
  assert.equal(find(buildTransactionDetailSections(one), 'Relationship Intelligence')!.notes![0], 'Possible duplicate — appears to match 1 other transaction on 2026-06-01.');
  const two = detail({ relationships: { pendingPosted: null, duplicate: { transactionIds: ['a', 'b'] }, refundCandidate: null, transferCandidate: null, transferAssessment: { status: 'NONE', transactionId: null, counterpartyAccountId: null, confidence: 0, reason: 'NO_CANDIDATE', destinationAccountType: null, maturity: 'UNRESOLVED_TRANSFER', evidenceLevel: 'NO_DESTINATION_EVIDENCE', persistableCounterparty: false, persistableLeg: false, unresolvedReason: null, admission: 'ADMITTED' } } });
  const note = find(buildTransactionDetailSections(two), 'Relationship Intelligence')!.notes![0];
  assert.match(note, /Possible duplicate/);
  assert.match(note, /2 other transactions/);
  assert.ok(!/\bduplicate\b(?!.*possible)/i.test(note.replace('Possible duplicate', ''))); // never a bare certain "duplicate"
});

test('refundCandidate / transferCandidate (null) never render a section', () => {
  assert.equal(find(buildTransactionDetailSections(detail()), 'Relationship Intelligence'), undefined);
});

test('transferCandidate with no counterparty block stays generic and id-free', () => {
  const t = detail({
    relationships: {
      pendingPosted: null,
      duplicate: null,
      refundCandidate: null,
      transferCandidate: {
        status: 'RESOLVED',
        transactionId: 'leg2',
        counterpartyAccountId: 'acct-2',
        confidence: 1,
        reason: 'DETERMINISTIC_UNIQUE', destinationAccountType: 'savings', maturity: 'SAVINGS_TRANSFER', evidenceLevel: 'ACCOUNT_CERTAIN', persistableCounterparty: false, persistableLeg: false, unresolvedReason: null, admission: 'ADMITTED',
      },
      transferAssessment: {
        status: 'RESOLVED', transactionId: 'leg2', counterpartyAccountId: 'acct-2', confidence: 1,
        reason: 'DETERMINISTIC_UNIQUE', destinationAccountType: 'savings', maturity: 'SAVINGS_TRANSFER', evidenceLevel: 'ACCOUNT_CERTAIN', persistableCounterparty: false, persistableLeg: false, unresolvedReason: null, admission: 'ADMITTED',
      },
    },
  });
  const notes = find(buildTransactionDetailSections(t), 'Relationship Intelligence')!.notes!;
  assert.equal(notes[0], 'Appears to match a transfer between your own accounts.');
  // Hedged — never an unqualified "is a transfer" claim.
  assert.match(notes[0], /Appears to match/);
  // Account-name-free and id-free: the DTO's counterpartyAccountId/transactionId
  // must never leak into the rendered note.
  assert.ok(!/acct-2|leg2/.test(notes.join(' ')));
});

test('refundCandidate stays reserved-null even when transferCandidate resolves', () => {
  // A resolved transferCandidate renders; refundCandidate (null by contract) does
  // not add any note — no refund/return wording ever appears.
  const t = detail({
    relationships: {
      pendingPosted: null,
      duplicate: null,
      refundCandidate: null,
      transferCandidate: {
        status: 'RESOLVED', transactionId: null, counterpartyAccountId: 'acct-2',
        confidence: 1, reason: 'DETERMINISTIC_UNIQUE', destinationAccountType: 'savings', maturity: 'SAVINGS_TRANSFER', evidenceLevel: 'ACCOUNT_CERTAIN', persistableCounterparty: false, persistableLeg: false, unresolvedReason: null, admission: 'ADMITTED',
      },
      transferAssessment: {
        status: 'RESOLVED', transactionId: null, counterpartyAccountId: 'acct-2',
        confidence: 1, reason: 'DETERMINISTIC_UNIQUE', destinationAccountType: 'savings', maturity: 'SAVINGS_TRANSFER', evidenceLevel: 'ACCOUNT_CERTAIN', persistableCounterparty: false, persistableLeg: false, unresolvedReason: null, admission: 'ADMITTED',
      },
    },
  });
  const notes = find(buildTransactionDetailSections(t), 'Relationship Intelligence')!.notes!;
  assert.equal(notes.length, 1);
  assert.ok(!/refund|return/i.test(notes.join(' ')));
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
  const rep = detail({ reporting: { amount: 11.2, currency: 'EUR', estimated: true, unavailable: false, rate: 0.9, effectiveDateISO: '2026-06-01' } });
  const rows = find(buildTransactionDetailSections(rep), 'Reporting')!.rows!;
  assert.match(rows.find((r) => r.label === 'Reporting amount')!.value, /€11\.20.*est/);
});

// V25-FINAL-1 — the RENDERED transaction-detail surface must expose an unavailable
// conversion as unavailable, never as a fake 0 or a native magnitude under the
// reporting-currency label.
test('Reporting section: FX-unavailable renders "Unavailable", never a 0 or native amount', () => {
  const rep = detail({ reporting: { amount: null, currency: 'EUR', estimated: true, unavailable: true, rate: null, effectiveDateISO: null } });
  const rows = find(buildTransactionDetailSections(rep), 'Reporting')!.rows!;
  const shown = rows.find((r) => r.label === 'Reporting amount')!.value;
  assert.match(shown, /Unavailable/i);
  assert.match(shown, /no exchange rate/i);
  assert.doesNotMatch(shown, /0\.00|€0\b/); // never a fabricated zero
});

test('Needs classification: hidden by default; shown with case-appropriate wording; no jargon', () => {
  // Default (ordinary purchase) — no disclosure section.
  assert.equal(find(buildTransactionDetailSections(detail()), 'Needs classification'), undefined);

  // Payment-app unknown purpose.
  const p2p = detail({ needsClassification: true, needsClassificationReason: 'UNKNOWN_PAYMENT_APP_PURPOSE' });
  const pSec = find(buildTransactionDetailSections(p2p), 'Needs classification')!;
  assert.match(pSec.notes![0], /this money moved, but it can’t yet determine why/);

  // Unidentified inflow.
  const inflow = detail({ needsClassification: true, needsClassificationReason: 'UNKNOWN_INFLOW_SOURCE' });
  const iSec = find(buildTransactionDetailSections(inflow), 'Needs classification')!;
  assert.match(iSec.notes![0], /money came in, but it can’t yet identify the source/);

  // The disclosure itself carries no confidence numbers, reason codes, provider
  // strings, or ontology terms (scoped to the Needs-classification section — the
  // unrelated Provenance "Source: Plaid" row is an existing, intended field).
  for (const sec of [pSec, iSec]) {
    const text = [sec.title, ...(sec.notes ?? [])].join(' ');
    assert.ok(!/0\.5|confidence|SIGN_DEFAULT|PAYMENT_APP|plaid|pfc|transferRail|UNKNOWN_/i.test(text), `jargon leaked: ${text}`);
  }
});

test('no section is ever empty', () => {
  for (const s of buildTransactionDetailSections(detail())) {
    assert.ok((s.rows?.length ?? 0) > 0 || (s.notes?.length ?? 0) > 0, `${s.title} is empty`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// v2.6-XFER-2 — the RESOLVED counterparty reaches the drawer
//
// `TransactionDetail.counterparty` carries a KD-15-gated, identity-authority
// name, and it was rendered by NOTHING: the drawer showed only the provider's
// counterparty CLASS. Three AMEX savings→checking transfers resolved to
// "Rewards Checking" and still read "Financial institution".
//
// Precedence is most-specific-true-statement-first, and each branch is pinned:
// a name when we may show one, "Another account" when KD-15 forbids the name but
// a counterparty exists, and the provider's class only when there is no resolved
// account at all.
// ─────────────────────────────────────────────────────────────────────────────

const cpRow = (d: TransactionDetail): string | null => {
  const sec = find(buildTransactionDetailSections(d), 'Transaction Intelligence');
  return sec?.rows?.find((r) => r.label === 'Counterparty')?.value ?? null;
};

test('XFER-2: a resolved VISIBLE counterparty renders its account name', () => {
  const v = cpRow(detail({
    counterpartyType: 'FINANCIAL_INSTITUTION',
    counterparty: { visible: true, accountId: 'a2', name: 'Rewards Checking' },
  }));
  assert.equal(v, 'Rewards Checking', 'the resolved account name must win over the provider class');
});

test('XFER-2: a resolved but NON-VISIBLE counterparty is named generically, never by name', () => {
  const v = cpRow(detail({
    counterpartyType: 'FINANCIAL_INSTITUTION',
    counterparty: { visible: false },
  }));
  assert.equal(v, 'Another account',
    'KD-15 forbids the name; saying nothing would imply there was no counterparty');
});

test('XFER-2: with NO resolved counterparty the provider class is preserved', () => {
  assert.equal(
    cpRow(detail({ counterpartyType: 'FINANCIAL_INSTITUTION', counterparty: null })),
    'Financial institution',
    'unchanged behaviour where the authority resolved nothing',
  );
  // …and a row with neither shows no counterparty row at all.
  assert.equal(cpRow(detail({ counterpartyType: null, counterparty: null })), null);
});

test('XFER-2: the drawer never derives a counterparty name itself', () => {
  // The name is whatever the read boundary put in the DTO — produced there by
  // accountDisplayName, the ONE identity authority. This surface must render it
  // verbatim so it cannot call an account something no other surface calls it.
  const v = cpRow(detail({
    counterpartyType: 'MERCHANT',
    counterparty: { visible: true, accountId: 'a2', name: 'Ultimate Rewards®' },
  }));
  assert.equal(v, 'Ultimate Rewards®', 'rendered verbatim, never re-derived or re-formatted');
});

// ─────────────────────────────────────────────────────────────────────────────
// v2.6-XFER-3 — the relationship note names the account
//
// XFER-2 put the resolved name in the fact rows; the Relationship Intelligence
// sentence beside it still read "a transfer between your own accounts" while the
// account was named two rows above. Same defect, second consumer.
//
// A name may appear ONLY when the DTO proves all three: the match resolved to an
// account, the counterparty block is VISIBLE (KD-15's own verdict), and the block
// is about THAT account. Everything else keeps the generic wording. These probes
// pin each condition separately, because the dangerous failure is not silence —
// it is confidently naming the wrong account.
// ─────────────────────────────────────────────────────────────────────────────

const resolvedTo = (acctId: string | null) => ({
  status: 'RESOLVED', transactionId: 'leg2', counterpartyAccountId: acctId, confidence: 1,
  reason: 'DETERMINISTIC_UNIQUE', destinationAccountType: 'checking', maturity: 'INTERNAL_TRANSFER',
  evidenceLevel: 'ACCOUNT_CERTAIN', persistableCounterparty: true, persistableLeg: true,
  unresolvedReason: null, admission: 'ADMITTED',
});
const withMatch = (over: Partial<TransactionDetail>, acctId: string | null = 'a2') => detail({
  relationships: {
    pendingPosted: null, duplicate: null, refundCandidate: null,
    transferCandidate: resolvedTo(acctId), transferAssessment: resolvedTo(acctId),
  },
  ...over,
} as Partial<TransactionDetail>);
const relNote = (d: TransactionDetail): string =>
  find(buildTransactionDetailSections(d), 'Relationship Intelligence')!.notes![0];

test('XFER-3: the note names the account, and takes its direction from the sign', () => {
  // The live AMEX case: −$500 out of High Yield Savings, matched to Rewards Checking.
  const out = withMatch({
    flowType: 'TRANSFER', flowDirection: 'OUTFLOW', amount: -500,
    counterparty: { visible: true, accountId: 'a2', name: 'Rewards Checking' },
  });
  assert.equal(relNote(out), 'Appears to match a transfer to Rewards Checking.');

  // The opposite leg reads the same fact from the other side.
  const inbound = withMatch({
    flowType: 'TRANSFER', flowDirection: 'INFLOW', amount: 500,
    counterparty: { visible: true, accountId: 'a2', name: 'High Yield Savings Account' },
  });
  assert.equal(relNote(inbound), 'Appears to match a transfer from High Yield Savings Account.');

  // Still HEDGED — naming the other side is not a claim that the transfer occurred.
  assert.match(relNote(out), /^Appears to match/);
});

test('XFER-3: KD-15 governs the note exactly as it governs the fact row', () => {
  const hidden = withMatch({
    flowType: 'TRANSFER', flowDirection: 'OUTFLOW', amount: -500,
    counterparty: { visible: false },
  });
  assert.equal(relNote(hidden), 'Appears to match a transfer between your own accounts.',
    'an invisible counterparty must not be named here either');
});

test('XFER-3: a counterparty block about a DIFFERENT account never names the match', () => {
  // `d.counterparty` prefers the PERSISTED link, which need not be the leg this
  // read matched. Naming one account from a block describing another would be a
  // fabrication that reads as authoritative — the note must fall back instead.
  const mismatched = withMatch({
    flowType: 'TRANSFER', flowDirection: 'OUTFLOW', amount: -500,
    counterparty: { visible: true, accountId: 'SOMEONE-ELSE', name: 'Platinum Card®' },
  });
  assert.equal(relNote(mismatched), 'Appears to match a transfer between your own accounts.');
  assert.ok(!/Platinum/.test(relNote(mismatched)), 'the wrong account must never be named');

  // …and a match that resolved no account id at all cannot be named either.
  const noId = withMatch({
    flowType: 'TRANSFER', flowDirection: 'OUTFLOW', amount: -500,
    counterparty: { visible: true, accountId: 'a2', name: 'Rewards Checking' },
  }, null);
  assert.equal(relNote(noId), 'Appears to match a transfer between your own accounts.');
});

test('XFER-3: the note never renders a raw id, named or generic', () => {
  for (const d of [
    withMatch({ flowType: 'TRANSFER', amount: -500, counterparty: { visible: true, accountId: 'a2', name: 'Rewards Checking' } }),
    withMatch({ flowType: 'TRANSFER', amount: -500, counterparty: { visible: false } }),
  ]) {
    const notes = find(buildTransactionDetailSections(d), 'Relationship Intelligence')!.notes!.join(' ');
    assert.ok(!/\ba2\b|leg2/.test(notes), `an id leaked into the note: ${notes}`);
  }
});
