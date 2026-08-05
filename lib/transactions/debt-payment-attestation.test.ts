/**
 * lib/transactions/debt-payment-attestation.test.ts   (v2.6-TRUTH-8)
 *
 * The eight standing probes for the Cash Flow transfer / debt-payment defect.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * A $4,000 movement from Chase checking into an American Express HIGH YIELD
 * SAVINGS account was counted as a debt payment and as household Cash Out.
 *
 * Plaid categorised it `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` — the descriptor said
 * AMERICANEXPRESS and that institution also issues a card — so the row was
 * persisted `flowType: DEBT_PAYMENT`. `classifyLiquidity` then returned
 * CASH_OUT / DEBT_PAYMENT at confidence **1** from `flowType` and the own
 * account's tier alone, never looking at the destination the transfer authority
 * had already resolved (High Yield Savings Account, maturity SAVINGS_TRANSFER).
 *
 * The fix consults that destination. These probes keep it consulted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "./liquidity";
import { selectDebtPaymentCashLegs, totalDebtPaid } from "./debt-payment-authority";
import { findDuplicateEvents } from "./event-projection";

// Two institutions, each owning BOTH a card and a deposit account — the exact
// shape that produced the defect. Names are inert here: nothing under test may
// read them, and probe 4 proves it.
const TIERS = tierResolver([
  { id: "chk",      type: "checking" },
  { id: "amexSav",  type: "savings" },   // same institution as amexCard
  { id: "amexCard", type: "debt" },
  { id: "chaseCard", type: "debt" },
  { id: "brokerage", type: "investment" },
]);

const row = (o: {
  id: string; own: string; amount: number; flowType?: string;
  cp?: string | null; eventId?: string | null;
}): LiquidityTx => ({
  id: o.id, accountId: o.own, financialAccountId: o.own,
  counterpartyAccountId: o.cp ?? null,
  transactionEventId: o.eventId ?? `ev_${o.id}`,
  amount: o.amount, flowType: o.flowType ?? "DEBT_PAYMENT", currency: "USD",
  date: "2026-08-03", merchant: "m", category: "Other", pending: false,
} as unknown as LiquidityTx);

const abs = (t: LiquidityTx) => Math.abs(t.amount);

// ── 1 ────────────────────────────────────────────────────────────────────────

test("1. the savings transfer enters neither Debt Payments nor Cash Out", () => {
  // The live row: −$4,000 out of Chase checking, persisted DEBT_PAYMENT because
  // the PROVIDER said so, destination resolved to an Amex savings account.
  const t = row({ id: "the4000", own: "chk", amount: -4000, cp: "amexSav" });
  const c = classifyLiquidity(t, TIERS);
  assert.equal(c.effect, "NEUTRAL", "a savings transfer must not be household Cash Out");
  assert.equal(c.reason, "INTERNAL_TRANSFER");
  assert.equal(totalDebtPaid([t], TIERS, abs).total, 0, "and it must not be a debt payment");
});

// ── 2 ────────────────────────────────────────────────────────────────────────

test("2. a true checking → card payment enters Debt Payments exactly once", () => {
  const cash = row({ id: "cash", own: "chk", amount: -650, cp: "chaseCard", eventId: "ev_pay" });
  const liab = row({ id: "liab", own: "chaseCard", amount: 650, cp: "chk", eventId: "ev_pay2" });
  const r = totalDebtPaid([cash, liab], TIERS, abs);
  assert.equal(r.total, 650);
  assert.equal(r.count, 1);
  assert.equal(r.excludedLiabilityLegCount, 1);
  // ⚠️ The liability leg must stay NEUTRAL/DEBT_PAYMENT — its counterparty is the
  // SOURCE, not the destination, so the new guard must not divert it.
  const lc = classifyLiquidity(liab, TIERS);
  assert.equal(lc.effect, "NEUTRAL");
  assert.equal(lc.reason, "DEBT_PAYMENT");
});

// ── 3 ────────────────────────────────────────────────────────────────────────

test("3. a savings transfer is still a savings transfer when the institution also owns a card", () => {
  // `amexSav` and `amexCard` are the same institution. The existence of the card
  // must not make a deposit into the savings account a payment.
  const t = row({ id: "s", own: "chk", amount: -2500, cp: "amexSav" });
  assert.equal(classifyLiquidity(t, TIERS).reason, "INTERNAL_TRANSFER");
  assert.equal(totalDebtPaid([t], TIERS, abs).total, 0);
  // The same amount to that institution's CARD is a debt payment.
  const p = row({ id: "p", own: "chk", amount: -2500, cp: "amexCard" });
  assert.equal(totalDebtPaid([p], TIERS, abs).total, 2500);
});

// ── 4 ────────────────────────────────────────────────────────────────────────

test("4. institution and merchant names cannot affect debt-payment classification", () => {
  // Structural proof: identical rows, wildly different descriptors, same verdict.
  const mk = (merchant: string, cp: string) => ({
    ...row({ id: `x_${merchant}`, own: "chk", amount: -1000, cp }),
    merchant, description: merchant,
  }) as LiquidityTx;
  const descriptors = [
    "AMERICANEXPRESS TRANSFER 000320046315336 WEB",
    "AMERICAN EXPRESS ACH PMT M4082 WEB ID: 2005032111",
    "Payment to Chase card ending in 0202",
    "zzzz nonsense",
  ];
  for (const d of descriptors) {
    assert.equal(classifyLiquidity(mk(d, "amexSav"), TIERS).reason, "INTERNAL_TRANSFER",
      `descriptor changed the verdict: ${d}`);
    assert.equal(classifyLiquidity(mk(d, "amexCard"), TIERS).reason, "DEBT_PAYMENT",
      `descriptor changed the verdict: ${d}`);
  }

  // And the source proof — the authorities may not read a descriptor at all.
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  for (const f of ["lib/transactions/debt-payment-authority.ts"]) {
    const code = strip(readFileSync(join(process.cwd(), f), "utf8"));
    for (const forbidden of [/\bmerchant\b/i, /\bdescription\b/i, /institution/i]) {
      assert.ok(!forbidden.test(code), `${f} reads a descriptor: ${forbidden}`);
    }
  }
  // classifyLiquidity's DEBT_PAYMENT branch specifically.
  const liq = strip(readFileSync(join(process.cwd(), "lib/transactions/liquidity.ts"), "utf8"));
  const branch = liq.slice(liq.indexOf("if (isDebtPayment(ft))"), liq.indexOf("if (isInvestmentFlow(ft))"));
  for (const forbidden of [/merchant/i, /description/i, /institution/i, /\bname\b/i]) {
    assert.ok(!forbidden.test(branch), `the DEBT_PAYMENT branch reads a descriptor: ${forbidden}`);
  }
});

// ── 5 ────────────────────────────────────────────────────────────────────────

test("5. internal transfers do not alter household net cash flow", () => {
  const legs = [
    row({ id: "out", own: "chk",     amount: -4000, cp: "amexSav", flowType: "DEBT_PAYMENT" }),
    row({ id: "in",  own: "amexSav", amount:  4000, cp: "chk",     flowType: "TRANSFER" }),
  ];
  const net = legs.reduce((a, t) => {
    const c = classifyLiquidity(t, TIERS);
    return a + (c.effect === "CASH_IN" ? Math.abs(t.amount) : c.effect === "CASH_OUT" ? -Math.abs(t.amount) : 0);
  }, 0);
  assert.equal(net, 0, "moving your own money changed household net cash flow");
});

// ── 6 ────────────────────────────────────────────────────────────────────────

test("6. the card total and its drill-down rows are the SAME set", () => {
  const rows = [
    row({ id: "a", own: "chk", amount: -650,  cp: "chaseCard" }),
    row({ id: "b", own: "chk", amount: -4000, cp: "amexSav" }),
    row({ id: "c", own: "chk", amount: -300,  cp: "amexCard" }),
  ];
  const selected = selectDebtPaymentCashLegs(rows, TIERS).counted;
  const total = totalDebtPaid(rows, TIERS, abs);
  // The drawer renders `selected`; the heading renders `total`. One selection.
  assert.equal(selected.length, total.count);
  assert.equal(selected.reduce((a, t) => a + abs(t), 0), total.total);
  assert.deepEqual(selected.map((r) => r.id).sort(), ["a", "c"]);
});

// ── 7 ────────────────────────────────────────────────────────────────────────

test("7. no event contributes both a transfer amount and a debt-payment amount", () => {
  const rows = [
    row({ id: "out", own: "chk", amount: -4000, cp: "amexSav", flowType: "DEBT_PAYMENT", eventId: "ev1" }),
    row({ id: "pay", own: "chk", amount: -650,  cp: "chaseCard", eventId: "ev2" }),
  ];
  const debtEvents = new Set(selectDebtPaymentCashLegs(rows, TIERS).counted
    .map((r) => (r as unknown as { transactionEventId: string }).transactionEventId));
  const transferEvents = new Set(rows
    .filter((r) => classifyLiquidity(r, TIERS).reason === "INTERNAL_TRANSFER")
    .map((r) => (r as unknown as { transactionEventId: string }).transactionEventId));
  const both = [...debtEvents].filter((e) => transferEvents.has(e));
  assert.deepEqual(both, [], "an event is being counted as movement AND as a payment");
});

// ── 8 ────────────────────────────────────────────────────────────────────────

test("8. pending and posted observations count once through event projection", () => {
  // Both legs of one lifecycle share an event id. Even if a read ever returned
  // both, the projection guard catches it before any total is formed.
  const pending = row({ id: "pending", own: "chk", amount: -650, cp: "chaseCard", eventId: "ev_life" });
  const posted  = row({ id: "posted",  own: "chk", amount: -650, cp: "chaseCard", eventId: "ev_life" });
  assert.equal(findDuplicateEvents([pending, posted] as never).length, 1,
    "a duplicated event must be detectable before it reaches a total");
  // With the projection filter doing its job, only one reaches the authority.
  assert.equal(totalDebtPaid([posted], TIERS, abs).total, 650);
});
