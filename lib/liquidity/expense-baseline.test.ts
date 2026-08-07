/**
 * lib/liquidity/expense-baseline.test.ts
 *
 * v2.6-ASSESS-2 — one baseline authority, one precedence, and a stated basis.
 *
 * ── What it protects ────────────────────────────────────────────────────────
 *
 * "How many months of expenses does my cash cover?" divided by two different
 * numbers: the user's DECLARED figure (`emergency_fund_progress` config, which
 * the Liquidity workspace and the Overview EF hero use) and the MEASURED
 * reliable-month average (which `computeAssessment` used). Neither surface said
 * which, so a user could not reconcile them.
 *
 * Measured before this landed (scripts/audit-coverage-fraction-divergence.ts):
 * 0 Spaces declared a baseline, 6 had a measured one, and on Chris' Space the
 * product showed NO coverage while the engine told the AI "1.6 months" — a
 * WARNING-grade position the product never mentioned. The NUMERATORS agreed on
 * all 6 Spaces, so the denominator was the whole divergence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveExpenseBaseline, describeExpenseBaseline } from "@/lib/liquidity/expense-baseline";

test("ASSESS-2: a declared figure outranks a measured one", () => {
  // THE product decision, pinned so it is made once rather than differently on
  // each surface. A declaration is the user's explicit statement about their own
  // affairs; an average of complete months is our inference about it — the same
  // ordering `displayName` has over `officialName` in the account-identity
  // authority.
  const b = resolveExpenseBaseline({ declared: 4_000, measured: 5_494.09 });
  assert.equal(b?.amount, 4_000);
  assert.equal(b?.basis, "DECLARED");
});

test("ASSESS-2: the measured average answers when nothing is declared", () => {
  const b = resolveExpenseBaseline({ declared: null, measured: 5_494.09 });
  assert.equal(b?.amount, 5_494.09);
  assert.equal(b?.basis, "MEASURED");
});

test("ASSESS-2: a non-positive figure is a refusal at EVERY rung", () => {
  // v2.6-ASSESS-1: `computeAverageMonthlySpending` returns 0 for reliable months
  // with no spending, and dividing by it produced Infinity months graded
  // EXCELLENT at HIGH confidence on 5 of 9 Spaces. Zero is not a small baseline.
  assert.equal(resolveExpenseBaseline({ declared: 0, measured: 0 }), null);
  assert.equal(resolveExpenseBaseline({ measured: 0 }), null);
  assert.equal(resolveExpenseBaseline({ declared: 0 }), null);
  assert.equal(resolveExpenseBaseline({}), null);
  assert.equal(resolveExpenseBaseline({ declared: null, measured: null }), null);

  // A zero DECLARED figure must fall through to a usable measurement rather than
  // refusing outright — the user has not declared 0, they have declared nothing.
  const fellThrough = resolveExpenseBaseline({ declared: 0, measured: 2_000 });
  assert.equal(fellThrough?.amount, 2_000);
  assert.equal(fellThrough?.basis, "MEASURED");
});

test("ASSESS-2: non-finite input never becomes a baseline", () => {
  // `Number(config.monthlyExpenses)` is NaN for an unset or malformed config,
  // and Infinity is reachable from a bad edit. Neither may divide anything.
  assert.equal(resolveExpenseBaseline({ declared: NaN, measured: NaN }), null);
  assert.equal(resolveExpenseBaseline({ declared: Infinity }), null);
  assert.equal(resolveExpenseBaseline({ declared: -100, measured: -5 }), null);
  assert.equal(resolveExpenseBaseline({ declared: NaN, measured: 2_000 })?.basis, "MEASURED");
});

test("ASSESS-2: the description states which baseline was used", () => {
  const fmt = (n: number) => `$${n.toLocaleString("en-US")}`;
  const declared = describeExpenseBaseline({ amount: 4_000, basis: "DECLARED" }, fmt);
  const measured = describeExpenseBaseline({ amount: 5_494, basis: "MEASURED" }, fmt);

  assert.match(declared, /you set/, "a declared baseline must be attributed to the user");
  assert.match(measured, /average/, "a measured baseline must be attributed to the measurement");
  assert.notEqual(
    declared, measured,
    "the two bases must not read identically — indistinguishable wording is how " +
    "two baselines passed as one number in the first place",
  );
});
