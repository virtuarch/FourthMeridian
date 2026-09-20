/**
 * lib/debt/payoff.test.ts
 *
 * Standalone tsx guard (house convention: exit 0/1).
 *
 *   npx tsx lib/debt/payoff.test.ts
 *
 * Pins the payoff-timing authority. Expected values are derived INDEPENDENTLY
 * in each block (hand arithmetic over the stated day counts), never by calling
 * the engine twice — a test that re-runs the implementation pins nothing.
 *
 * Every schedule starts 2026-01-01: Jan = 31 days, Feb = 28, Mar = 31, Apr = 30.
 */

import { planPayoff, accruedInterest, DEFAULT_PAYOFF_PAYMENT, PAYOFF_CADENCE, MAX_PAYOFF_PAYMENTS } from "./payoff";
import { computeInterestCost, estimatedMonthlyInterest } from "./interest-cost";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const START = "2026-01-01";
const paid = (p: ReturnType<typeof planPayoff>) => (p.status === "paid_off" ? p : null);

console.log("0. Contract constants");
check("default payment is 50", DEFAULT_PAYOFF_PAYMENT === 50);
check("one cadence: monthly", PAYOFF_CADENCE === "monthly");

console.log("1. ZERO APR — final partial payment lands inside the month");
{
  // 1174 at 500/mo: full payments on 02-01 and 03-01 leave 174. March has 31
  // days; the budget covers 174 on the first d with 500·d/31 ≥ 174 ⇒ d ≥ 10.788 ⇒ 11.
  const p = paid(planPayoff({ balance: 1174, aprPct: 0, payment: 500, startISO: START }));
  check("paid off", p !== null);
  check("two full payments", p?.fullPayments === 2, `${p?.fullPayments}`);
  check("final payment is 174.00", p?.finalPayment === 174, `${p?.finalPayment}`);
  check("final payment is partial", p?.finalPaymentIsPartial === true);
  check("final payment on day 11 of its month", p?.finalPaymentDay === 11, `${p?.finalPaymentDay}`);
  check("payoff date 2026-03-12", p?.payoffISO === "2026-03-12", p?.payoffISO);
  check("elapsed 2 months, 1 week, 4 days",
    p?.elapsed.totalMonths === 2 && p?.elapsed.weeks === 1 && p?.elapsed.days === 4, JSON.stringify(p?.elapsed));
  check("label reads the non-zero parts", p?.elapsed.label === "2 months, 1 week, 4 days", p?.elapsed.label);
  check("totalDays is the calendar distance (31+28+11)", p?.elapsed.totalDays === 70, `${p?.elapsed.totalDays}`);
  check("no interest at 0%", p?.totalInterest === 0 && p?.totalPaid === 1174, `${p?.totalInterest} / ${p?.totalPaid}`);
  check("NOT the coarse '3 months'", p?.elapsed.totalMonths !== 3);
}

console.log("2. NONZERO APR — interest changes the schedule and the final payment");
{
  // 1174 at 24%, 500/mo.
  //   Jan (31d): interest round2(1174 × .24 × 31/365) = 23.93 → 1197.93 − 500 = 697.93
  //   Feb (28d): interest round2(697.93 × .24 × 28/365) = 12.85 → 710.78 − 500 = 210.78
  //   Mar (31d): first d with 500·d/31 ≥ 210.78 + round2(210.78 × .24 × d/365)
  //     d=13: budget 209.68 < 212.58 ; d=14: budget 225.81 ≥ 210.78 + 1.94 = 212.72
  const jan = Math.round(1174 * 0.24 * 31 / 365 * 100) / 100;
  const b1 = Math.round((1174 + jan - 500) * 100) / 100;
  const feb = Math.round(b1 * 0.24 * 28 / 365 * 100) / 100;
  const b2 = Math.round((b1 + feb - 500) * 100) / 100;
  const last = Math.round(b2 * 0.24 * 14 / 365 * 100) / 100;
  check("hand arithmetic: 23.93 / 697.93 / 12.85 / 210.78 / 1.94",
    jan === 23.93 && b1 === 697.93 && feb === 12.85 && b2 === 210.78 && last === 1.94,
    `${jan} ${b1} ${feb} ${b2} ${last}`);

  const p = paid(planPayoff({ balance: 1174, aprPct: 24, payment: 500, startISO: START }));
  check("two full payments", p?.fullPayments === 2);
  check("final payment 212.72", p?.finalPayment === 212.72, `${p?.finalPayment}`);
  check("final payment on day 14 ⇒ 2026-03-15", p?.finalPaymentDay === 14 && p?.payoffISO === "2026-03-15", `${p?.finalPaymentDay} ${p?.payoffISO}`);
  check("elapsed 2 months, 2 weeks", p?.elapsed.label === "2 months, 2 weeks", p?.elapsed.label);
  check("total interest 23.93 + 12.85 + 1.94 = 38.72", p?.totalInterest === 38.72, `${p?.totalInterest}`);
  check("total paid = principal + interest", p?.totalPaid === 1212.72, `${p?.totalPaid}`);
  const zero = paid(planPayoff({ balance: 1174, aprPct: 0, payment: 500, startISO: START }));
  check("interest pushed the payoff date later than 0%", (p?.payoffISO ?? "") > (zero?.payoffISO ?? "z"));
  check("interest raised the final payment above 0%'s", (p?.finalPayment ?? 0) > (zero?.finalPayment ?? Infinity));
}

