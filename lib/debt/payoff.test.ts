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

import { planPayoff, accruedInterest, allocateProRata, DEFAULT_PAYOFF_PAYMENT, PAYOFF_CADENCE, MAX_PAYOFF_PAYMENTS } from "./payoff";
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

console.log("7. UNKNOWN APR — a principal-only ESTIMATE; UNKNOWN is still not 0%");
{
  // SUPERSEDES the earlier rule ("unknown APR ⇒ no timeline"). A missing APR does
  // not block the schedule; it changes what the schedule is allowed to CLAIM.
  const u = paid(planPayoff({ balance: 1174, aprPct: null, payment: 500, startISO: START }));
  check("one debt, unknown APR ⇒ a payoff estimate IS returned", u !== null);
  check("basis is PRINCIPAL_ONLY", u?.basis.interest === "PRINCIPAL_ONLY", u?.basis.interest);
  check("the APR stays UNKNOWN on the liability: aprPct null, basis ASSUMED_ZERO_UNKNOWN_APR — not 0",
    u?.liabilities[0].aprPct === null && u?.liabilities[0].interestBasis === "ASSUMED_ZERO_UNKNOWN_APR" && u?.basis.avgKnownAprPct === null);
  check("the zero it used is recorded as an ESTIMATION ASSUMPTION, not a rate",
    u?.basis.unknownAprAssumption?.aprPct === 0 && u?.basis.unknownAprAssumption?.provenance === "ESTIMATION_ASSUMPTION");
  check("the whole balance is reported as unknown-APR", u?.basis.unknownAprBalance === 1174 && u?.basis.knownAprBalance === 0);
  check("the final PARTIAL payment still works under principal-only (174.00 on day 11 ⇒ 2026-03-12)",
    u?.finalPayment === 174 && u?.finalPaymentIsPartial === true && u?.finalPaymentDay === 11 && u?.payoffISO === "2026-03-12",
    `${u?.finalPayment} ${u?.finalPaymentDay} ${u?.payoffISO}`);
  check("no interest is CLAIMED (0 modelled — the basis says why)", u?.totalInterest === 0 && u?.totalPaid === 1174);

  // KNOWN 0% vs UNKNOWN: the same dates, never the same evidence.
  const z = paid(planPayoff({ balance: 1174, aprPct: 0, payment: 500, startISO: START }));
  check("known 0% is INTEREST_AWARE", z?.basis.interest === "INTEREST_AWARE");
  check("known 0% is KNOWN_APR with aprPct 0 and NO assumption",
    z?.liabilities[0].aprPct === 0 && z?.liabilities[0].interestBasis === "KNOWN_APR" && z?.basis.unknownAprAssumption === null);
  check("…the two schedules coincide", z?.payoffISO === u?.payoffISO && z?.finalPayment === u?.finalPayment);
  check("…and are still distinguishable by structure alone", JSON.stringify(z?.basis) !== JSON.stringify(u?.basis));

  const k = paid(planPayoff({ balance: 1174, aprPct: 24, payment: 500, startISO: START }));
  check("known nonzero APR stays INTEREST_AWARE and unchanged (212.72 on 2026-03-15)",
    k?.basis.interest === "INTEREST_AWARE" && k?.liabilities[0].aprPct === 24 && k?.finalPayment === 212.72 && k?.payoffISO === "2026-03-15");
  check("adding the APR upgrades the SAME calculation: later date, larger final payment, no assumption",
    (k?.payoffISO ?? "") > (u?.payoffISO ?? "z") && (k?.finalPayment ?? 0) > (u?.finalPayment ?? Infinity) && k?.basis.unknownAprAssumption === null);
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const CARD_A = { id: "a", label: "Card A", balance: 600, aprPct: 24 };
const CARD_B = { id: "b", label: "Card B", balance: 600, aprPct: 12 };
const CARD_U = { id: "u", label: "Card U", balance: 600, aprPct: null };

console.log("7a. PER LIABILITY — a partial payment lowers THAT liability's next interest");
{
  // 1,174 @ 24%, 500/mo. January accrues on 1,174.00; after the 500 payment the
  // balance is 697.93, and February accrues on THAT — not on the opening balance.
  const p = paid(planPayoff({ balance: 1174, aprPct: 24, payment: 500, startISO: START }))!;
  const [jan, feb] = p.payments;
  check("Jan: 23.93 interest, 500.00 paid = 23.93 to interest + 476.07 to principal, 697.93 left",
    jan.allocations[0].interest === 23.93 && jan.allocations[0].paid === 500 && jan.allocations[0].toInterest === 23.93
      && jan.allocations[0].toPrincipal === 476.07 && jan.allocations[0].balanceAfter === 697.93, JSON.stringify(jan.allocations[0]));
  check("Feb interest is on the REDUCED balance: round2(697.93 × .24 × 28/365) = 12.85", feb.allocations[0].interest === 12.85);
  // The same February WITHOUT January's 500 would have accrued on 1,197.93.
  const withoutPayment = accruedInterest(r2(1174 + 23.93), 24, 28);
  // 1,197.93 × .24 × 28/365 = 22.0550… → 22.06.
  check("…which is lower than the 22.06 it would have accrued had the 500 not been paid", withoutPayment === 22.06 && feb.allocations[0].interest < withoutPayment, `${withoutPayment}`);
  check("after one payment: 476.07 of 1,174 principal paid, 697.93 remaining (the partial-payment view)",
    r2(1174 - jan.allocations[0].toPrincipal) === 697.93);
  check("every allocation carries its reason", p.payments.every((pm) => pm.allocations.every((a) => a.reason === "PRO_RATA_BY_BALANCE" || a.reason === "FINAL_SETTLEMENT"))
    && p.payments[p.payments.length - 1].allocations[0].reason === "FINAL_SETTLEMENT");
  check("paid-off liability: principalPaid = starting principal, interestPaid = every cent modelled, 0 remaining",
    p.liabilities[0].principalPaid === 1174 && p.liabilities[0].interestPaid === 38.72 && p.liabilities[0].remainingBalance === 0);
}

console.log("7b. TWO CARDS, DIFFERENT APRs — independent accrual, NOT one 1,200 debt at 18%");
{
  // A 600 @ 24%, B 600 @ 12%, 500/mo, pro rata by balance (largest remainder):
  //   Jan (31d): iA 12.23, iB 6.12 → 612.23 / 606.12 → shares 251.25 / 248.75 → 360.98 / 357.37
  //   Feb (28d): iA  6.65, iB 3.29 → 367.63 / 360.66 → shares 252.39 / 247.61 → 115.24 / 113.05
  //   Mar: first d with 500·d/31 ≥ (115.24+iA(d)) + (113.05+iB(d)) is 15 → 116.38 + 113.61 = 229.99
  const p = paid(planPayoff({ liabilities: [CARD_A, CARD_B], payment: 500, startISO: START }))!;
  const at = (k: number, id: string) => p.payments[k].allocations.find((x) => x.id === id)!;
  check("Jan: each card accrues at ITS OWN rate (12.23 vs 6.12)", at(0, "a").interest === 12.23 && at(0, "b").interest === 6.12);
  check("Jan: 500 split pro rata by balance → 251.25 / 248.75", at(0, "a").paid === 251.25 && at(0, "b").paid === 248.75);
  check("Jan: independent balances afterwards → 360.98 / 357.37", at(0, "a").balanceAfter === 360.98 && at(0, "b").balanceAfter === 357.37);
  check("Feb: interest follows each card's own reduced balance (6.65 / 3.29)", at(1, "a").interest === 6.65 && at(1, "b").interest === 3.29);
  check("Feb: shares 252.39 / 247.61 → 115.24 / 113.05", at(1, "a").paid === 252.39 && at(1, "b").paid === 247.61 && at(1, "a").balanceAfter === 115.24 && at(1, "b").balanceAfter === 113.05);
  check("final settlement day 15 (2026-03-16): A 116.38 + B 113.61 = 229.99", p.finalPaymentDay === 15 && p.payoffISO === "2026-03-16"
    && at(2, "a").paid === 116.38 && at(2, "b").paid === 113.61 && p.finalPayment === 229.99);
  const A = p.liabilities.find((l) => l.id === "a")!, B = p.liabilities.find((l) => l.id === "b")!;
  check("per-card interest: A 20.02 (12.23+6.65+1.14), B 9.97 (6.12+3.29+0.56)", A.interestPaid === 20.02 && B.interestPaid === 9.97, `${A.interestPaid} ${B.interestPaid}`);
  check("each card keeps its own APR in the result", A.aprPct === 24 && B.aprPct === 12);

  // THE TEST A BLENDED ENGINE FAILS: one 1,200 balance at the 18% blend accrues
  // 18.35 + 9.92 + 1.69 = 29.96 and closes at 229.96. Per liability it is 29.99 / 229.99.
  const blended = paid(planPayoff({ balance: 1200, aprPct: 18, payment: 500, startISO: START }))!;
  check("the blended figure really is 29.96 / 229.96 (so this test can tell them apart)", blended.totalInterest === 29.96 && blended.finalPayment === 229.96);
  check("per-liability total interest is 29.99 — NOT the blended 29.96", p.totalInterest === 29.99 && p.totalInterest !== blended.totalInterest, `${p.totalInterest}`);
  check("the average is DESCRIPTIVE only: avgKnownAprPct 18, and it drove nothing", p.basis.avgKnownAprPct === 18);
  // The gap is structural, not rounding: it widens as the high-rate card's share grows.
  const slow  = paid(planPayoff({ liabilities: [{ ...CARD_A, balance: 6000 }, { ...CARD_B, balance: 6000 }], payment: 300, startISO: START }))!;
  const slowB = paid(planPayoff({ balance: 12000, aprPct: 18, payment: 300, startISO: START }))!;
  check("over a long schedule the blend UNDER-counts interest by dollars, not cents", slow.totalInterest - slowB.totalInterest > 25,
    `${slow.totalInterest} vs ${slowB.totalInterest}`);

  console.log("   conservation + aggregation");
  const sum = (f: (l: typeof A) => number) => r2(p.liabilities.reduce((t, l) => t + f(l), 0));
  check("aggregate principal / interest / total paid are SUMS of the liability schedules",
    p.principal === sum((l) => l.startingPrincipal) && p.totalInterest === sum((l) => l.interestPaid) && p.totalPaid === sum((l) => l.totalPaid));
  check("per liability: principalPaid + interestPaid = totalPaid, and principalPaid = starting principal",
    p.liabilities.every((l) => r2(l.principalPaid + l.interestPaid) === l.totalPaid && l.principalPaid === l.startingPrincipal));
  check("Σ settlements = total paid; every settlement ≤ the budget", r2(p.payments.reduce((t, pm) => t + pm.paid, 0)) === p.totalPaid && p.payments.every((pm) => pm.paid <= 500 + 1e-9));
  check("per settlement: Σ allocations = paid, and toInterest + toPrincipal = paid",
    p.payments.every((pm) => r2(pm.allocations.reduce((t, a) => t + a.paid, 0)) === pm.paid && pm.allocations.every((a) => r2(a.toInterest + a.toPrincipal) === a.paid)));
  check("no balance is ever negative", p.payments.every((pm) => pm.allocations.every((a) => a.balanceAfter >= 0)) && p.liabilities.every((l) => l.remainingBalance === 0));
}

console.log("7c. KNOWN + UNKNOWN — no APR leakage between liabilities");
{
  //   Jan: iA 12.23, iU 0 → 612.23 / 600.00 → shares 252.52 / 247.48 → 359.71 / 352.52
  //   Feb: iA  6.62, iU 0 → 366.33 / 352.52 → shares 254.80 / 245.20 → 111.53 / 107.32
  //   Mar: day 14 → A 111.53 + 1.03 = 112.56, U 107.32 → 219.88
  const m = paid(planPayoff({ liabilities: [CARD_A, CARD_U], payment: 500, startISO: START }))!;
  const U = m.liabilities.find((l) => l.id === "u")!, A = m.liabilities.find((l) => l.id === "a")!;
  check("basis is PARTIAL_INTEREST — not described as interest-aware", m.basis.interest === "PARTIAL_INTEREST");
  check("basis names the unknown liability and splits 600 / 600", m.basis.unknownAprLiabilityIds.join() === "u" && m.basis.knownAprBalance === 600 && m.basis.unknownAprBalance === 600);
  check("Card U accrued NO interest in ANY settlement — it never inherited Card A's 24%",
    m.payments.every((pm) => pm.allocations.find((x) => x.id === "u")!.interest === 0) && U.interestPaid === 0 && U.totalPaid === 600);
  check("Card U is still UNKNOWN in the result (aprPct null, assumption labelled)", U.aprPct === null && U.interestBasis === "ASSUMED_ZERO_UNKNOWN_APR");
  check("Card A accrued at its own 24%: 12.23 + 6.62 + 1.03 = 19.88", A.interestPaid === 19.88 && A.aprPct === 24 && A.interestBasis === "KNOWN_APR", `${A.interestPaid}`);
  check("final settlement 219.88 on day 14 (2026-03-15)", m.finalPayment === 219.88 && m.payoffISO === "2026-03-15", `${m.finalPayment} ${m.payoffISO}`);
  check("the descriptive average covers the KNOWN card only (24), never the unknown one", m.basis.avgKnownAprPct === 24);

  // Supplying the missing APR (12%) ⇒ the two-card INTEREST_AWARE schedule of 7b.
  const done = paid(planPayoff({ liabilities: [CARD_A, { ...CARD_U, aprPct: 12 }], payment: 500, startISO: START }))!;
  check("adding the APR ⇒ INTEREST_AWARE, qualification gone, interest now 29.99",
    done.basis.interest === "INTEREST_AWARE" && done.basis.unknownAprAssumption === null && done.totalInterest === 29.99);
  const na = planPayoff({ liabilities: [{ ...CARD_A, balance: 10000 }, CARD_U], payment: 100, startISO: START });
  check("a refusal that ran a schedule still reports its basis", na.status === "non_amortizing" && na.basis.interest === "PARTIAL_INTEREST");
}

console.log("7d. PAYMENT BUDGET larger than the debt needs — clamp, report, never overpay");
{
  /** Ending balance DERIVED from the result: what was owed + interest − what was paid. */
  const ending = (p: NonNullable<ReturnType<typeof paid>>) => r2(p.principal + p.totalInterest - p.totalPaid);

  // A. KNOWN 0% — 1,174 owed, 2,000 budget. First d with 2000·d/31 ≥ 1174 is 19.
  const a = paid(planPayoff({ balance: 1174, aprPct: 0, payment: 2000, startISO: START }))!;
  check("A: actual total paid is 1,174 — not 2,000", a.totalPaid === 1174 && a.finalPayment === 1174, `${a.totalPaid}`);
  check("A: unused payment capacity is 826; the budget is reported as asked (2,000)", a.unusedPaymentCapacity === 826 && a.paymentBudget === 2000);
  check("A: ending balance 0 — not negative; remainingBalance 0", ending(a) === 0 && a.liabilities[0].remainingBalance === 0);
  check("A: the first payment extinguishes it and the schedule STOPS", a.paymentCount === 1 && a.fullPayments === 0 && a.payments.length === 1 && a.liabilities[0].paidOffWithFirstPayment);
  check("A: 1,174 of 1,174 principal paid, 0.00 modelled interest", a.liabilities[0].principalPaid === 1174 && a.liabilities[0].interestPaid === 0);
  check("A: paid on day 19 (2026-01-20), INTEREST_AWARE", a.finalPaymentDay === 19 && a.payoffISO === "2026-01-20" && a.basis.interest === "INTEREST_AWARE");
  check("J: budget = actual + unused, so unused is never inside total paid", r2(a.totalPaid + a.unusedPaymentCapacity) === a.paymentBudget);

  // B. KNOWN POSITIVE APR — the comparison is the MODELLED requirement, not principal.
  //    d=18: 1161.29 < 1174 + 13.89; d=19: 1225.81 ≥ 1174 + 14.67.
  check("B: hand arithmetic — requirement on day 19 is 1,188.67", r2(1174 + r2(1174 * 0.24 * 19 / 365)) === 1188.67);
  const b = paid(planPayoff({ balance: 1174, aprPct: 24, payment: 2000, startISO: START }))!;
  check("B: actual payment clamps to the deterministic requirement 1,188.67", b.finalPayment === 1188.67 && b.totalPaid === 1188.67, `${b.finalPayment}`);
  check("B: principal and interest are separate: 1,174.00 + 14.67", b.liabilities[0].principalPaid === 1174 && b.liabilities[0].interestPaid === 14.67);
  check("B: unused is measured against the requirement: 811.33 (not 826)", b.unusedPaymentCapacity === 811.33, `${b.unusedPaymentCapacity}`);
  check("B: excess excluded from total paid; ending balance 0", r2(b.totalPaid + b.unusedPaymentCapacity) === 2000 && ending(b) === 0);
  const near = paid(planPayoff({ balance: 1174, aprPct: 24, payment: 1180, startISO: START }))!;
  check("B: budget > principal but < modelled requirement (1,197.93) ⇒ two payments, NO unused capacity",
    near.paymentCount === 2 && near.unusedPaymentCapacity === 0, `${near.paymentCount} ${near.unusedPaymentCapacity}`);

  // C. UNKNOWN APR.
  const c = paid(planPayoff({ balance: 1174, aprPct: null, payment: 2000, startISO: START }))!;
  check("C: payoff still returned, unused capacity 826 reported", c.totalPaid === 1174 && c.unusedPaymentCapacity === 826);
  check("C: PRINCIPAL_ONLY, the APR still null — not converted to 0%",
    c.basis.interest === "PRINCIPAL_ONLY" && c.liabilities[0].aprPct === null && c.basis.unknownAprAssumption?.provenance === "ESTIMATION_ASSUMPTION");
  check("C: same money as known-0% (A), different evidence", c.totalPaid === a.totalPaid && c.basis.interest !== a.basis.interest);

  // Capacity greater than ONE card's payoff but not all debt: nobody is overpaid,
  // nothing is spare, and the schedule is an ordinary one.
  const one = paid(planPayoff({ liabilities: [{ id: "s", balance: 1174, aprPct: 0 }, { id: "big", balance: 5000, aprPct: 0 }], payment: 2000, startISO: START }))!;
  check("budget > one card (1,174) but < all debt (6,174): no card receives more than it owes, no unused capacity",
    one.unusedPaymentCapacity === 0 && one.paymentCount > 1 && one.payments.every((pm) => pm.allocations.every((x) => x.balanceAfter >= 0))
      && one.liabilities.every((l) => l.totalPaid === l.startingPrincipal), JSON.stringify(one.liabilities.map((l) => l.totalPaid)));

  // Capacity greater than ALL debt — two cards. Day 19: A 607.50 + B 603.75 = 1,211.25.
  const all = paid(planPayoff({ liabilities: [CARD_A, CARD_B], payment: 2000, startISO: START }))!;
  check("budget > ALL debt: each card gets exactly its own requirement (607.50 / 603.75), 788.75 spare",
    all.liabilities[0].totalPaid === 607.5 && all.liabilities[1].totalPaid === 603.75 && all.totalPaid === 1211.25 && all.unusedPaymentCapacity === 788.75,
    `${all.liabilities.map((l) => l.totalPaid).join()} ${all.unusedPaymentCapacity}`);
  check("…both 'paid off with one payment'", all.liabilities.every((l) => l.paidOffWithFirstPayment && l.paymentCount === 1));

  // D. MIXED — day 19: A 600 + 7.50, U 600 + 0.
  const d = paid(planPayoff({ liabilities: [CARD_A, CARD_U], payment: 2000, startISO: START }))!;
  check("D: clamps to 1,207.50, unused 792.50, one payment", d.totalPaid === 1207.5 && d.unusedPaymentCapacity === 792.5 && d.paymentCount === 1);
  check("D: PARTIAL_INTEREST retained; the unknown card paid exactly 600.00 (no inherited interest)",
    d.basis.interest === "PARTIAL_INTEREST" && d.liabilities.find((l) => l.id === "u")!.totalPaid === 600 && d.totalInterest === 7.5);

  // E. EXACT.
  const e = paid(planPayoff({ balance: 500, aprPct: 0, payment: 500, startISO: START }))!;
  check("E: exact payment ⇒ one payment, unused capacity 0", e.paymentCount === 1 && e.finalPayment === 500 && e.unusedPaymentCapacity === 0);

  // F / G.
  const f = paid(planPayoff({ balance: 1174, aprPct: 24, payment: 500, startISO: START }))!;
  check("F: 500 budget ⇒ unchanged schedule (2 full + 212.72 on 2026-03-15), 38.72 interest",
    f.fullPayments === 2 && f.finalPayment === 212.72 && f.payoffISO === "2026-03-15" && f.totalInterest === 38.72 && f.totalPaid === 1212.72);
  check("G: a smaller LAST payment is a final partial payment — NOT unused capacity", f.finalPaymentIsPartial && f.unusedPaymentCapacity === 0);

  check("H: the default payment is still 50", DEFAULT_PAYOFF_PAYMENT === 50);

  // I / J. SWEEP — one and two liabilities, every rate/evidence/budget combination.
  let worst = "", n = 0;
  for (const balance of [0.01, 49.99, 50, 1174, 9999.99])
    for (const aprPct of [null, 0, 9.9, 29.99])
      for (const second of [null, { id: "x", balance: 333.33, aprPct: 17.5 }, { id: "x", balance: 2500, aprPct: null }])
        for (const payment of [0.01, 50, 1174, 2000, 1_000_000]) {
          const liabilities = [{ id: "m", balance, aprPct }, ...(second ? [second] : [])];
          const plan = planPayoff({ liabilities, payment, startISO: START });
          if (plan.status !== "paid_off") continue;
          n++;
          const ok =
            ending(plan) === 0 &&
            plan.liabilities.every((l) => l.remainingBalance === 0 && l.principalPaid === l.startingPrincipal && r2(l.principalPaid + l.interestPaid) === l.totalPaid) &&
            plan.payments.every((pm) => pm.paid <= payment + 1e-9 && pm.allocations.every((x) => x.balanceAfter >= 0 && x.paid >= 0)) &&
            r2(plan.payments.reduce((t, pm) => t + pm.paid, 0)) === plan.totalPaid &&
            plan.liabilities.filter((l) => l.aprPct === null).every((l) => l.interestPaid === 0) &&
            plan.unusedPaymentCapacity >= 0 &&
            (plan.paymentCount === 1 ? r2(plan.totalPaid + plan.unusedPaymentCapacity) === r2(payment) : plan.unusedPaymentCapacity === 0);
          if (!ok && !worst) worst = JSON.stringify({ liabilities, payment, totalPaid: plan.totalPaid, unused: plan.unusedPaymentCapacity });
        }
  check(`I+J: across ${n} paid-off schedules — balance lands on 0, never negative, never overpaid, unknown never accrues, unused never in total paid`, worst === "" && n > 150, worst || `${n}`);
}

console.log("8. Refusals");
{
  check("pro-rata allocation conserves every cent (largest remainder)",
    allocateProRata(500, [612.23, 606.12]).join() === "251.25,248.75" && allocateProRata(100, [1, 1, 1]).reduce((t, x) => t + x, 0) === 100);
  check("no liabilities owe ⇒ nothing_owed", planPayoff({ liabilities: [{ id: "a", balance: 0, aprPct: 5 }, { id: "c", balance: -40, aprPct: null }], payment: 50, startISO: START }).status === "nothing_owed");
  check("an issuer credit on one card never nets against another's debt",
    paid(planPayoff({ liabilities: [{ id: "a", balance: 300, aprPct: 0 }, { id: "c", balance: -124.04, aprPct: 0 }], payment: 500, startISO: START }))?.totalPaid === 300);
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
