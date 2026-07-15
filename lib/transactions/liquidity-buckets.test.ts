/**
 * lib/transactions/liquidity-buckets.test.ts
 *
 * Liquidity reason breakdown — proves the canonical Summary (deriveCashFlowAxes)
 * counts a liquid-account payment-app movement as spendable cash while excluding
 * a liability payment-app leg and an internal transfer. Pure — no DB.
 *
 * NOTE: the former History/Calendar reconciliation cases were removed together
 * with the dead `bucketLiquidity`/`dailyLiquidity` folds (zero production
 * consumers — CF-3 `DayFacts` in cash-flow-projection.ts is the live per-bucket
 * / per-day projection). What remains here is the deriveCashFlowAxes reason
 * coverage those cases also carried.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { deriveCashFlowAxes, tierResolver, type LiquidityTx } from "./liquidity";

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

test("liquid payment-app is counted; liability payment-app + internal are excluded", () => {
  const axes = deriveCashFlowAxes(rows, ctxWithSav);
  // Cash In = 6000 income + 8141.98 investments + 200 payment-app-in.
  assert.equal(Math.round(axes.cashIn * 100), Math.round((6000 + 8141.98 + 200) * 100));
  // Cash Out = 50 payment-app-out + 1000 money invested. (69.84 liability + 500 internal excluded.)
  assert.equal(Math.round(axes.cashOut * 100), Math.round((50 + 1000) * 100));
  assert.equal(Math.round(axes.byReason.PAYMENT_APP_INFLOW * 100), 20000);
  assert.equal(Math.round(axes.byReason.PAYMENT_APP_OUTFLOW * 100), 5000);
});
