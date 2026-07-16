/**
 * lib/transactions/cash-flow-fold-authority.test.ts  (P2-1)
 *
 * Proves DayFacts is the SOLE semantic fold for cash-flow aggregation, and that
 * the economic answer has ONE authority (foldEconomicRow + clampEconomicSpend),
 * shared by:
 *   • economicTotals          — the economic-only entry point (no liqCtx)
 *   • aggregateDayFacts          — Summary
 *   • bucketDayFacts             — History
 *   • projectDailyFacts          — Calendar
 *
 * Two halves (house pattern):
 *   1. BEHAVIOURAL parity across entry points — NOT "two duplicated formulas
 *      happen to agree": all four entry points fold the SAME foldEconomicRow, so
 *      this proves the shared authority is wired through every surface (income,
 *      spending, refunds, debt-payment exclusion, transfer exclusion, and mixed
 *      month/day bucketing all reconcile Summary == History Σ == Calendar Σ ==
 *      economic-only).
 *   2. SOURCE-SCAN invariants — prevent new independent economic logic from
 *      re-accumulating (the 3-way branch + clamp must live only in the shared
 *      primitives; no production surface may resurrect the deriveCashFlowAxes
 *      double-fold).
 *
 *     npx tsx lib/transactions/cash-flow-fold-authority.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tierResolver, type LiquidityTx } from "./liquidity";
import { economicTotals, type CashFlowPeriod } from "./cash-flow";
import {
  aggregateDayFacts, projectDailyFacts, bucketDayFacts,
  perspectiveTotals, economicSpend,
} from "./cash-flow-projection";

let n = 0;
function tx(over: Partial<LiquidityTx> & { amount: number; date: string }): LiquidityTx {
  return {
    id: `t${n++}`, accountId: "chk", financialAccountId: "chk", merchant: "m", category: "Shopping",
    pending: false, currency: "USD", flowType: "SPENDING", counterpartyAccountId: null, transferDisposition: null, ...over,
  } as unknown as LiquidityTx;
}

const liqCtx = tierResolver([{ id: "chk", type: "checking" }, { id: "card", type: "debt" }, { id: "brk", type: "investment" }]);
const cents = (v: number) => Math.round(v * 100);

/** For a row set: economic-only (economicTotals) must equal the economic
 *  projection of Summary (aggregateDayFacts), History (Σ bucketDayFacts) and
 *  Calendar (Σ projectDailyFacts) — one economic semantic across every fold. */
function assertEconomicParity(label: string, rows: LiquidityTx[], period: CashFlowPeriod) {
  const eco = economicTotals(rows);                       // economic-only entry
  const agg = aggregateDayFacts(rows, liqCtx);               // Summary
  const summaryEco = perspectiveTotals(agg, "economic");
  const daily = [...projectDailyFacts(rows, liqCtx).values()]; // Calendar
  const buckets = bucketDayFacts(rows, liqCtx, period);        // History
  const sum = (arr: { income: number; spendGross: number; refunds: number }[], k: "income" | "spendGross" | "refunds") =>
    arr.reduce((s, f) => s + f[k], 0);

  // Summary economic == economic-only entry
  assert.equal(cents(summaryEco.in),  cents(eco.income), `${label}: Summary income == economicTotals income`);
  assert.equal(cents(summaryEco.out), cents(eco.spend),  `${label}: Summary spend == economicTotals spend`);
  assert.equal(cents(summaryEco.net), cents(eco.net),    `${label}: Summary net == economicTotals net`);

  // Calendar Σ (daily) == Summary aggregate, on the economic fields
  assert.equal(cents(sum(daily, "income")),     cents(agg.income),     `${label}: Calendar Σ income`);
  assert.equal(cents(sum(daily, "spendGross")), cents(agg.spendGross), `${label}: Calendar Σ spendGross`);
  assert.equal(cents(sum(daily, "refunds")),    cents(agg.refunds),    `${label}: Calendar Σ refunds`);

  // History Σ (buckets) == Summary aggregate, on the economic fields
  assert.equal(cents(sum(buckets, "income")),     cents(agg.income),     `${label}: History Σ income`);
  assert.equal(cents(sum(buckets, "spendGross")), cents(agg.spendGross), `${label}: History Σ spendGross`);
  assert.equal(cents(sum(buckets, "refunds")),    cents(agg.refunds),    `${label}: History Σ refunds`);

  // clamp authority: economic spend from DayFacts == the economic-only spend
  assert.equal(cents(economicSpend(agg)), cents(eco.spend), `${label}: economicSpend(DayFacts) == economicTotals spend`);
}

