/**
 * lib/ai/intelligence/trajectory.test.ts  (A2)
 *
 * Golden tests for the deterministic TRAJECTORY verdict.
 *
 * WHAT A2 SETTLED, and why these tests exist rather than prose in the prompt:
 * before A2 the assessment computed per-metric trend DIRECTIONS and showed them
 * to the model with no deterministic significance attached. "Spending fell 3%"
 * could be narrated as progress or as noise and nothing in the assessment said
 * which — the exact gap where a language model supplies its own conclusion.
 *
 * THE ARBITER IS `net`. Income and expense do not vote: `net` is ALREADY their
 * canonical resolution (metricValue → income − clampEconomicSpend, REVIEW-3 C-3).
 * "Income rose but expenses rose faster" is therefore not a tie broken here; it
 * is a question the canonical basis already answered. The cases below pin that.
 *
 * MATERIALITY IS INHERITED. A direction of FLAT already means the move was under
 * TREND_FLAT_PCT. A2 adds no second threshold.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeAssessment } from "@/lib/ai/intelligence";
import { computeSpendingTrends } from "@/lib/ai/intelligence/annotations/metrics";
import { computeTrajectory } from "@/lib/ai/intelligence/annotations/engines";
import { FinanceDomains } from "@/lib/ai/types";
import type {
  SpaceContext_AI, TransactionsSummaryData, MonthlyBreakdownEntry,
} from "@/lib/ai/types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** One complete calendar month. `partial`/`truncated` false ⇒ eligible for trends. */
function mo(month: string, incomeTotal: number, expenseTotal: number): MonthlyBreakdownEntry {
  return {
    month, incomeTotal, expenseTotal, refundTotal: 0,
    debtPaymentTotal: 0, transferTotal: 0, transactionCount: 12,
    partial: false, truncated: false, estimated: false,
  } as unknown as MonthlyBreakdownEntry;
}

function mkTxn(monthlyBreakdown: MonthlyBreakdownEntry[]): TransactionsSummaryData {
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
    monthlyBreakdown,
    largestIncome: null, largestExpense: null,
  } as unknown as TransactionsSummaryData;
}

/** Trajectory over two complete months: (income, expense) previous → latest. */
function traj(prev: [number, number], latest: [number, number]) {
  return computeTrajectory(computeSpendingTrends(mkTxn([
    mo("2026-05", prev[0], prev[1]),
    mo("2026-06", latest[0], latest[1]),
  ])));
}

// ── 1. The decision table ────────────────────────────────────────────────────
// Each case names the intended branch AND asserts the component directions that
// put it there — a verdict reached down an unintended path is a silent pass.

test("A2 — rising income, flat spend → IMPROVING", () => {
  const t = traj([4000, 2000], [5000, 2000]);
  assert.equal(t.incomeDirection, "RISING");
  assert.equal(t.expenseDirection, "FLAT");
  assert.equal(t.classification, "IMPROVING");
});

test("A2 — flat income, falling spend → IMPROVING", () => {
  const t = traj([4000, 2000], [4000, 1500]);
  assert.equal(t.incomeDirection, "FLAT");
  assert.equal(t.expenseDirection, "FALLING");
  assert.equal(t.classification, "IMPROVING");
});

test("A2 — falling income, flat spend → WORSENING", () => {
  const t = traj([4000, 2000], [3000, 2000]);
  assert.equal(t.incomeDirection, "FALLING");
  assert.equal(t.expenseDirection, "FLAT");
  assert.equal(t.classification, "WORSENING");
});

test("A2 — flat income, rising spend → WORSENING", () => {
  const t = traj([4000, 2000], [4000, 3000]);
  assert.equal(t.incomeDirection, "FLAT");
  assert.equal(t.expenseDirection, "RISING");
  assert.equal(t.classification, "WORSENING");
});

test("A2 — both rising, net improving → IMPROVING, rising spend recorded as divergent", () => {
  // income +2000, expense +500 ⇒ net +1500.
  const t = traj([4000, 2000], [6000, 2500]);
  assert.equal(t.incomeDirection, "RISING");
  assert.equal(t.expenseDirection, "RISING");
  assert.equal(t.classification, "IMPROVING");
  assert.ok(t.divergentSignals.some((d) => d.metric === "expense" && d.direction === "RISING"),
    "Spending rose while net improved — that must be recorded, not hidden behind the headline.");
});

test("A2 — both rising, net worsening → WORSENING (net outranks a rising income)", () => {
  // income +500, expense +2000 ⇒ net −1500. The canonical net has already
  // resolved "income rose but expenses rose faster"; A2 must not re-decide it.
  const t = traj([4000, 2000], [4500, 4000]);
  assert.equal(t.incomeDirection, "RISING");
  assert.equal(t.expenseDirection, "RISING");
  assert.equal(t.classification, "WORSENING");
  assert.ok(t.divergentSignals.some((d) => d.metric === "income" && d.direction === "RISING"),
    "Earning more and still going backwards is a different conversation — it must be surfaced.");
});

