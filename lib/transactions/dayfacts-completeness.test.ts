/**
 * lib/transactions/dayfacts-completeness.test.ts  (P2-1A)
 *
 * Pins the P2-1A DayFacts completion + the LIQUIDITY_REASON_SIDE partition that
 * lets groupLiquidityByReason be a pure projection:
 *
 *   1. byReason is EFFECT-PARTITIONED — Σ byReason[side='in'] === cashIn and
 *      Σ byReason[side='out'] === cashOut, so the reason map reconstructs the
 *      Cash In / Cash Out totals exactly (the invariant the projection relies on;
 *      it breaks the instant LIQUIDITY_REASON_SIDE misclassifies a reason).
 *   2. STRADDLE EXCLUSION — a straddle reason's NEUTRAL leg (income into a
 *      non-liquid account → EARNED_INCOME/NEUTRAL) is NOT recorded in byReason,
 *      so it can never pollute the Cash In partition or a measure.
 *   3. NEUTRAL-CONTEXT reasons ARE recorded (INTERNAL_TRANSFER / ASSET_CONVERSION
 *      / NON_CASH), and `unresolved` is captured and sums back over the day map.
 *
 *     npx tsx lib/transactions/dayfacts-completeness.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { tierResolver, type LiquidityTx, type LiquidityReason } from "./liquidity";
import { aggregateDayFacts, projectDailyFacts } from "./cash-flow-projection";
import { LIQUIDITY_REASON_SIDE } from "./liquidity-breakdown";

let n = 0;
function tx(over: Partial<LiquidityTx> & { amount: number; date: string; own: string }): LiquidityTx {
  const { own, ...rest } = over;
  return {
    id: `t${n++}`, accountId: own, financialAccountId: own, merchant: "m", category: "Shopping",
    pending: false, currency: "USD", flowType: "SPENDING",
    counterpartyAccountId: null, transferDisposition: null, ...rest,
  } as unknown as LiquidityTx;
}

// chk/sav liquid · cb asset · card liability
const ctx = tierResolver([
  { id: "chk", type: "checking" }, { id: "sav", type: "savings" },
  { id: "cb", type: "crypto" }, { id: "card", type: "debt" },
]);
const cents = (v: number) => Math.round(v * 100);

// A rich fixture that exercises many reasons across both sides + context.
const rich: LiquidityTx[] = [
  tx({ own: "chk", amount: 6000, date: "2026-06-01", flowType: "INCOME" }),                                        // EARNED_INCOME (in)
  tx({ own: "chk", amount: 500,  date: "2026-06-02", flowType: "REFUND" }),                                        // REFUND (in)
  tx({ own: "chk", amount: 1000, date: "2026-06-03", flowType: "TRANSFER", counterpartyAccountId: "cb" }),         // ASSET_LIQUIDATION (in)
  tx({ own: "chk", amount: 300,  date: "2026-06-04", flowType: "TRANSFER", counterpartyAccountId: "card" }),       // DEBT_PROCEEDS (in)
  tx({ own: "chk", amount: 200,  date: "2026-06-05", flowType: "TRANSFER", transferDisposition: "PAYMENT_APP_MOVEMENT" }), // PAYMENT_APP_INFLOW (in)
  tx({ own: "chk", amount: -120, date: "2026-06-06", flowType: "SPENDING" }),                                      // REAL_COST (out)
  tx({ own: "chk", amount: -800, date: "2026-06-07", flowType: "DEBT_PAYMENT" }),                                  // DEBT_PAYMENT (out)
  tx({ own: "chk", amount: -400, date: "2026-06-08", flowType: "TRANSFER", counterpartyAccountId: "cb" }),         // ASSET_DEPLOYMENT (out)
  tx({ own: "chk", amount: -50,  date: "2026-06-09", flowType: "TRANSFER", transferDisposition: "PAYMENT_APP_MOVEMENT" }), // PAYMENT_APP_OUTFLOW (out)
  tx({ own: "chk", amount: -500, date: "2026-06-10", flowType: "TRANSFER", counterpartyAccountId: "sav" }),        // INTERNAL_TRANSFER (context)
  tx({ own: "cb",  amount: 900,  date: "2026-06-11", flowType: "INVESTMENT" }),                                    // ASSET_CONVERSION (context)
  tx({ own: "chk", amount: 42,   date: "2026-06-12", flowType: "ADJUSTMENT" }),                                    // NON_CASH (context)
  tx({ own: "chk", amount: 777,  date: "2026-06-13", flowType: "TRANSFER" }),                                      // UNRESOLVED (unknown cp)
];

test("1. byReason partitions cashIn/cashOut exactly (LIQUIDITY_REASON_SIDE pin)", () => {
  const f = aggregateDayFacts(rich, ctx);
  let inSum = 0, outSum = 0, ctxSum = 0;
  for (const [reason, amt] of Object.entries(f.byReason) as [LiquidityReason, number][]) {
    const side = LIQUIDITY_REASON_SIDE[reason];
    if (side === "in") inSum += amt; else if (side === "out") outSum += amt; else ctxSum += amt;
  }
  assert.equal(cents(inSum),  cents(f.cashIn),  "Σ byReason[in]  === cashIn");
  assert.equal(cents(outSum), cents(f.cashOut), "Σ byReason[out] === cashOut");
  // context reasons are recorded but never part of cash in/out
  assert.ok(ctxSum > 0, "context reasons are recorded in byReason");
  assert.equal(cents((f.byReason.INTERNAL_TRANSFER ?? 0)), cents(500));
  assert.equal(cents((f.byReason.ASSET_CONVERSION ?? 0)),  cents(900));
  assert.equal(cents((f.byReason.NON_CASH ?? 0)),          cents(42));
});

test("2. straddle exclusion — a NEUTRAL income leg is NOT recorded in byReason", () => {
  // Income into an ASSET account is EARNED_INCOME/NEUTRAL (earned, not spendable).
  const assetIncomeOnly = aggregateDayFacts([tx({ own: "cb", amount: 250, date: "2026-06-01", flowType: "INCOME" })], ctx);
  assert.equal(assetIncomeOnly.cashIn, 0, "asset income is not Cash In");
  assert.equal(assetIncomeOnly.byReason.EARNED_INCOME ?? 0, 0, "neutral income leg is NOT in byReason");
  // Mixed: liquid income 100 (CASH_IN) + asset income 50 (NEUTRAL) → byReason has ONLY the 100.
  const mixed = aggregateDayFacts([
    tx({ own: "chk", amount: 100, date: "2026-06-01", flowType: "INCOME" }),
    tx({ own: "cb",  amount: 50,  date: "2026-06-01", flowType: "INCOME" }),
  ], ctx);
  assert.equal(cents(mixed.cashIn), cents(100));
  assert.equal(cents(mixed.byReason.EARNED_INCOME ?? 0), cents(100), "only the liquid (CASH_IN) leg is recorded");
  // economic income still counts BOTH (economic axis is tier-independent).
  assert.equal(cents(mixed.income), cents(150));
});

test("3. unresolved is captured and sums back over the day map", () => {
  const agg = aggregateDayFacts(rich, ctx);
  assert.equal(cents(agg.unresolved), cents(777));
  const daily = [...projectDailyFacts(rich, ctx).values()];
  const dailyUnresolved = daily.reduce((s, d) => s + d.unresolved, 0);
  assert.equal(cents(dailyUnresolved), cents(agg.unresolved), "daily Σ unresolved === aggregate");
});

test("4. LIQUIDITY_REASON_SIDE covers every LiquidityReason exactly once", () => {
  // Completeness is compile-time (Record<LiquidityReason, …>); assert the values
  // are only the three sanctioned sides so a typo can't slip a 4th bucket in.
  const sides = new Set(Object.values(LIQUIDITY_REASON_SIDE));
  assert.deepEqual([...sides].sort(), ["context", "in", "out"]);
});
