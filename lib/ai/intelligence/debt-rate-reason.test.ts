/**
 * lib/ai/intelligence/debt-rate-reason.test.ts
 *
 * A CLASSIFICATION TRAVELS WITH ITS SCOPE AND ITS REASON — and a rate is not a
 * burden.
 *
 * The forensic case (docs/plans/AI-CONVERSATION-STATE-…, §12a): a small balance
 * across two high-rate cards graded `debt: CRITICAL` at HIGH confidence. The
 * arithmetic was right — the blended rate was above 22 — and the label was read as
 * "your debt situation is in the most severe tier, driven by how you've been
 * using and repaying it", because a bare label told a narrator nothing about
 * what had been graded or why.
 *
 * What is pinned here is corpus-independent:
 *
 *   · the classification is SCOPED to the rate on the owed balance
 *   · every rung names itself, its operands and its thresholds
 *   · a small balance and a large balance at one rate grade IDENTICALLY (a high
 *     APR is never hidden because the balance is small) and differ ONLY in the
 *     burden — which is stated relative to the user's own income, expenses and
 *     cash, with the operands echoed, and is never graded
 *   · no downstream verdict moved: the same ladder, the same thresholds
 *
 * ⚠️ SYNTHETIC FIGURES. The shape of the case is reproduced (a small balance, two
 * rates above the critical threshold); no value here is anyone's real money.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/intelligence/debt-rate-reason.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeAssessment } from "@/lib/ai/intelligence";
import { computeDebtBurden, gradeDebtRate, pctOf } from "@/lib/ai/intelligence/annotations/classification-reason";
import { APR_CRITICAL_THRESHOLD, APR_WARNING_THRESHOLD } from "@/lib/ai/intelligence/annotations/constants";
import { FinanceDomains } from "@/lib/ai/types";
import type {
  AccountSummaryItem, AccountsSectionData, SpaceContext_AI, TransactionsSummaryData,
} from "@/lib/ai/types";

// ── Fixtures ────────────────────────────────────────────────────────────────

const month = (m: string, income: number, expense: number) => ({
  month: m, incomeTotal: income, expenseTotal: expense, refundTotal: 0, debtPaymentTotal: 0,
  transferTotal: 0, netCashFlow: income - expense, partial: false, byCategory: [],
});

function mkTxn(over: Partial<TransactionsSummaryData> = {}): TransactionsSummaryData {
  return {
    windowDays: 90, startDate: "2026-04-01", endDate: "2026-06-30",
    transactionCount: 120, truncated: false, coverageStartDate: "2026-04-01", fetchLimit: 5000,
    incomeTotal: 30_000, expenseTotal: 12_000, refundTotal: 0, debtPaymentTotal: 0,
    transferTotal: 0, netCashFlow: 18_000, estimated: false,
    pendingCreditCount: 0, pendingCreditTotal: 0, pendingDebitCount: 0, pendingDebitTotal: 0,
    unclassifiedCount: 0, adjustmentCount: 0,
    needsClassification: { count: 0, unknownInflowCount: 0, unknownInflowTotal: 0,
      unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0, counterpartyResolution: "PERSISTED_AND_READ_TIME" },
    byCategory: [{ category: "Income", total: 30_000, count: 8 }],
    monthlyBreakdown: [month("2026-04", 10_000, 4_000), month("2026-05", 10_000, 4_000), month("2026-06", 10_000, 4_000)],
    largestIncome: null, largestExpense: null,
    ...over,
  } as unknown as TransactionsSummaryData;
}

const card = (id: string, owed: number, apr: number | null, over: Partial<AccountSummaryItem> = {}): AccountSummaryItem => ({
  id, name: `Card ${id}`, type: "debt", balance: owed, currency: "USD", reportingBalance: owed,
  lastUpdated: "2026-06-30T00:00:00.000Z", needsReauth: false, visibilityLevel: "FULL", apr, ...over,
} as AccountSummaryItem);

function mkAccts(cards: AccountSummaryItem[], liquid = 12_000): AccountsSectionData {
  const owed = cards.reduce((s, c) => s + Math.max(0, c.reportingBalance ?? 0), 0);
  return {
    totalCount: cards.length + 1, totalAssets: liquid, totalLiabilities: owed, netWorth: liquid - owed,
    totalLiquid: liquid, totalInvestments: 0, totalDigitalAssets: 0, totalRealAssets: 0,
    totalsEstimated: false, totalsUnconverted: false,
    counts: { liquid: 1, investments: 0, digitalAssets: 0, realAssets: 0, liabilities: cards.length },
    health: { errorCount: 0, errorAccountNames: [], staleCount: 0, needsReauthCount: 0 },
    knowledgeGaps: cards.filter((c) => c.apr == null).map((c) => ({ accountId: c.id, accountName: c.name, field: "apr", label: "APR" })),
    accounts: cards, accountListScope: "DEBT_ONLY",
  } as unknown as AccountsSectionData;
}

function mkCtx(accts: AccountsSectionData | null, snap: Record<string, unknown> = {}): SpaceContext_AI {
  return {
    requestedAt: "2026-06-30T00:00:00.000Z", spaceId: "s", userId: "u", role: "OWNER",
    agentId: "a", resolvedDomains: [], space: { id: "s", name: "S", type: "personal", category: "personal" },
    domains: {
      [FinanceDomains.TRANSACTIONS_SUMMARY]: { domain: FinanceDomains.TRANSACTIONS_SUMMARY, assembledAt: "x", data: mkTxn() },
      [FinanceDomains.SNAPSHOT_HISTORY]: { domain: FinanceDomains.SNAPSHOT_HISTORY, assembledAt: "x", data: { snapshotCount: 60, history: [], ...snap } },
      ...(accts ? { [FinanceDomains.ACCOUNTS]: { domain: FinanceDomains.ACCOUNTS, assembledAt: "x", data: accts } } : {}),
    },
    signals: [], auditLogId: "x",
  } as unknown as SpaceContext_AI;
}

// A small balance at two high rates: 1,480 @ 23.99% and 120 @ 29.99% ⇒ 24.44% on 1,600.
const SMALL = [card("a", 1480, 23.99), card("b", 120, 29.99)];
// The same two rates on a hundred times the balance.
const LARGE = [card("a", 148_000, 23.99), card("b", 12_000, 29.99)];

// ── 1. Scope and reason ─────────────────────────────────────────────────────

test("the debt classification is scoped to the RATE on the owed balance, and says which rung fired", () => {
  const d = computeAssessment(mkCtx(mkAccts(SMALL))).debt;
  assert.equal(d.classification, "CRITICAL");
  assert.equal(d.reason.scope, "RATE_ON_OWED_BALANCE");
  assert.equal(d.reason.reasonCode, "WEIGHTED_APR_ABOVE_CRITICAL");
  assert.equal(d.reason.reasonMetrics.weightedAprPct, 24.44, "the operand the rule compared");
  assert.equal(d.reason.reasonMetrics.criticalAbovePct, APR_CRITICAL_THRESHOLD, "the threshold it compared it with");
  assert.equal(d.reason.reasonMetrics.warningAbovePct, APR_WARNING_THRESHOLD);
  assert.equal(d.reason.reasonMetrics.ratedOwed, 1600);
  assert.deepEqual(d.reason.evidencePopulation, { kind: "DEBT_ACCOUNTS", accounts: 2, graded: 2 });
  assert.equal(d.confidence, "HIGH", "confidence is in the RATE classification: both APRs are known");
});

test("every rung of the ladder names itself — including the refusing ones", () => {
  const code = (accts: AccountsSectionData | null, snap?: Record<string, unknown>) => {
    const d = computeAssessment(mkCtx(accts, snap)).debt;
    return `${d.classification}/${d.reason.reasonCode}`;
  };
  assert.equal(code(mkAccts([card("a", 5_000, 18)])), "WARNING/WEIGHTED_APR_ABOVE_WARNING");
  assert.equal(code(mkAccts([card("a", 5_000, 9)])), "HEALTHY/RATE_BELOW_WARNING");
  assert.equal(code(mkAccts([card("a", 5_000, 9)]), { liabilitiesChange: { abs: -400, pct: -7 } }),
    "IMPROVING/RATE_BELOW_WARNING_LIABILITIES_DECLINING");
  assert.equal(code(mkAccts([card("a", 5_000, null)])), "INSUFFICIENT_DATA/APR_UNKNOWN");
  assert.equal(code(mkAccts([])), "NO_DEBT/NO_LIABILITIES");
  assert.equal(code(null), "INSUFFICIENT_DATA/ACCOUNTS_DOMAIN_ABSENT");
  const listAbsent = { ...mkAccts(SMALL), accounts: undefined } as AccountsSectionData;
  assert.equal(code(listAbsent), "INSUFFICIENT_DATA/ACCOUNT_LIST_ABSENT");
});

test("the trend tie-break's operand is echoed only on the rungs that read it", () => {
  const improving = computeAssessment(mkCtx(mkAccts([card("a", 5_000, 9)]), { liabilitiesChange: { abs: -400, pct: -7 } })).debt;
  assert.equal(improving.reason.reasonMetrics.liabilitiesChangeOverWindow, -400);
  const critical = computeAssessment(mkCtx(mkAccts(SMALL), { liabilitiesChange: { abs: -400, pct: -7 } })).debt;
  assert.ok(!("liabilitiesChangeOverWindow" in critical.reason.reasonMetrics),
    "a falling balance did not participate in a CRITICAL rate verdict, so it is not offered as its reason");
});

// ── 2. Rate vs burden ───────────────────────────────────────────────────────

test("small balance / high APR and large balance / high APR grade IDENTICALLY on rate — the APR is never hidden", () => {
  const small = computeAssessment(mkCtx(mkAccts(SMALL))).debt;
  const large = computeAssessment(mkCtx(mkAccts(LARGE))).debt;
  assert.equal(small.classification, "CRITICAL");
  assert.equal(large.classification, "CRITICAL");
  assert.equal(small.reason.reasonMetrics.weightedAprPct, large.reason.reasonMetrics.weightedAprPct);
});

test("…and differ ONLY in the burden, stated against the user's own position with its operands", () => {
  const small = computeAssessment(mkCtx(mkAccts(SMALL))).debt.burden;
  const large = computeAssessment(mkCtx(mkAccts(LARGE))).debt.burden;

  // Operands echoed: the monthly income mean, the expense baseline, liquid cash.
  assert.equal(small.monthlyIncome, 10_000);
  assert.equal(small.monthlyExpenses, 4_000);
  assert.equal(small.liquid, 12_000);

  assert.equal(small.monthlyInterestIfCarried, 32.59);
  assert.equal(small.interestOfMonthlyIncomePct, 0.33);
  assert.equal(small.interestOfMonthlyExpensesPct, 0.81);
  assert.equal(small.owedOfLiquidPct, 13.33);

  assert.equal(large.monthlyInterestIfCarried, 3258.67);
  assert.equal(large.interestOfMonthlyIncomePct, 32.59);
  assert.equal(large.interestOfMonthlyExpensesPct, 81.47);
  assert.equal(large.owedOfLiquidPct, 1333.33);

  assert.ok(!("classification" in small) && !("severity" in small),
    "the burden is facts with operands — no scoring model exists, so none is invented");
});

test("low APR / heavy balance: the rate is HEALTHY and the burden still shows what it costs", () => {
  const d = computeAssessment(mkCtx(mkAccts([card("loan", 240_000, 6.5)]))).debt;
  assert.equal(d.classification, "HEALTHY", "a 6.5% rate is below both rate thresholds — the rate rule says so");
  assert.equal(d.burden.monthlyInterestIfCarried, 1300);
  assert.equal(d.burden.interestOfMonthlyIncomePct, 13);
  assert.equal(d.burden.owedOfLiquidPct, 2000);
});

test("a ratio whose base is not established is null — never 0, never Infinity", () => {
  assert.equal(pctOf(32.59, 0), null);
  assert.equal(pctOf(32.59, 0.004), null, "under half a cent is no base (MONEY_EPSILON)");
  assert.equal(pctOf(32.59, null), null);
  assert.equal(pctOf(null, 100), null);
  const b = computeDebtBurden({ ratedOwed: 1000, monthlyInterestIfCarried: 20, totalLiabilities: 1000,
    monthlyIncome: null, monthlyExpenses: 0, liquid: null });
  assert.equal(b.interestOfMonthlyIncomePct, null);
  assert.equal(b.interestOfMonthlyExpensesPct, null);
  assert.equal(b.owedOfLiquidPct, null);
  assert.equal(b.monthlyInterestIfCarried, 20, "the amount itself is still a fact");
});

test("no debt: nothing owed, nothing to burden", () => {
  const d = computeAssessment(mkCtx(mkAccts([]))).debt;
  assert.equal(d.burden.monthlyInterestIfCarried, null);
  assert.equal(d.burden.owedOfLiquidPct, null);
});

// ── 3. The ladder did not move ──────────────────────────────────────────────

test("the ladder is the one computeAssessment always ran: strict thresholds, null rate weighs as 0", () => {
  const at = (apr: number | null, change: number | null = null) => gradeDebtRate({
    weightedAprPct: apr, ratedOwed: 1000, liabilitiesChangeAbs: change, debtAccounts: 1, debtAccountsWithApr: 1,
  }).classification;
  assert.equal(at(22), "WARNING", "exactly the threshold is NOT above it");
  assert.equal(at(22.01), "CRITICAL");
  assert.equal(at(15), "HEALTHY");
  assert.equal(at(15.01), "WARNING");
  assert.equal(at(null), "HEALTHY");
  assert.equal(at(null, -1), "IMPROVING");
});

test("downstream verdicts are unchanged: CRITICAL still means high-APR debt present to every consumer", () => {
  const a = computeAssessment(mkCtx(mkAccts(SMALL)));
  assert.ok(a.advisorHeuristics.includes("HIGH_APR_DEBT_PRIORITY"));
  assert.ok(a.riskOpportunities.risks.some((r) => r.code === "HIGH_INTEREST_DEBT"));
  assert.equal(a.capitalAllocation.highInterestDebtPresent, true);
  assert.equal(a.investmentReadiness.highAprDebtPresent, true);
  assert.equal(a.debtStrategy.payoffUrgency, "CRITICAL");
});

// ── 4. Liquidity carries the same shape ─────────────────────────────────────

test("liquidity ships the SAME reason shape: scope, rung, operands, thresholds, population", () => {
  const l = computeAssessment(mkCtx(mkAccts(SMALL, 12_000))).liquidity;
  assert.equal(l.classification, "SAFE");
  assert.equal(l.reason.scope, "LIQUID_CASH_VS_MONTHLY_EXPENSES");
  assert.equal(l.reason.reasonCode, "COVERAGE_BELOW_EXCELLENT");
  assert.deepEqual(l.reason.reasonMetrics, {
    coverageMonths: 3, liquid: 12_000, monthlyExpenses: 4_000, monthlyExpensesBasis: "MEASURED",
    criticalBelowMonths: 1, warningBelowMonths: 3, excellentFromMonths: 6,
  });
  assert.deepEqual(l.reason.evidencePopulation, { kind: "LIQUID_ACCOUNTS", accounts: 1, graded: 1 });

  const low = computeAssessment(mkCtx(mkAccts(SMALL, 3_000))).liquidity;
  assert.equal(`${low.classification}/${low.reason.reasonCode}`, "CRITICAL/COVERAGE_BELOW_CRITICAL");
});

test("a refused liquidity grade names WHY, in the same shape", () => {
  const noLiquid = { ...mkAccts(SMALL), counts: { liquid: 0, investments: 0, digitalAssets: 0, realAssets: 0, liabilities: 2 } } as AccountsSectionData;
  const l = computeAssessment(mkCtx(noLiquid)).liquidity;
  assert.equal(`${l.classification}/${l.reason.reasonCode}`, "UNKNOWN/NO_LIQUID_ACCOUNTS");
  assert.equal(l.reason.evidencePopulation.graded, 0);
});
