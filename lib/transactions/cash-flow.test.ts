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
  incomeBySource,
  incomeSourceLabel,
  transactionsInBucket,
  availableHistoricalPeriods,
  dataBearingYears,
  periodKey,
  periodLabel,
  isExplicitPeriod,
  periodScale,
  getCashFlowHistoryModes,
  getDefaultCashFlowHistoryMode,
  monthsInRange,
  dailyCashFlow,
  CASH_FLOW_PERIODS,
  TO_DATE_PERIODS,
  ROLLING_PERIODS,
  DEFAULT_CASH_FLOW_PERIOD,
} from "@/lib/transactions/cash-flow";
import type { Transaction, FlowType, TransactionCategory } from "@/types";
import { isCostFlow, isRefund, isIncome } from "@/lib/transactions/flow-predicates";

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
check("9 periods with the required set (incl. All Time)",
  CASH_FLOW_PERIODS.map((p) => p.id).join(",") ===
    "WTD,MTD,QTD,YTD,PAST_WEEK,PAST_MONTH,PAST_QUARTER,PAST_YEAR,ALL");
check("default period is MTD", DEFAULT_CASH_FLOW_PERIOD === "MTD");

// ── All Time (Phase 8) — now-independent (constant sentinel range) ───────────────
{
  const r = periodRange("ALL");
  check("ALL range bounds any real date on both sides",
    r.start === "0000-01-01" && r.end === "9999-12-31");
  const spanning: Transaction[] = [
    tx("2019-01-15", -50, "SPENDING"),
    tx("2026-07-08", -75, "SPENDING"),
    tx("2011-12-31", 100, "INCOME"),
  ];
  check("ALL keeps every live transaction (no historical cutoff)",
    filterByPeriod(spanning, "ALL").length === 3);
  check("ALL label is human-readable 'All Time'", periodLabel("ALL") === "All Time");
  // The calendar is now OFFERED under All Time but BOUNDED to one navigable
  // data-bearing year at a time (viewYear cursor); the default mode stays cards
  // so the mega-calendar is never rendered by default.
  check("ALL offers calendar + cards; default stays cards (bounded single-year calendar)",
    getCashFlowHistoryModes("ALL").join(",") === "calendar,cards" &&
    getDefaultCashFlowHistoryMode("ALL") === "cards");
  check("ALL buckets monthly", granularityFor("ALL") === "month");
}

// ── All Time calendar — data-bearing year navigation (bounded single year) ──────
{
  const multiYear: Transaction[] = [
    tx("2019-01-15", -50, "SPENDING"),
    tx("2026-07-08", -75, "SPENDING"),
    tx("2011-12-31", 100, "INCOME"),
    tx("2019-06-01", -20, "SPENDING"),   // same year → not duplicated
  ];
  const years = dataBearingYears(multiYear);
  check("dataBearingYears: distinct calendar years, newest first",
    years.join(",") === "2026,2019,2011", JSON.stringify(years));
  check("dataBearingYears: only years that hold data (no empty in-between years)",
    !years.includes(2020) && !years.includes(2015) && !years.includes(2012));
  check("dataBearingYears empty for no rows", dataBearingYears([]).length === 0);
  // A bounded single-year calendar view enumerates exactly that year's 12 months —
  // never the ALL sentinel's 0000–9999 span (which monthsInRange would cap at 24
  // garbage grids). This is what CashFlowCalendar's viewYear prop bounds to.
  const oneYear = monthsInRange("2019-01-01", "2019-12-31");
  check("single navigable year = exactly 12 month grids",
    oneYear.length === 12 && oneYear[0].month === 1 && oneYear[11].month === 12);
  // Year-stepping is bounded: the newest data year has no newer neighbor and the
  // oldest none older (the widget disables the ◀/▶ arrows at those ends).
  check("year-nav stays within the data-bearing range (newest…oldest)",
    years[0] === 2026 && years[years.length - 1] === 2011);
}

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

// ── Grouped period constants ────────────────────────────────────────────────────
check("to-date group is WTD..YTD",
  TO_DATE_PERIODS.map((p) => p.id).join(",") === "WTD,MTD,QTD,YTD");
