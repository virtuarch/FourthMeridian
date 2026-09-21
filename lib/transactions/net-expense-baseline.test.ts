/**
 * lib/transactions/net-expense-baseline.test.ts   (NET-BASELINE-1)
 *
 * "HOW MUCH DO I ACTUALLY SPEND A MONTH?" IS NET ECONOMIC SPENDING — end to end
 * through the PURE chain, with no DB:
 *
 *   rows → foldEconomicRow (the one fold) → monthly {gross, refunds}
 *        → meanMonthlyEconomicSpend (the one monthly-mean definition)
 *        → computeAverageMonthlySpending        (assessment · Liquidity · Brief · the route)
 *        → measure('spending').netOfRefunds → economicSpendingOf → the M1 expense baseline
 *        → derive(): surplus · savings rate · runway · N-months-of-expenses thresholds
 *        → deriveObservedSpendingRate → the scenario floor (resolveMonthsOfExpensesFloor)
 *
 * REFUND-1 (382897e) made the fold right and left the measured baseline GROSS, so
 * the Spending-by-category view netted refunds while every reasoning surface still
 * divided by what was CHARGED. This slice moves the baseline — and adds NO refund
 * arithmetic of its own: every test below feeds rows to the canonical fold.
 *
 * Every expected figure is HAND ARITHMETIC written beside the case. Invariants are
 * relational; no live personal dollar value is pinned.
 *
 * Run:  npx tsx lib/transactions/net-expense-baseline.test.ts
 */
import { readFileSync } from "node:fs";
import {
  foldEconomicRow, clampEconomicSpend, meanMonthlyEconomicSpend, MATERIAL_MONTHLY_REFUND_EFFECT,
} from "@/lib/transactions/cash-flow";
import { isDebtPayment, isTransfer } from "@/lib/transactions/flow-predicates";
import { computeAverageMonthlySpending, computeMonthlySpendingBasis, metricValue } from "@/lib/ai/intelligence/annotations/metrics";
import { measure, type MonthRow, type DataCoverage } from "@/lib/ai/measures/measure";
import { resolvePeriod } from "@/lib/ai/measures/period";
import {
  resolveExpenseBaselineFromEvidence, resolveIncomeBaseline, derive, economicSpendingOf, resolveMonthsOfExpensesFloor,
} from "@/lib/ai/measures/baseline";
import { deriveObservedSpendingRate } from "@/lib/forecast/observed-spending";
import { resolveExpenseBaseline } from "@/lib/liquidity/expense-baseline";
import type { TransactionsSummaryData } from "@/lib/ai/types";

let failures = 0, passed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
}
const cents = (n: number) => Math.round(n * 100);
const eq = (a: number | null | undefined, b: number) => a != null && cents(a) === cents(b);

