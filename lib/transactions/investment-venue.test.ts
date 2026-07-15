/**
 * lib/transactions/investment-venue.test.ts
 *
 * CF-2 — evidence-aware investment-venue directional reclassification.
 * BROKERAGE/EXCHANGE venue evidence, on a liquid-account leg, with no owned
 * counterparty, resolves to Cash In ("From investments") / Cash Out ("Money
 * invested") — never a claimed sale. Pure — no DB.
 *   npx tsx --test lib/transactions/investment-venue.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "./liquidity";
import { economicTotals } from "./cash-flow";
import { aggregateDayFacts } from "./cash-flow-projection";
import { groupLiquidityByReason, LIQUIDITY_REASON_LABEL } from "./liquidity-breakdown";

const ACCOUNTS = [{ id: "chk", type: "checking" }, { id: "brk", type: "investment" }, { id: "card", type: "debt" }];
const ctx = tierResolver(ACCOUNTS);

function tx(over: Partial<LiquidityTx> & { amount: number }): LiquidityTx {
  return {
    id: `t${over.amount}${(over as { transferDisposition?: string }).transferDisposition ?? ""}`,
    accountId: "chk", financialAccountId: "chk", date: "2026-02-27", merchant: "m",
    category: "Transfer", pending: false, currency: "USD", flowType: "TRANSFER",
    counterpartyAccountId: null, transferDisposition: null, ...over,
  } as unknown as LiquidityTx;
}
const venueOut = tx({ amount: -1000, transferDisposition: "ASSET_VENUE_TRANSFER" });
const venueIn  = tx({ amount:  8141.98, transferDisposition: "ASSET_VENUE_TRANSFER" });

test("1. venue OUT from a liquid account → Cash Out · Money invested", () => {
  const c = classifyLiquidity(venueOut, ctx);
  assert.equal(c.effect, "CASH_OUT");
  assert.equal(c.reason, "INVESTMENT_OUTFLOW");
  assert.equal(LIQUIDITY_REASON_LABEL[c.reason], "Money invested");
});

test("2. venue IN to a liquid account → Cash In · From investments", () => {
  const c = classifyLiquidity(venueIn, ctx);
  assert.equal(c.effect, "CASH_IN");
  assert.equal(c.reason, "INVESTMENT_INFLOW");
  assert.equal(LIQUIDITY_REASON_LABEL[c.reason], "From investments");
});

test("3. venue IN does NOT become earned income (economic axis untouched)", () => {
  assert.equal(classifyLiquidity(venueIn, ctx).reason !== "EARNED_INCOME", true);
  // Economic axis: a TRANSFER is neither income nor spend — venue IN adds $0 to income.
  assert.equal(economicTotals([venueIn]).income, 0);
});

test("5. venue evidence alone does NOT claim an asset sale (never ASSET_LIQUIDATION)", () => {
  assert.notEqual(classifyLiquidity(venueIn, ctx).reason, "ASSET_LIQUIDATION");
  assert.equal(classifyLiquidity(venueIn, ctx).reason, "INVESTMENT_INFLOW"); // conservative
});

test("6. refunds unchanged; 7. internal owned transfer unchanged", () => {
  const refund = tx({ amount: 12.5, flowType: "REFUND", transferDisposition: null });
  assert.equal(classifyLiquidity(refund, ctx).reason, "REFUND");
  const internal = tx({ amount: -500, counterpartyAccountId: "chk2", transferDisposition: "INTERNAL_TRANSFER" });
  // counterparty liquid (own checking sibling) → NEUTRAL internal, not touched by CF-2.
  const ctx2 = tierResolver([...ACCOUNTS, { id: "chk2", type: "savings" }]);
  assert.equal(classifyLiquidity(internal, ctx2).effect, "NEUTRAL");
});

test("debt-account venue leg stays NEUTRAL (excluded from Cash Out)", () => {
  const debtLeg = tx({ amount: -33.63, accountId: "card", financialAccountId: "card", transferDisposition: "ASSET_VENUE_TRANSFER" });
  const c = classifyLiquidity(debtLeg, ctx);
  assert.equal(c.effect, "NEUTRAL");            // non-liquid leg
  assert.notEqual(c.effect, "CASH_OUT");
});

test("9/11. Cash In/Out reconcile: breakdown sums to totals, venue rows counted once", () => {
  const set = [venueOut, venueIn, tx({ amount: 6000, flowType: "INCOME", transferDisposition: null })];
  const facts = aggregateDayFacts(set, ctx);
  const bd = groupLiquidityByReason(facts);     // pure projection over the same facts
  assert.equal(bd.cashInTotal, facts.cashIn);   // reconciles
  assert.equal(bd.cashOutTotal, facts.cashOut);
  assert.equal(facts.cashIn, 6000 + 8141.98);   // earned income + From investments
  assert.equal(facts.cashOut, 1000);            // Money invested
  assert.equal(bd.netCash, facts.cashIn - facts.cashOut);
  // From investments appears exactly once, in Cash In.
  assert.equal(bd.cashIn.filter((l) => l.reason === "INVESTMENT_INFLOW").length, 1);
  assert.ok(!bd.cashOut.some((l) => l.reason === "INVESTMENT_INFLOW"));
});

test("without venue evidence, an unknown-counterparty transfer stays UNRESOLVED (no false positive)", () => {
  const plain = tx({ amount: 500, transferDisposition: null }); // no evidence
  assert.equal(classifyLiquidity(plain, ctx).effect, "UNRESOLVED");
});

// ── CF-2B: payment-app tier/direction (rail = HOW, tier = whether cash moved) ──
test("liquid + PAYMENT_APP + OUT → Cash Out · Payments through apps", () => {
  const c = classifyLiquidity(tx({ amount: -50, transferDisposition: "PAYMENT_APP_MOVEMENT" }), ctx);
  assert.equal(c.effect, "CASH_OUT");
  assert.equal(c.reason, "PAYMENT_APP_OUTFLOW");
  assert.equal(LIQUIDITY_REASON_LABEL[c.reason], "Payments through apps");
});

test("liquid + PAYMENT_APP + IN → Cash In · From payment apps", () => {
  const c = classifyLiquidity(tx({ amount: 200, transferDisposition: "PAYMENT_APP_MOVEMENT" }), ctx);
  assert.equal(c.effect, "CASH_IN");
  assert.equal(c.reason, "PAYMENT_APP_INFLOW");
  assert.equal(LIQUIDITY_REASON_LABEL[c.reason], "From payment apps");
});

test("liability + PAYMENT_APP → NEUTRAL, never Cash In/Out (the Customg6w5n leak fixed)", () => {
  const c = classifyLiquidity(tx({ amount: -69.84, accountId: "card", financialAccountId: "card", transferDisposition: "PAYMENT_APP_MOVEMENT" }), ctx);
  assert.equal(c.effect, "NEUTRAL");
  assert.notEqual(c.effect, "CASH_OUT");
  assert.notEqual(c.effect, "CASH_IN");
});

test("payment-app claims no purpose (never income/spending reason)", () => {
  const out = classifyLiquidity(tx({ amount: -50, transferDisposition: "PAYMENT_APP_MOVEMENT" }), ctx);
  assert.ok(!["EARNED_INCOME", "REAL_COST", "REFUND"].includes(out.reason));
});

test("12. liquidity + breakdown code are provider-neutral (no Plaid/PFC strings)", () => {
  for (const f of ["liquidity.ts", "liquidity-breakdown.ts", "cash-flow-context.ts"]) {
    const src = readFileSync(join(process.cwd(), "lib", "transactions", f), "utf8");
    assert.ok(!/plaid/i.test(src) && !/\bpfc/i.test(src), `${f} must stay provider-neutral`);
  }
});