check("rolling group is PAST_* + All Time",
  ROLLING_PERIODS.map((p) => p.id).join(",") === "PAST_WEEK,PAST_MONTH,PAST_QUARTER,PAST_YEAR,ALL");
check("CASH_FLOW_PERIODS = to-date ++ rolling",
  CASH_FLOW_PERIODS.length === TO_DATE_PERIODS.length + ROLLING_PERIODS.length);

// ── Explicit calendar periods ───────────────────────────────────────────────────
check("isExplicitPeriod: relative is false", !isExplicitPeriod("MTD"));
check("isExplicitPeriod: object is true", isExplicitPeriod({ kind: "year", year: 2025 }));

// explicit ranges are independent of `now`
const janRange = periodRange({ kind: "month", year: 2025, month: 1 }, now);
check("month Jan 2025 → 2025-01-01..2025-01-31",
  janRange.start === "2025-01-01" && janRange.end === "2025-01-31",
  JSON.stringify(janRange));
check("month Feb 2024 (leap) ends 2024-02-29",
  periodRange({ kind: "month", year: 2024, month: 2 }).end === "2024-02-29");
const q2Range = periodRange({ kind: "quarter", year: 2026, quarter: 2 });
check("quarter Q2 2026 → 2026-04-01..2026-06-30",
  q2Range.start === "2026-04-01" && q2Range.end === "2026-06-30", JSON.stringify(q2Range));
check("quarter Q4 2025 → 2025-10-01..2025-12-31",
  (() => { const r = periodRange({ kind: "quarter", year: 2025, quarter: 4 }); return r.start === "2025-10-01" && r.end === "2025-12-31"; })());
const yr2024 = periodRange({ kind: "year", year: 2024 });
check("year 2024 → 2024-01-01..2024-12-31",
  yr2024.start === "2024-01-01" && yr2024.end === "2024-12-31", JSON.stringify(yr2024));

check("filterByPeriod with explicit month keeps only that month",
  filterByPeriod(
    [tx("2025-01-15", 10, "INCOME"), tx("2025-02-01", 10, "INCOME"), tx("2024-12-31", 10, "INCOME")],
    { kind: "month", year: 2025, month: 1 },
  ).length === 1);

// explicit granularity: month→day, quarter→week, year→month
check("granularity: explicit month → day",   granularityFor({ kind: "month",   year: 2025, month: 1 })   === "day");
check("granularity: explicit quarter → week", granularityFor({ kind: "quarter", year: 2025, quarter: 1 }) === "week");
check("granularity: explicit year → month",  granularityFor({ kind: "year",    year: 2025 })              === "month");

// ── Labels & keys ────────────────────────────────────────────────────────────────
check("month label is human-readable",  periodLabel({ kind: "month", year: 2025, month: 1 }) === "January 2025");
check("quarter label is 'Q2 2026'",     periodLabel({ kind: "quarter", year: 2026, quarter: 2 }) === "Q2 2026");
check("year label is '2025'",           periodLabel({ kind: "year", year: 2025 }) === "2025");
check("relative label falls back to chip", periodLabel("MTD") === "MTD");
check("periodKey is stable & distinct",
  periodKey({ kind: "month", year: 2025, month: 1 }) === "month:2025-01" &&
  periodKey({ kind: "quarter", year: 2026, quarter: 2 }) === "quarter:2026-Q2" &&
  periodKey({ kind: "year", year: 2025 }) === "year:2025" &&
  periodKey("MTD") === "MTD");

// ── Historical option generation ─────────────────────────────────────────────────
const histTx = [
  tx("2025-01-10", 10, "INCOME"),
  tx("2025-06-20", 10, "INCOME"),
  tx("2025-06-25", 10, "SPENDING"),   // same month → not double-counted
  tx("2024-12-05", 10, "INCOME"),
  tx("2023-03-15", 10, "INCOME"),
];
const hist = availableHistoricalPeriods(histTx);
check("months: distinct, newest first",
  hist.months.map((p) => periodKey(p)).join(",") === "month:2025-06,month:2025-01,month:2024-12,month:2023-03",
  JSON.stringify(hist.months));
