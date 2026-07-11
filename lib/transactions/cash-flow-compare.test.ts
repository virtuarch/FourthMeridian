/**
 * lib/transactions/cash-flow-compare.test.ts
 *
 * P1 — Cash Flow Time Machine (lib phase). Proves:
 *   1. cashFlowStamp emits the A5-S1 shared Completeness envelope with the right
 *      coverage-boundary tier: `observed` within history, `incomplete` before it,
 *      `observed` for All-Time (never a spurious pre-coverage gap), and
 *      `incomplete` with a null dataAsOf when there is no history at all.
 *   2. compareCashFlow's deltas reconcile EXACTLY with an independent per-period
 *      recomputation over the same canonical helpers (no drift), and its
 *      completeness is the WORST of the two sides.
 *   3. Determinism: a fixed clock + identical inputs ⇒ byte-identical output.
 * Pure — no DB.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { tierResolver, type LiquidityTx } from "./liquidity";
import {
  filterByPeriod,
  outflowByCategory,
  type CashFlowPeriod,
} from "./cash-flow";
import { aggregateDayFacts, perspectiveTotals } from "./cash-flow-projection";
import { cashFlowStamp, compareCashFlow } from "./cash-flow-compare";

// Fixed local clock — periodRange/filterByPeriod read local Y/M/D, so build with
// local components (never a UTC "Z" literal, which would shift the day by TZ).
const CLOCK = () => new Date(2026, 5, 15); // 2026-06-15, local

let n = 0;
function tx(over: Partial<LiquidityTx> & { amount: number; date: string }): LiquidityTx {
  return {
    id: `t${n++}`, accountId: "chk", financialAccountId: "chk", merchant: "m", category: "Groceries",
    pending: false, currency: "USD", flowType: "SPENDING", counterpartyAccountId: null, transferDisposition: null, ...over,
  } as unknown as LiquidityTx;
}

// History spans 2026-04 → 2026-06. Earliest data = 2026-04-03; latest = 2026-06-10.
const rows: LiquidityTx[] = [
  tx({ amount: 5000, date: "2026-04-03", category: "Income",    flowType: "INCOME" }),
  tx({ amount: -100, date: "2026-04-10", category: "Groceries", flowType: "SPENDING" }),
  tx({ amount: 5200, date: "2026-05-04", category: "Income",    flowType: "INCOME" }),
  tx({ amount: -200, date: "2026-05-12", category: "Groceries", flowType: "SPENDING" }),
  tx({ amount: -80,  date: "2026-05-20", category: "Dining",    flowType: "SPENDING" }),
  tx({ amount: 30,   date: "2026-05-25", category: "Groceries", flowType: "REFUND" }),
  tx({ amount: 5300, date: "2026-06-05", category: "Income",    flowType: "INCOME" }),
  tx({ amount: -150, date: "2026-06-10", category: "Groceries", flowType: "SPENDING" }),
];

const liqCtx = tierResolver([{ id: "chk", type: "checking" }]);

const MAY: CashFlowPeriod = { kind: "month", year: 2026, month: 5 };
const JAN: CashFlowPeriod = { kind: "month", year: 2026, month: 1 }; // before coverage

// ─── Stamp: coverage-boundary tiers ──────────────────────────────────────────

test("stamp: a period within history is observed, dataAsOf = newest posted row", () => {
  const s = cashFlowStamp({ transactions: rows, period: MAY, now: CLOCK });
  assert.equal(s.completeness.tier, "observed");
  assert.equal(s.completeness.conflict, false);
  assert.equal(s.completeness.coverageFrom, "2026-04-03");
  assert.equal(s.dataAsOf, "2026-06-10");
});

test("stamp: a period reaching before history is incomplete with the coverage floor", () => {
  const s = cashFlowStamp({ transactions: rows, period: JAN, now: CLOCK });
  assert.equal(s.completeness.tier, "incomplete");
  assert.equal(s.completeness.coverageFrom, "2026-04-03");
  assert.match(s.completeness.reason, /2026-04-03/);
  assert.equal(s.dataAsOf, "2026-06-10");
});

test("stamp: All-Time asks only for held history — observed, never pre-coverage", () => {
  const s = cashFlowStamp({ transactions: rows, period: "ALL", now: CLOCK });
  assert.equal(s.completeness.tier, "observed");
});

test("stamp: no history at all is incomplete with a null dataAsOf", () => {
  const s = cashFlowStamp({ transactions: [], period: MAY, now: CLOCK });
  assert.equal(s.completeness.tier, "incomplete");
  assert.equal(s.dataAsOf, null);
  assert.equal(s.completeness.coverageFrom, undefined);
});

test("stamp: determinism — identical inputs + fixed clock ⇒ byte-identical", () => {
  const a = cashFlowStamp({ transactions: rows, period: "MTD", now: CLOCK });
  const b = cashFlowStamp({ transactions: rows, period: "MTD", now: CLOCK });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ─── Then vs Now: deltas reconcile with independent recomputation ─────────────

/** Recompute one side's economic totals independently, straight from the canon. */
function sideTotals(period: CashFlowPeriod) {
  const f = aggregateDayFacts(filterByPeriod(rows, period, CLOCK()), liqCtx);
  return perspectiveTotals(f, "economic");
}

