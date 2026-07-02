/**
 * lib/ai/assemblers/transactions.privacy.test.ts
 *
 * KD-1 privacy regression tests — visibility predicate (pure, no DB).
 *
 * The project has no test runner (no jest/vitest). This file is a standalone,
 * dependency-free script runnable with the already-installed `tsx`, mirroring
 * lib/ai/intent/classifier.test.ts:
 *
 *     npx tsx lib/ai/assemblers/transactions.privacy.test.ts
 *
 * Run from the repo root (the source-scan checks resolve paths from cwd).
 * Exits 0 when all cases pass and 1 on failure, so it can be wired into CI
 * without changes.
 *
 * Two layers of checks:
 *   1. Predicate behavior — TRANSACTION_DETAIL_VISIBILITY grants FULL only;
 *      every other visibility level fails closed.
 *   2. Source tripwires — every SpaceAccountLink query in the transactions
 *      assembler carries the shared predicate, and no hardcoded visibility
 *      literal can silently diverge from it. If a future edit adds a SAL
 *      query without the predicate, or inlines a visibility literal, these
 *      fail loudly.
 *
 * DB-backed end-to-end coverage lives in
 * scripts/test-visibility-two-user-space.ts.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { VisibilityLevel } from '@prisma/client';

import { TRANSACTION_DETAIL_VISIBILITY, grantsTransactionDetail } from '../visibility';

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Predicate behavior
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

// SHARED is the legacy "maps to FULL" value. The 2026-07-02 data audit
// (scripts/audit-visibility-levels.ts) confirmed zero SHARED rows in dev and
// prod, and no write path can produce one, so the predicate excludes it and
// fails closed. This assertion makes that decision executable: if SHARED is
// ever added to the predicate, this test must be changed consciously,
// together with a fresh data audit.
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
// 2. Source tripwires — transactions assembler
// ---------------------------------------------------------------------------

const assemblerPath = join(process.cwd(), 'lib', 'ai', 'assemblers', 'transactions.ts');
const source = readFileSync(assemblerPath, 'utf8');

const salQueryCount = (source.match(/spaceAccountLinks:/g) ?? []).length;
const predicateUseCount = (
  source.match(/visibilityLevel: \{ in: TRANSACTION_DETAIL_VISIBILITY \}/g) ?? []
).length;

check(
  'every SpaceAccountLink query carries the shared predicate',
  salQueryCount > 0 && salQueryCount === predicateUseCount,
  `spaceAccountLinks queries: ${salQueryCount}, predicate uses: ${predicateUseCount} — ` +
    'a SAL query was added without the KD-1 visibility constraint',
);

check(
  'no hardcoded visibility literal in the assembler (summary and drilldown share lib/ai/visibility.ts)',
  !/visibilityLevel:\s*VisibilityLevel\./.test(source),
  'found a visibilityLevel: VisibilityLevel.<LITERAL> — use TRANSACTION_DETAIL_VISIBILITY instead',
);

check(
  'assembler imports the canonical predicate module',
  source.includes("from '@/lib/ai/visibility'"),
);

// ---------------------------------------------------------------------------

console.log('');
if (failures === 0) {
  console.log('All KD-1 predicate/tripwire cases passed.');
  process.exit(0);
} else {
  console.log(`${failures} failure(s).`);
  process.exit(1);
}
