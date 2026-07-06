/**
 * lib/data/transaction-detail.privacy.test.ts
 *
 * TI-1 privacy tests — the single-transaction detail read
 * (GET /api/transactions/[id] → getTransactionDetail → transactionDetailWhere).
 *
 * House convention: standalone tsx script, no test framework, no live DB:
 *     npx tsx lib/data/transaction-detail.privacy.test.ts
 * Run from the repo root (source-scan checks resolve paths from cwd).
 *
 * Two layers, mirroring lib/data/transactions.privacy.test.ts (KD-15):
 *
 *   1. VISIBILITY MATRIX (pure) — asserts the exact WHERE clause shape that
 *      transactionDetailWhere() hands to Prisma's findFirst. Combined with
 *      findFirst semantics (no match → null → route 404s), each assertion
 *      proves one required 404 case:
 *        - nonexistent transaction        → `id` is in the WHERE; no row matches
 *        - deleted transaction            → `deletedAt: null` excludes it
 *        - transaction outside the Space  → both OR paths are Space-scoped
 *        - BALANCE_ONLY / non-FULL share  → SAL path requires the shared
 *                                           TRANSACTION_DETAIL_VISIBILITY
 *                                           predicate (FULL only, KD-15/KD-1)
 *        - deleted FinancialAccount       → `financialAccount.deletedAt: null`
 *
 *   2. SOURCE TRIPWIRES — the data layer actually uses the builder; the
 *      route actually delegates (no duplicated query logic, no direct db
 *      access, 404 fail-closed); the counterparty name-exposure gate carries
 *      the same shared predicate; no hardcoded visibility literals anywhere
 *      in the new files.
 *
 * DB-backed end-to-end coverage remains the province of
 * scripts/test-visibility-two-user-space.ts (not modified by TI-1).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { ShareStatus, VisibilityLevel } from '@prisma/client';

import { TRANSACTION_DETAIL_VISIBILITY } from '../ai/visibility';
import { transactionDetailWhere } from '../transactions/detail-query';

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Visibility matrix — the WHERE clause shape
// ---------------------------------------------------------------------------

const where = transactionDetailWhere('tx_123', 'space_A');

check(
  'WHERE is scoped to exactly the requested row id (nonexistent id → no match → 404)',
  where.id === 'tx_123',
);

check(
  'WHERE excludes soft-deleted transactions (import rollback → 404)',
  Object.prototype.hasOwnProperty.call(where, 'deletedAt') && where.deletedAt === null,
);

check(
  'WHERE has exactly two visibility paths (legacy own-account OR canonical SAL) — no third, unguarded path',
  Array.isArray(where.OR) && where.OR.length === 2,
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const legacyPath: any = where.OR[0];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const canonicalPath: any = where.OR[1];

check(
  'legacy path is Space-scoped (own accounts only — other Space → 404)',
  legacyPath?.account?.spaceId === 'space_A' &&
    Object.keys(legacyPath).length === 1 &&
    Object.keys(legacyPath.account).length === 1,
);

check(
  'canonical path excludes soft-deleted FinancialAccounts (deleted account → 404)',
  canonicalPath?.financialAccount?.deletedAt === null,
);

const sal = canonicalPath?.financialAccount?.spaceAccountLinks?.some;

check(
  'canonical path requires a SpaceAccountLink for THIS Space (other Space → 404)',
  sal?.spaceId === 'space_A',
);

check(
  'canonical path requires an ACTIVE link (revoked share → 404)',
  sal?.status === ShareStatus.ACTIVE,
);

check(
  'canonical path requires the SHARED transaction-detail predicate — same constant as KD-15/KD-1',
  sal?.visibilityLevel?.in === TRANSACTION_DETAIL_VISIBILITY,
  'the SAL filter must reference TRANSACTION_DETAIL_VISIBILITY itself, not a copy',
);

check(
  'predicate grants FULL only (BALANCE_ONLY / SUMMARY_ONLY / PRIVATE / legacy SHARED → 404)',
  TRANSACTION_DETAIL_VISIBILITY.length === 1 &&
    TRANSACTION_DETAIL_VISIBILITY[0] === VisibilityLevel.FULL,
  `actual: [${TRANSACTION_DETAIL_VISIBILITY.join(', ')}]`,
);

// ---------------------------------------------------------------------------
// 2. Source tripwires — the builder is actually used, end to end
// ---------------------------------------------------------------------------

const detailQuerySrc = readFileSync(
  join(process.cwd(), 'lib', 'transactions', 'detail-query.ts'), 'utf8');
const dataSrc = readFileSync(
  join(process.cwd(), 'lib', 'data', 'transactions.ts'), 'utf8');
const routeSrc = readFileSync(
  join(process.cwd(), 'app', 'api', 'transactions', '[id]', 'route.ts'), 'utf8');

check(
  'detail-query.ts imports the canonical predicate module',
  /from ['"]@\/lib\/ai\/visibility['"]/.test(detailQuerySrc),
);

check(
  'no hardcoded visibility literal in detail-query.ts',
  !/visibilityLevel:\s*VisibilityLevel\./.test(detailQuerySrc) &&
    !/visibilityLevel:\s*['"]/.test(detailQuerySrc),
  'found an inlined visibilityLevel literal — use TRANSACTION_DETAIL_VISIBILITY instead',
);

check(
  'getTransactionDetail queries through transactionDetailWhere (no duplicated visibility logic)',
  /where:\s*transactionDetailWhere\(/.test(dataSrc),
);

check(
  'counterparty name-exposure gate in lib/data/transactions.ts carries the shared predicate',
  /counterpartyAccount:[\s\S]*?visibilityLevel:\s*\{\s*in:\s*TRANSACTION_DETAIL_VISIBILITY\s*\}/.test(dataSrc),
  'the counterparty SAL sub-query must use TRANSACTION_DETAIL_VISIBILITY (fails closed on names)',
);

check(
  'detail route delegates to getTransactionDetail (no query logic in the route)',
  /getTransactionDetail\(/.test(routeSrc),
);

check(
  'detail route never touches the db client directly',
  !/from ['"]@\/lib\/db['"]/.test(routeSrc) && !/\bdb\.transaction\b/.test(routeSrc),
  'the route must read only through lib/data/transactions.ts',
);

check(
  'detail route fails closed with a 404 (uniform for missing AND invisible rows)',
  /status:\s*404/.test(routeSrc),
);

check(
  'detail route requires authentication (requireUser)',
  /requireUser\(\)/.test(routeSrc),
);

check(
  'no hardcoded visibility literal in the detail route',
  !/visibilityLevel/.test(routeSrc),
  'visibility decisions belong to detail-query.ts, never the route',
);

// TI-1 is read-only: the detail path must introduce no transaction writes.
check(
  'no transaction writes anywhere in the detail path (route + data layer)',
  !/transaction\.(update|create|delete|upsert)/.test(routeSrc) &&
    !/transaction\.(update|create|delete|upsert)/.test(dataSrc),
  'TI-1 is a read-only slice — a write crept into the detail path',
);

// ---------------------------------------------------------------------------

console.log('');
if (failures === 0) {
  console.log('All TI-1 detail visibility/tripwire cases passed.');
  process.exit(0);
} else {
  console.log(`${failures} failure(s).`);
  process.exit(1);
}