test("compare: totals delta == independent (now − then) recomputation", () => {
  const cmp = compareCashFlow({
    transactions: rows, liqCtx, then: MAY, now: "MTD", perspective: "economic", clock: CLOCK,
  });
  const then = sideTotals(MAY);
  const now = sideTotals("MTD");
  assert.equal(cmp.delta.totals.in,  now.in  - then.in);
  assert.equal(cmp.delta.totals.out, now.out - then.out);
  assert.equal(cmp.delta.totals.net, now.net - then.net);
  // and each side's own totals match the canon
  assert.deepEqual(cmp.then.totals, then);
  assert.deepEqual(cmp.now.totals, now);
});

test("compare: category delta == independent per-period outflowByCategory diff", () => {
  const cmp = compareCashFlow({
    transactions: rows, liqCtx, then: MAY, now: "MTD", perspective: "economic", clock: CLOCK,
  });
  const thenCats = new Map(outflowByCategory(filterByPeriod(rows, MAY, CLOCK())).map((c) => [c.id, c.value]));
  const nowCats  = new Map(outflowByCategory(filterByPeriod(rows, "MTD", CLOCK())).map((c) => [c.id, c.value]));
  for (const d of cmp.delta.outflowByCategory) {
    const t = thenCats.get(d.id) ?? 0;
    const nn = nowCats.get(d.id) ?? 0;
    assert.equal(d.then, t);
    assert.equal(d.now, nn);
    assert.equal(d.delta, nn - t);
  }
  // every category present in either period is represented, none invented
  const union = new Set([...thenCats.keys(), ...nowCats.keys()]);
  assert.equal(cmp.delta.outflowByCategory.length, union.size);
  // biggest absolute mover first
  const abs = cmp.delta.outflowByCategory.map((d) => Math.abs(d.delta));
  for (let i = 1; i < abs.length; i++) assert.ok(abs[i - 1] >= abs[i]);
});

test("compare: completeness is the worst of the two sides", () => {
  const both = compareCashFlow({
    transactions: rows, liqCtx, then: MAY, now: "MTD", perspective: "economic", clock: CLOCK,
  });
  assert.equal(both.completeness.tier, "observed"); // both sides within history

  const oneGap = compareCashFlow({
    transactions: rows, liqCtx, then: JAN, now: "MTD", perspective: "economic", clock: CLOCK,
  });
  assert.equal(oneGap.completeness.tier, "incomplete"); // JAN predates coverage ⇒ worst wins
  assert.equal(oneGap.completeness.coverageFrom, "2026-04-03");
});

test("compare: determinism — identical inputs + fixed clock ⇒ byte-identical", () => {
  const a = compareCashFlow({ transactions: rows, liqCtx, then: MAY, now: "MTD", perspective: "economic", clock: CLOCK });
  const b = compareCashFlow({ transactions: rows, liqCtx, then: MAY, now: "MTD", perspective: "economic", clock: CLOCK });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