// ── Rows → months, through THE fold (never a second inclusion rule) ───────────
type Flow = "SPENDING" | "FEE" | "INTEREST" | "REFUND" | "INCOME" | "DEBT_PAYMENT" | "TRANSFER" | "UNKNOWN" | "INVESTMENT";
interface Tx { date: string; flow: Flow; amount: number; category?: string; incomeClass?: string }
function months(rows: Tx[], partialMonths: string[] = []): MonthRow[] {
  const by = new Map<string, MonthRow>();
  for (const t of rows) {
    const month = t.date.slice(0, 7);
    let m = by.get(month);
    if (!m) { m = { month, incomeTotal: 0, expenseTotal: 0, refundTotal: 0, debtPaymentTotal: 0, transferTotal: 0, byCategory: [] }; by.set(month, m); }
    const acc = { income: 0, spendGross: 0, refunds: 0 };
    foldEconomicRow(acc, { flowType: t.flow, amount: t.amount, incomeClass: t.incomeClass ?? null });
    m.incomeTotal += acc.income; m.expenseTotal += acc.spendGross; m.refundTotal += acc.refunds;
    if (isDebtPayment(t.flow as never)) m.debtPaymentTotal += Math.abs(t.amount);
    if (isTransfer(t.flow as never)) m.transferTotal += Math.abs(t.amount);
    if (t.category && (acc.spendGross > 0 || acc.refunds > 0)) {
      let c = m.byCategory.find((x) => x.category === t.category);
      if (!c) { c = { category: t.category, total: 0 }; m.byCategory.push(c); }
      c.total += acc.spendGross; if (acc.refunds > 0) c.refundTotal = (c.refundTotal ?? 0) + acc.refunds;
    }
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => (partialMonths.includes(m.month) ? { ...m, partial: true } : m));
}
const asTxn = (rows: MonthRow[]) => ({ monthlyBreakdown: rows }) as unknown as TransactionsSummaryData;
const COV: DataCoverage = { corpusFrom: "2024-01-01", corpusTo: "2026-09-30", fetchCapHit: false };
const CEIL = "2026-10-20";
const spent = (date: string, amount: number, category = "Travel"): Tx => ({ date, flow: "SPENDING", amount: -amount, category });
const refund = (date: string, amount: number, category = "Travel"): Tx => ({ date, flow: "REFUND", amount, category });
const measured = (rows: MonthRow[], from: string, to: string) => measure("spending", rows, resolvePeriod({ from, to }, CEIL), COV);
const baselineOf = (rows: MonthRow[], from: string, to: string, extra: { stated?: number; declared?: number } = {}) =>
  resolveExpenseBaselineFromEvidence({ ...extra, measured: measured(rows, from, to) });

console.log("1. no refunds — net IS gross, and nothing extra is said");
{
  const rows = months([spent("2026-08-05", 3000), spent("2026-09-05", 5000)]);
  const b = computeMonthlySpendingBasis(asTxn(rows))!;
  check("net 4,000 = gross 4,000; refund effect 0; not material", eq(b.net, 4000) && eq(b.gross, 4000) && eq(b.refundEffect, 0) && !b.material);
  const base = baselineOf(rows, "2026-08-01", "2026-09-30")!;
  check("M1 baseline 4,000 MEASURED, with NO gross/refundEffect clutter", eq(base.amount, 4000) && base.basis === "MEASURED" && base.gross === undefined && base.refundEffect === undefined);
}

console.log("2. partial refund, same month");
{
  // Aug 3,000. Sep 5,000 charged − 2,000 refunded = 3,000. Mean net (3,000+3,000)/2 = 3,000; gross (3,000+5,000)/2 = 4,000.
  const rows = months([spent("2026-08-05", 3000), spent("2026-09-05", 5000), refund("2026-09-20", 2000)]);
  check("assessment figure is NET 3,000 (was gross 4,000)", eq(computeAverageMonthlySpending(asTxn(rows)), 3000));
  const b = computeMonthlySpendingBasis(asTxn(rows))!;
  check("gross 4,000 · refund effect 1,000 · material · gross − effect = net", eq(b.gross, 4000) && eq(b.refundEffect, 1000) && b.material && eq(b.gross - b.refundEffect, b.net));
  const base = baselineOf(rows, "2026-08-01", "2026-09-30")!;
  check("M1 baseline 3,000, carrying gross 4,000 and refundEffect 1,000 so the model never subtracts", eq(base.amount, 3000) && eq(base.gross, 4000) && eq(base.refundEffect, 1000));
  check("the baseline's months are the NET months (3,000 / 3,000)", base.months!.map((m) => m.value).join() === "3000,3000");
  check("the two paths agree: assessment mean === M1 baseline", eq(computeAverageMonthlySpending(asTxn(rows)), base.amount));
}

console.log("3. full refund, same month");
{
  // Sep: 1,500 charged, 1,500 refunded ⇒ 0. Aug 2,000. Mean (2,000 + 0)/2 = 1,000.
  const rows = months([spent("2026-08-05", 2000, "Groceries"), spent("2026-09-05", 1500), refund("2026-09-25", 1500)]);
  check("a fully refunded month contributes 0; mean 1,000", eq(computeAverageMonthlySpending(asTxn(rows)), 1000));
}

