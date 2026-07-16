/**
 * lib/transactions/cash-flow-space-data.test.ts  (SD-4 contract priming — Cash Flow)
 *
 * Pure fixture test for the Cash Flow projection contract (house convention, no
 * prisma generate):  npx tsx lib/transactions/cash-flow-space-data.test.ts
 *
 * Pins the ownership boundary — "composes, computes none": every field the builder
 * returns is byte-equal to the canonical authority applied to the SAME windowed
 * rows (summary/daily/buckets/category/income), while the stamp + selector lists
 * are computed over the FULL history (coverage/selectability are properties of the
 * data, not the window). The builder adds NO arithmetic and re-classifies no row.
 */

import { buildCashFlowSpaceData } from "./cash-flow-space-data";
import {
  periodRange,
  filterByPeriod,
  availableHistoricalPeriods,
  dataBearingYears,
  outflowByCategory,
  incomeBySource,
} from "./cash-flow";
import { aggregateDayFacts, projectDailyFacts, bucketDayFacts, type DayFacts } from "./cash-flow-projection";
import { cashFlowStamp } from "./cash-flow-compare";
import { tierResolver, type LiquidityTx } from "./liquidity";
import type { Transaction } from "@/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function sameFacts(a: DayFacts, b: DayFacts): boolean {
  return a.cashIn === b.cashIn && a.cashOut === b.cashOut && a.income === b.income
    && a.spendGross === b.spendGross && a.unresolved === b.unresolved;
}

// Fixed clock so relative periods resolve deterministically.
const NOW = () => new Date("2026-06-15T12:00:00.000Z");

const ACCOUNTS = [
  { id: "chk", type: "checking" },
  { id: "card", type: "credit_card" },
];

// History spanning May + June 2026, plus one April row (out of an MTD window) and
// one 2025 row (proves multi-year selector derivation).
const TX: Transaction[] = [
  { id: "t1", accountId: "chk", date: "2026-06-02", merchant: "ACME Payroll", category: "Income",   amount: 3000, pending: false, flowType: "INCOME" },
  { id: "t2", accountId: "chk", date: "2026-06-05", merchant: "Groceries Co",  category: "Groceries", amount: -120, pending: false, flowType: "SPENDING" },
  { id: "t3", accountId: "card", date: "2026-06-09", merchant: "Shop",         category: "Shopping",  amount: -80,  pending: false, flowType: "SPENDING" },
  { id: "t4", accountId: "chk", date: "2026-05-20", merchant: "Dining Place",  category: "Dining",    amount: -40,  pending: false, flowType: "SPENDING" },
  { id: "t5", accountId: "chk", date: "2026-04-11", merchant: "Old Thing",     category: "Shopping",  amount: -25,  pending: false, flowType: "SPENDING" },
  { id: "t6", accountId: "chk", date: "2025-12-31", merchant: "NYE",           category: "Dining",    amount: -60,  pending: false, flowType: "SPENDING" },
];

console.log("CashFlowSpaceData — buildCashFlowSpaceData");

const data = buildCashFlowSpaceData({ transactions: TX, accounts: ACCOUNTS, period: "MTD", now: NOW });

// Reference: window + context computed the same way the builder must.
const nowDate = NOW();
const windowed = filterByPeriod(TX, "MTD", nowDate);
const liqCtx = tierResolver(ACCOUNTS);
const rows = windowed as LiquidityTx[];

// ── Window ──
check("period echoed", data.period === "MTD");
check("range === periodRange(period, now)", JSON.stringify(data.range) === JSON.stringify(periodRange("MTD", nowDate)));
check("rows === windowed slice (only June rows)", data.rows.map((t) => t.id).sort().join(",") === "t1,t2,t3", data.rows.map((t) => t.id).join(","));
check("rows exclude out-of-window (t4 May, t5 Apr, t6 2025)", data.rows.every((t) => !["t4", "t5", "t6"].includes(t.id)));

// ── Delegation: each projection === authority over the SAME windowed rows ──
check("summary === aggregateDayFacts(window)", sameFacts(data.summary, aggregateDayFacts(rows, liqCtx)));
check("summary carries the payroll inflow", data.summary.cashIn === 3000, String(data.summary.cashIn));

const refDaily = projectDailyFacts(rows, liqCtx);
check("daily size === projectDailyFacts(window)", data.daily.size === refDaily.size);
check("daily keys are the window's days", [...data.daily.keys()].sort().join(",") === "2026-06-02,2026-06-05,2026-06-09");

const refBuckets = bucketDayFacts(rows, liqCtx, "MTD");
check("buckets === bucketDayFacts(window)", JSON.stringify(data.buckets) === JSON.stringify(refBuckets));

check("outflowByCategory === authority(window)", JSON.stringify(data.outflowByCategory) === JSON.stringify(outflowByCategory(windowed)));
check("incomeBySource === authority(window)", JSON.stringify(data.incomeBySource) === JSON.stringify(incomeBySource(windowed)));
check("cashInByReason is an array", Array.isArray(data.cashInByReason));
check("debtPayments is an array", Array.isArray(data.debtPayments));
check("context has movedNotSpent/needsClassification sections", data.context != null && "movedNotSpent" in data.context && "needsClassification" in data.context);

// ── Trust + selectors: over the FULL history, not the window ──
check("stamp === cashFlowStamp(FULL history)", JSON.stringify(data.stamp) === JSON.stringify(cashFlowStamp({ transactions: TX, period: "MTD", now: NOW })));
check("stamp observed (period within coverage)", data.stamp.completeness.tier === "observed");
check("available === availableHistoricalPeriods(FULL)", JSON.stringify(data.available) === JSON.stringify(availableHistoricalPeriods(TX)));
check("dataYears === dataBearingYears(FULL) incl. 2025 & 2026", JSON.stringify(data.dataYears) === JSON.stringify(dataBearingYears(TX)) && data.dataYears.includes(2025) && data.dataYears.includes(2026));

// ── Pre-coverage window ⇒ stamp incomplete (coverage is a data property) ──
const pre = buildCashFlowSpaceData({ transactions: TX, accounts: ACCOUNTS, period: "PAST_YEAR", now: NOW });
check("PAST_YEAR reaches before earliest data ⇒ incomplete", pre.stamp.completeness.tier === "incomplete", pre.stamp.completeness.tier);

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll CashFlowSpaceData checks passed");
