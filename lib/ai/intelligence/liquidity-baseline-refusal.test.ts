/**
 * lib/ai/intelligence/liquidity-baseline-refusal.test.ts
 *
 * v2.6-ASSESS-1 — the liquidity judgment refuses when its denominator cannot
 * support it. A zero baseline is not infinite runway.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `computeAverageMonthlySpending` returns null only when NO reliable month
 * exists. A Space with reliable months and no spending in them returns 0 — a
 * true measurement — and the coverage guard only tested `=== null`, so 0 went
 * into the divide.
 *
 * Measured on the live corpus: 5 of 9 Spaces had liquid accounts and a $0.00
 * measured baseline. Each was graded, and this is what the model was told:
 *
 *     LIQUIDITY  [confidence: HIGH]
 *       Coverage: Infinity months → EXCELLENT
 *       1. [HIGH] READY_TO_INVEST — conditions support investing
 *
 * A HIGH-impact investment recommendation manufactured from an absence of
 * evidence. The zero-cash case was worse: 0/0 is NaN, NaN fails every `<`
 * comparison, and the classification ladder is a chain of `<` tests — so NaN
 * fell through all of them onto EXCELLENT, the most favourable verdict
 * available. Nothing in the ladder had to be wrong for the worst possible answer
 * to be produced; it was reached by falling through.
 *
 * It also serialized incoherently: `JSON.stringify(Infinity)` is `null`, so a
 * consumer received `{ coverageMonths: null, classification: "EXCELLENT" }` —
 * an object contradicting itself, the null looking exactly like an honest
 * refusal.
 *
 * This is the arc's own doctrine, inverted. v2.6-DEBT-1 refused to ADMIT a debt
 * payment on silence ("absence of contradiction is not evidence"); here the
 * engine was producing a FINDING on silence. Same rule, other direction.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeAssessment } from "@/lib/ai/intelligence";
import { FinanceDomains } from "@/lib/ai/types";
import type {
  SpaceContext_AI, TransactionsSummaryData, AccountsSectionData,
} from "@/lib/ai/types";

function mkCtx(opts: { expenseTotal: number; totalLiquid: number; liquidCount?: number; reliableMonth?: boolean }): SpaceContext_AI {
  const { expenseTotal, totalLiquid, liquidCount = 2, reliableMonth = true } = opts;
  const txn = {
    windowDays: 90, startDate: "2026-04-01", endDate: "2026-06-30",
    transactionCount: 30, truncated: false, coverageStartDate: "2026-04-01", fetchLimit: 5000,
    incomeTotal: 9000, expenseTotal, refundTotal: 0, debtPaymentTotal: 0, transferTotal: 0,
    netCashFlow: 9000 - expenseTotal, estimated: false,
    pendingCreditCount: 0, pendingCreditTotal: 0, pendingDebitCount: 0, pendingDebitTotal: 0,
    unclassifiedCount: 0, adjustmentCount: 0,
    needsClassification: {
      count: 0, unknownInflowCount: 0, unknownInflowTotal: 0,
      unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0,
      counterpartyResolution: "PERSISTED_AND_READ_TIME",
    },
    byCategory: [{ category: "Income", total: 0, count: 8 }],
    // A reliable month is one that is neither partial nor truncated. Without one,
    // computeAverageMonthlySpending returns null — the case that ALREADY refused.
    monthlyBreakdown: reliableMonth
      ? [{ month: "2026-05", partial: false, truncated: false, expenseTotal, incomeTotal: 3000, netCashFlow: 3000 - expenseTotal, byCategory: [] }]
      : [],
    largestIncome: null, largestExpense: null,
  } as unknown as TransactionsSummaryData;

  const accts = {
    totalCount: 2, totalAssets: totalLiquid, totalLiabilities: 0, netWorth: totalLiquid,
    totalLiquid, totalInvestments: 0, totalDigitalAssets: 0, totalRealAssets: 0,
    totalsEstimated: false, totalsUnconverted: false,
    counts: { liquid: liquidCount, investments: 0, digitalAssets: 0, realAssets: 0, liabilities: 0 },
    health: { errorCount: 0, errorAccountNames: [], staleCount: 0, needsReauthCount: 0 },
    knowledgeGaps: [], accounts: [],
  } as unknown as AccountsSectionData;

  return {
    requestedAt: "2026-06-30T00:00:00.000Z",
    spaceId: "space-1", userId: "user-1", role: "OWNER",
    agentId: "agent-1", resolvedDomains: [],
    space: { id: "space-1", name: "S", type: "personal", category: "personal" },
    domains: {
      [FinanceDomains.TRANSACTIONS_SUMMARY]: { domain: FinanceDomains.TRANSACTIONS_SUMMARY, assembledAt: "x", data: txn },
      [FinanceDomains.SNAPSHOT_HISTORY]:     { domain: FinanceDomains.SNAPSHOT_HISTORY, assembledAt: "x", data: { snapshotCount: 60, spanDays: 59, history: [], canonicalChange: null } },
      [FinanceDomains.ACCOUNTS]:             { domain: FinanceDomains.ACCOUNTS, assembledAt: "x", data: accts },
    },
    signals: [], auditLogId: "audit-1",
  } as unknown as SpaceContext_AI;
}

test("ASSESS-1: a ZERO measured baseline refuses coverage, never EXCELLENT", () => {
  const a = computeAssessment(mkCtx({ expenseTotal: 0, totalLiquid: 10_000 }));

  assert.equal(
    a.liquidity.classification, "UNKNOWN",
    "$10,000 of cash against a $0.00 measured baseline was graded EXCELLENT off " +
    "coverageMonths = Infinity. Dividing by zero does not yield a large number.",
  );
  assert.equal(a.liquidity.coverageMonths, null, "an uncomputable coverage is null, not Infinity");
  assert.notEqual(
    a.liquidity.confidence, "HIGH",
    "there is no such thing as a HIGH-confidence UNKNOWN — the confidence was as " +
    "wrong as the grade",
  );
  // The baseline itself is still reported: $0.00 is a real measurement, and
  // suppressing it would replace a wrong conclusion with a missing input.
  assert.equal(a.liquidity.estimatedMonthlyExpense, 0);
});

test("ASSESS-1: zero cash AND zero spending does not fall through to EXCELLENT", () => {
  // 0/0 is NaN, and every rung of the classification ladder is a `<` test that
  // NaN fails — so the worst-evidence case reached the best-sounding verdict by
  // falling through every check rather than by any rung being wrong.
  const a = computeAssessment(mkCtx({ expenseTotal: 0, totalLiquid: 0 }));
  assert.equal(a.liquidity.classification, "UNKNOWN");
  assert.equal(a.liquidity.coverageMonths, null);
  assert.ok(!Number.isNaN(a.liquidity.coverageMonths as unknown as number));
});

test("ASSESS-1: the refusal removes the fabricated investment recommendation", () => {
  // READY_TO_INVEST gates on liquidity being SAFE or EXCELLENT. While a zero
  // baseline produced EXCELLENT, the engine emitted a HIGH-impact "conditions
  // support investing" for a Space it had no expense evidence about at all.
  const fabricated = computeAssessment(mkCtx({ expenseTotal: 0, totalLiquid: 10_000 }));
  assert.notEqual(fabricated.investmentReadiness.classification, "READY");
  assert.equal(fabricated.investmentReadiness.liquiditySafe, false);

  const opportunities = fabricated.riskOpportunities.opportunities.map((o) => o.code);
  assert.ok(
    !opportunities.includes("READY_TO_INVEST"),
    `an investment recommendation survived a refused liquidity judgment: ${opportunities.join(", ")}`,
  );
});

test("ASSESS-1: a real baseline still grades normally", () => {
  // The counterpart that proves the guard discriminates rather than suppresses.
  // One reliable month at $2,000 ⇒ a $2,000 baseline ⇒ 10,000 / 2,000 = 5 months,
  // which is SAFE (≥ WARNING's 3, below EXCELLENT's 6).
  const a = computeAssessment(mkCtx({ expenseTotal: 2_000, totalLiquid: 10_000 }));
  assert.equal(a.liquidity.estimatedMonthlyExpense, 2_000);
  assert.equal(a.liquidity.coverageMonths, 5);
  assert.equal(a.liquidity.classification, "SAFE");
  assert.equal(a.liquidity.confidence, "HIGH");
});

test("ASSESS-1: no reliable month still refuses, as it always did", () => {
  // The pre-existing null path must be untouched by the new zero path.
  const a = computeAssessment(mkCtx({ expenseTotal: 6_000, totalLiquid: 10_000, reliableMonth: false }));
  assert.equal(a.liquidity.estimatedMonthlyExpense, null);
  assert.equal(a.liquidity.classification, "UNKNOWN");
  assert.equal(a.liquidity.coverageMonths, null);
});