check("quarters: distinct, newest first",
  hist.quarters.map((p) => periodKey(p)).join(",") === "quarter:2025-Q2,quarter:2025-Q1,quarter:2024-Q4,quarter:2023-Q1",
  JSON.stringify(hist.quarters));
check("years: distinct, newest first",
  hist.years.map((p) => (isExplicitPeriod(p) && p.kind === "year" ? p.year : 0)).join(",") === "2025,2024,2023");
check("no 2022 data ⇒ no 2022 year option",
  !hist.years.some((p) => isExplicitPeriod(p) && p.kind === "year" && p.year === 2022));
check("empty transactions ⇒ empty historical groups",
  (() => { const h = availableHistoricalPeriods([]); return h.months.length === 0 && h.quarters.length === 0 && h.years.length === 0; })());

// selecting a generated historical option filters to exactly that period's rows
check("selecting the newest available month scopes to that month",
  (() => {
    const opt = hist.months[0];                 // month:2025-06
    const scoped = filterByPeriod(histTx, opt);
    return scoped.length === 2 &&               // both 2025-06 rows, nothing else
      scoped.every((t) => t.date.startsWith("2025-06"));
  })());
check("selecting an available year scopes to that year",
  (() => {
    const y2024 = hist.years.find((p) => isExplicitPeriod(p) && p.kind === "year" && p.year === 2024)!;
    return filterByPeriod(histTx, y2024).every((t) => t.date.startsWith("2024"));
  })());

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

// ── Period scale ─────────────────────────────────────────────────────────────────
check("scale: WTD/PAST_WEEK → week",
  periodScale("WTD") === "week" && periodScale("PAST_WEEK") === "week");
check("scale: MTD/PAST_MONTH/month → month",
  periodScale("MTD") === "month" && periodScale("PAST_MONTH") === "month" &&
  periodScale({ kind: "month", year: 2025, month: 1 }) === "month");
check("scale: QTD/PAST_QUARTER/quarter → quarter",
  periodScale("QTD") === "quarter" && periodScale("PAST_QUARTER") === "quarter" &&
  periodScale({ kind: "quarter", year: 2025, quarter: 2 }) === "quarter");
check("scale: YTD/PAST_YEAR/year → year",
  periodScale("YTD") === "year" && periodScale("PAST_YEAR") === "year" &&
  periodScale({ kind: "year", year: 2025 }) === "year");

// ── History modes & defaults (Bars → Cards) ──────────────────────────────────────
check("week scale: cards only",
  getCashFlowHistoryModes("WTD").join(",") === "cards" &&
  getCashFlowHistoryModes("PAST_WEEK").join(",") === "cards");
check("week scale: default cards",
  getDefaultCashFlowHistoryMode("WTD") === "cards" &&
  getDefaultCashFlowHistoryMode("PAST_WEEK") === "cards");
check("no mode is labeled 'bars' anymore",
  !getCashFlowHistoryModes("MTD").includes("bars" as never) &&
  !getCashFlowHistoryModes("WTD").includes("bars" as never));
check("month scale: calendar + cards, calendar default",
  getCashFlowHistoryModes("MTD").join(",") === "calendar,cards" &&
  getDefaultCashFlowHistoryMode("MTD") === "calendar" &&
  getDefaultCashFlowHistoryMode("PAST_MONTH") === "calendar" &&
  getDefaultCashFlowHistoryMode({ kind: "month", year: 2025, month: 1 }) === "calendar");
check("quarter scale: calendar default",
  getDefaultCashFlowHistoryMode("QTD") === "calendar" &&
  getDefaultCashFlowHistoryMode({ kind: "quarter", year: 2025, quarter: 2 }) === "calendar");
check("year scale: calendar default",
  getDefaultCashFlowHistoryMode("YTD") === "calendar" &&
  getDefaultCashFlowHistoryMode({ kind: "year", year: 2025 }) === "calendar");
check("every default mode is in its available modes",
  ([
    "WTD","MTD","QTD","YTD","PAST_WEEK","PAST_MONTH","PAST_QUARTER","PAST_YEAR",
  ] as const).every((p) => getCashFlowHistoryModes(p).includes(getDefaultCashFlowHistoryMode(p))));

// ── monthsInRange ────────────────────────────────────────────────────────────────
check("explicit month → 1 calendar month",
  monthsInRange(...Object.values(periodRange({ kind: "month", year: 2025, month: 1 })) as [string, string]).length === 1);
