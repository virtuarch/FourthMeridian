/**
 * lib/imports/transaction-facts-import.test.ts
 *
 * TI2-5 — proves the import path's TI-fact derivation contract (the route's
 * `computeFactFields`, which is DB-bound and not unit-testable here). Reproduces
 * exactly what app/api/accounts/[id]/import/route.ts computes per imported row:
 *
 *   buildTransactionFacts({ captured: <empty>, pending: false,
 *                           rowCurrency, accountCurrency })
 *   then { ...facts, paymentMethod: null }   // honest NULL, not UNKNOWN
 *
 *   npx tsx --test lib/imports/transaction-facts-import.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTransactionFacts } from '../transactions/transaction-facts';
import type { CapturedPlaidMetadata } from '../transactions/plaid-flow-input';

// Imports carry no provider metadata: empty capture sidecar.
const EMPTY_CAPTURED: CapturedPlaidMetadata = { pfcConfidenceLevel: null, merchantEntityId: null, counterparties: [] };

// Verbatim reproduction of the route's computeFactFields (see module header).
function importFactFields(rowCurrency: string | null, accountCurrency: string | null) {
  const facts = buildTransactionFacts({ captured: EMPTY_CAPTURED, pending: false, rowCurrency, accountCurrency });
  return { ...facts, paymentMethod: null };
}

test('imported rows stamp tiFactsVersion', () => {
  assert.equal(importFactFields('USD', 'USD').tiFactsVersion, 1);
});

test('settlementState is POSTED (imports are never pending)', () => {
  assert.equal(importFactFields('USD', 'USD').settlementState, 'POSTED');
});

test('fxApplied is false when the account currency is known, null when unknown', () => {
  // Imports stamp the row with the account's own currency, so row === account.
  assert.equal(importFactFields('USD', 'USD').fxApplied, false);
  assert.equal(importFactFields('EUR', 'EUR').fxApplied, false);
  assert.equal(importFactFields(null, null).fxApplied, null);
});

test('every provider-only fact is honest NULL (never fabricated)', () => {
  const f = importFactFields('USD', 'USD');
  assert.equal(f.paymentChannel, null);
  assert.equal(f.authorizedAt, null);
  assert.equal(f.counterpartyType, null);
  assert.equal(f.pendingTransactionRef, null);
});

test('paymentMethod is NULL for imports — not the builder UNKNOWN sentinel', () => {
  // The bare builder would return UNKNOWN (no signal); the import override nulls it,
  // because these providers never supply payment metadata at all.
  assert.equal(buildTransactionFacts({ captured: EMPTY_CAPTURED, pending: false, rowCurrency: 'USD', accountCurrency: 'USD' }).paymentMethod, 'UNKNOWN');
  assert.equal(importFactFields('USD', 'USD').paymentMethod, null);
});

test('no fabricated payment metadata: exactly settlementState/fxApplied/tiFactsVersion are non-null', () => {
  const f = importFactFields('USD', 'USD') as Record<string, unknown>;
  const nonNull = Object.entries(f).filter(([, v]) => v !== null).map(([k]) => k).sort();
  assert.deepEqual(nonNull, ['fxApplied', 'settlementState', 'tiFactsVersion']);
});
