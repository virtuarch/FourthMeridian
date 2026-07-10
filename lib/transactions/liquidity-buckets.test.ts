/**
 * lib/transactions/liquidity-buckets.test.ts
 *
 * CF-2B convergence — proves the shared liquidity projection (deriveCashFlowAxes,
 * bucketLiquidity, dailyLiquidity) reconciles: Summary == Σ History buckets ==
 * Σ Calendar days for the same rows. Pure — no DB.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { deriveCashFlowAxes, bucketLiquidity, dailyLiquidity, tierResolver, type LiquidityTx } from "./liquidity";

let n = 0;
function tx(over: Partial<LiquidityTx> & { amount: number; date: string }): LiquidityTx {
  return { id: `t${n++}`, accountId: "chk", financialAccountId: "chk", merchant: "m", category: "Transfer",
    pending: false, currency: "USD", flowType: "TRANSFER", counterpartyAccountId: null, transferDisposition: null, ...over } as unknown as LiquidityTx;
}
const rows: LiquidityTx[] = [
  tx({ amount: 6000,   date: "2026-02-05", flowType: "INCOME", transferDisposition: null }),        // earned income → Cash In
  tx({ amount: 8141.98, date: "2026-02-27", transferDisposition: "ASSET_VENUE_TRANSFER" }),         // From investments → Cash In
  tx({ amount: -50,    date: "2026-02-10", transferDisposition: "PAYMENT_APP_MOVEMENT" }),          // Payments through apps → Cash Out
  tx({ amount: 200,    date: "2026-02-12", transferDisposition: "PAYMENT_APP_MOVEMENT" }),          // From payment apps → Cash In
  tx({ amount: -1000,  date: "2026-03-08", transferDisposition: "ASSET_VENUE_TRANSFER" }),          // Money invested → Cash Out
  tx({ amount: -69.84, date: "2026-02-15", accountId: "card", financialAccountId: "card", transferDisposition: "PAYMENT_APP_MOVEMENT" }), // liability → NEUTRAL, excluded
  tx({ amount: -500,   date: "2026-02-20", counterpartyAccountId: "chk2", transferDisposition: "INTERNAL_TRANSFER" }),                    // internal → NEUTRAL, excluded
];
const ctxWithSav = tierResolver([{ id: "chk", type: "checking" }, { id: "chk2", type: "savings" }, { id: "brk", type: "investment" }, { id: "card", type: "debt" }]);

test("History buckets sum to the Summary totals (reconcile)", () => {
  const axes = deriveCashFlowAxes(rows, ctxWithSav);
  const buckets = bucketLiquidity(rows, ctxWithSav, "PAST_YEAR");
  const sumIn = buckets.reduce((s, b) => s + b.cashIn, 0);
  const sumOut = buckets.reduce((s, b) => s + b.cashOut, 0);
  assert.equal(Math.round(sumIn * 100), Math.round(axes.cashIn * 100));
  assert.equal(Math.round(sumOut * 100), Math.round(axes.cashOut * 100));
});

test("Calendar days sum to the Summary totals (reconcile)", () => {
  const axes = deriveCashFlowAxes(rows, ctxWithSav);
  const days = dailyLiquidity(rows, ctxWithSav);
  const sumIn = [...days.values()].reduce((s, d) => s + d.cashIn, 0);
  const sumOut = [...days.values()].reduce((s, d) => s + d.cashOut, 0);
  assert.equal(Math.round(sumIn * 100), Math.round(axes.cashIn * 100));
  assert.equal(Math.round(sumOut * 100), Math.round(axes.cashOut * 100));
});

test("liquid payment-app is counted; liability payment-app + internal are excluded", () => {
  const axes = deriveCashFlowAxes(rows, ctxWithSav);
  // Cash In = 6000 income + 8141.98 investments + 200 payment-app-in.
  assert.equal(Math.round(axes.cashIn * 100), Math.round((6000 + 8141.98 + 200) * 100));
  // Cash Out = 50 payment-app-out + 1000 money invested. (69.84 liability + 500 internal excluded.)
  assert.equal(Math.round(axes.cashOut * 100), Math.round((50 + 1000) * 100));
  assert.equal(Math.round(axes.byReason.PAYMENT_APP_INFLOW * 100), 20000);
  assert.equal(Math.round(axes.byReason.PAYMENT_APP_OUTFLOW * 100), 5000);
});

test("only CASH_IN/CASH_OUT rows enter buckets — NEUTRAL/UNRESOLVED are absent", () => {
  const days = dailyLiquidity(rows, ctxWithSav);
  // 2026-02-15 (liability payment-app) and 2026-02-20 (internal) produced no cash-flow.
  assert.ok(!days.has("2026-02-15"));
  assert.ok(!days.has("2026-02-20"));
});

test("byReason on buckets enables future filters without a new classifier", () => {
  const buckets = bucketLiquidity(rows, ctxWithSav, "PAST_YEAR");
  const all = buckets.flatMap((b) => Object.keys(b.byReason));
  assert.ok(all.includes("EARNED_INCOME"));
  assert.ok(all.includes("INVESTMENT_INFLOW"));
  assert.ok(all.includes("PAYMENT_APP_OUTFLOW"));
});