check("explicit quarter → 3 calendar months",
  (() => { const r = periodRange({ kind: "quarter", year: 2026, quarter: 2 });
           const ms = monthsInRange(r.start, r.end);
           return ms.length === 3 && ms[0].month === 4 && ms[2].month === 6; })());
check("explicit year → 12 calendar months",
  (() => { const r = periodRange({ kind: "year", year: 2025 });
           const ms = monthsInRange(r.start, r.end);
           return ms.length === 12 && ms[0].month === 1 && ms[11].month === 12; })());
check("monthsInRange spans a year boundary",
  monthsInRange("2025-11-15", "2026-02-03").map((m) => `${m.year}-${m.month}`).join(",")
    === "2025-11,2025-12,2026-1,2026-2");

// ── dailyCashFlow (calendar buckets) ─────────────────────────────────────────────
const dayRows: Transaction[] = [
  tx("2026-07-02", 5000, "INCOME",   "Income"),
  tx("2026-07-03", -200, "SPENDING", "Groceries"),
  tx("2026-07-03", 40,   "REFUND",   "Groceries"),   // same day → nets spend to 160
  tx("2026-07-04", -1000,"TRANSFER", "Transfer"),    // excluded
];
const daily = dailyCashFlow(dayRows);
check("daily net: income day", daily.get("2026-07-02")?.net === 5000);
check("daily net: refund nets same-day spend (−160)",
  daily.get("2026-07-03")?.spend === 160 && daily.get("2026-07-03")?.net === -160);
check("daily net: transfers excluded (no cash-flow day)", !daily.has("2026-07-04"));
check("daily refunds disclosed separately for tooltip (40)",
  daily.get("2026-07-03")?.refunds === 40);
check("daily spend clamps ≥ 0 per day",
  dailyCashFlow([tx("2026-07-05", -50, "SPENDING"), tx("2026-07-05", 200, "REFUND")]).get("2026-07-05")?.spend === 0);
check("dailyCashFlow matches aggregate net over the same rows",
  (() => { const total = [...dailyCashFlow(dayRows).values()].reduce((s, d) => s + d.net, 0);
           return total === aggregateCashFlow(dayRows).net; })());

// ── Income by Source (Part A) ────────────────────────────────────────────────────
function inc(amount: number, flow: FlowType, over: Partial<Transaction> = {}): Transaction {
  return { id: `${amount}-${flow}-${Math.random()}`, accountId: "a1", date: "2026-07-02",
    merchant: "", category: "Income", amount, pending: false, flowType: flow, ...over };
}

const srcRows: Transaction[] = [
  inc(5000, "INCOME", { merchantDisplayName: "Acme Payroll", merchant: "ACME CORP DIRECT DEP" }),
  inc(2000, "INCOME", { merchant: "Coinbase" }),
  inc(100,  "INCOME", { description: "Interest payment" }),
  inc(9999, "TRANSFER",   { merchantDisplayName: "Internal move" }),   // excluded
  inc(8888, "INVESTMENT", { merchantDisplayName: "BTC disposal" }),    // excluded (BTC sale)
  inc(50,   "REFUND",     { merchantDisplayName: "Store refund" }),    // excluded
];
const bySrc = incomeBySource(srcRows);
check("incomeBySource: INCOME-only, grouped, descending",
  bySrc.map((c) => `${c.label}:${c.value}`).join(",") === "Acme Payroll:5000,Coinbase:2000,Interest payment:100",
  JSON.stringify(bySrc));
check("incomeBySource excludes TRANSFER", !bySrc.some((c) => c.label === "Internal move"));
check("incomeBySource excludes INVESTMENT (BTC sale)", !bySrc.some((c) => c.label === "BTC disposal"));
check("incomeBySource excludes REFUND", !bySrc.some((c) => c.label === "Store refund"));
check("incomeBySource sums same-source rows",
  incomeBySource([inc(300, "INCOME", { merchant: "Client A" }), inc(200, "INCOME", { merchant: "Client A" })])[0].value === 500);