console.log("4. purchase month N, refund month N+1 — the refund counts where it is DATED");
{
  // Aug 1,000 purchase. Sep 600 other spend + 400 refund of the AUGUST purchase.
  // August stays 1,000 (never rewritten). September = 600 − 400 = 200. Mean = 600.
  const rows = months([spent("2026-08-10", 1000), spent("2026-09-08", 600, "Dining"), refund("2026-09-15", 400)]);
  const b = computeMonthlySpendingBasis(asTxn(rows))!;
  check("August is NOT rewritten: still 1,000", eq(b.months.find((m) => m.month === "2026-08")!.net, 1000));
  check("September carries the refund: 600 − 400 = 200", eq(b.months.find((m) => m.month === "2026-09")!.net, 200));
  check("two-month mean = (1,000 + 200)/2 = 600; total conserved (1,600 − 400 = 1,200)", eq(b.net, 600) && eq(b.months.reduce((s, m) => s + m.net, 0), 1200));
  check("an August-only baseline is still 1,000 — a later refund does not reach back", eq(baselineOf(rows, "2026-08-01", "2026-08-31")!.amount, 1000));
}

console.log("5 + 6. a refund month with no matching purchase — excess refund floors at 0, and is REPORTED");
{
  // Aug 2,000. Sep: 100 spend, 900 refund ⇒ max(0, 100 − 900) = 0, with 800 unapplied.
  const rows = months([spent("2026-08-10", 2000), spent("2026-09-08", 100, "Dining"), refund("2026-09-15", 900)]);
  const b = computeMonthlySpendingBasis(asTxn(rows))!;
  check("the month floors at 0 — never negative consumption", eq(b.months[1].net, 0) && b.months.every((m) => m.net >= 0));
  check("mean = (2,000 + 0)/2 = 1,000 — NOT (2,000 − 800)/2 = 600", eq(b.net, 1000));
  check("the excess is reported, not discarded: refundsUnapplied = 800/2 = 400 per month", eq(b.refundsUnapplied, 400));
  check("gross − net = refundEffect counts only the refund that WAS applied: (2,100 − 2,000)/2 = 50", eq(b.gross, 1050) && eq(b.refundEffect, 50));
  check("the M1 path floors identically (same clamp)", eq(baselineOf(rows, "2026-08-01", "2026-09-30")!.amount, 1000));
  const only = months([refund("2026-09-15", 900)]);
  check("a month holding ONLY a refund is 0, and the baseline REFUSES rather than dividing by it",
    eq(computeMonthlySpendingBasis(asTxn(only))!.net, 0) && resolveExpenseBaseline({ measured: computeAverageMonthlySpending(asTxn(only)) }) === null);
}

console.log("7. multiple categories — the monthly figure is the whole month's economic spend");
{
  // Sep: Travel 1,500 − 500, Dining 400 − 0, Groceries 600 ⇒ 2,500 gross − 500 = 2,000.
  const rows = months([spent("2026-09-02", 1500), refund("2026-09-09", 500), spent("2026-09-11", 400, "Dining"), spent("2026-09-12", 600, "Groceries")]);
  check("2,500 charged − 500 refunded = 2,000", eq(computeAverageMonthlySpending(asTxn(rows)), 2000));
}

