/**
 * lib/transactions/cash-flow.test.ts
 *
 * UX-PER-3 Cash Flow — pure period/aggregation math. Runnable with tsx:
 *   npx tsx lib/transactions/cash-flow.test.ts
 * Auto-discovered by scripts/run-tests.ts. Pure module (no DB/React).
 */

import {
  periodRange,
  filterByPeriod,
  aggregateCashFlow,
  bucketCashFlow,
  granularityFor,
  outflowByCategory,
  CASH_FLOW_PERIODS,
  DEFAULT_CASH_FLOW_PERIOD,
} from "@/lib/transactions/cash-flow";
import type { Transaction, FlowType, TransactionCategory } from "@/types";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

function tx(date: string, amount: number, flowType: FlowType, category: TransactionCategory = "Other"): Transaction {
  return {
    id: `${date}-${amount}-${flowType}`, accountId: "a1", date, merchant: "m",
    category, amount, pending: false, flowType,
  };
}

// ── Period model ──────────────────────────────────────────────────────────────
check("8 periods with the required set",
  CASH_FLOW_PERIODS.map((p) => p.id).join(",") ===
    "WTD,MTD,QTD,YTD,PAST_WEEK,PAST_MONTH,PAST_QUARTER,PAST_YEAR");
check("default period is MTD", DEFAULT_CASH_FLOW_PERIOD === "MTD");

// Fixed reference date: 2026-07-09 (a Thursday).
const now = new Date(2026, 6, 9);
check("MTD starts on the 1st of the month",  periodRange("MTD", now).start === "2026-07-01");
check("MTD ends today",                      periodRange("MTD", now).end === "2026-07-09");
check("QTD starts at the quarter (Jul 1)",   periodRange("QTD", now).start === "2026-07-01");
check("YTD starts Jan 1",                    periodRange("YTD", now).start === "2026-01-01");
check("WTD starts Sunday (2026-07-05)",      periodRange("WTD", now).start === "2026-07-05");
check("PAST_WEEK starts 7 days back",        periodRange("PAST_WEEK", now).start === "2026-07-02");
check("PAST_MONTH starts one month back",    periodRange("PAST_MONTH", now).start === "2026-06-09");
check("PAST_YEAR starts one year back",      periodRange("PAST_YEAR", now).start === "2025-07-09");

check("filterByPeriod keeps in-range, drops out-of-range",
  filterByPeriod([tx("2026-07-05", 10, "INCOME"), tx("2026-06-30", 10, "INCOME")], "MTD", now).length === 1);

// ── FlowType-aware aggregation ──────────────────────────────────────────────────
const rows: Transaction[] = [
  tx("2026-07-02", 5000, "INCOME",   "Income"),
  tx("2026-07-03", -200, "SPENDING", "Groceries"),
  tx("2026-07-04", -50,  "FEE",      "Fee"),
  tx("2026-07-05", -30,  "INTEREST", "Interest"),
  tx("2026-07-06", 40,   "REFUND",   "Groceries"),   // reduces spend
  tx("2026-07-07", -1000,"TRANSFER", "Transfer"),    // excluded
  tx("2026-07-08", -500, "DEBT_PAYMENT", "Payment"), // excluded
];
const agg = aggregateCashFlow(rows);
check("income = INCOME only (5000)", agg.income === 5000);
check("spend = SPENDING+FEE+INTEREST − REFUND = 280−40 = 240", agg.spend === 240);
check("refunds disclosed separately (40)", agg.refunds === 40);
check("net = income − spend = 4760", agg.net === 4760);
check("transfers & debt payments excluded from cash flow",
  aggregateCashFlow([tx("2026-07-02", -1000, "TRANSFER"), tx("2026-07-02", -500, "DEBT_PAYMENT")]).net === 0);
check("refund clamps spend at ≥ 0",
  aggregateCashFlow([tx("2026-07-02", -50, "SPENDING"), tx("2026-07-02", 200, "REFUND")]).spend === 0);

// ── History bucketing ───────────────────────────────────────────────────────────
check("granularity: MTD → day",     granularityFor("MTD") === "day");
check("granularity: QTD → week",    granularityFor("QTD") === "week");
check("granularity: YTD → month",   granularityFor("YTD") === "month");

const buckets = bucketCashFlow(rows, "MTD");
check("daily buckets are chronological", buckets.map((b) => b.key).every((k, i, a) => i === 0 || a[i - 1] < k));
check("a bucket carries income/spend/net", buckets.some((b) => b.income === 5000));

const yearBuckets = bucketCashFlow(
  [tx("2026-01-15", 100, "INCOME"), tx("2026-03-20", 100, "INCOME")],
  "YTD",
);
check("YTD buckets are monthly (2 distinct months)", yearBuckets.length === 2 && yearBuckets[0].key === "2026-01");

// ── Outflow by category ─────────────────────────────────────────────────────────
const contrib = outflowByCategory(rows);
check("outflow grouped by category, descending",
  contrib.length > 0 && contrib.every((c, i) => i === 0 || contrib[i - 1].value >= c.value));
check("groceries outflow nets its refund (200−40 = 160)",
  contrib.find((c) => c.label === "Groceries")?.value === 160);
check("outflow excludes income/transfer categories",
  !contrib.some((c) => c.label === "Income" || c.label === "Transfer"));

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("Cash Flow lib tests FAILED."); process.exit(1); }
console.log("Cash Flow lib tests passed.");
process.exit(0);