check("incomeBySource empty when no inflows",
  incomeBySource([inc(-10, "SPENDING"), inc(8888, "INVESTMENT")]).length === 0);

// source label priority: counterparty/displayName → merchant → description → category → Unknown
check("source label: merchantDisplayName wins",
  incomeSourceLabel(inc(1, "INCOME", { merchantDisplayName: "Acme", merchant: "RAW" })) === "Acme");
check("source label: falls back to raw merchant",
  incomeSourceLabel(inc(1, "INCOME", { merchant: "Coinbase" })) === "Coinbase");
check("source label: falls back to description",
  incomeSourceLabel(inc(1, "INCOME", { description: "Dividend" })) === "Dividend");
check("source label: falls back to category",
  incomeSourceLabel(inc(1, "INCOME", { category: "Income" })) === "Income");
check("source label: Unknown source when nothing usable",
  incomeSourceLabel(inc(1, "INCOME", { merchant: "", category: "" as TransactionCategory })) === "Unknown source");

// ── BTC INVESTMENT disposal excluded from Cash Flow (Part B doctrine) ─────────────
check("INVESTMENT (BTC sale) is neither spend nor income nor refund in aggregate",
  (() => { const a = aggregateCashFlow([tx("2026-07-02", -8888, "INVESTMENT", "Sell")]);
           return a.spend === 0 && a.income === 0 && a.refunds === 0 && a.net === 0; })());
check("INVESTMENT (BTC sale) never appears in Spending by Category",
  outflowByCategory([tx("2026-07-02", -8888, "INVESTMENT", "Sell")]).length === 0);

// ── Drill-down slices (Part A) ────────────────────────────────────────────────────
// Calendar day slice = exact-date rows; its aggregate must match the cell.
const drillRows: Transaction[] = [
  tx("2026-07-02", 5000, "INCOME",   "Income"),
  tx("2026-07-02", -200, "SPENDING", "Groceries"),
  tx("2026-07-03", -80,  "SPENDING", "Dining"),
  tx("2026-07-03", -1000,"TRANSFER", "Transfer"),   // excluded from cash flow
];
const day02 = drillRows.filter((t) => t.date === "2026-07-02");
check("calendar day slice = that date's rows", day02.length === 2);
check("day slice aggregate matches the day net (5000−200=4800)",
  aggregateCashFlow(day02).net === 4800);

// History bucket slice (MTD → daily granularity): key is the date itself.
check("transactionsInBucket returns that day's rows for a daily period",
  transactionsInBucket(drillRows, "MTD", "2026-07-03").length === 2 &&
  transactionsInBucket(drillRows, "MTD", "2026-07-03").every((t) => t.date === "2026-07-03"));
// Year period → monthly buckets: key is YYYY-MM.
check("transactionsInBucket groups by month for a yearly period",
  transactionsInBucket(
    [tx("2026-01-10", 10, "INCOME"), tx("2026-01-20", 20, "INCOME"), tx("2026-03-01", 30, "INCOME")],
    { kind: "year", year: 2026 }, "2026-01").length === 2);

// Spending-by-category slice = cost + refund rows for that category (matches card).
const catRows: Transaction[] = [
  tx("2026-07-02", -200, "SPENDING", "Groceries"),
  tx("2026-07-04", 40,   "REFUND",   "Groceries"),
  tx("2026-07-03", -80,  "SPENDING", "Dining"),
  tx("2026-07-02", 5000, "INCOME",   "Income"),
];
const grocerySlice = catRows.filter((t) => t.category === "Groceries" && (isCostFlow(t.flowType) || isRefund(t.flowType)));
check("category slice = cost + refund rows of that category",
  grocerySlice.length === 2);
check("category slice aggregate spend matches card (200−40=160)",
  aggregateCashFlow(grocerySlice).spend === 160);

// Income-by-source slice = INCOME rows whose source label matches.
const acmeSlice = srcRows.filter((t) => isIncome(t.flowType) && incomeSourceLabel(t) === "Acme Payroll");
check("income source slice = INCOME rows for that source",
  acmeSlice.length === 1 && aggregateCashFlow(acmeSlice).income === 5000);

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("Cash Flow lib tests FAILED."); process.exit(1); }
console.log("Cash Flow lib tests passed.");
process.exit(0);