console.log("8–11. sign-test DEFEATERS — none of these may reduce expenses");
{
  const base = [spent("2026-09-02", 2000)];
  const with_ = (extra: Tx) => computeAverageMonthlySpending(asTxn(months([...base, extra])));
  check("8. a card PAYMENT (+1,200 on the card) does not reduce expenses", eq(with_({ date: "2026-09-10", flow: "DEBT_PAYMENT", amount: 1200 }), 2000));
  check("9. a TRANSFER in (+3,000) does not reduce expenses", eq(with_({ date: "2026-09-10", flow: "TRANSFER", amount: 3000 }), 2000));
  check("10. a reward / statement credit (UNKNOWN, +50) does not reduce expenses", eq(with_({ date: "2026-09-10", flow: "UNKNOWN", amount: 50 }), 2000));
  check("11. a REIMBURSEMENT deposited as income (+800) stays distinct — expenses unchanged", eq(with_({ date: "2026-09-10", flow: "INCOME", amount: 800, incomeClass: "OTHER_INCOME" }), 2000));
  check("…and only a canonical REFUND row does", eq(with_(refund("2026-09-10", 500)), 1500));
}

// A 14-month record: 2025-08 … 2026-09, 3,000/month, with refunds in three months.
const LONG: Tx[] = [];
for (let i = 0; i < 14; i++) {
  const y = 2025 + Math.floor((7 + i) / 12), m = ((7 + i) % 12) + 1;
  LONG.push(spent(`${y}-${String(m).padStart(2, "0")}-05`, 3000, "Groceries"));
}
LONG.push(refund("2026-09-20", 600), refund("2026-08-20", 300), refund("2026-04-20", 1200));
LONG.push(spent("2026-10-03", 9999, "Groceries")); // the current, incomplete month

console.log("12 + 13. complete-month mean; the incomplete current month is excluded");
{
  const rows = months(LONG, ["2026-10"]);
  check("the partial October (9,999) is not in the mean", computeMonthlySpendingBasis(asTxn(rows))!.months.every((m) => m.month !== "2026-10"));
  const oct = measured(rows, "2026-09-01", "2026-10-20");
  check("M1: a window holding a partial month averages only the WHOLE one: Sep = 3,000 − 600 = 2,400",
    eq(economicSpendingOf(oct).perCompleteMonth, 2400) && oct.completeMonths === 1);
}

console.log("14–17. 2 / 3 / 6 / 12-month baselines — same definition at every window");
{
  const rows = months(LONG, ["2026-10"]);
  const w = (from: string) => baselineOf(rows, from, "2026-09-30")!;
  // 2 mo (Aug, Sep): (2,700 + 2,400)/2 = 2,550.   gross 3,000, effect 450
  check("2-month: 2,550 net · 3,000 gross · 450 effect", eq(w("2026-08-01").amount, 2550) && eq(w("2026-08-01").gross, 3000) && eq(w("2026-08-01").refundEffect, 450));
  // 3 mo (Jul–Sep): (3,000 + 2,700 + 2,400)/3 = 2,700
  check("3-month: 2,700 net", eq(w("2026-07-01").amount, 2700) && w("2026-07-01").completeMonths === 3);
  // 6 mo (Apr–Sep): 18,000 − (1,200 + 300 + 600) = 15,900 / 6 = 2,650
  check("6-month: 2,650 net · effect 350", eq(w("2026-04-01").amount, 2650) && eq(w("2026-04-01").refundEffect, 350));
  // 12 mo (Oct 2025–Sep 2026): 36,000 − 2,100 = 33,900 / 12 = 2,825
  check("12-month: 2,825 net · effect 175", eq(w("2025-10-01").amount, 2825) && eq(w("2025-10-01").refundEffect, 175) && w("2025-10-01").completeMonths === 12);
  check("every window: gross − refundEffect = net, exactly",
    ["2026-08-01", "2026-07-01", "2026-04-01", "2025-10-01"].every((f) => eq(w(f).gross! - w(f).refundEffect!, w(f).amount)));
  check("net ≤ gross at every window (a refund never RAISES spending)",
    ["2026-08-01", "2026-07-01", "2026-04-01", "2025-10-01"].every((f) => w(f).amount <= w(f).gross!));
}

