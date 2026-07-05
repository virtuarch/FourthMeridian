/**
 * lib/debt.test.ts
 *
 * FlowType P5 Slice 3 — debt-payment rollup tests (pure, no DB).
 *
 * Standalone, dependency-free script in the house style (see
 * lib/transactions/flow-classifier.test.ts), runnable with `tsx`:
 *
 *     npx tsx lib/debt.test.ts
 *
 * Auto-discovered by scripts/run-tests.ts (D-TEST). Imports ONLY lib/debt.ts,
 * which is Prisma-free, so this suite runs without `prisma generate`.
 */

import {
  totalDebtPaid,
  rollupDebtPaymentsByAccount,
  type DebtPaymentTxnLike,
} from './debt';

// ── Tiny assert harness ───────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

const tx = (accountId: string, amount: number, flowType: string | null): DebtPaymentTxnLike =>
  ({ accountId, amount, flowType });

// ── totalDebtPaid ─────────────────────────────────────────────────────────────

check('empty input → 0', totalDebtPaid([]) === 0);

check(
  'non-DEBT_PAYMENT rows ignored',
  totalDebtPaid([tx('a', -50, 'SPENDING'), tx('a', 100, 'INCOME'), tx('a', -35, 'FEE')]) === 0,
);

check(
  'null flowType excluded (legacy Payment rows are not counted by flow predicate)',
  totalDebtPaid([tx('a', -300, null)]) === 0,
);

check(
  'abs-sums across mixed signs (INTERNAL negative + INFLOW positive legs)',
  totalDebtPaid([tx('a', -300, 'DEBT_PAYMENT'), tx('b', 200, 'DEBT_PAYMENT')]) === 500,
  `got ${totalDebtPaid([tx('a', -300, 'DEBT_PAYMENT'), tx('b', 200, 'DEBT_PAYMENT')])}`,
);

// ── rollupDebtPaymentsByAccount ───────────────────────────────────────────────

check('empty input → empty rollup', rollupDebtPaymentsByAccount([]).length === 0);

const mixed = [
  tx('amex',  -300, 'DEBT_PAYMENT'),
  tx('chase',  500, 'DEBT_PAYMENT'),
  tx('amex',  -100, 'DEBT_PAYMENT'),
  tx('amex',   -20, 'SPENDING'),      // purchase on the card — not a payment
  tx('chase',  -15, null),            // unclassified — excluded
];
const rollup = rollupDebtPaymentsByAccount(mixed);

check('groups by account id', rollup.length === 2, `got ${rollup.length} entries`);
check(
  'sorted descending by total',
  rollup[0]?.accountId === 'chase' && rollup[0]?.total === 500,
  `got [0]=${rollup[0]?.accountId}:${rollup[0]?.total}`,
);
check(
  'per-account total + count (abs-summed)',
  rollup[1]?.accountId === 'amex' && rollup[1]?.total === 400 && rollup[1]?.count === 2,
  `got [1]=${rollup[1]?.accountId}:${rollup[1]?.total} count=${rollup[1]?.count}`,
);
check(
  'rollup totals reconcile to totalDebtPaid over the same rows',
  rollup.reduce((s, e) => s + e.total, 0) === totalDebtPaid(mixed),
);

// ── Report ────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\nFlowType P5 Slice 3 debt rollup: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`FlowType P5 Slice 3 debt rollup: all ${passed} checks passed.`);
process.exit(0);
