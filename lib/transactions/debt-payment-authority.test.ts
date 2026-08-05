/**
 * lib/transactions/debt-payment-authority.test.ts   (V27-TRUTH-7)
 *
 * The one debt-payment total, and the double-count it makes impossible.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  selectDebtPaymentCashLegs, totalDebtPaid, COUNTED_DEBT_PAYMENT_LEG,
} from "./debt-payment-authority";
import { tierResolver, type LiquidityTx } from "./liquidity";

const TIERS = tierResolver([
  { id: "chk", type: "checking" },
  { id: "sav", type: "savings" },
  { id: "card", type: "debt" },
  { id: "brk", type: "investment" },
]);

const row = (o: Partial<LiquidityTx> & { own: string; amount: number }): LiquidityTx => ({
  id: `${o.own}:${o.amount}`, accountId: o.own, financialAccountId: o.own,
  counterpartyAccountId: o.counterpartyAccountId ?? null,
  amount: o.amount, flowType: o.flowType ?? "DEBT_PAYMENT", currency: "USD",
  date: "2026-06-01", merchant: "m", category: "Other", pending: false,
} as unknown as LiquidityTx);

const abs = (t: LiquidityTx) => Math.abs(t.amount);

// The two legs of ONE $300 card payment.
const CASH_LEG = row({ own: "chk", amount: -300, counterpartyAccountId: "card" });
const LIABILITY_LEG = row({ own: "card", amount: 300, counterpartyAccountId: "chk" });

test("the counted leg is named, not implied", () => {
  assert.equal(COUNTED_DEBT_PAYMENT_LEG, "CASH");
});

test("one payment counts once, however many legs you pass", () => {
  // The defect: lib/debt.ts abs-summed whatever it was handed, so this returned
  // $600 for a $300 payment.
  assert.equal(totalDebtPaid([CASH_LEG, LIABILITY_LEG], TIERS, abs).total, 300);
  assert.equal(totalDebtPaid([CASH_LEG], TIERS, abs).total, 300);
  assert.equal(totalDebtPaid([LIABILITY_LEG, CASH_LEG], TIERS, abs).total, 300);
});

test("passing ONLY the liability leg counts nothing, and says how much it skipped", () => {
  // Not a silent zero — the caller can see that 1 row of the other leg was there.
  const r = totalDebtPaid([LIABILITY_LEG], TIERS, abs);
  assert.equal(r.total, 0);
  assert.equal(r.count, 0);
  assert.equal(r.excludedLiabilityLegCount, 1);
});

test("selection is idempotent — re-selecting a counted set changes nothing", () => {
  const once = selectDebtPaymentCashLegs([CASH_LEG, LIABILITY_LEG], TIERS).counted;
  const twice = selectDebtPaymentCashLegs(once, TIERS).counted;
  assert.deepEqual(twice.map((r) => r.id), once.map((r) => r.id));
});

test("a payment toward an UNCONNECTED liability still counts", () => {
  // 26 live cash legs ($50,150) have no counterparty at all — the liability is
  // not connected here, so no liability leg exists. A liability-scoped total
  // cannot see them; this one must.
  const unconnected = row({ own: "chk", amount: -4000, counterpartyAccountId: null });
  const r = totalDebtPaid([unconnected], TIERS, abs);
  assert.equal(r.total, 4000);
  assert.equal(r.count, 1);
});

test("a savings transfer is never a debt payment", () => {
  // The $4,000 Amex HYSA row: TRANSFER, savings ← checking, both owned.
  const savingsIn = row({ own: "sav", amount: 4000, flowType: "TRANSFER", counterpartyAccountId: "chk" });
  const savingsOut = row({ own: "chk", amount: -4000, flowType: "TRANSFER", counterpartyAccountId: "sav" });
  const r = totalDebtPaid([savingsIn, savingsOut], TIERS, abs);
  assert.equal(r.total, 0);
  assert.equal(r.count, 0);
});

test("non-payment rows never enter the total", () => {
  const rows = [
    CASH_LEG,
    row({ own: "chk", amount: -55, flowType: "SPENDING" }),
    row({ own: "chk", amount: 900, flowType: "INCOME" }),
    row({ own: "brk", amount: -100, flowType: "TRANSFER", counterpartyAccountId: "chk" }),
  ];
  assert.equal(totalDebtPaid(rows, TIERS, abs).total, 300);
});

test("an unconvertible row is EXCLUDED and disclosed, never counted as zero", () => {
  // V25-FINAL-1 — a null magnitude means no acceptable FX rate.
  const other = row({ own: "chk", amount: -100, counterpartyAccountId: "card" });
  const r = totalDebtPaid([CASH_LEG, other], TIERS, (t) => (t.amount === -100 ? null : Math.abs(t.amount)));
  assert.equal(r.total, 300);
  assert.equal(r.count, 1);
  assert.equal(r.unconverted, true);
});

test("empty input is zero, and honest about it", () => {
  const r = totalDebtPaid([], TIERS, abs);
  assert.deepEqual(r, { total: 0, count: 0, excludedLiabilityLegCount: 0, unconverted: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// Standing probe
// ─────────────────────────────────────────────────────────────────────────────

test("nothing outside the authority selects debt-payment rows itself", () => {
  // Four surfaces each carried their own copy of this predicate, and two of them
  // disagreed by $6,000. One authority, or the divergence comes back.
  const ALLOWED = new Set([
    "lib/transactions/debt-payment-authority.ts",
    "lib/transactions/liquidity.ts",
    "lib/transactions/liquidity-breakdown.ts",
    // The calendar measure registry. Its `debtPayments` entry is one row in a
    // uniform table of eight measures, all expressed through the same generic
    // `reasonIs` helper, which reads classifyLiquidity. It selects the SAME leg
    // (CASH_OUT), so it agrees with the authority by construction rather than by
    // coincidence — a vocabulary projection, not a competing predicate.
    "lib/transactions/cash-flow-projection.ts",
  ]);
  const walk = (d: string, out: string[] = []): string[] => {
    let entries: string[] = [];
    try { entries = readdirSync(join(process.cwd(), d)); } catch { return out; }
    for (const e of entries) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const rel = `${d}/${e}`;
      if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out);
      else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(rel);
    }
    return out;
  };
  const offenders = ["lib", "app", "components", "jobs"].flatMap((r) => walk(r))
    .filter((f) => !f.startsWith("prototype/") && !ALLOWED.has(f))
    .filter((f) => {
      const code = readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
      // The shape every duplicate had: a CASH_OUT + DEBT_PAYMENT pair test.
      return /CASH_OUT[\s\S]{0,80}DEBT_PAYMENT/.test(code);
    });
  assert.deepEqual(offenders, [], "these modules re-derive debt-payment membership instead of using the authority");
});