console.log("18–20. savings rate · runway · six-month threshold follow the NET baseline");
{
  // Aug 3,000; Sep 5,000 − 2,000 ⇒ NET 3,000/mo, GROSS 4,000/mo. Income 5,000 semimonthly-equivalent. Liquid 18,000.
  const rows = months([spent("2026-08-05", 3000), spent("2026-09-05", 5000), refund("2026-09-20", 2000)]);
  const expense = baselineOf(rows, "2026-08-01", "2026-09-30")!;
  const income = resolveIncomeBaseline({ stated: 5000, streams: [], measured: null })!;
  const d = derive({ expense, income, liquid: 18000, monthsOfExpenses: [6] });
  check("monthly surplus = 5,000 − 3,000 = 2,000 (gross would have said 1,000)", "amount" in d.monthlySurplus && eq(d.monthlySurplus.amount, 2000));
  check("18. savings rate = 2,000 / 5,000 = 40% (gross: 20%)", "ratePct" in d.savingsRate && eq(d.savingsRate.ratePct, 40));
  check("19. runway = 18,000 / 3,000 = 6 months (gross: 4.5)", "months" in d.runway && eq(d.runway.months, 6));
  const six = d.thresholds[0];
  check("20. six months of expenses = 6 × 3,000 = 18,000 (gross: 24,000); liquid is AT_OR_ABOVE it",
    "amount" in six && eq(six.amount, 18000) && six.vsLiquid?.status === "AT_OR_ABOVE" && eq(six.baseline.amount, 3000));
  check("identities hold: surplus = income − expense; runway × expense = liquid; threshold = N × expense",
    "amount" in d.monthlySurplus && "months" in d.runway && "amount" in six
      && eq(d.monthlySurplus.amount, income.amount - expense.amount) && eq(d.runway.months * expense.amount, 18000) && eq(six.amount, 6 * expense.amount));
}

console.log("21. liquid-floor scenario — the projection's spending rate and its floor are the SAME net figure");
{
  const rows = months([spent("2026-07-05", 3000), spent("2026-08-05", 3000), spent("2026-09-05", 5000), refund("2026-09-20", 2000)]);
  // What lib/ai/forecast/assemble.ts hands the rate: each month through the canonical clamp.
  const rate = deriveObservedSpendingRate(rows.map((m) => ({ month: m.month, expenseTotal: clampEconomicSpend(m.expenseTotal, m.refundTotal) })));
  check("observed rate = (3,000 + 3,000 + 3,000)/3 = 3,000 net (gross would be 3,666.67)", rate.assertable && eq(rate.monthlyRate, 3000));
  const floor = resolveMonthsOfExpensesFloor({ monthsOfExpenses: 6, observedMonthly: rate.assertable ? rate.monthlyRate : null });
  check("six-month liquid floor = 18,000, MEASURED", "liquidFloor" in floor && eq(floor.liquidFloor, 18000) && floor.derivedFrom.baseline.basis === "MEASURED");
  check("the scenario floor and the get_baselines threshold agree on the same window", "liquidFloor" in floor
    && eq(floor.liquidFloor, 6 * baselineOf(rows, "2026-07-01", "2026-09-30")!.amount));
  const src = readFileSync("lib/ai/forecast/assemble.ts", "utf8");
  check("the forecast feeds the rate through the canonical clamp, not gross expenseTotal",
    /expenseTotal: clampEconomicSpend\(m\.expenseTotal, m\.refundTotal\)/.test(src) && !/expenseTotal: m\.expenseTotal \}\)\)\)/.test(src));
}

console.log("22 + 23. STATED and DECLARED still outrank the measurement, and stay distinct");
{
  const rows = months([spent("2026-08-05", 3000), spent("2026-09-05", 5000), refund("2026-09-20", 2000)]);
  const stated = baselineOf(rows, "2026-08-01", "2026-09-30", { stated: 5000 })!;
  check("22. a stated 5,000 overrides the measured 3,000 — and carries no gross/refund fields (it is not a measurement)",
    eq(stated.amount, 5000) && stated.basis === "STATED" && stated.gross === undefined && stated.refundEffect === undefined);
  const declared = baselineOf(rows, "2026-08-01", "2026-09-30", { declared: 4200 })!;
  check("23. a declared 4,200 outranks the measurement and is labelled DECLARED", eq(declared.amount, 4200) && declared.basis === "DECLARED" && declared.gross === undefined);
  check("precedence is unchanged: STATED > DECLARED > MEASURED", baselineOf(rows, "2026-08-01", "2026-09-30", { stated: 5000, declared: 4200 })!.basis === "STATED");
}

