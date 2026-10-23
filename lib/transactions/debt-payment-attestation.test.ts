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
import { isDebtPaymentAttested } from "@/lib/transactions/debt-payment-attestation";

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

// ─────────────────────────────────────────────────────────────────────────────
// v2.6-DEBT-1 — ADMISSION REQUIRES POSITIVE EVIDENCE
//
// TRUTH-8 (probes 1–8 above) stopped a CONTRADICTED row being counted: the
// destination was known and was not a liability. It left the other half open.
// `classifyLiquidity` diverted a row only when the destination was KNOWN and NOT
// a liability, so an UNKNOWN destination fell through and was counted at
// confidence 1 — admission by ABSENCE OF CONTRADICTION, which is not evidence.
//
// Measured on the live corpus: no row was exploiting it (all 119 counted
// payments carry positive evidence — 101 with a nameable owned liability, 18
// with a proven liability destination TYPE). The fall-through was a standing
// hazard, not an active defect: any row with a provider-derived
// `flowType = DEBT_PAYMENT`, a liquid own account and no resolved counterparty
// would have been admitted on nothing at all. That is the shape that put a
// $4,000 savings transfer in the card in the first place.
//
// ⚠️ Attestation is MEMBERSHIP, never NAMING. A type-attested row whose account
// cannot be named IS a debt payment and stays counted, under "Debt account not
// determined". Conflating the two axes is what made a corpus report describe 18
// type-attested rows as "provider-asserted" — and that mislabel is what the
// $6,500 figure came from.
// ─────────────────────────────────────────────────────────────────────────────

const attestedRow = (o: Parameters<typeof row>[0] & { maturity?: string | null }) =>
  ({ ...row(o), transferMaturity: o.maturity ?? null }) as LiquidityTx;

const countedAsDebt = (t: LiquidityTx) => {
  const c = classifyLiquidity(t, TIERS);
  return c.effect === "CASH_OUT" && c.reason === "DEBT_PAYMENT";
};

test("9. provider classification alone can never admit a debt payment", () => {
  // Nothing but the stored category — no counterparty, no authority verdict.
  assert.equal(
    countedAsDebt(attestedRow({ id: "bare", own: "chk", amount: -500 })), false,
    "flowType alone admitted a row; it is a provider category derived from descriptor text",
  );
  assert.equal(isDebtPaymentAttested({ counterpartyTier: "unknown", transferMaturity: null }), false);
});

test("10. an UNRESOLVED transfer verdict cannot satisfy debt-payment admission", () => {
  for (const maturity of [
    "UNRESOLVED_TRANSFER", "CASH_MOVEMENT", "EXTERNAL_PERSON_TRANSFER",
    "SAVINGS_TRANSFER", "CASH_TRANSFER", "EXTERNAL_VENUE_TRANSFER",
    "EXTERNAL_DEPOSITORY_TRANSFER", "INTERNAL_TRANSFER",
  ]) {
    assert.equal(
      isDebtPaymentAttested({ counterpartyTier: "unknown", transferMaturity: maturity }), false,
      `${maturity} must not attest a liability destination`,
    );
    assert.equal(
      countedAsDebt(attestedRow({ id: `m_${maturity}`, own: "chk", amount: -500, maturity })), false,
      `a row the authority called ${maturity} was counted as a debt payment`,
    );
  }
});

test("11. every admitted debt payment is structurally attested", () => {
  // The two positive forms — and only these.
  assert.ok(countedAsDebt(attestedRow({ id: "named", own: "chk", amount: -500, cp: "chaseCard" })),
    "an owned liability counterparty must admit");
  assert.ok(countedAsDebt(attestedRow({ id: "typed", own: "chk", amount: -500, maturity: "DEBT_PAYMENT" })),
    "a proven liability destination TYPE must admit — an unnameable account is a NAMING limit, not a membership one");
  for (const tier of ["liquid", "asset", "unknown", null, undefined]) {
    assert.equal(isDebtPaymentAttested({ counterpartyTier: tier, transferMaturity: null }), false);
  }
  // The LIABILITY-side leg is untouched: its destination is the own account,
  // structurally certain, needing no counterparty evidence.
  const leg = classifyLiquidity(attestedRow({ id: "liab", own: "chaseCard", amount: 500 }), TIERS);
  assert.equal(leg.effect, "NEUTRAL");
  assert.equal(leg.reason, "DEBT_PAYMENT", "the liability leg keeps its meaning and stays uncounted");
});

test("12. descriptor and institution text cannot create a debt payment", () => {
  for (const merchant of [
    "PAYMENT TO CHASE CARD ENDING IN 0202", "AMERICAN EXPRESS ACH PMT",
    "CARD PAYMENT", "Mobile Payment - Thank You", "CREDIT CARD PAYMENT",
  ]) {
    const t = { ...attestedRow({ id: "d", own: "chk", amount: -500, maturity: "UNRESOLVED_TRANSFER" }), merchant } as LiquidityTx;
    assert.equal(countedAsDebt(t), false, `descriptor "${merchant}" admitted an unattested row`);
  }
});

test("13. no provider reclassification can reintroduce admission-by-silence", () => {
  // Every provider-supplied signal a future taxonomy change could alter. None
  // may admit a row the transfer authority has not attested.
  const shapes = [
    { pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD" },
    { pfcPrimary: "TRANSFER_OUT",  pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER" },
    { category: "Payment" }, { category: "Transfer" },
    { classificationReason: "CATEGORY_FLOW_VALUE", classificationConfidence: 1 },
    { classificationReason: "ACCOUNT_TYPE_CONTEXT", classificationConfidence: 1 },
  ];
  for (const shape of shapes) {
    const t = { ...attestedRow({ id: "p", own: "chk", amount: -500 }), ...shape } as LiquidityTx;
    assert.equal(countedAsDebt(t), false, `provider shape ${JSON.stringify(shape)} admitted an unattested row`);
  }
});
