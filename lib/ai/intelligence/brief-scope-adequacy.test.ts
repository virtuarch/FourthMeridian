/**
 * lib/ai/intelligence/brief-scope-adequacy.test.ts
 *
 * v2.6-BRIEF-1 — `computeAssessment` must never report a TRUNCATED PAYLOAD as a
 * finding about the user's finances.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `scopeHint: 'brief'` is documented as a payload-size knob ("assembler may
 * return a condensed summary"). It is not. It withholds inputs the assessment
 * engine reads, and the engine cannot tell "absent because the corpus is thin"
 * from "absent because the payload was truncated". Measured on the live corpus
 * (scripts/audit-brief-assessment-parity.ts), varying ONLY the hint moved:
 *
 *     incomeConfidence          HIGH                  → LOW
 *     cashFlowReliability       RELIABLE              → UNRELIABLE
 *     deficitCause              POSSIBLE_OVERSPENDING → LOW_INCOME_SAMPLE
 *     currentStatePriority      CASH_FLOW             → DATA_QUALITY
 *     incompleteIncomeWarning   false                 → true
 *
 * on a Space whose income data is complete. Same corpus, same day, same rows.
 *
 * That is the same error class this arc has spent ten slices removing: a
 * conclusion drawn from ABSENCE. v2.6-DEBT-1 put it plainly — "absence of
 * contradiction is not evidence" — and refused to admit a debt payment on
 * silence. The assessment engine was doing the mirror image: admitting a
 * FINDING on silence.
 *
 * These are the two withheld inputs, pinned as fixtures. Both are corpus-
 * independent — they are properties of the engine, so they belong in CI, unlike
 * the corpus drift count, which is a report.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeAssessment } from "@/lib/ai/intelligence";
import { FinanceDomains } from "@/lib/ai/types";
import type {
  SpaceContext_AI, TransactionsSummaryData, AccountsSectionData,
} from "@/lib/ai/types";

// ── Fixtures ────────────────────────────────────────────────────────────────

function mkTxn(over: Partial<TransactionsSummaryData> = {}): TransactionsSummaryData {
  return {
    windowDays: 90, startDate: "2026-04-01", endDate: "2026-06-30",
    transactionCount: 40, truncated: false, coverageStartDate: "2026-04-01",
    fetchLimit: 5000,
    incomeTotal: 12000, expenseTotal: 6000, refundTotal: 0, debtPaymentTotal: 0,
    transferTotal: 0, netCashFlow: 6000, estimated: false,
    pendingCreditCount: 0, pendingCreditTotal: 0, pendingDebitCount: 0, pendingDebitTotal: 0,
    unclassifiedCount: 0, adjustmentCount: 0,
    needsClassification: {
      count: 0, unknownInflowCount: 0, unknownInflowTotal: 0,
      unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0,
      counterpartyResolution: "PERSISTED_AND_READ_TIME",
    },
    byCategory: [{ category: "Income", total: 0, count: 8 }],
    monthlyBreakdown: [],
    largestIncome: null, largestExpense: null,
    ...over,
  } as TransactionsSummaryData;
}

function mkAccts(over: Partial<AccountsSectionData> = {}): AccountsSectionData {
  return {
    totalCount: 4, totalAssets: 100_000, totalLiabilities: 20_000,
    netWorth: 80_000, totalLiquid: 10_000, totalInvestments: 90_000,
    totalDigitalAssets: 0, totalRealAssets: 0,
    totalsEstimated: false, totalsUnconverted: false,
    counts: { liquid: 2, investments: 1, digitalAssets: 0, realAssets: 0, liabilities: 1 },
    health: { errorCount: 0, errorAccountNames: [], staleCount: 0, needsReauthCount: 0 },
    knowledgeGaps: [],
    ...over,
  } as AccountsSectionData;
}

function mkCtx(
  txn: TransactionsSummaryData,
  accts: AccountsSectionData | null,
  snapshotCount = 60,
): SpaceContext_AI {
  return {
    requestedAt: "2026-06-30T00:00:00.000Z",
    spaceId: "space-1", userId: "user-1", role: "OWNER",
    agentId: "agent-1", resolvedDomains: [],
    space: { id: "space-1", name: "S", type: "personal", category: "personal" },
    domains: {
      [FinanceDomains.TRANSACTIONS_SUMMARY]: { domain: FinanceDomains.TRANSACTIONS_SUMMARY, assembledAt: "x", data: txn },
      [FinanceDomains.SNAPSHOT_HISTORY]:     { domain: FinanceDomains.SNAPSHOT_HISTORY, assembledAt: "x", data: { snapshotCount, history: [] } },
      ...(accts ? { [FinanceDomains.ACCOUNTS]: { domain: FinanceDomains.ACCOUNTS, assembledAt: "x", data: accts } } : {}),
    },
    signals: [], auditLogId: "audit-1",
  } as SpaceContext_AI;
}

// ── 1. WITHHELD DEBT ACCOUNTS ───────────────────────────────────────────────

test("BRIEF-1: liabilities with the per-account list WITHHELD is INSUFFICIENT_DATA, never HEALTHY", () => {
  // `accounts` is `undefined` — exactly what lib/ai/assemblers/accounts.ts emits
  // under scopeHint='brief' ("omitted when scopeHint === 'brief'", ai/types.ts).
  // `counts.liabilities` is 1, so the engine KNOWS a liability exists and knows
  // it was not given the account. It must not grade what it cannot see.
  const withheld = computeAssessment(mkCtx(mkTxn(), mkAccts({ accounts: undefined })));

  assert.equal(
    withheld.debt.classification, "INSUFFICIENT_DATA",
    "A $20,000 liability whose account list was withheld was graded from an empty " +
    "debt-account set: no APR was found, so the weighted average was 0, so the " +
    "verdict came out HEALTHY. The engine graded silence.",
  );
  assert.notEqual(
    withheld.debt.confidence, "HIGH",
    "A verdict reached with no debt account in hand must not be HIGH confidence.",
  );
  // The total is still a fact — only the GRADE is unknowable. Suppressing the
  // number too would replace a wrong conclusion with a missing one.
  assert.equal(withheld.debt.totalLiabilities, 20_000);
});

test("BRIEF-1: a genuinely empty debt-account list still grades normally", () => {
  // The counterpart that proves the rule discriminates. `accounts: []` with
  // liabilities present is a real (if odd) corpus state — evidence supplied and
  // empty — not a withheld payload, and must not be swept into the new branch.
  const supplied = computeAssessment(mkCtx(mkTxn(), mkAccts({ accounts: [] })));
  assert.notEqual(
    supplied.debt.classification, undefined,
    "an explicitly empty list is evidence, not absence",
  );

  // And no-debt stays the clean NO_DEBT answer at HIGH confidence.
  const noDebt = computeAssessment(mkCtx(mkTxn(), mkAccts({
    totalLiabilities: 0, counts: { liquid: 2, investments: 1, digitalAssets: 0, realAssets: 0, liabilities: 0 },
  })));
  assert.equal(noDebt.debt.classification, "NO_DEBT");
  assert.equal(noDebt.debt.confidence, "HIGH");
});

// ── 2. WITHHELD INCOME COUNT ────────────────────────────────────────────────

test("BRIEF-1: the Income category survives the brief-scope byCategory slice", () => {
  // The assembler sorts byCategory by DEBIT total descending and, under
  // scopeHint='brief', keeps only the top 5. Income is an INFLOW: its debit
  // total is 0, so it sorts LAST and is the first entry the slice discards.
  //
  // The assembler's own comment says that entry exists for this reader:
  //   "Income's inflow figure is carried by incomeTotal, not byCategory; its
  //    byCategory entry exists for its `count`, which
  //    lib/ai/intelligence/annotations.ts reads for incomeTransactionCount"
  //
  // Measured: 11 categories → 5, Income dropped, incomeTransactionCount 8 → 0.
  // This asserts the ENGINE's consequence, so the coupling cannot be re-broken
  // silently from either side.
  const withIncome = computeAssessment(mkCtx(mkTxn(), mkAccts()));
  const withoutIncome = computeAssessment(mkCtx(
    mkTxn({ byCategory: [{ category: "Groceries", total: 900, count: 20 }] }),
    mkAccts(),
  ));

  assert.equal(withIncome.dataQuality.incomeConfidence, "HIGH");
  assert.equal(withIncome.cashFlow.reliability, "RELIABLE");

  // Losing ONLY the Income row — same incomeTotal, same rows, same window —
  // collapses the entire confidence ladder. This is what truncation costs.
  assert.equal(withoutIncome.dataQuality.incomeTransactionCount, 0);
  assert.equal(withoutIncome.dataQuality.incomeConfidence, "LOW");
  assert.equal(withoutIncome.cashFlow.reliability, "UNRELIABLE");
  assert.equal(withoutIncome.currentStatePriority, "DATA_QUALITY");
});