console.log("3. BALANCE SMALLER THAN ONE PAYMENT");
{
  // 300 at 500/mo, 0%: first d with 500·d/31 ≥ 300 ⇒ d ≥ 18.6 ⇒ 19.
  const p = paid(planPayoff({ balance: 300, aprPct: 0, payment: 500, startISO: START }));
  check("no full payments", p?.fullPayments === 0);
  check("one payment of exactly the balance", p?.finalPayment === 300 && p?.paymentCount === 1);
  check("cleared on day 19, not 'in 1 month'", p?.finalPaymentDay === 19 && p?.payoffISO === "2026-01-20", `${p?.finalPaymentDay} ${p?.payoffISO}`);
  check("elapsed 2 weeks, 5 days", p?.elapsed.label === "2 weeks, 5 days" && p?.elapsed.totalMonths === 0, p?.elapsed.label);
}

console.log("4. EXACT-PAYMENT BOUNDARY");
{
  const p = paid(planPayoff({ balance: 1000, aprPct: 0, payment: 500, startISO: START }));
  check("one full payment, then a full final payment", p?.fullPayments === 1 && p?.finalPayment === 500);
  check("final payment is NOT partial", p?.finalPaymentIsPartial === false);
  check("ends exactly on the month boundary", p?.payoffISO === "2026-03-01", p?.payoffISO);
  check("elapsed is exactly 2 months — no stray week or day", p?.elapsed.label === "2 months" && p?.elapsed.weeks === 0 && p?.elapsed.days === 0, p?.elapsed.label);
  const one = paid(planPayoff({ balance: 500, aprPct: 0, payment: 500, startISO: START }));
  check("balance == payment ⇒ exactly 1 month, one full payment", one?.elapsed.label === "1 month" && one?.finalPayment === 500 && one?.fullPayments === 0, one?.elapsed.label);
}

console.log("5. VERY SMALL PAYMENT");
{
  // 100 at 5/mo, 0% ⇒ exactly 20 months.
  const p = paid(planPayoff({ balance: 100, aprPct: 0, payment: 5, startISO: START }));
  check("amortizes: 19 full + a full final", p?.fullPayments === 19 && p?.finalPayment === 5);
  check("elapsed 1 year, 8 months", p?.elapsed.label === "1 year, 8 months" && p?.elapsed.totalMonths === 20, p?.elapsed.label);
  check("payoff 2027-09-01", p?.payoffISO === "2027-09-01", p?.payoffISO);
  // 5000 at 1/mo, 0% ⇒ 5000 payments: real, but past any useful horizon.
  const far = planPayoff({ balance: 5000, aprPct: 0, payment: 1, startISO: START });
  check("beyond the horizon ⇒ named status, no date", far.status === "beyond_horizon" && !("payoffISO" in far));
  check("horizon is the exported ceiling", far.status === "beyond_horizon" && far.maxPayments === MAX_PAYOFF_PAYMENTS);
}

console.log("6. NON-AMORTIZING — interest equals or exceeds the payment");
{
  // 10,000 at 24%: a 31-day month accrues 203.84; 28 days accrues 184.11.
  check("hand: Jan interest on 10,000 @ 24% = 203.84", accruedInterest(10000, 24, 31) === 203.84);
  const under = planPayoff({ balance: 10000, aprPct: 24, payment: 150, startISO: START });
  check("payment below interest ⇒ non_amortizing", under.status === "non_amortizing");
  check("reports the first period's interest, no date", under.status === "non_amortizing" && under.firstPeriodInterest === 203.84 && !("payoffISO" in under));
  // Exactly the yearly interest spread over 12 payments: 10,000 × 24% / 12 = 200.
  const equal = planPayoff({ balance: 10000, aprPct: 24, payment: 200, startISO: START });
  check("payment EQUAL to the interest run-rate ⇒ non_amortizing", equal.status === "non_amortizing", equal.status);
  const over = planPayoff({ balance: 10000, aprPct: 24, payment: 400, startISO: START });
  check("a payment that clears interest amortizes", over.status === "paid_off");
}

