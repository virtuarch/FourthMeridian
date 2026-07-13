/**
 * lib/ai/signals/detectors/transactions.ti2.test.ts
 *
 * TI2-W2 — the NEEDS_CLASSIFICATION signal detector. Pins:
 *   - fires iff needsClassification.count > 0;
 *   - severity is `info` when the unidentified-inflow share is below the shared
 *     materiality threshold, `warning` at/above it (the SAME threshold the Brief
 *     caveat uses — one definition);
 *   - a zero-income window with unresolved payment-app rows stays `info` (share
 *     is null, never material) — no divide-by-zero escalation.
 *
 * Inline assertions, exit 0/1 (house pattern).
 */

import { detectTransactionSignals } from "./transactions";
import { SignalType } from "@/lib/ai/signals/types";
import { MATERIAL_UNIDENTIFIED_INFLOW_SHARE, FinanceDomains } from "@/lib/ai/types";
import type { ContextDomainSection, TransactionsSummaryData } from "@/lib/ai/types";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

function mkTxn(over: Partial<TransactionsSummaryData> = {}): TransactionsSummaryData {
  return {
    windowDays: 30, startDate: "2026-06-01", endDate: "2026-06-30",
    transactionCount: 10, truncated: false, coverageStartDate: "2026-06-01", fetchLimit: 5000,
    incomeTotal: 1000, expenseTotal: 500, refundTotal: 0, debtPaymentTotal: 0,
    transferTotal: 0, netCashFlow: 500, estimated: false,
    pendingCreditCount: 0, pendingCreditTotal: 0, pendingDebitCount: 0, pendingDebitTotal: 0,
    needsClassification: {
      count: 0, unknownInflowCount: 0, unknownInflowTotal: 0,
      unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0,
      counterpartyResolution: "PERSISTED_AND_READ_TIME",
    },
    byCategory: [], monthlyBreakdown: [], largestIncome: null, largestExpense: null,
    ...over,
  };
}

function run(txn: TransactionsSummaryData) {
  const domains: Record<string, ContextDomainSection> = {
    [FinanceDomains.TRANSACTIONS_SUMMARY]: { domain: FinanceDomains.TRANSACTIONS_SUMMARY, assembledAt: "x", data: txn },
  };
  return detectTransactionSignals(domains, "space-1").find((s) => s.type === SignalType.NEEDS_CLASSIFICATION);
}

// count 0 → no signal.
check("no signal when count === 0", run(mkTxn()) === undefined);
check("threshold sanity: shared constant is 0.15", MATERIAL_UNIDENTIFIED_INFLOW_SHARE === 0.15);

// count > 0, immaterial share (5%) → info.
{
  const sig = run(mkTxn({
    needsClassification: { count: 1, unknownInflowCount: 1, unknownInflowTotal: 50,
      unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0, counterpartyResolution: "PERSISTED_AND_READ_TIME" },
  }));
  check("fires when count > 0", !!sig);
  check("immaterial share → info severity", sig?.severity === "info", sig?.severity);
  check("title pins count", sig?.title === "1 transaction need classification", sig?.title);
}

// count > 0, material share (20%) → warning; pluralized title.
{
  const sig = run(mkTxn({
    needsClassification: { count: 3, unknownInflowCount: 2, unknownInflowTotal: 200,
      unknownPaymentAppCount: 1, unknownPaymentAppTotal: 40, counterpartyResolution: "PERSISTED_AND_READ_TIME" },
  }));
  check("material share → warning severity", sig?.severity === "warning", sig?.severity);
  check("title pluralizes", sig?.title === "3 transactions need classification", sig?.title);
  check("metadata.detail pins both clauses",
    sig?.metadata?.detail === "$200.00 of income has no identified source; $40.00 moved via payment apps, purpose unknown",
    String(sig?.metadata?.detail));
}

// count > 0 but zero income (only payment-app rows) → share null → info, no crash.
{
  const sig = run(mkTxn({
    incomeTotal: 0,
    needsClassification: { count: 2, unknownInflowCount: 0, unknownInflowTotal: 0,
      unknownPaymentAppCount: 2, unknownPaymentAppTotal: 120, counterpartyResolution: "PERSISTED_AND_READ_TIME" },
  }));
  check("zero income → still fires", !!sig);
  check("zero income → info (share null, never material)", sig?.severity === "info", sig?.severity);
  check("zero income → share metadata null (no NaN)", sig?.metadata?.unidentifiedInflowShare === null);
}

if (failures.length > 0) {
  console.error(`\nTI2-W2 signal detector: ${failures.length} FAILURE(S) (${passed} passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`TI2-W2 signal detector: all ${passed} checks passed.`);
process.exit(0);