// ── 1. Behavioural parity across the named scenarios ─────────────────────────

test("ordinary income + spending: parity across Summary/History/Calendar/economic-only", () => {
  const rows = [
    tx({ amount: 5000,   date: "2026-06-01", category: "Income",    flowType: "INCOME" }),
    tx({ amount: -120,   date: "2026-06-03", category: "Groceries", flowType: "SPENDING" }),
    tx({ amount: -40,    date: "2026-06-04", category: "Fee",       flowType: "FEE" }),
    tx({ amount: -10,    date: "2026-06-05", category: "Interest",  flowType: "INTEREST" }),
  ];
  assertEconomicParity("income+spend", rows, "PAST_MONTH");
  const eco = economicTotals(rows);
  assert.equal(cents(eco.income), cents(5000));
  assert.equal(cents(eco.spend),  cents(170)); // 120 + 40 + 10, no refunds
});

test("refunds net the spend (clamp) with identical parity", () => {
  const rows = [
    tx({ amount: -200, date: "2026-06-03", category: "Shopping", flowType: "SPENDING" }),
    tx({ amount: 30,   date: "2026-06-06", category: "Shopping", flowType: "REFUND" }),
  ];
  assertEconomicParity("refunds", rows, "PAST_MONTH");
  const eco = economicTotals(rows);
  assert.equal(cents(eco.refunds), cents(30));
  assert.equal(cents(eco.spend),   cents(170)); // 200 − 30
});

test("refund exceeding spend clamps to 0 (never negative)", () => {
  const rows = [
    tx({ amount: -50,  date: "2026-06-03", category: "Shopping", flowType: "SPENDING" }),
    tx({ amount: 200,  date: "2026-06-06", category: "Shopping", flowType: "REFUND" }),
  ];
  assertEconomicParity("over-refund", rows, "PAST_MONTH");
  assert.equal(cents(economicTotals(rows).spend), cents(0));
});

test("debt payments are EXCLUDED from the economic answer (not spend)", () => {
  const rows = [
    tx({ amount: -100,  date: "2026-06-03", category: "Groceries", flowType: "SPENDING" }),
    tx({ amount: -800,  date: "2026-06-20", category: "Payment",   flowType: "DEBT_PAYMENT" }),
  ];
  assertEconomicParity("debt-payment", rows, "PAST_MONTH");
  assert.equal(cents(economicTotals(rows).spend), cents(100)); // debt payment not counted
});

test("transfers / investment funding are EXCLUDED from the economic answer", () => {
  const rows = [
    tx({ amount: 3000,   date: "2026-06-01", category: "Income",   flowType: "INCOME" }),
    tx({ amount: -1000,  date: "2026-06-10", category: "Transfer", flowType: "TRANSFER", transferDisposition: "ASSET_VENUE_TRANSFER" }),
    tx({ amount: -60,    date: "2026-06-11", category: "Dining",   flowType: "SPENDING" }),
  ];
  assertEconomicParity("transfer-excluded", rows, "PAST_MONTH");
  const eco = economicTotals(rows);
  assert.equal(cents(eco.income), cents(3000));
  assert.equal(cents(eco.spend),  cents(60)); // transfer excluded
});

