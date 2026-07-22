/**
 * lib/transactions/cash-flow-context.test.ts
 *
 * CF-1 — proves the Cash Flow context grouping: "Moved, not spent" (NEUTRAL/
 * UNRESOLVED transfers by disposition + direction, incl. payment-app) and
 * "Needs classification" (the remaining TE-2B rows = unidentified inflow), with
 * zero overlap and no double-counting against Cash In/Out. Pure — no DB.
 *   npx tsx --test lib/transactions/cash-flow-context.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { groupCashFlowContext } from "./cash-flow-context";
import { tierResolver, type LiquidityTx } from "./liquidity";
import { aggregateDayFacts } from "./cash-flow-projection";

const ACCOUNTS = [
  { id: "chk", type: "checking" }, { id: "sav", type: "savings" },
  { id: "brk", type: "investment" },
];
const ctx = tierResolver(ACCOUNTS);

let seq = 0;
function tx(over: Partial<LiquidityTx> & { amount: number; flowType: string }): LiquidityTx {
  return {
    id: `t${seq++}`, accountId: "chk", financialAccountId: "chk", date: "2026-02-27",
    merchant: "m", category: "Transfer", pending: false, currency: "USD",
    counterpartyAccountId: null, transferDisposition: null, needsClassification: false,
    ...over,
  } as unknown as LiquidityTx;
}

const rows: LiquidityTx[] = [
  tx({ amount: -500,  flowType: "TRANSFER", counterpartyAccountId: "sav", transferDisposition: "INTERNAL_TRANSFER" }), // between accounts
  tx({ amount: -200,  flowType: "TRANSFER", transferDisposition: "CASH_MOVEMENT" }),                                   // moved to cash (withdrawal)
  tx({ amount: 2500,  flowType: "TRANSFER", transferDisposition: "CASH_MOVEMENT" }),                                   // cash deposited
  tx({ amount: -3000, flowType: "TRANSFER", transferDisposition: "ASSET_VENUE_TRANSFER" }),                           // CF-2: → Cash Out (excluded here)
  tx({ amount: 8000,  flowType: "TRANSFER", transferDisposition: "ASSET_VENUE_TRANSFER" }),                           // CF-2: → Cash In (excluded here)
  tx({ amount: -300,  flowType: "TRANSFER", transferDisposition: "EXTERNAL_BANK_TRANSFER" }),                         // other movement
  tx({ amount: -50,   flowType: "TRANSFER", transferDisposition: "PAYMENT_APP_MOVEMENT", needsClassification: true }),// payment-app → Moved, not spent
  tx({ amount: 900,   flowType: "INCOME",   transferDisposition: null, needsClassification: true }),                  // unidentified inflow → Needs classification
  tx({ amount: -5000, flowType: "TRANSFER", counterpartyAccountId: "brk", transferDisposition: "ASSET_VENUE_TRANSFER" }), // CASH_OUT deployment → excluded
  tx({ amount: -73,   flowType: "SPENDING", category: "Dining", transferDisposition: null }),                         // ordinary spend → excluded
];

test("Moved, not spent groups NEUTRAL/UNRESOLVED transfers by disposition + direction", () => {
  const c = groupCashFlowContext(rows, ctx);
  const byKey = Object.fromEntries(c.movedNotSpent.map((r) => [r.key, r]));
  assert.equal(byKey["between-accounts"].label, "Between your accounts");
  assert.equal(byKey["cash-withdrawals"].label, "Cash withdrawals");
  assert.equal(byKey["cash-deposited"].label, "Cash deposited");
  assert.equal(byKey["unresolved-transfers"].label, "Unresolved transfers");
  // CF-2B: payment-app is no longer a "Moved, not spent" bucket (it's Cash In/Out).
  assert.ok(!byKey["payment-app"]);
  assert.equal(byKey["cash-withdrawals"].amount, 200);
  assert.equal(byKey["cash-deposited"].amount, 2500);
});

test("CF-2B: an unidentified inflow into a NON-liquid (asset) account is excluded (crypto dust)", () => {
  const cryptoIn = tx({ amount: 0.03, flowType: "INCOME", accountId: "brk", financialAccountId: "brk", transferDisposition: null, needsClassification: true });
  const bankIn   = tx({ amount: 900,  flowType: "INCOME", transferDisposition: null, needsClassification: true }); // into chk (liquid)
  const c = groupCashFlowContext([cryptoIn, bankIn], ctx);
  assert.deepEqual(c.needsClassification.map((r) => r.key), ["unknown-inflow"]);
  assert.equal(c.needsClassification[0].count, 1); // only the liquid-account inflow
});

test("CF-2: investment-venue rows are NOT in Moved, not spent (they are Cash In/Out)", () => {
  const c = groupCashFlowContext(rows, ctx);
  assert.ok(!c.movedNotSpent.some((r) => r.key === "money-invested" || r.key === "investment-proceeds"));
  // The +8000 inflow and −3000 outflow venue rows never appear in the context section.
  const ctxIds = c.movedNotSpent.flatMap((r) => r.rows.map((x) => x.id));
  const venueIds = rows.filter((r) => (r as { transferDisposition?: string }).transferDisposition === "ASSET_VENUE_TRANSFER").map((r) => r.id);
  assert.ok(!ctxIds.some((id) => venueIds.includes(id)));
});

test("Needs classification carries only the remaining TE-2B subset (unidentified inflow)", () => {
  const c = groupCashFlowContext(rows, ctx);
  assert.deepEqual(c.needsClassification.map((r) => r.key), ["unknown-inflow"]);
  assert.equal(c.needsClassification[0].label, "Money in, source unknown");
  assert.equal(c.needsClassification[0].count, 1);
});

test("Needs classification is HIDDEN (empty) when there are no unidentified inflows", () => {
  const noInflow = rows.filter((r) => !(r as { needsClassification?: boolean }).needsClassification && (r as { flowType: string }).flowType !== "INCOME");
  const withPaymentApp = [...noInflow, tx({ amount: -25, flowType: "TRANSFER", transferDisposition: "PAYMENT_APP_MOVEMENT", needsClassification: true })];
  assert.equal(groupCashFlowContext(withPaymentApp, ctx).needsClassification.length, 0);
});

test("a CASH_OUT owned asset deployment is EXCLUDED from Moved, not spent (no double count)", () => {
  const c = groupCashFlowContext(rows, ctx);
  assert.ok(!c.movedNotSpent.flatMap((r) => r.rows).some((r) => r.amount === -5000));
});

test("zero overlap: every row appears in at most one displayed group", () => {
  const c = groupCashFlowContext(rows, ctx);
  const ids = [...c.movedNotSpent, ...c.needsClassification].flatMap((g) => g.rows.map((r) => r.id));
  assert.equal(new Set(ids).size, ids.length);
  // 4 moved (between/cash-withdrawals/cash-deposited/unresolved) + 1 needs; the 2 venue
  // rows + the payment-app row moved to Cash In/Out; spending + owned deployment excluded.
  assert.equal(ids.length, 5);
});

test("Cash In / Cash Out / Net are computed independently and unchanged by the grouping", () => {
  const before = aggregateDayFacts(rows, ctx);
  groupCashFlowContext(rows, ctx);
  const after = aggregateDayFacts(rows, ctx);
  assert.deepEqual({ in: after.cashIn, out: after.cashOut, net: (after.cashIn - after.cashOut) },
                   { in: before.cashIn, out: before.cashOut, net: (before.cashIn - before.cashOut) });
});
