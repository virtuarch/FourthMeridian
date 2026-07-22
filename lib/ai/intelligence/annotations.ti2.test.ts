/**
 * lib/ai/intelligence/annotations.ti2.test.ts
 *
 * TI2-W2 — the assessment layer's consumption of the needs-classification
 * aggregate. Pins three behaviors:
 *   1. deriveUnidentifiedInflowShare guards divide-by-zero (null, never NaN).
 *   2. A material unidentified-inflow share downgrades incomeConfidence below
 *      HIGH even when the row-count proxy alone would call it HIGH.
 *   3. INCOMPLETE_INCOME_DATA evidence states the amount ("$X of $Y income …
 *      has no identified source") when there is unidentified inflow, and falls
 *      back to the count-only wording when there is not.
 *
 * No test framework — inline assertions, exit 0/1 (house pattern). Importing
 * annotations transitively constructs the Prisma client but issues no query
 * (same note as the assembler golden test).
 */

import { computeAssessment } from "./annotations";
import { deriveUnidentifiedInflowShare, FinanceDomains } from "@/lib/ai/types";
import type { SpaceContext_AI, TransactionsSummaryData } from "@/lib/ai/types";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function mkTxn(over: Partial<TransactionsSummaryData> = {}): TransactionsSummaryData {
  return {
    windowDays: 90, startDate: "2026-04-01", endDate: "2026-06-30",
    transactionCount: 30, truncated: false, coverageStartDate: "2026-04-01",
    fetchLimit: 5000,
    incomeTotal: 1000, expenseTotal: 500, refundTotal: 0, debtPaymentTotal: 0,
    transferTotal: 0, netCashFlow: 500, estimated: false,
    pendingCreditCount: 0, pendingCreditTotal: 0, pendingDebitCount: 0, pendingDebitTotal: 0,
    unclassifiedCount: 0, adjustmentCount: 0,
    needsClassification: {
      count: 0, unknownInflowCount: 0, unknownInflowTotal: 0,
      unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0,
      counterpartyResolution: "PERSISTED_AND_READ_TIME",
    },
    // Income category present with 3 rows → count proxy passes HIGH.
    byCategory: [{ category: "Income", total: 0, count: 3 }],
    monthlyBreakdown: [],
    largestIncome: null, largestExpense: null,
    ...over,
  };
}

function mkCtx(txn: TransactionsSummaryData, snapshotCount = 60): SpaceContext_AI {
  return {
    requestedAt: "2026-06-30T00:00:00.000Z",
    spaceId: "space-1", userId: "user-1", role: "OWNER",
    agentId: "agent-1", resolvedDomains: [],
    space: { id: "space-1", name: "S", type: "personal", category: "personal" },
    domains: {
      [FinanceDomains.TRANSACTIONS_SUMMARY]: { domain: FinanceDomains.TRANSACTIONS_SUMMARY, assembledAt: "x", data: txn },
      [FinanceDomains.SNAPSHOT_HISTORY]:     { domain: FinanceDomains.SNAPSHOT_HISTORY, assembledAt: "x", data: { snapshotCount, history: [] } },
    },
    signals: [], auditLogId: "audit-1",
  };
}

// ── 1. divide-by-zero guard ──────────────────────────────────────────────────

check("share: zero income → null (no NaN/Infinity)",
  deriveUnidentifiedInflowShare({ incomeTotal: 0, needsClassification: { unknownInflowTotal: 200 } }) === null);
check("share: positive income → ratio",
  deriveUnidentifiedInflowShare({ incomeTotal: 1000, needsClassification: { unknownInflowTotal: 200 } }) === 0.2);
check("share: missing needsClassification block → 0 (defensive)",
  deriveUnidentifiedInflowShare({ incomeTotal: 1000 }) === 0);

// ── 2. incomeConfidence downgraded by share alone ────────────────────────────

{
  // Baseline: count proxy passes (3 income rows, plausible ratio, HIGH history),
  // no unidentified inflow → HIGH.
  const highCtx = mkCtx(mkTxn());
  const high = computeAssessment(highCtx);
  check("baseline income confidence is HIGH (count proxy passes)",
    high.dataQuality.incomeConfidence === "HIGH", high.dataQuality.incomeConfidence);
  check("baseline share is 0 (no unidentified inflow)",
    high.dataQuality.unidentifiedInflowShare === 0);

  // Same, but 20% of income is unidentified (material) → HIGH capped to MEDIUM,
  // by SHARE ALONE — the count proxy is unchanged.
  const matCtx = mkCtx(mkTxn({
    needsClassification: {
      count: 2, unknownInflowCount: 2, unknownInflowTotal: 200,
      unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0,
      counterpartyResolution: "PERSISTED_AND_READ_TIME",
    },
  }));
  const mat = computeAssessment(matCtx);
  check("material share downgrades HIGH → not HIGH (share alone)",
    mat.dataQuality.incomeConfidence !== "HIGH", mat.dataQuality.incomeConfidence);
  check("material share downgrades to MEDIUM specifically",
    mat.dataQuality.incomeConfidence === "MEDIUM", mat.dataQuality.incomeConfidence);
  check("dataQuality.unidentifiedInflowShare surfaced (0.2)",
    mat.dataQuality.unidentifiedInflowShare === 0.2, String(mat.dataQuality.unidentifiedInflowShare));

  // Immaterial share (5%) leaves HIGH intact.
  const immatCtx = mkCtx(mkTxn({
    needsClassification: {
      count: 1, unknownInflowCount: 1, unknownInflowTotal: 50,
      unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0,
      counterpartyResolution: "PERSISTED_AND_READ_TIME",
    },
  }));
  check("immaterial share leaves HIGH intact",
    computeAssessment(immatCtx).dataQuality.incomeConfidence === "HIGH");
}

// ── 3. INCOMPLETE_INCOME_DATA amount-based wording ───────────────────────────

{
  // incomeConfidence LOW (0 income rows) but income + unidentified present.
  const ctx = mkCtx(mkTxn({
    byCategory: [], // no Income row → incomeTransactionCount 0 → LOW
    needsClassification: {
      count: 3, unknownInflowCount: 3, unknownInflowTotal: 200,
      unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0,
      counterpartyResolution: "PERSISTED_AND_READ_TIME",
    },
  }));
  const a = computeAssessment(ctx);
  const risk = a.riskOpportunities.risks.find((r) => r.code === "INCOMPLETE_INCOME_DATA");
  check("INCOMPLETE_INCOME_DATA risk present", !!risk);
  check("evidence states the amount ($X of $Y income … no identified source)",
    !!risk && risk.evidence === "$200.00 of $1000.00 income in-window has no identified source (0 income transaction(s) captured) — income confidence LOW",
    risk?.evidence);

  // No unidentified inflow → count-only fallback wording.
  const ctx2 = mkCtx(mkTxn({ byCategory: [] }));
  const a2 = computeAssessment(ctx2);
  const risk2 = a2.riskOpportunities.risks.find((r) => r.code === "INCOMPLETE_INCOME_DATA");
  check("fallback evidence is count-only when no unidentified inflow",
    !!risk2 && risk2.evidence === "Only 0 income transaction(s) captured — income confidence LOW",
    risk2?.evidence);
}

if (failures.length > 0) {
  console.error(`\nTI2-W2 annotations: ${failures.length} FAILURE(S) (${passed} passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`TI2-W2 annotations: all ${passed} checks passed.`);
process.exit(0);
