/**
 * lib/transactions/canonical-spending.test.ts
 *
 * THE CANONICAL SPENDING BASELINE — which months, and what each counts as.
 * Owner decisions (2026-10-04), each pinned below with hand arithmetic:
 *
 *   asOf 2026-10-04 → Jul/Aug/Sep · 09-30 → Jun/Jul/Aug · 10-01 → Jul/Aug/Sep
 *   the current month is never complete, including on its last day
 *   net of refunds by the one clamp · a complete month with nothing is $0
 *   fewer months of history ⇒ average what exists, disclosed · none ⇒ refuse
 *
 * Pure: no DB. Rows go through the REAL monthly fold (`buildMonthlyBreakdown`).
 *
 * Run:  npx tsx lib/transactions/canonical-spending.test.ts
 */
import {
  CANONICAL_SPENDING_MONTHS, canonicalSpendingWindow, selectCanonicalSpendingMonths,
  canonicalSpendingBaseline, readCanonicalSpending, coverageOfRead, monthRangeLabel,
} from "@/lib/transactions/canonical-spending";
import { WINDOW_MONTHS } from "@/lib/forecast/observed-spending";
import { buildMonthlyBreakdown } from "@/lib/ai/assemblers/transactions";
import type { MonthlyBreakdownEntry, TransactionsSummaryData } from "@/lib/ai/types";

let failures = 0, passed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a: number | null | undefined, b: number) => typeof a === "number" && Math.abs(a - b) < 0.005;

type Row = { id: string; date: Date; amount: number; currency: string; category: string; flowType: string };
let seq = 0;
const spend = (day: string, amount: number, category = "Shopping"): Row =>
  ({ id: `s${seq++}`, date: new Date(`${day}T12:00:00Z`), amount: -amount, currency: "USD", category, flowType: "SPENDING" });
const refund = (day: string, amount: number, category = "Shopping"): Row =>
  ({ id: `r${seq++}`, date: new Date(`${day}T12:00:00Z`), amount, currency: "USD", category, flowType: "REFUND" });
const income = (day: string, amount: number): Row =>
  ({ id: `i${seq++}`, date: new Date(`${day}T12:00:00Z`), amount, currency: "USD", category: "Income", flowType: "INCOME" });

/** A read over [from, to] exactly as the assembler folds it. */
function summaryOver(rows: Row[], from: string, to: string, inProgress = false): TransactionsSummaryData {
  const inWindow = rows.filter((r) => {
    const d = r.date.toISOString().slice(0, 10);
    return d >= from && d <= to;
  });
  return {
    startDate: from, endDate: to, windowDays: 0, transactionCount: inWindow.length, truncated: false,
    coverageStartDate: from,
    monthlyBreakdown: buildMonthlyBreakdown(inWindow as never, [], from, to, null, undefined, undefined, inProgress),
  } as unknown as TransactionsSummaryData;
}

async function baselineFor(rows: Row[], asOf: string, history?: { from: string | null; to: string | null }) {
  const days = rows.map((r) => r.date.toISOString().slice(0, 10)).sort();
  return readCanonicalSpending({
    asOf,
    readWindow: async (w) => summaryOver(rows, w.startDate, w.endDate),
    readHistory: async () => history ?? { from: days[0] ?? null, to: days[days.length - 1] ?? null },
  });
}