console.log("7. UNKNOWN APR — never read as 0%");
{
  const u = planPayoff({ balance: 1174, aprPct: null, payment: 500, startISO: START });
  check("status unknown_apr", u.status === "unknown_apr");
  check("no timeline, no final payment fabricated", !("payoffISO" in u) && !("finalPayment" in u) && !("elapsed" in u));
  check("explicit 0 IS a rate", planPayoff({ balance: 1174, aprPct: 0, payment: 500, startISO: START }).status === "paid_off");
}

console.log("8. Refusals");
{
  check("nothing owed", planPayoff({ balance: 0, aprPct: 10, payment: 50, startISO: START }).status === "nothing_owed");
  check("an issuer credit owes nothing", planPayoff({ balance: -124.04, aprPct: 10, payment: 50, startISO: START }).status === "nothing_owed");
  check("zero payment is invalid", planPayoff({ balance: 100, aprPct: 10, payment: 0, startISO: START }).status === "invalid_input");
  check("negative APR is invalid", planPayoff({ balance: 100, aprPct: -1, payment: 50, startISO: START }).status === "invalid_input");
  check("NaN payment is invalid", planPayoff({ balance: 100, aprPct: 10, payment: NaN, startISO: START }).status === "invalid_input");
  check("malformed start date is invalid", planPayoff({ balance: 100, aprPct: 10, payment: 50, startISO: "soon" }).status === "invalid_input");
}

console.log("9. Determinism + month-end anchoring");
{
  const a = JSON.stringify(planPayoff({ balance: 4321.09, aprPct: 19.99, payment: 275, startISO: "2026-01-31" }));
  const b = JSON.stringify(planPayoff({ balance: 4321.09, aprPct: 19.99, payment: 275, startISO: "2026-01-31" }));
  check("same input ⇒ byte-identical plan", a === b);
  // Jan-31 anchor: anniversaries are 02-28, 03-31, 04-30 … never drifting to the 28th.
  const p = paid(planPayoff({ balance: 1500, aprPct: 0, payment: 500, startISO: "2026-01-31" }));
  check("Jan-31 start, 3 exact payments ⇒ ends 2026-04-30 (not 04-28)", p?.payoffISO === "2026-04-30", p?.payoffISO);
}

console.log("10. INTEREST COST — one authority, unknown stays unknown");
{
  check("1200 @ 24% ⇒ 24.00/mo", estimatedMonthlyInterest(1200, 24) === 24);
  check("unknown APR ⇒ null, never 0", estimatedMonthlyInterest(1200, null) === null && estimatedMonthlyInterest(1200, undefined) === null);
  check("explicit 0% ⇒ 0, a known figure", estimatedMonthlyInterest(1200, 0) === 0);
  check("a credit balance accrues nothing", estimatedMonthlyInterest(-50, 24) === 0);

  const before = computeInterestCost([
    { id: "a", balance: 1200, aprPct: 24 },
    { id: "b", balance: 600, aprPct: null },
    { id: "c", balance: 0, aprPct: null },      // settled — not "unknown"
    { id: "d", balance: 300, aprPct: 0 },       // 0% promo — known
  ]);
  check("every OWING row is listed, rated or not", before.rows.map((r) => r.id).join() === "a,d,b", before.rows.map((r) => r.id).join());
  check("unknown row has a null figure", before.rows.find((r) => r.id === "b")?.monthly === null);
  check("total excludes the unknown row", before.totalMonthly === 24, `${before.totalMonthly}`);
  check("unknownCount counts only owing, unrated rows", before.unknownCount === 1, `${before.unknownCount}`);

  // The user supplies b's APR ⇒ the cost moves, and nothing is unknown any more.
  const after = computeInterestCost([
    { id: "a", balance: 1200, aprPct: 24 },
    { id: "b", balance: 600, aprPct: 18 },
    { id: "d", balance: 300, aprPct: 0 },
  ]);
  check("an APR edit changes the interest cost (24 → 33)", after.totalMonthly === 33 && after.unknownCount === 0, `${after.totalMonthly}`);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