test("A2 — both falling, net improving → IMPROVING, falling income recorded as divergent", () => {
  // income −500, expense −1500 ⇒ net +1000.
  const t = traj([4000, 3000], [3500, 1500]);
  assert.equal(t.incomeDirection, "FALLING");
  assert.equal(t.expenseDirection, "FALLING");
  assert.equal(t.classification, "IMPROVING");
  assert.ok(t.divergentSignals.some((d) => d.metric === "income" && d.direction === "FALLING"),
    "A gain built on a shrinking income base must not read as unqualified improvement.");
});

test("A2 — both falling, net worsening → WORSENING", () => {
  // income −2000, expense −500 ⇒ net −1500.
  const t = traj([5000, 2000], [3000, 1500]);
  assert.equal(t.incomeDirection, "FALLING");
  assert.equal(t.expenseDirection, "FALLING");
  assert.equal(t.classification, "WORSENING");
  assert.ok(t.divergentSignals.some((d) => d.metric === "expense" && d.direction === "FALLING"));
});

test("A2 — immaterial movement → STABLE (materiality inherited from TREND_FLAT_PCT)", () => {
  // +1% income, +1% expense: both under the flat band ⇒ net flat too.
  const t = traj([4000, 2000], [4040, 2020]);
  assert.equal(t.incomeDirection, "FLAT");
  assert.equal(t.expenseDirection, "FLAT");
  assert.equal(t.classification, "STABLE");
  assert.deepEqual(t.divergentSignals, [], "A genuinely steady month has nothing to qualify.");
});

test("A2 — flat net built from offsetting MATERIAL moves → MIXED, never STABLE", () => {
  // income −1000, expense −1000 ⇒ net unchanged, but the household materially
  // changed. Reporting that as STABLE would be a false comfort.
  const t = traj([5000, 3000], [4000, 2000]);
  assert.equal(t.netDirection, "FLAT");
  assert.equal(t.incomeDirection, "FALLING");
  assert.equal(t.expenseDirection, "FALLING");
  assert.equal(t.classification, "MIXED");
  assert.equal(t.divergentSignals.length, 2, "MIXED must name both offsetting moves.");
});

// ── 2. Refusal ───────────────────────────────────────────────────────────────

test("A2 — one complete month → INSUFFICIENT_DATA, no basis, no direction", () => {
  const t = computeTrajectory(computeSpendingTrends(mkTxn([mo("2026-06", 4000, 2000)])));
  assert.equal(t.classification, "INSUFFICIENT_DATA");
  assert.equal(t.basis, null, "A refused verdict must not claim a comparison basis.");
  assert.deepEqual(t.divergentSignals, []);
});

test("A2 — zero complete months → INSUFFICIENT_DATA", () => {
  assert.equal(
    computeTrajectory(computeSpendingTrends(mkTxn([]))).classification,
    "INSUFFICIENT_DATA",
  );
});

test("A2 — partial months cannot manufacture a trajectory", () => {
  const partial = { ...mo("2026-05", 9000, 500), partial: true } as MonthlyBreakdownEntry;
  const trends  = computeSpendingTrends(mkTxn([partial, mo("2026-06", 4000, 2000)]));
  const t       = computeTrajectory(trends);
  assert.equal(t.completeMonthsAnalyzed, 1,
    "The partial month was counted as complete — trends would compare clipped data.");
  assert.equal(t.classification, "INSUFFICIENT_DATA",
    "A partial month was substituted to reach two months and produce a direction.");
  assert.ok(trends.partialMonthsExcluded.includes("2026-05"));
});

test("A2 — a partial month cannot move an EXISTING verdict", () => {
  const complete = [mo("2026-04", 4000, 2000), mo("2026-05", 4000, 2000), mo("2026-06", 5000, 2000)];
  const base = computeTrajectory(computeSpendingTrends(mkTxn(complete)));
  // A wildly adverse in-progress month appended to the same history.
  const withPartial = computeTrajectory(computeSpendingTrends(mkTxn([
    ...complete, { ...mo("2026-07", 100, 9000), partial: true } as MonthlyBreakdownEntry,
  ])));
  assert.equal(base.classification, "IMPROVING", "anti-vacuity: the base case must reach a real verdict");
  assert.equal(withPartial.classification, base.classification,
    "An in-progress month changed the verdict — partial data must never be compared.");
});

// ── 3. Determinism ───────────────────────────────────────────────────────────

test("A2 — identical facts produce an identical trajectory verdict", () => {
  const a = traj([4000, 2000], [5000, 1800]);
  const b = traj([4000, 2000], [5000, 1800]);
  assert.equal(a.classification, "IMPROVING", "anti-vacuity: must reach a real verdict");
  assert.deepEqual(a, b);
});

