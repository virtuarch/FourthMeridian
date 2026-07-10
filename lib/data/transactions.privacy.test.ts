/**
 * lib/data/transactions.privacy.test.ts
 *
 * KD-15 privacy regression tests — UI transaction read paths (pure, no DB).
 *
 * KD-15 is the UI counterpart to KD-1: it applies the SAME transaction-detail
 * visibility predicate (lib/ai/visibility.ts) to the UI read paths that KD-1
 * left untouched — the dashboard/banking/credit/investments lists in
 * lib/data/transactions.ts and the account-detail modal route in
 * app/api/accounts/[id]/transactions/route.ts.
 *
 * The project has no test runner (no jest/vitest). This file is a standalone,
 * dependency-free script runnable with the already-installed `tsx`, mirroring
 * lib/ai/assemblers/transactions.privacy.test.ts:
 *
 *     npx tsx lib/data/transactions.privacy.test.ts
 *
 * Run from the repo root (the source-scan checks resolve paths from cwd).
 * Exits 0 when all cases pass and 1 on failure, so it can be wired into CI
 * without changes.
 *
 * Two layers of checks:
 *   1. Predicate reuse — the UI paths import the SAME constant the AI path uses,
 *      and that constant grants FULL only; every other visibility level fails
 *      closed.
 *   2. Source tripwires — every SpaceAccountLink query in lib/data/transactions.ts
 *      carries the shared predicate, no hardcoded visibility literal can silently
 *      diverge from it, and the account-modal route gates row access on the same
 *      predicate. If a future edit adds an unguarded SAL read, these fail loudly.
 *
 * DB-backed end-to-end coverage lives in
 * scripts/test-visibility-two-user-space.ts.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { VisibilityLevel } from '@prisma/client';

import { TRANSACTION_DETAIL_VISIBILITY, grantsTransactionDetail } from '../ai/visibility';

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Predicate reuse (pure)
// ---------------------------------------------------------------------------

check(
  'FULL grants transaction detail',
  grantsTransactionDetail(VisibilityLevel.FULL),
);

check(
  'BALANCE_ONLY does not grant transaction detail',
  !grantsTransactionDetail(VisibilityLevel.BALANCE_ONLY),
);

check(
  'SUMMARY_ONLY does not grant transaction detail',
  !grantsTransactionDetail(VisibilityLevel.SUMMARY_ONLY),
);

check(
  'PRIVATE does not grant transaction detail',
  !grantsTransactionDetail(VisibilityLevel.PRIVATE),
);

// SHARED is the legacy "maps to FULL" value, excluded so the predicate fails
// closed (see KD-1 test + scripts/audit-visibility-levels.ts). The UI paths
// reuse the identical constant, so this holds here too.
check(
  'SHARED (legacy) does not grant transaction detail — fails closed',
  !grantsTransactionDetail(VisibilityLevel.SHARED),
);

check(
  'predicate is exactly [FULL] — no accidental widening',
  TRANSACTION_DETAIL_VISIBILITY.length === 1 &&
    TRANSACTION_DETAIL_VISIBILITY[0] === VisibilityLevel.FULL,
  `actual: [${TRANSACTION_DETAIL_VISIBILITY.join(', ')}]`,
);

// ---------------------------------------------------------------------------
// 2. Source tripwires — lib/data/transactions.ts (dashboard list read paths)
// ---------------------------------------------------------------------------

const dataPath = join(process.cwd(), 'lib', 'data', 'transactions.ts');
const dataSrc = readFileSync(dataPath, 'utf8');

const salQueryCount = (dataSrc.match(/spaceAccountLinks:/g) ?? []).length;
const predicateUseCount = (
  dataSrc.match(/visibilityLevel: \{ in: TRANSACTION_DETAIL_VISIBILITY \}/g) ?? []
).length;

check(
  'every SpaceAccountLink query in lib/data/transactions.ts carries the shared predicate',
  salQueryCount > 0 && salQueryCount === predicateUseCount,
  `spaceAccountLinks queries: ${salQueryCount}, predicate uses: ${predicateUseCount} — ` +
    'a SAL query was added without the KD-15 visibility constraint',
);

// The exported read functions own exactly five SAL queries today: the
// counterpartyVisibilityInclude() list gate (shared by getTransactions /
// getDebtTransactions for the Cash Flow liquidity axis), the main row-visibility
// query in each of getTransactions / getDebtTransactions / getInvestmentTransactions,
// and the counterparty name-exposure gate inside getTransactionDetail. (The count
// was raised 3→4 when the detail read landed, and 4→5 when the list counterparty
// gate landed.) TI4 Slice 1's read-time transfer-match visibility gate lives in
// lib/transactions/transfer-resolution.ts — deliberately OUTSIDE this file — so the
// count here is unchanged. If it drifts, a read path was added or removed — force a
// conscious review.
check(
  'lib/data/transactions.ts has the expected five SAL read queries',
  salQueryCount === 5,
  `expected 5 spaceAccountLinks queries (counterpartyVisibilityInclude list gate / ` +
    `getTransactions / getDebtTransactions / getInvestmentTransactions / ` +
    `getTransactionDetail counterparty gate), found ${salQueryCount}`,
);

check(
  'no hardcoded visibility literal in lib/data/transactions.ts',
  !/visibilityLevel:\s*VisibilityLevel\./.test(dataSrc) &&
    !/visibilityLevel:\s*['"]/.test(dataSrc),
  'found an inlined visibilityLevel literal — use TRANSACTION_DETAIL_VISIBILITY instead',
);

check(
  'lib/data/transactions.ts imports the canonical predicate module',
  /from ['"]@\/lib\/ai\/visibility['"]/.test(dataSrc),
);

// ---------------------------------------------------------------------------
// 3. Source tripwires — account-detail modal route
// ---------------------------------------------------------------------------

const routePath = join(
  process.cwd(), 'app', 'api', 'accounts', '[id]', 'transactions', 'route.ts',
);
const routeSrc = readFileSync(routePath, 'utf8');

check(
  'account-modal route imports the canonical predicate module',
  /from ['"]@\/lib\/ai\/visibility['"]/.test(routeSrc),
);

check(
  'account-modal route gates row access on grantsTransactionDetail (KD-15)',
  /grantsTransactionDetail\(/.test(routeSrc),
  'the route must reject non-FULL links before returning transaction rows',
);

// Non-FULL shared accounts must get an empty list (200), never a leak and never
// a 404 (they ARE shared into the Space, just not at transaction-detail tier).
check(
  'account-modal route returns an empty transactions list for non-FULL links',
  /transactions:\s*\[\]/.test(routeSrc),
  'expected a `{ transactions: [] }` response on the non-FULL branch',
);

check(
  'no hardcoded visibility literal in the account-modal route',
  !/visibilityLevel:\s*VisibilityLevel\./.test(routeSrc) &&
    !/visibilityLevel:\s*['"]/.test(routeSrc),
  'found an inlined visibilityLevel literal — use the shared predicate helpers instead',
);

// ---------------------------------------------------------------------------

console.log('');
if (failures === 0) {
  console.log('All KD-15 predicate/tripwire cases passed.');
  process.exit(0);
} else {
  console.log(`${failures} failure(s).`);
  process.exit(1);
}