async function main() {
  console.log("THE WINDOW — trailing 3 complete months strictly before the as-of month");
  {
    check("ONE length: CANONICAL_SPENDING_MONTHS = 3, and the projection's WINDOW_MONTHS is it",
      CANONICAL_SPENDING_MONTHS === 3 && WINDOW_MONTHS === CANONICAL_SPENDING_MONTHS);
    const oct4 = canonicalSpendingWindow("2026-10-04");
    check("[test 1] asOf 2026-10-04 → Jul, Aug, Sep (2026-07-01..2026-09-30)",
      oct4.months.join() === "2026-07,2026-08,2026-09" && oct4.from === "2026-07-01" && oct4.to === "2026-09-30",
      JSON.stringify(oct4));
    const sep30 = canonicalSpendingWindow("2026-09-30");
    check("[test 11] asOf 2026-09-30 → Jun, Jul, Aug — September is NOT complete on its last day",
      sep30.months.join() === "2026-06,2026-07,2026-08" && sep30.to === "2026-08-31", JSON.stringify(sep30));
    const oct1 = canonicalSpendingWindow("2026-10-01");
    check("[test 11] asOf 2026-10-01 → Jul, Aug, Sep — the first day of a month closes the previous one",
      oct1.months.join() === "2026-07,2026-08,2026-09");
    const jan = canonicalSpendingWindow("2026-01-15");
    check("year boundary: asOf 2026-01-15 → Oct, Nov, Dec 2025", jan.months.join() === "2025-10,2025-11,2025-12");
    const leap = canonicalSpendingWindow("2024-03-01");
    check("leap boundary: asOf 2024-03-01 → Dec 2023, Jan 2024, Feb 2024 (to 2024-02-29)",
      leap.months.join() === "2023-12,2024-01,2024-02" && leap.to === "2024-02-29", JSON.stringify(leap));
    check("labels: 'Jul–Sep 2026', 'Dec 2023–Feb 2024'",
      monthRangeLabel(oct4.months) === "Jul–Sep 2026" && monthRangeLabel(leap.months) === "Dec 2023–Feb 2024");
  }

  console.log("THE MONTHS — net of refunds, partial October excluded, zero months are $0");
  {
    const rows = [
      spend("2026-06-10", 9_000),                        // June: outside the window
      spend("2026-07-05", 3_000), refund("2026-07-20", 500),   // July net 2,500
      spend("2026-08-05", 6_000),                         // August 6,000
      spend("2026-09-05", 7_500),                         // September 7,500
      spend("2026-10-02", 40_000),                        // October: in progress
      income("2026-07-15", 5_000), income("2026-08-15", 5_000), income("2026-09-15", 5_000),
    ];
    const r = await baselineFor(rows, "2026-10-04");
    // (2,500 + 6,000 + 7,500) / 3 = 5,333.33
    check("[test 1] Oct 4 averages Jul+Aug+Sep: (2,500 + 6,000 + 7,500) / 3 = 5,333.33",
      eq(r.baseline.monthly, 5_333.33) && r.baseline.months.join() === "2026-07,2026-08,2026-09"
        && r.baseline.monthCount === 3, JSON.stringify(r.baseline));
    check("[test 2] partial October contributes NOTHING (40,000 spent Oct 2 is not in the mean)",
      !r.baseline.months.includes("2026-10") && eq(r.baseline.monthly, 5_333.33));
    check("[test 3] the July refund lowers July: gross 3,000 − refund 500 = 2,500 (basis NET_OF_REFUNDS)",
      eq(r.baseline.economics?.months[0].net, 2_500) && eq(r.baseline.economics?.months[0].gross, 3_000)
        && r.baseline.basis === "NET_OF_REFUNDS");
    check("the label names the months and the count", r.baseline.label === "Jul–Sep 2026 (3 complete months)", r.baseline.label);

    // The defect this replaces: the 90-day rolling read ending 10-04 starts 07-06, so
    // July is CLIPPED and only Aug+Sep were averaged — (6,000 + 7,500) / 2 = 6,750.
    const rolling = summaryOver(rows, "2026-07-06", "2026-10-04", true);
    const reliable = rolling.monthlyBreakdown.filter((m) => !m.partial && !m.truncated).map((m) => m.month);
    check("REGRESSION WITNESS: the old 90-day read holds only Aug+Sep complete — the window, not the authority, chose",
      reliable.join() === "2026-08,2026-09", reliable.join());
  }

  console.log("OWNER DECISION — a complete month with nothing spent is $0 in the average");
  {
    const rows = [
      spend("2026-06-10", 1_000),                         // history began in June
      income("2026-07-15", 5_000),                        // July: income, no spending
      spend("2026-08-05", 6_000), spend("2026-09-05", 6_000),
    ];
    const r = await baselineFor(rows, "2026-10-04");
    check("[test 14] Jul $0 · Aug $6,000 · Sep $6,000 ⇒ 4,000 (never 6,000 over two months)",
      eq(r.baseline.monthly, 4_000) && r.baseline.monthCount === 3, JSON.stringify(r.baseline));
    const empty = await baselineFor([spend("2026-06-10", 1_000), spend("2026-08-05", 6_000), spend("2026-09-05", 6_000)], "2026-10-04");
    check("a month with NO ROWS AT ALL inside history is a zero month, flagged as such",
      eq(empty.baseline.monthly, 4_000) && empty.baseline.zeroMonths.join() === "2026-07", JSON.stringify(empty.baseline));
  }

  console.log("[test 12] FEWER THAN THREE COMPLETE MONTHS — average what exists, disclose the count; none ⇒ refuse");
  {
    const rows = [spend("2026-08-12", 6_000), spend("2026-09-05", 3_000)];
    const r = await baselineFor(rows, "2026-10-04");
    check("history from 2026-08-12: July is BEFORE_HISTORY ⇒ (6,000 + 3,000) / 2 = 4,500 over 2 months",
      eq(r.baseline.monthly, 4_500) && r.baseline.monthCount === 2
        && r.baseline.excluded.some((x) => x.month === "2026-07" && x.reason === "BEFORE_HISTORY")
        && r.baseline.label === "Aug–Sep 2026 (2 complete months)", JSON.stringify(r.baseline));
    const none = await baselineFor([], "2026-10-04", { from: null, to: null });
    check("no history at all ⇒ null (a refusal, never $0)", none.baseline.monthly === null && none.baseline.monthCount === 0);
    const stopped = await baselineFor([spend("2026-06-03", 1_000), spend("2026-07-04", 2_000)], "2026-10-04");
    check("a month after the LAST transaction is AFTER_HISTORY, not $0 (a source that stopped is not zero spending)",
      stopped.baseline.months.join() === "2026-07" && stopped.baseline.excluded.filter((x) => x.reason === "AFTER_HISTORY").length === 2,
      JSON.stringify(stopped.baseline.excluded));
  }

  console.log("[test 13] A REFUND-HEAVY MONTH floors at zero — never negative consumption");
  {
    const rows = [spend("2026-07-03", 500), refund("2026-07-20", 2_000), spend("2026-08-05", 3_000), spend("2026-09-05", 3_000)];
    const r = await baselineFor(rows, "2026-10-04");
    check("Jul max(0, 500 − 2,000) = 0 ⇒ (0 + 3,000 + 3,000) / 3 = 2,000; the excess is disclosed, not carried",
      eq(r.baseline.monthly, 2_000) && eq(r.baseline.economics?.months[0].net, 0)
        && (r.baseline.economics?.refundsUnapplied ?? 0) > 0, JSON.stringify(r.baseline.economics));
  }

  console.log("[test 15] TIMEZONE — the fold buckets by the UTC economic date; pinned so a TZ change is deliberate");
  {
    // 2026-09-30 23:30 in UTC−5 is 2026-10-01 04:30 UTC: October, not September.
    const late: Row = { id: "tz", date: new Date("2026-10-01T04:30:00Z"), amount: -900, currency: "USD", category: "Shopping", flowType: "SPENDING" };
    const rows = [spend("2026-07-05", 1_000), spend("2026-08-05", 1_000), spend("2026-09-05", 1_000), late];
    const r = await baselineFor(rows, "2026-10-04");
    check("a 23:30 local (UTC−5) Sep 30 purchase is October in UTC and stays out of Jul–Sep",
      eq(r.baseline.monthly, 1_000), JSON.stringify(r.baseline.economics?.months));
  }

  console.log("COVERAGE — a truncated read zero-fills nothing older than its oldest kept row");
  {
    const window = canonicalSpendingWindow("2026-10-04");
    const cov = coverageOfRead({ startDate: "2026-07-01", truncated: true, coverageStartDate: "2026-08-20" } as never, window,
      { from: "2025-01-01", to: "2026-10-03" });
    const sel = selectCanonicalSpendingMonths([] as MonthlyBreakdownEntry[], window, cov);
    check("July (no bucket, before the cap floor) is PARTIAL, not $0; August's floor month too",
      sel.months.length === 1 && sel.months[0].month === "2026-09"
        && sel.excluded.map((x) => `${x.month}:${x.reason}`).join() === "2026-07:PARTIAL,2026-08:PARTIAL", JSON.stringify(sel));
    const b = canonicalSpendingBaseline(sel);
    check("…and the baseline says how many months it used", b.monthCount === 1 && b.label === "Sep 2026 (1 complete month)");
  }

  console.log("B2 — THE ROLLING READ: a month is complete when it has ENDED, not when today is its last day");
  {
    const rows = [spend("2026-09-05", 1_000), spend("2026-08-05", 1_000)];
    const closed = buildMonthlyBreakdown(rows as never, [], "2026-08-01", "2026-09-30", null);
    const live = buildMonthlyBreakdown(rows as never, [], "2026-08-01", "2026-09-30", null, undefined, undefined, true);
    check("a CLOSED window ending 09-30 marks September complete (history, unchanged)",
      closed.find((m) => m.month === "2026-09")?.partial !== true);
    check("a read ending TODAY on 09-30 marks September PARTIAL (it has not ended)",
      live.find((m) => m.month === "2026-09")?.partial === true && live.find((m) => m.month === "2026-08")?.partial !== true);
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
