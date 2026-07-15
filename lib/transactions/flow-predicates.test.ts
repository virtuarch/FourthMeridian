/**
 * lib/transactions/flow-predicates.test.ts
 *
 * TI1 — locks the membership of the single-authority predicates so a future
 * edit cannot silently change what counts as spend / income / a transfer / etc.
 * These sets reproduce the pre-TI1 consumer definitions byte-for-byte; the
 * assertions below are the behavior-neutrality contract for the migration.
 *
 * Pure module, no DB — runnable under `tsx`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { FlowType } from '@prisma/client';
import {
  COST_FLOWS,
  SERIALIZED_SPENDING_FLOWS,
  FLOW_TYPE_LABEL,
  UNCLASSIFIED_FLOW_KEY,
  sumByFlowType,
  isCostFlow,
  isSerializedSpendingFlow,
  isSpendLedgerFlow,
  isExcludedFromSpendLedger,
  isIncome,
  isRefund,
  isTransfer,
  isDebtPayment,
  isInvestmentFlow,
  isBankingPopulation,
} from './flow-predicates';

// Every FlowType value (mirrors flow-classifier.ts FlowType union).
const ALL: string[] = [
  'SPENDING', 'INCOME', 'REFUND', 'DEBT_PAYMENT', 'TRANSFER',
  'INVESTMENT', 'FEE', 'INTEREST', 'ADJUSTMENT', 'UNKNOWN',
];

test('COST_FLOWS is exactly the pre-TI1 FLOW_COST / EXPENSE_FLOWS set', () => {
  assert.deepEqual([...COST_FLOWS].sort(), ['FEE', 'INTEREST', 'SPENDING']);
  for (const ft of ALL) {
    assert.equal(isCostFlow(ft), ['SPENDING', 'FEE', 'INTEREST'].includes(ft));
  }
});

test('SERIALIZED_SPENDING_FLOWS is exactly {SPENDING, FEE} (narrower than cost)', () => {
  assert.deepEqual([...SERIALIZED_SPENDING_FLOWS].sort(), ['FEE', 'SPENDING']);
  for (const ft of ALL) {
    assert.equal(isSerializedSpendingFlow(ft), ['SPENDING', 'FEE'].includes(ft));
  }
  // The deliberate divergence: INTEREST is a cost flow but NOT serialized-spending.
  assert.equal(isCostFlow('INTEREST'), true);
  assert.equal(isSerializedSpendingFlow('INTEREST'), false);
});

test('spend-ledger is exactly {SPENDING, REFUND} and its complement is total', () => {
  for (const ft of ALL) {
    const inLedger = ft === 'SPENDING' || ft === 'REFUND';
    assert.equal(isSpendLedgerFlow(ft), inLedger);
    assert.equal(isExcludedFromSpendLedger(ft), !inLedger);
  }
});

test('single-value predicates match strict equality', () => {
  for (const ft of ALL) {
    assert.equal(isIncome(ft), ft === 'INCOME');
    assert.equal(isRefund(ft), ft === 'REFUND');
    assert.equal(isTransfer(ft), ft === 'TRANSFER');
    assert.equal(isDebtPayment(ft), ft === 'DEBT_PAYMENT');
    assert.equal(isInvestmentFlow(ft), ft === 'INVESTMENT');
  }
});

test('P2-2 isBankingPopulation admits every flow EXCEPT INVESTMENT, and keeps UNKNOWN/null visible', () => {
  // The canonical banking-population rule: FlowType, not provider category, decides
  // eligibility. Only pure investment security-activity is excluded.
  for (const ft of ALL) {
    assert.equal(isBankingPopulation(ft), ft !== 'INVESTMENT', `banking membership for ${ft}`);
  }
  // The requirements that make this a population rule, not a taxonomy allow-list:
  //  - canonical banking flows are admitted regardless of category label,
  assert.equal(isBankingPopulation('SPENDING'), true);
  assert.equal(isBankingPopulation('INCOME'), true);   // e.g. a cash Dividend row
  assert.equal(isBankingPopulation('FEE'), true);      // e.g. a card/investment Fee row
  assert.equal(isBankingPopulation('ADJUSTMENT'), true);
  //  - UNKNOWN / unclassified rows STAY IN so review / needs-classification paths see them,
  assert.equal(isBankingPopulation('UNKNOWN'), true);
  assert.equal(isBankingPopulation(null), true);
  assert.equal(isBankingPopulation(undefined), true);
  //  - and ONLY investment security-activity is held out (the banking/investment split).
  assert.equal(isBankingPopulation('INVESTMENT'), false);
  // It is exactly the complement of the single INVESTMENT authority (no new list).
  for (const ft of [...ALL, null, undefined]) {
    assert.equal(isBankingPopulation(ft), !isInvestmentFlow(ft));
  }
});

test('FLOW_TYPE_LABEL has exactly one non-empty label per FlowType enum value', () => {
  // Source-scan against the Prisma enum: a new flow kind cannot ship without a
  // humanized label (the filter would otherwise render a blank/undefined option).
  const enumValues = Object.values(FlowType) as string[];
  assert.deepEqual(Object.keys(FLOW_TYPE_LABEL).sort(), [...enumValues].sort());
  for (const ft of enumValues) {
    const label = FLOW_TYPE_LABEL[ft];
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 0, `empty label for ${ft}`);
  }
  // No extra keys beyond the enum (the map is not a dumping ground).
  for (const key of Object.keys(FLOW_TYPE_LABEL)) {
    assert.ok(enumValues.includes(key), `unknown FlowType key: ${key}`);
  }
});

test('sumByFlowType buckets by flowType, sentinels null, and is the one summary/GroupBy source', () => {
  const rows = [
    { flowType: 'SPENDING', amt: 100 },
    { flowType: 'FEE', amt: 5 },
    { flowType: 'INTEREST', amt: 3 },
    { flowType: 'REFUND', amt: 20 },
    { flowType: 'INCOME', amt: 200 },
    { flowType: 'TRANSFER', amt: 50 },
    { flowType: 'DEBT_PAYMENT', amt: 40 },
    { flowType: 'INVESTMENT', amt: 60 },
    { flowType: 'TRANSFER', amt: 10 },
    { flowType: null, amt: 7 },
  ];
  const sums = sumByFlowType(rows, (r) => r.amt);

  // Each bucket equals an independent per-kind reduce (correctness). Because BOTH
  // the summary chips and the "By Flow Type" Group By read THIS map, they cannot
  // drift apart — this is the stop-condition-§9.8 guarantee.
  const keys = ['SPENDING', 'FEE', 'INTEREST', 'REFUND', 'INCOME', 'TRANSFER', 'DEBT_PAYMENT', 'INVESTMENT', UNCLASSIFIED_FLOW_KEY];
  for (const key of keys) {
    const manual = rows.filter((r) => (r.flowType ?? UNCLASSIFIED_FLOW_KEY) === key).reduce((s, r) => s + r.amt, 0);
    assert.equal(sums.get(key) ?? 0, manual, `bucket ${key}`);
  }
  assert.equal(sums.get('TRANSFER'), 60); // 50 + 10 accumulated
  assert.equal(sums.get(UNCLASSIFIED_FLOW_KEY), 7);

  // The composite "Spend" the summary bar shows (cost flows − refund, clamped ≥ 0)
  // reproduces the pre-existing isCostFlow/isRefund math from the SAME map.
  const cost = (sums.get('SPENDING') ?? 0) + (sums.get('FEE') ?? 0) + (sums.get('INTEREST') ?? 0);
  const spend = Math.max(0, cost - (sums.get('REFUND') ?? 0));
  const costViaPredicate = rows.filter((r) => isCostFlow(r.flowType)).reduce((s, r) => s + r.amt, 0);
  const refundViaPredicate = rows.filter((r) => isRefund(r.flowType)).reduce((s, r) => s + r.amt, 0);
  assert.equal(cost, costViaPredicate);
  assert.equal(spend, Math.max(0, costViaPredicate - refundViaPredicate));
});

test('null / undefined flow is never a member of any set', () => {
  for (const v of [null, undefined]) {
    assert.equal(isCostFlow(v), false);
    assert.equal(isSerializedSpendingFlow(v), false);
    assert.equal(isSpendLedgerFlow(v), false);
    assert.equal(isExcludedFromSpendLedger(v), true); // complement: null is excluded
    assert.equal(isIncome(v), false);
    assert.equal(isRefund(v), false);
    assert.equal(isTransfer(v), false);
    assert.equal(isDebtPayment(v), false);
    assert.equal(isInvestmentFlow(v), false);
  }
});