console.log("24. population completeness is untouched by the economic definition");
{
  const rows = months([spent("2026-08-05", 3000), spent("2026-09-05", 5000), refund("2026-09-20", 2000)]);
  const p = resolvePeriod({ from: "2026-08-01", to: "2026-09-30" }, CEIL);
  const stale: DataCoverage = { ...COV, components: [{ key: "bank", tier: "incomplete", deliveredThrough: "2026-09-10" }] };
  const clean = measure("spending", rows, p, COV), behind = measure("spending", rows, p, stale);
  check("a stale contributing source still lowers the tier", clean.completeness.tier === "observed" && behind.completeness.tier !== "observed");
  check("…and the baseline carries that completeness through unchanged",
    resolveExpenseBaselineFromEvidence({ measured: behind })!.completeness!.tier === behind.completeness.tier);
  check("…while the net figure is the same either way", eq(economicSpendingOf(clean).perCompleteMonth, 3000) && eq(economicSpendingOf(behind).perCompleteMonth, 3000));
}

console.log("25. ONE authority — no second refund calculation anywhere in the baseline chain");
{
  const code = (rel: string) => readFileSync(rel, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const baseline = code("lib/ai/measures/baseline.ts"), metrics = code("lib/ai/intelligence/annotations/metrics.ts");
  check("baseline.ts reads the measure's netOfRefunds — it never touches refund rows, flow types or merchants",
    baseline.includes("m.netOfRefunds") && !/refundTotal|merchant|flowType|isRefund|foldEconomicRow/.test(baseline));
  check("the assessment mean is meanMonthlyEconomicSpend over reliableMonths — no local subtraction",
    /meanMonthlyEconomicSpend\(reliableMonths\(txn\)\)/.test(metrics) && !/expenseTotal\s*-\s*[a-z.]*refundTotal/i.test(metrics));
  check("the mean's per-month net IS the canonical clamp", /net: clampEconomicSpend\(m\.expenseTotal, m\.refundTotal\)/.test(code("lib/transactions/cash-flow.ts")));
  check("the expense TREND reconciles: income − expense = net, month by month",
    (() => { const m = months([spent("2026-09-05", 5000), refund("2026-09-20", 2000), { date: "2026-09-01", flow: "INCOME", amount: 6000, incomeClass: "EARNED_INCOME" }])[0];
      const row = { ...m, transactionCount: 3, estimated: false } as never;
      return eq(metricValue(row, "income") - metricValue(row, "expense"), metricValue(row, "net")) && eq(metricValue(row, "expense"), 3000); })());
  check("disclosure threshold is the one exported constant", MATERIAL_MONTHLY_REFUND_EFFECT === 1);
  // 0.60 of refunds over 2 months = 0.30/mo: NET is still used, but nothing is disclosed.
  const tiny = months([spent("2026-08-05", 1000), spent("2026-09-05", 1000), refund("2026-09-09", 0.6)]);
  const tb = baselineOf(tiny, "2026-08-01", "2026-09-30")!;
  check("an immaterial refund still nets (999.70) but adds no gross/refund clutter", eq(tb.amount, 999.7) && tb.gross === undefined && tb.refundEffect === undefined);
  check("no months ⇒ null (UNKNOWN), never 0", meanMonthlyEconomicSpend([]) === null && computeAverageMonthlySpending(asTxn([])) === null);
}

console.log(failures === 0 ? `\nPASS — ${passed} checks` : `\nFAIL — ${failures} of ${passed + failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
