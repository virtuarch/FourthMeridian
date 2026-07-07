/**
 * lib/transactions/transaction-facts-backfill.test.ts
 *
 * TI3 — proves the pure surfaces the backfill script depends on:
 *   - buildBackfillFacts derivation (settlementState / fxApplied / version),
 *   - provider-only facts are structurally NOT writable (excluded from the type),
 *   - the version-gate truth table (mirrors the script's Prisma where-clause:
 *     tiFactsVersion IS NULL OR tiFactsVersion < TI_FACTS_VERSION), which is what
 *     makes the backfill idempotent (a re-run over stamped rows finds nothing).
 *
 * The script (scripts/backfill-transaction-facts.ts) is DB-bound and auto-runs
 * main() on import, so its --apply / dry-run branching is validated operationally
 * (dry-run → review → --apply → re-run sees 0), exactly like backfill-flowtype.
 *
 *   npx tsx --test lib/transactions/transaction-facts-backfill.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBackfillFacts, TI_FACTS_VERSION } from './transaction-facts';

// The version gate, reproduced verbatim from the script's selection predicate.
const isEligible = (tiFactsVersion: number | null): boolean =>
  tiFactsVersion === null || tiFactsVersion < TI_FACTS_VERSION;

test('settlementState derives from pending (POSTED/PENDING)', () => {
  assert.equal(buildBackfillFacts({ pending: false, currency: 'USD', accountCurrency: 'USD' }).settlementState, 'POSTED');
  assert.equal(buildBackfillFacts({ pending: true, currency: 'USD', accountCurrency: 'USD' }).settlementState, 'PENDING');
});

test('fxApplied derives from row vs account currency (false/true/null)', () => {
  assert.equal(buildBackfillFacts({ pending: false, currency: 'USD', accountCurrency: 'USD' }).fxApplied, false);
  assert.equal(buildBackfillFacts({ pending: false, currency: 'EUR', accountCurrency: 'USD' }).fxApplied, true);
  assert.equal(buildBackfillFacts({ pending: false, currency: null, accountCurrency: 'USD' }).fxApplied, null);
  assert.equal(buildBackfillFacts({ pending: false, currency: 'USD', accountCurrency: null }).fxApplied, null);
});

test('tiFactsVersion is stamped to the current version', () => {
  assert.equal(buildBackfillFacts({ pending: false, currency: 'USD', accountCurrency: 'USD' }).tiFactsVersion, TI_FACTS_VERSION);
});

test('provider-only facts are NOT part of the backfill output (stay NULL, never written)', () => {
  const f = buildBackfillFacts({ pending: false, currency: 'USD', accountCurrency: 'USD' }) as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(f).sort(), ['fxApplied', 'settlementState', 'tiFactsVersion']);
  for (const providerOnly of ['paymentChannel', 'paymentMethod', 'authorizedAt', 'counterpartyType', 'pendingTransactionRef']) {
    assert.ok(!(providerOnly in f), `provider-only fact ${providerOnly} must not be in the backfill write set`);
  }
});

test('version gate: null and stale rows are eligible; current/newer rows are skipped', () => {
  assert.equal(isEligible(null), true);                       // never stamped
  assert.equal(isEligible(TI_FACTS_VERSION - 1), true);       // stale
  assert.equal(isEligible(TI_FACTS_VERSION), false);          // current → skipped
  assert.equal(isEligible(TI_FACTS_VERSION + 1), false);      // newer → never downgraded
});

test('idempotence: a row stamped by a prior --apply is not eligible on re-run', () => {
  const facts = buildBackfillFacts({ pending: false, currency: 'USD', accountCurrency: 'USD' });
  // After apply the row's tiFactsVersion === facts.tiFactsVersion; re-run gate → skip.
  assert.equal(isEligible(facts.tiFactsVersion), false);
});