test("A2 — irrelevant context cannot move the trajectory verdict", () => {
  const months = [mo("2026-04", 4000, 2000), mo("2026-05", 4000, 2000), mo("2026-06", 5000, 2000)];
  const mkCtx = (txn: TransactionsSummaryData): SpaceContext_AI => ({
    requestedAt: "2026-06-30T00:00:00.000Z",
    spaceId: "s", userId: "u", role: "OWNER", agentId: "a", resolvedDomains: [],
    space: { id: "s", name: "S", type: "personal", category: "personal" },
    domains: {
      [FinanceDomains.TRANSACTIONS_SUMMARY]: { domain: FinanceDomains.TRANSACTIONS_SUMMARY, assembledAt: "x", data: txn },
      [FinanceDomains.SNAPSHOT_HISTORY]: { domain: FinanceDomains.SNAPSHOT_HISTORY, assembledAt: "x", data: { snapshotCount: 60, history: [] } },
    },
    signals: [], auditLogId: "al",
  } as unknown as SpaceContext_AI);

  const base  = computeAssessment(mkCtx(mkTxn(months)));
  const noisy = computeAssessment(mkCtx({
    ...mkTxn(months),
    byCategory: [
      { category: "Income", total: 0, count: 8 },
      { category: "Dining", total: 4000, count: 60 },
      { category: "Travel", total: 9000, count: 12 },
    ],
  } as unknown as TransactionsSummaryData));

  assert.equal(base.trajectory.classification, "IMPROVING", "anti-vacuity: base must grade");
  assert.equal(noisy.trajectory.classification, base.trajectory.classification,
    "Category detail the trajectory does not read moved the verdict.");
  assert.deepEqual(noisy.trajectory, base.trajectory);
});

test("A2 — trajectory reads complete months only, so scope cannot move it", () => {
  // scopeHint is transport-only since W4 and the assessment window is 90 rolling
  // days at every hint; trajectory adds no scope-sensitive input of its own — its
  // ONLY input is SpendingTrendsSection, itself derived from complete months.
  const months = [mo("2026-04", 4000, 2000), mo("2026-05", 4000, 2000), mo("2026-06", 5000, 2000)];
  const wide   = computeTrajectory(computeSpendingTrends(mkTxn(months)));
  const brief  = computeTrajectory(computeSpendingTrends({
    ...mkTxn(months), byCategory: [{ category: "Income", total: 0, count: 8 }],
  } as unknown as TransactionsSummaryData));
  assert.equal(wide.classification, "IMPROVING", "anti-vacuity");
  assert.deepEqual(brief, wide);
});

// ── 4. The refusal is DECLARED, not merely absent ────────────────────────────
//
// ⚠️ THE SERIALIZATION HALF OF THIS SECTION WAS DELETED WITH THE PROMPT LAYER
// (AI conversation reset). It asserted that a refused trajectory reached the
// model as "Classification: INSUFFICIENT_DATA" plus an instruction not to infer
// a direction — a property of a prompt serializer that no longer exists. What
// is kept is the property that survives any narration layer: the assessment
// itself declares the refusal in `ungraded[]`, so a future conversation layer
// can find it without a parallel mechanism.

test("A2 — an ungradeable trajectory declares its refusal in ungraded[]", () => {
  const a = computeAssessment({
    requestedAt: "2026-06-30T00:00:00.000Z",
    spaceId: "s", userId: "u", role: "OWNER", agentId: "a", resolvedDomains: [],
    space: { id: "s", name: "S", type: "personal", category: "personal" },
    domains: {
      [FinanceDomains.TRANSACTIONS_SUMMARY]: { domain: FinanceDomains.TRANSACTIONS_SUMMARY, assembledAt: "x", data: mkTxn([mo("2026-06", 4000, 2000)]) },
      [FinanceDomains.SNAPSHOT_HISTORY]: { domain: FinanceDomains.SNAPSHOT_HISTORY, assembledAt: "x", data: { snapshotCount: 60, history: [] } },
    },
    signals: [], auditLogId: "al",
  } as unknown as SpaceContext_AI);

  assert.equal(a.trajectory.classification, "INSUFFICIENT_DATA", "anti-vacuity: fixture must refuse");

  const u = a.ungraded.find((x) => x.section === "trajectory");
  assert.ok(u, "A withheld trajectory must be declared in ungraded[].");
  assert.equal(u!.reason, "INSUFFICIENT_COMPLETE_MONTHS");
});

test("A2 — a graded trajectory does not also declare a refusal", () => {
  const a = computeAssessment({
    requestedAt: "2026-06-30T00:00:00.000Z",
    spaceId: "s", userId: "u", role: "OWNER", agentId: "a", resolvedDomains: [],
    space: { id: "s", name: "S", type: "personal", category: "personal" },
    domains: {
      [FinanceDomains.TRANSACTIONS_SUMMARY]: { domain: FinanceDomains.TRANSACTIONS_SUMMARY, assembledAt: "x", data: mkTxn([mo("2026-05", 4000, 2000), mo("2026-06", 5000, 2000)]) },
      [FinanceDomains.SNAPSHOT_HISTORY]: { domain: FinanceDomains.SNAPSHOT_HISTORY, assembledAt: "x", data: { snapshotCount: 60, history: [] } },
    },
    signals: [], auditLogId: "al",
  } as unknown as SpaceContext_AI);

  assert.equal(a.trajectory.classification, "IMPROVING", "anti-vacuity: fixture must grade");
  assert.ok(!a.ungraded.some((x) => x.section === "trajectory"),
    "A graded trajectory must not also declare a refusal.");
});