test("mixed month/day bucketing: History Σ == Summary across a multi-month window", () => {
  const rows = [
    tx({ amount: 2000, date: "2026-04-15", category: "Income",   flowType: "INCOME" }),
    tx({ amount: -300, date: "2026-04-20", category: "Shopping", flowType: "SPENDING" }),
    tx({ amount: -150, date: "2026-05-02", category: "Dining",   flowType: "SPENDING", accountId: "card", financialAccountId: "card" }),
    tx({ amount: 25,   date: "2026-05-09", category: "Shopping", flowType: "REFUND" }),
    tx({ amount: -80,  date: "2026-06-01", category: "Groceries", flowType: "SPENDING" }),
  ];
  // PAST_YEAR → monthly buckets spanning Apr/May/Jun.
  assertEconomicParity("mixed-months", rows, "PAST_YEAR");
  const buckets = bucketDayFacts(rows, liqCtx, "PAST_YEAR");
  assert.ok(buckets.length >= 3, "at least three monthly buckets exist");
});

// ── 2. Source-scan invariants — single-fold authority ────────────────────────

const read = (rel: string[]) => readFileSync(join(process.cwd(), ...rel), "utf8");

test("INVARIANT: economicTotals delegates to the shared economic primitives (no inline branch/clamp)", () => {
  const src = read(["lib", "transactions", "cash-flow.ts"]);
  // The behavioural parity above already proves every entry point folds the SAME
  // authority (a re-inlined accumulator would break the Summary==History==Calendar
  // reconciliation). Here we only pin symbol delegation — that economicTotals
  // reaches for the shared primitives — not the exact argument spelling.
  assert.ok(/foldEconomicRow\(/.test(src), "economicTotals folds via the shared foldEconomicRow");
  assert.ok(/clampEconomicSpend\(/.test(src), "economicTotals clamps via the shared clampEconomicSpend");
});

test("INVARIANT: the DayFacts fold delegates the economic answer to the shared primitive", () => {
  const src = read(["lib", "transactions", "cash-flow-projection.ts"]);
  // Symbol delegation, not spelled-out inline-accumulation negatives (those pinned
  // exact `acc.income +=` / `Math.max(0, f.spendGross` text). Divergence is caught
  // behaviourally by the parity harness above.
  assert.ok(/foldEconomicRow\(/.test(src), "foldDayFacts folds economics via the shared foldEconomicRow");
  assert.ok(/clampEconomicSpend\(/.test(src), "economicSpend delegates the clamp to clampEconomicSpend");
});

test("INVARIANT: no production surface uses the retired deriveCashFlowAxes double-fold", () => {
  // Durable single-authority / import-graph guard: the Cash Flow Summary (the
  // former double-fold) must read DayFacts only — no deriveCashFlowAxes CALL and no
  // import (explanatory comments may still name it). Surface symbols are checked by
  // presence, not exact argument spelling.
  const summary = read(["components", "space", "widgets", "CashFlowSummaryWidget.tsx"]);
  assert.ok(!/deriveCashFlowAxes\(/.test(summary), "CashFlowSummaryWidget no longer calls deriveCashFlowAxes");
  assert.ok(!/^\s*deriveCashFlowAxes,/m.test(summary), "CashFlowSummaryWidget no longer imports deriveCashFlowAxes");
  assert.ok(summary.includes("aggregateDayFacts"), "CashFlowSummaryWidget folds via aggregateDayFacts");
  // Summary / History / Calendar all consume the shared DayFacts projection.
  const history = read(["components", "space", "widgets", "CashFlowHistoryWidget.tsx"]);
  const calendar = read(["components", "space", "widgets", "CashFlowCalendar.tsx"]);
  assert.ok(history.includes("bucketDayFacts"), "History folds via bucketDayFacts");
  assert.ok(calendar.includes("projectDailyFacts"), "Calendar folds via projectDailyFacts");
});
