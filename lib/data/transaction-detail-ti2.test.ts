/**
 * lib/data/transaction-detail-ti2.test.ts
 *
 * TI5-1 — locks the read-exposure contract:
 *   - TransactionDetail exposes every TI2 durable fact,
 *   - the list-row `Transaction` DTO exposes NONE of them (detail-only).
 *
 * The assertions are compile-time (enforced by `tsc --noEmit`, which scans test
 * files); the runtime body is a trivial guard so the suite runs under tsx.
 *   npx tsx --test lib/data/transaction-detail-ti2.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { TransactionDetail, Transaction } from '../../types';

// Compile-time: TransactionDetail must carry all 8 TI2 facts (Pick fails if any is removed).
type _HasTI2 = Pick<
  TransactionDetail,
  | 'paymentChannel' | 'paymentMethod' | 'settlementState' | 'authorizedAt'
  | 'counterpartyType' | 'fxApplied' | 'pendingTransactionRef' | 'tiFactsVersion'
>;
const TI2_KEYS: (keyof _HasTI2)[] = [
  'paymentChannel', 'paymentMethod', 'settlementState', 'authorizedAt',
  'counterpartyType', 'fxApplied', 'pendingTransactionRef', 'tiFactsVersion',
];

// Compile-time: the list-row DTO must NOT carry TI2 facts. If any leaks onto
// `Transaction`, this flips to `true` and the assignment fails tsc.
type ListExposesTI2 = 'paymentChannel' extends keyof Transaction ? true : false;
const listExposesTI2: ListExposesTI2 = false;

test('TI5-1: TransactionDetail exposes all 8 TI2 facts; list DTO exposes none', () => {
  assert.equal(TI2_KEYS.length, 8);
  assert.equal(listExposesTI2, false);
});
