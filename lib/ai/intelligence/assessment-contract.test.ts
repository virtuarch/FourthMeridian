/**
 * lib/ai/intelligence/assessment-contract.test.ts  (A1)
 *
 * THE DETERMINISTIC ASSESSMENT CONTRACT — the falsifiable declaration of what
 * computeAssessment() can conclude, and the proof that it concludes it
 * deterministically or refuses.
 *
 * A1 is the transition from the truthfulness/substrate program into the
 * assessment program. Everything downstream (context framing, then evaluation
 * of the model's own reasoning) is built on the guarantee that this layer is a
 * pure function of assembled facts. That guarantee was assumed, never pinned.
 *
 * WHAT THIS ADDS (and only this — no invariant proved elsewhere is duplicated):
 *
 *   §1 DECLARED COVERAGE. Every graded dimension and the COMPLETE set of
 *      verdicts it may return, declared here and checked against the type
 *      source. Coverage cannot silently widen: a new classification member is a
 *      test failure until it is declared, which forces the question "is this
 *      dimension actually gradeable from trustworthy facts?" to be answered
 *      deliberately rather than by merging.
 *
 *   §2 DETERMINISM. Same facts ⇒ same verdict; twice ⇒ identical; and context
 *      the grade does not depend on cannot move the grade.
 *
 *   §3 NO INVENTION. Absent facts produce a declared refusal, never a
 *      conclusion computed from silence — and every refusal names a DATA GAP.
 *
 * ALREADY PROVEN ELSEWHERE — deliberately not repeated here:
 *   · scope cannot change a conclusion (W3/W4) — scripts/audit-brief-assessment-parity.ts
 *     (REQUIRED-adjacent, measured over real Spaces: 0 conclusion movement)
 *   · debt refusal conditions + "the engine graded silence" — brief-scope-adequacy.test.ts
 *   · liquidity baseline refusal + DECLARED > MEASURED — liquidity-baseline-refusal.test.ts
 *   · income-confidence downgrade — annotations.ti2.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeAssessment } from "@/lib/ai/intelligence";
import { FinanceDomains } from "@/lib/ai/types";
import type {
  SpaceContext_AI, TransactionsSummaryData, AccountsSectionData,
} from "@/lib/ai/types";

// ── Fixtures (same shape as brief-scope-adequacy.test.ts) ────────────────────

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
    // Complete (non-partial) calendar months, so the MEASURED expense baseline
    // resolves and liquidity reaches a REAL grade. Without these the section
    // refuses NO_EXPENSE_BASELINE_IN_WINDOW and the §2 assertion is vacuous.
    monthlyBreakdown: [
      { month: "2026-04", incomeTotal: 4000, expenseTotal: 2000, refundTotal: 0, debtPaymentTotal: 0, transferTotal: 0, transactionCount: 14, partial: false },
      { month: "2026-05", incomeTotal: 4000, expenseTotal: 2000, refundTotal: 0, debtPaymentTotal: 0, transferTotal: 0, transactionCount: 14, partial: false },
      { month: "2026-06", incomeTotal: 4000, expenseTotal: 2000, refundTotal: 0, debtPaymentTotal: 0, transferTotal: 0, transactionCount: 12, partial: false },
    ] as unknown as TransactionsSummaryData["monthlyBreakdown"],
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
    accounts: [
      // V25-SIDE-1: a liability balance is POSITIVE when owed (amountOwed = max(b,0)).
      // A negative here models an OVERPAID card, which correctly grades HEALTHY —
      // it would make the §2 debt assertion compare a refusal to a refusal.
      { id: "d1", name: "Card A", type: "debt", balance: 20_000, currency: "USD", reportingBalance: 20_000, apr: 24, visibilityLevel: "FULL" },
      { id: "c1", name: "Checking", type: "checking", balance: 10_000, currency: "USD", reportingBalance: 10_000, visibilityLevel: "FULL" },
    ],
    ...over,
  } as unknown as AccountsSectionData;
}

function mkCtx(
  txn: TransactionsSummaryData | null,
  accts: AccountsSectionData | null,
  snapshotCount = 60,
): SpaceContext_AI {
  return {
    requestedAt: "2026-06-30T00:00:00.000Z",
    spaceId: "space-1", userId: "user-1", role: "OWNER",
    agentId: "agent-1", resolvedDomains: [],
    space: { id: "space-1", name: "S", type: "personal", category: "personal" },
    domains: {
      ...(txn ? { [FinanceDomains.TRANSACTIONS_SUMMARY]: { domain: FinanceDomains.TRANSACTIONS_SUMMARY, assembledAt: "x", data: txn } } : {}),
      [FinanceDomains.SNAPSHOT_HISTORY]: { domain: FinanceDomains.SNAPSHOT_HISTORY, assembledAt: "x", data: { snapshotCount, history: [] } },
      ...(accts ? { [FinanceDomains.ACCOUNTS]: { domain: FinanceDomains.ACCOUNTS, assembledAt: "x", data: accts } } : {}),
    },
    signals: [], auditLogId: "audit-1",
  } as unknown as SpaceContext_AI;
}

// ── §1 DECLARED COVERAGE ─────────────────────────────────────────────────────
//
// The contract. Each entry: a graded dimension, and EVERY verdict it may
// return. Checked against lib/ai/intelligence/annotations/types.ts, so the
// declaration and the implementation cannot drift apart in either direction.

const DECLARED_COVERAGE: Record<string, string[]> = {
  // Base sections — the primary financial judgements.
  // Renamed from DebtHealthClassification: the union grades the RATE on the owed
  // balance, and now says so. The verdict set is UNCHANGED — no new claim.
  DebtRateClassification: [
    "CRITICAL", "WARNING", "IMPROVING", "HEALTHY", "INSUFFICIENT_DATA", "NO_DEBT",
  ],
  LiquidityCoverageClassification: [
    "CRITICAL", "WARNING", "SAFE", "EXCELLENT", "UNKNOWN",
  ],
  CashFlowReliability: ["UNRELIABLE", "PARTIAL", "RELIABLE"],
  DeficitCauseClassification: [
    "POSSIBLE_OVERSPENDING", "LOW_INCOME_SAMPLE", "DEBT_DRIVEN", "NOT_APPLICABLE",
  ],
  // Layer-2 engines — framing inputs derived from the base sections.
  CapitalAllocationRecommendation: [
    "BUILD_LIQUIDITY", "PAY_HIGH_APR_DEBT", "DEBT_BEFORE_INVESTING",
    "INVEST_ELIGIBLE", "BLOCKED_BY_DATA",
  ],
  DebtPayoffUrgency: ["CRITICAL", "HIGH", "MODERATE", "LOW", "NONE", "UNKNOWN"],
  InvestmentReadinessClassification: [
    "READY", "CONDITIONALLY_READY", "DEBT_FIRST", "BUILD_LIQUIDITY_FIRST", "BLOCKED_BY_DATA",
  ],
  TrendDirection: ["RISING", "FALLING", "FLAT", "INSUFFICIENT_DATA"],
  // A2 — the significance of those directions. Declared deliberately: this guard
  // FAILED when the union was added, which is the mechanism working.
  TrajectoryClassification: [
    "IMPROVING", "WORSENING", "STABLE", "MIXED", "INSUFFICIENT_DATA",
  ],
  // Ranking + refusal vocabulary.
  CurrentStatePriority: ["DATA_QUALITY", "LIQUIDITY", "DEBT", "CASH_FLOW"],
  UngradedReasonCode: [
    "ACCOUNTS_DOMAIN_ABSENT", "ACCOUNT_LIST_ABSENT", "APR_MISSING",
    "NO_LIQUID_ACCOUNTS_IN_SPACE", "NO_EXPENSE_BASELINE_IN_WINDOW", "LOW_INCOME_CONFIDENCE",
    // A2 — fewer than two complete calendar months, so no comparison exists.
    "INSUFFICIENT_COMPLETE_MONTHS",
  ],
};

/**
 * Union members declared in the type source.
 *
 * Comments are stripped from the WHOLE source BEFORE the declaration is matched,
 * never after: a trailing comment here contains a semicolon ("...market return
 * reference; liquidity safe"), which ends a non-greedy match at the wrong place
 * and silently truncates the union. A guard that reads half a type would pass
 * while the contract drifted.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function unionMembers(bareSrc: string, name: string): string[] {
  const decl = new RegExp(`export type ${name}\\s*=([^;]*);`, "m").exec(bareSrc);
  assert.ok(decl, `${name} not found in types.ts — the contract names a type that no longer exists`);
  return [...decl[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
}

test("A1 §1 — declared coverage matches the implementation exactly", () => {
  const src = stripComments(readFileSync("lib/ai/intelligence/annotations/types.ts", "utf8"));
  for (const [typeName, declared] of Object.entries(DECLARED_COVERAGE)) {
    assert.deepEqual(
      unionMembers(src, typeName), [...declared].sort(),
      `${typeName} drifted from the A1 declared coverage contract. A new verdict is a new ` +
      `CLAIM the product can make about someone's finances — declare it here deliberately, ` +
      `and only after confirming its inputs are trustworthy.`,
    );
  }
});

// ── §2 DETERMINISM ───────────────────────────────────────────────────────────

test("A1 §2 — computing twice over one context yields identical output", () => {
  const ctx = mkCtx(mkTxn(), mkAccts());
  assert.deepEqual(
    computeAssessment(ctx), computeAssessment(ctx),
    "computeAssessment is not idempotent — a second call over the same context " +
    "produced a different assessment. Every downstream guarantee assumes purity.",
  );
});

test("A1 §2 — structurally identical but distinct contexts yield identical output", () => {
  assert.deepEqual(
    computeAssessment(mkCtx(mkTxn(), mkAccts())),
    computeAssessment(mkCtx(mkTxn(), mkAccts())),
    "Two contexts carrying the same facts graded differently — the verdict depends " +
    "on something other than the facts.",
  );
});

test("A1 §2 — context a grade does not depend on cannot move that grade", () => {
  const base = computeAssessment(mkCtx(mkTxn(), mkAccts()));
  // ANTI-VACUITY. "Unchanged" is worthless if both sides are refusals: this
  // assertion only means something while the fixture reaches real verdicts.
  assert.ok(!["INSUFFICIENT_DATA"].includes(base.debt.classification),
    "§2 fixture no longer grades DEBT — the invariant below would compare two refusals.");
  assert.ok(!["UNKNOWN"].includes(base.liquidity.classification),
    "§2 fixture no longer grades LIQUIDITY — the invariant below would compare two refusals.");
  // Add spending detail and larger investment/digital-asset totals. Neither is an
  // input to the debt or liquidity verdicts; both are plausible things to appear
  // in a richer payload. (This is also why W6 does not gate assessment: moving
  // the crypto valuation basis moves totalDigitalAssets, which no grade reads.)
  const noisy = computeAssessment(mkCtx(
    mkTxn({
      byCategory: [
        { category: "Income", total: 0, count: 8 },
        { category: "Dining", total: 900, count: 30 },
        { category: "Travel", total: 1500, count: 4 },
      ],
    }),
    mkAccts({ totalInvestments: 400_000, totalDigitalAssets: 250_000, totalAssets: 700_000 }),
  ));
  assert.equal(noisy.debt.classification, base.debt.classification,
    "Irrelevant context moved the DEBT verdict.");
  assert.equal(noisy.liquidity.classification, base.liquidity.classification,
    "Irrelevant context moved the LIQUIDITY verdict.");
  assert.equal(noisy.currentStatePriority, base.currentStatePriority,
    "Irrelevant context moved the ranked priority.");
});

// ── §3 NO INVENTION ──────────────────────────────────────────────────────────

test("A1 §3 — an empty context refuses every gradeable dimension", () => {
  const a = computeAssessment(mkCtx(null, null, 0));

  assert.equal(a.debt.classification, "INSUFFICIENT_DATA",
    "With no accounts domain the debt verdict must refuse, not grade an absent balance sheet.");
  assert.equal(a.liquidity.classification, "UNKNOWN",
    "With no accounts domain liquidity coverage must be UNKNOWN, never EXCELLENT by " +
    "dividing zero expenses into zero cash (the ASSESS-1 hazard).");
  assert.equal(a.liquidity.coverageMonths, null,
    "A refused coverage must carry no number — a figure beside a refusal reads as a grade.");
  assert.ok(a.ungraded.length > 0,
    "Nothing was graded, yet the assessment declared no refusal. A missing verdict must " +
    "be a stated refusal, never silence a consumer can misread as a pass.");
  assert.equal(a.capitalAllocation.recommendation, "BLOCKED_BY_DATA",
    "Capital allocation must be BLOCKED_BY_DATA when there is nothing to allocate from.");
  assert.equal(a.trajectory.classification, "INSUFFICIENT_DATA",
    "With no months of history the trajectory must refuse — a direction inferred from " +
    "nothing is the narrative gap A2 exists to close.");
  assert.equal(a.trajectory.basis, null,
    "A refused trajectory must not claim a comparison basis.");
  assert.equal(a.investmentReadiness.classification, "BLOCKED_BY_DATA",
    "Investment readiness must not read READY off an empty context (the ASSESS-1 " +
    "fabricated-recommendation shape).");
});

test("A1 §3 — every refusal names a data gap, never a scope or presentation choice", () => {
  const declared = DECLARED_COVERAGE.UngradedReasonCode;
  for (const ctx of [mkCtx(null, null, 0), mkCtx(mkTxn(), mkAccts({ accounts: undefined }))]) {
    for (const u of computeAssessment(ctx).ungraded) {
      assert.ok(declared.includes(u.reason),
        `Undeclared refusal reason ${u.reason} — the refusal vocabulary is part of the contract.`);
      assert.ok(!/WITHHELD|SCOPE|BRIEF|HINT/i.test(u.reason),
        `Refusal ${u.reason} attributes the gap to scope. Since W3/W4 the assessment window ` +
        `and the debt rows are scope-invariant: a refusal names missing DATA or it is wrong.`);
      assert.ok(u.detail.trim().length > 0,
        `Refusal ${u.reason} carries no human-readable detail — a consumer cannot say what is missing.`);
    }
  }
});
