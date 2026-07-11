/**
 * lib/transactions/cash-flow-projection.test.ts
 *
 * CF-3 — proves the shared two-perspective projection (cash-flow-projection.ts):
 *   1. reconciles with BOTH canonical authorities (deriveCashFlowAxes for the
 *      liquidity axis, aggregateCashFlow for the economic axis);
 *   2. daily / bucketed facts sum back to the aggregate;
 *   3. the governing invariants hold — a credit-card purchase is ECONOMIC spend
 *      but NOT liquidity Cash Out; a debt payment is Cash Out but NOT new spend
 *      (so the card purchase + its later payment are never spending twice); a
 *      cash withdrawal is neither spend nor Cash Out.
 * Pure — no DB.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { deriveCashFlowAxes, tierResolver, type LiquidityTx } from "./liquidity";
import { aggregateCashFlow, outflowByCategory, incomeBySource } from "./cash-flow";
import {
  aggregateDayFacts, projectDailyFacts, bucketDayFacts,
  perspectiveTotals, economicSpend, netOfMeasures, defaultMeasures,
  rowsForMeasures, CALENDAR_MEASURES, type CalendarMeasureId,
} from "./cash-flow-projection";

let n = 0;
function tx(over: Partial<LiquidityTx> & { amount: number; date: string }): LiquidityTx {
  return {
    id: `t${n++}`, accountId: "chk", financialAccountId: "chk", merchant: "m", category: "Shopping",
    pending: false, currency: "USD", flowType: "SPENDING", counterpartyAccountId: null, transferDisposition: null, ...over,
  } as unknown as LiquidityTx;
}

// A credit-card-heavy month: salary in, direct-debit + card purchases out, a card
// payment, an investment, a payment-app pair, and an ATM withdrawal.
const rows: LiquidityTx[] = [
  tx({ amount: 6000,    date: "2026-06-01", category: "Income",  flowType: "INCOME" }),                                     // earned income
  tx({ amount: -120.50, date: "2026-06-03", category: "Groceries", flowType: "SPENDING" }),                                // direct cash spend (checking)
  tx({ amount: -692.97, date: "2026-06-05", category: "Shopping",  flowType: "SPENDING", accountId: "card", financialAccountId: "card" }), // CARD purchase
  tx({ amount: -45.00,  date: "2026-06-05", category: "Dining",    flowType: "SPENDING", accountId: "card", financialAccountId: "card" }), // CARD purchase
  tx({ amount: -800.00, date: "2026-06-20", category: "Payment",   flowType: "DEBT_PAYMENT" }),                            // pay the card FROM checking
  tx({ amount: -1000,   date: "2026-06-22", category: "Transfer",  flowType: "TRANSFER", transferDisposition: "ASSET_VENUE_TRANSFER" }), // money invested
  tx({ amount: -50,     date: "2026-06-10", category: "Transfer",  flowType: "TRANSFER", transferDisposition: "PAYMENT_APP_MOVEMENT" }), // payments through apps
  tx({ amount: 200,     date: "2026-06-12", category: "Transfer",  flowType: "TRANSFER", transferDisposition: "PAYMENT_APP_MOVEMENT" }), // from payment apps
  tx({ amount: -300,    date: "2026-06-15", category: "Transfer",  flowType: "TRANSFER", transferDisposition: "CASH_MOVEMENT" }),        // ATM withdrawal
  tx({ amount: -30.00,  date: "2026-06-18", category: "Shopping",  flowType: "REFUND",   accountId: "card", financialAccountId: "card" }), // card refund
];

const liqCtx = tierResolver([{ id: "chk", type: "checking" }, { id: "card", type: "debt" }, { id: "brk", type: "investment" }]);

test("liquidity axis reconciles with deriveCashFlowAxes", () => {
  const f = aggregateDayFacts(rows, liqCtx);
  const axes = deriveCashFlowAxes(rows, liqCtx);
  assert.equal(Math.round(f.cashIn * 100),  Math.round(axes.cashIn * 100));
  assert.equal(Math.round(f.cashOut * 100), Math.round(axes.cashOut * 100));
});

test("economic axis reconciles with aggregateCashFlow", () => {
  const f = aggregateDayFacts(rows, liqCtx);
  const eco = aggregateCashFlow(rows);
  assert.equal(Math.round(f.income * 100),        Math.round(eco.income * 100));
  assert.equal(Math.round(economicSpend(f) * 100), Math.round(eco.spend * 100));
  assert.equal(Math.round(f.refunds * 100),       Math.round(eco.refunds * 100));
});

test("INVARIANT: a credit-card purchase is economic spend but NOT liquidity Cash Out", () => {
  const f = aggregateDayFacts(rows, liqCtx);
  // The two £692.97 + £45 card purchases are in economic spend (gross) and in creditCardSpending…
  assert.ok(f.creditCardSpending >= 737.97 - 0.01, "card purchases counted in creditCardSpending");
  assert.ok(f.spendGross >= f.creditCardSpending, "card spending is a subset of gross spend");
  // …but the ONLY Cash Out that touches the card tier is the £800 debt payment + direct debit + invested + app, never the purchases.
  // Cash Out = direct grocery (120.50) + debt payment (800) + invested (1000) + app out (50) = 1970.50
  assert.equal(Math.round(f.cashOut * 100), Math.round(1970.50 * 100));
});

test("INVARIANT: a debt payment is liquidity Cash Out but NOT new economic spend", () => {
  const f = aggregateDayFacts(rows, liqCtx);
  assert.equal(Math.round((f.byReason.DEBT_PAYMENT ?? 0) * 100), Math.round(800 * 100)); // in Cash Out
  // economic spend never includes DEBT_PAYMENT (not a cost flow) — so the card
  // purchase (£737.97) and its later payment (£800) are never both counted as spend.
  const eco = aggregateCashFlow(rows);
  // gross cost flows = 120.50 + 692.97 + 45 = 858.47 ; refund 30 ; spend = 828.47
  assert.equal(Math.round(eco.spend * 100), Math.round(828.47 * 100));
});

test("INVARIANT: an ATM withdrawal is neither economic spend nor liquidity Cash Out-by-purpose", () => {
  const f = aggregateDayFacts(rows, liqCtx);
  assert.equal(Math.round(f.cashWithdrawals * 100), Math.round(300 * 100));
  // it is NOT a cost flow, so not in economic spend…
  const eco = aggregateCashFlow(rows);
  assert.ok(eco.spend < 900, "withdrawal not in economic spend");
  // …and it is UNRESOLVED on the liquidity axis (unknown counterparty), so not in Cash Out.
  const axes = deriveCashFlowAxes(rows, liqCtx);
  assert.ok(axes.unresolved >= 300 - 0.01, "withdrawal surfaces as UNRESOLVED, not Cash Out");
});

test("directSpending + creditCardSpending partition gross cost flows by tier", () => {
  const f = aggregateDayFacts(rows, liqCtx);
  assert.equal(Math.round((f.directSpending + f.creditCardSpending) * 100), Math.round(f.spendGross * 100));
  // The grocery (£120.50, checking) is direct; the card purchases are credit-card.
  assert.equal(Math.round(f.directSpending * 100), Math.round(120.50 * 100));
  assert.equal(Math.round(CALENDAR_MEASURES.directDebitSpending.value(f) * 100), Math.round(f.directSpending * 100));
});

test("drill-down: 'Direct/debit spending' excludes card purchases", () => {
  // The mixedDay card purchases (Lulu, T-Mobile) are liability-tier → NOT direct.
  const drill = rowsForMeasures(mixedDay, ["directDebitSpending"], liqCtx).map((r) => r.id);
  assert.deepEqual(drill, []);
});

test("perspective totals: economic net sees card spending, liquidity net does not", () => {
  const f = aggregateDayFacts(rows, liqCtx);
  const eco = perspectiveTotals(f, "economic");
  const liq = perspectiveTotals(f, "liquidity");
  assert.equal(Math.round(eco.out * 100), Math.round(828.47 * 100)); // includes card purchases
  assert.equal(Math.round(liq.out * 100), Math.round(1970.50 * 100)); // excludes card purchases, includes debt payment
  assert.notEqual(Math.round(eco.out * 100), Math.round(liq.out * 100));
});

test("daily facts sum back to the aggregate (Calendar reconciles with Summary)", () => {
  const agg = aggregateDayFacts(rows, liqCtx);
  const daily = projectDailyFacts(rows, liqCtx);
  const sum = (pick: (f: typeof agg) => number) => [...daily.values()].reduce((s, d) => s + pick(d), 0);
  for (const key of ["cashIn", "cashOut", "income", "spendGross", "refunds", "creditCardSpending", "cashWithdrawals"] as const) {
    assert.equal(Math.round(sum((d) => d[key]) * 100), Math.round(agg[key] * 100), `daily Σ ${key}`);
  }
});

test("bucketed facts sum back to the aggregate (History reconciles with Summary)", () => {
  const agg = aggregateDayFacts(rows, liqCtx);
  const buckets = bucketDayFacts(rows, liqCtx, "PAST_YEAR");
  const sum = (pick: (f: typeof agg) => number) => buckets.reduce((s, d) => s + pick(d), 0);
  assert.equal(Math.round(sum((d) => d.cashOut) * 100), Math.round(agg.cashOut * 100));
  assert.equal(Math.round(sum((d) => d.creditCardSpending) * 100), Math.round(agg.creditCardSpending * 100));
});

test("netOfMeasures on default liquidity set == liquidity perspective net", () => {
  const f = aggregateDayFacts(rows, liqCtx);
  const viaMeasures = netOfMeasures(f, defaultMeasures("liquidity"));
  const viaPerspective = perspectiveTotals(f, "liquidity");
  assert.equal(Math.round(viaMeasures.net * 100), Math.round(viaPerspective.net * 100));
});

test("netOfMeasures on default economic set == economic perspective net", () => {
  const f = aggregateDayFacts(rows, liqCtx);
  const viaMeasures = netOfMeasures(f, defaultMeasures("economic"));
  const viaPerspective = perspectiveTotals(f, "economic");
  assert.equal(Math.round(viaMeasures.net * 100), Math.round(viaPerspective.net * 100));
});

test("Income by Source reconciles exactly with the economic projection income", () => {
  const f = aggregateDayFacts(rows, liqCtx);
  const bySource = incomeBySource(rows).reduce((s, c) => s + c.value, 0);
  assert.equal(Math.round(bySource * 100), Math.round(f.income * 100));
});

test("Spending by Category (incl. credit-card purchases) reconciles with economic spend", () => {
  const f = aggregateDayFacts(rows, liqCtx);
  const byCategory = outflowByCategory(rows).reduce((s, c) => s + c.value, 0);
  // Both count cost flows minus refunds; per-category clamp can only round UP vs
  // the single global clamp, so category Σ ≥ global spend and here they match
  // (no category went net-negative).
  assert.equal(Math.round(byCategory * 100), Math.round(economicSpend(f) * 100));
  // And the Shopping category carries the £692.97 card purchase (net of its £30
  // card refund → £662.97) — proving credit-card spending appears in Spending by
  // Category, the Part 1/2 requirement.
  const shopping = outflowByCategory(rows).find((c) => c.id === "Shopping");
  assert.equal(Math.round((shopping?.value ?? 0) * 100), Math.round(662.97 * 100));
});

test("liquidity reason measures partition Cash Out (no double-count when combined)", () => {
  const f = aggregateDayFacts(rows, liqCtx);
  // Every Cash Out reason sub-measure summed must not exceed total Cash Out.
  const outSubs: CalendarMeasureId[] = ["debtPayments", "moneyInvested", "paymentsThroughApps"];
  const subTotal = outSubs.reduce((s, id) => s + CALENDAR_MEASURES[id].value(f), 0);
  assert.ok(subTotal <= f.cashOut + 0.01, "reason subsets never exceed their parent Cash Out");
});

// ─── CF-3B — drill-down (rowsForMeasures) shows only the rows behind a measure ───
// Sanitized real "mixed day" (2026-07-08 Christian's Space): posted Lulu +
// T-Mobile card purchases share the day with a card debt payment and income.
// The bug: the Calendar/History drill-down showed EVERY row that day, mixing
// purchases with payments and burying the Lulu purchase.
const LULU = tx({ id: "lulu-jul8", amount: -72.83, date: "2026-07-08", category: "Shopping", flowType: "SPENDING", accountId: "card", financialAccountId: "card", merchant: "Lulu Hypermarket" });
const mixedDay: LiquidityTx[] = [
  LULU,
  tx({ id: "tmobile", amount: -119, date: "2026-07-08", category: "Utilities", flowType: "SPENDING", accountId: "card", financialAccountId: "card", merchant: "T-Mobile" }),
  tx({ id: "cardpay", amount: -800, date: "2026-07-08", category: "Payment",  flowType: "DEBT_PAYMENT", merchant: "AUTOPAY" }),        // paid FROM checking → Cash Out / Debt payment
  tx({ id: "salary",  amount: 500,  date: "2026-07-08", category: "Income",   flowType: "INCOME",       merchant: "ACME" }),
];

test("REGRESSION: posted June/July-8 Lulu appears in All spending AND Credit-card spending", () => {
  const f = projectDailyFacts(mixedDay, liqCtx).get("2026-07-08")!;
  assert.equal(Math.round(economicSpend(f) * 100), Math.round((72.83 + 119) * 100));   // Lulu + T-Mobile
  assert.equal(Math.round(f.creditCardSpending * 100), Math.round((72.83 + 119) * 100));
  // and it is NOT liquidity Cash Out, NOT a debt payment
  assert.equal(Math.round((f.byReason.DEBT_PAYMENT ?? 0) * 100), Math.round(800 * 100)); // only the real payment
});

test("drill-down: 'All spending' shows the purchases, not the debt payment or income", () => {
  const drill = rowsForMeasures(mixedDay, ["allSpending"], liqCtx).map((r) => r.id);
  assert.deepEqual(drill.sort(), ["lulu-jul8", "tmobile"]);
});

test("drill-down: 'Credit-card spending' shows card purchases, never the debt payment", () => {
  const drill = rowsForMeasures(mixedDay, ["creditCardSpending"], liqCtx).map((r) => r.id);
  assert.deepEqual(drill.sort(), ["lulu-jul8", "tmobile"]);
  assert.ok(!drill.includes("cardpay"), "debt payment must not appear in Credit-card spending");
});

test("drill-down: 'Debt payments' shows the payment, never a card purchase", () => {
  const drill = rowsForMeasures(mixedDay, ["debtPayments"], liqCtx).map((r) => r.id);
  assert.deepEqual(drill, ["cardpay"]);
  assert.ok(!drill.includes("lulu-jul8"), "card purchase must not appear in Debt payments");
});

test("INVARIANT: drill-down rows reconcile with the measure's heat-map value", () => {
  const f = projectDailyFacts(mixedDay, liqCtx).get("2026-07-08")!;
  for (const id of ["creditCardSpending", "debtPayments"] as CalendarMeasureId[]) {
    const rowsSum = rowsForMeasures(mixedDay, [id], liqCtx).reduce((s, r) => s + Math.abs(r.amount), 0);
    assert.equal(Math.round(rowsSum * 100), Math.round(CALENDAR_MEASURES[id].value(f) * 100), `${id} drawer Σ == cell`);
  }
});

test("INVARIANT: no row is in both a purchase measure and a payment measure (no double-count)", () => {
  const spend = new Set(rowsForMeasures(mixedDay, ["creditCardSpending"], liqCtx).map((r) => r.id));
  const pay   = rowsForMeasures(mixedDay, ["debtPayments"], liqCtx).map((r) => r.id);
  assert.ok(pay.every((id) => !spend.has(id)), "purchase and payment measures are disjoint");
});

// ── Phase 1 — the user-facing "Spending" measure/label ──────────────────────────
test("Phase 1: the all-spending economic measure is labelled 'Spending'", () => {
  assert.equal(CALENDAR_MEASURES.allSpending.label, "Spending");
});

test("Phase 1: 'Spending' nets refunds and excludes debt payments / income / withdrawals", () => {
  // Uses the top-of-file `rows` fixture (card + direct purchases, a card refund,
  // a debt payment, an ATM withdrawal, salary, an investment, app transfers).
  const drill = rowsForMeasures(rows, ["allSpending"], liqCtx);
  const ids = new Set(drill.map((r) => r.flowType));
  assert.ok(!ids.has("DEBT_PAYMENT"), "debt payments excluded from Spending");
  assert.ok(!ids.has("INCOME"),       "income excluded from Spending");
  assert.ok(!ids.has("TRANSFER"),     "transfers / investment funding / withdrawals excluded from Spending");
  // Spending includes BOTH credit-card and direct/debit cost flows, plus refunds.
  const f = aggregateDayFacts(rows, liqCtx);
  assert.ok(f.creditCardSpending > 0 && f.directSpending > 0, "both card and direct spending present");
  // The measure value == credit-card + direct spend, netted by refunds (clamped).
  assert.equal(
    Math.round(CALENDAR_MEASURES.allSpending.value(f) * 100),
    Math.round(economicSpend(f) * 100),
  );
});

// ── Spending Calendar filter — representative real rows (Concern C) ──────────────
// Reuses the SAME economic measure (allSpending) and rowsForMeasures the Calendar
// heat-map/tooltip/drawer already consume — no Calendar-only classifier. Four real
// merchants: Harvey Nichols + Uber on a credit card (liability tier), Lulu
// Hypermarket + Hunger Station on checking (direct/debit), plus a fee, interest, a
// refund, and a same-day debt payment. Hunger Station is `pending` (policy row).
const HARVEY_N = tx({ id: "harvey", amount: -692.97, date: "2026-06-05", category: "Shopping",  flowType: "SPENDING", accountId: "card", financialAccountId: "card", merchant: "Harvey Nichols" });
const LULU_HYP = tx({ id: "luluhyp", amount: -72.83, date: "2026-06-06", category: "Groceries", flowType: "SPENDING", accountId: "chk",  financialAccountId: "chk",  merchant: "Lulu Hypermarket" });
const UBER_RDE = tx({ id: "uber",   amount: -18.40, date: "2026-06-07", category: "Travel",    flowType: "SPENDING", accountId: "card", financialAccountId: "card", merchant: "Uber" });
const HUNGER_S = tx({ id: "hunger", amount: -33.10, date: "2026-06-08", category: "Dining",    flowType: "SPENDING", accountId: "chk",  financialAccountId: "chk",  merchant: "Hunger Station", pending: true });
const CARD_FEE = tx({ id: "fee",    amount: -12.00, date: "2026-06-09", category: "Fee",       flowType: "FEE",      accountId: "card", financialAccountId: "card", merchant: "Card fee" });
const CARD_INT = tx({ id: "int",    amount: -8.00,  date: "2026-06-09", category: "Interest",  flowType: "INTEREST", accountId: "card", financialAccountId: "card", merchant: "Interest charge" });
const CARD_REF = tx({ id: "ref",    amount: 20.00,  date: "2026-06-10", category: "Shopping",  flowType: "REFUND",   accountId: "card", financialAccountId: "card", merchant: "Harvey Nichols refund" });
const DEBT_PAY = tx({ id: "debt",   amount: -500,   date: "2026-06-08", category: "Payment",   flowType: "DEBT_PAYMENT", accountId: "chk", financialAccountId: "chk", merchant: "AUTOPAY" });
const spendingRows: LiquidityTx[] = [HARVEY_N, LULU_HYP, UBER_RDE, HUNGER_S, CARD_FEE, CARD_INT, CARD_REF, DEBT_PAY];

test("Spending filter: all four representative purchases appear in 'Spending'", () => {
  const ids = rowsForMeasures(spendingRows, ["allSpending"], liqCtx).map((r) => r.id).sort();
  for (const id of ["harvey", "luluhyp", "uber", "hunger"]) {
    assert.ok(ids.includes(id), `${id} appears in Spending`);
  }
});

test("Spending filter: posted card purchases appear in Spending AND Credit-card spending", () => {
  const cc = rowsForMeasures(spendingRows, ["creditCardSpending"], liqCtx).map((r) => r.id);
  assert.ok(cc.includes("harvey") && cc.includes("uber"), "Harvey Nichols + Uber are credit-card spending");
  const dd = rowsForMeasures(spendingRows, ["directDebitSpending"], liqCtx).map((r) => r.id);
  assert.ok(dd.includes("luluhyp") && dd.includes("hunger"), "Lulu + Hunger Station are direct/debit spending");
  // Both subsets are still part of top-level Spending.
  const spend = new Set(rowsForMeasures(spendingRows, ["allSpending"], liqCtx).map((r) => r.id));
  assert.ok([...cc, ...dd].every((id) => spend.has(id)), "card + debit spending ⊂ Spending");
});

test("Spending filter: debt payment is NOT in Spending (only in Debt payments)", () => {
  const spend = rowsForMeasures(spendingRows, ["allSpending"], liqCtx).map((r) => r.id);
  assert.ok(!spend.includes("debt"), "debt payment excluded from Spending");
  const pay = rowsForMeasures(spendingRows, ["debtPayments"], liqCtx).map((r) => r.id);
  assert.deepEqual(pay, ["debt"]);
});

test("Spending filter: fees + interest included; refunds net the total down", () => {
  const spend = rowsForMeasures(spendingRows, ["allSpending"], liqCtx).map((r) => r.id);
  assert.ok(spend.includes("fee") && spend.includes("int"), "fee + interest counted as Spending");
  assert.ok(spend.includes("ref"), "refund row surfaces in the Spending drawer (nets the total)");
  const f = aggregateDayFacts(spendingRows, liqCtx);
  // gross = 692.97+72.83+18.40+33.10+12+8 = 837.30 ; refund 20 ; spend = 817.30
  assert.equal(Math.round(economicSpend(f) * 100), Math.round(817.30 * 100));
});

test("Spending filter: a pending cost-flow row is included (documents pending policy)", () => {
  // Hunger Station is pending:true — the projection filters on NOTHING pending, so
  // it is in the Spending cell AND the drawer, exactly like posted rows.
  assert.ok(HUNGER_S.pending === true);
  const spend = rowsForMeasures(spendingRows, ["allSpending"], liqCtx).map((r) => r.id);
  assert.ok(spend.includes("hunger"), "pending purchase included in Spending (policy)");
});

test("Spending filter reconciles: Spending == economic spend == Σ Spending-by-Category", () => {
  const f = aggregateDayFacts(spendingRows, liqCtx);
  const measure = CALENDAR_MEASURES.allSpending.value(f);
  const byCategory = outflowByCategory(spendingRows).reduce((s, c) => s + c.value, 0);
  assert.equal(Math.round(measure * 100), Math.round(economicSpend(f) * 100));
  assert.equal(Math.round(byCategory * 100), Math.round(economicSpend(f) * 100));
  // Shopping carries Harvey Nichols £692.97 net of its £20 refund = £672.97.
  const shopping = outflowByCategory(spendingRows).find((c) => c.id === "Shopping");
  assert.equal(Math.round((shopping?.value ?? 0) * 100), Math.round(672.97 * 100));
});

test("Spending filter: credit-card + direct/debit spending partition Spending gross (no overlap)", () => {
  const f = aggregateDayFacts(spendingRows, liqCtx);
  assert.equal(Math.round((f.creditCardSpending + f.directSpending) * 100), Math.round(f.spendGross * 100));
  const cc = new Set(rowsForMeasures(spendingRows, ["creditCardSpending"], liqCtx).map((r) => r.id));
  const dd = rowsForMeasures(spendingRows, ["directDebitSpending"], liqCtx).map((r) => r.id);
  assert.ok(dd.every((id) => !cc.has(id)), "no purchase is both credit-card AND direct/debit");
});
