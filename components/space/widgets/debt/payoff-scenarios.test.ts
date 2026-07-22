/**
 * components/space/widgets/debt/payoff-scenarios.test.ts
 *
 * S4 — pure tests for buildPayoffScenarios (house pattern: standalone tsx):
 *
 *   npx tsx components/space/widgets/debt/payoff-scenarios.test.ts
 *
 * Locks: rows agree with direct simulatePayoff calls; interest-saved arithmetic
 * (row.totalInterest measured against the minimums baseline, floored at 0);
 * payment ≤ interest ⇒ honest null-months row; no minimum / nothing owed ⇒
 * empty; zero blended rate ⇒ null interest but real horizons; the clock/formatter
 * injection makes the output deterministic.
 */

import { simulatePayoff } from "@/components/space/sections/DebtPayoffSection";
import { buildPayoffScenarios } from "./payoff-scenarios";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const CLOCK = () => new Date(2026, 0, 1); // 2026-01-01 — pins payoffDate deterministically

console.log("1. Rows agree with direct simulatePayoff over the same inputs");
{
  const total = 10000, monthlyRate = 0.24 / 12, minPayment = 250; // 2%/mo
  const rows = buildPayoffScenarios({ total, monthlyRate, minPayment }, { now: CLOCK });
  check("three preset rows", rows.length === 3, `${rows.length}`);
  check("labels are Minimums / +$100/mo / +$250/mo", rows.map((r) => r.label).join("|") === "Minimums|+$100/mo|+$250/mo", rows.map((r) => r.label).join("|"));
  check("extras are 0 / 100 / 250", rows.map((r) => r.extra).join(",") === "0,100,250");
  for (const r of rows) {
    const direct = simulatePayoff(total, monthlyRate, minPayment + r.extra);
    check(`row +${r.extra}: months matches simulatePayoff`, r.months === (direct?.months ?? null), `${r.months} vs ${direct?.months}`);
    check(`row +${r.extra}: totalInterest matches`, r.totalInterest === (direct ? direct.totalInterest : null), `${r.totalInterest} vs ${direct?.totalInterest}`);
    check(`row +${r.extra}: payment = min + extra`, r.payment === minPayment + r.extra);
    check(`row +${r.extra}: payoffDate present`, typeof r.payoffDate === "string" && r.payoffDate.length > 0);
  }
}

console.log("2. Interest saved vs minimums — arithmetic + baseline null");
{
  const total = 10000, monthlyRate = 0.24 / 12, minPayment = 250;
  const rows = buildPayoffScenarios({ total, monthlyRate, minPayment }, { now: CLOCK });
  const base = simulatePayoff(total, monthlyRate, minPayment)!;
  check("baseline row saves null vs itself", rows[0].interestSavedVsMin === null);
  for (const r of rows.slice(1)) {
    const direct = simulatePayoff(total, monthlyRate, minPayment + r.extra)!;
    const expected = Math.max(0, base.totalInterest - direct.totalInterest);
    check(`row +${r.extra}: interestSaved = base − row`, r.interestSavedVsMin === expected, `${r.interestSavedVsMin} vs ${expected}`);
    check(`row +${r.extra}: paying more saves interest`, (r.interestSavedVsMin ?? 0) > 0);
  }
}

console.log("3. Payment ≤ interest ⇒ honest null-months baseline row");
{
  // firstInterest = 10000 · 0.02 = 200; a 150 minimum cannot cover it.
  const rows = buildPayoffScenarios({ total: 10000, monthlyRate: 0.02, minPayment: 150 }, { now: CLOCK });
  check("still three rows", rows.length === 3);
  check("baseline months null (does not cover interest)", rows[0].months === null);
  check("baseline payoffDate null", rows[0].payoffDate === null);
  check("baseline totalInterest null", rows[0].totalInterest === null);
  check("baseline interestSaved null", rows[0].interestSavedVsMin === null);
  // +250 → payment 400 > 200 interest ⇒ payable, but interestSaved is null since
  // the baseline itself is unknowable.
  check("+250 row is payable", rows[2].months !== null);
  check("+250 interestSaved null (no baseline to compare)", rows[2].interestSavedVsMin === null);
}

console.log("4. No minimums / nothing owed ⇒ empty (strip absent)");
{
  check("minPayment 0 ⇒ empty", buildPayoffScenarios({ total: 10000, monthlyRate: 0.02, minPayment: 0 }).length === 0);
  check("total 0 ⇒ empty", buildPayoffScenarios({ total: 0, monthlyRate: 0.02, minPayment: 200 }).length === 0);
}

console.log("5. Zero blended rate ⇒ null interest, real payoff horizons");
{
  const rows = buildPayoffScenarios({ total: 6000, monthlyRate: 0, minPayment: 200 }, { now: CLOCK });
  check("baseline months = ceil(6000/200) = 30", rows[0].months === 30, `${rows[0].months}`);
  check("no rate ⇒ totalInterest null", rows.every((r) => r.totalInterest === null));
  check("no rate ⇒ interestSaved null", rows.every((r) => r.interestSavedVsMin === null));
}

console.log("6. Injected formatter drives the label money");
{
  const rows = buildPayoffScenarios(
    { total: 10000, monthlyRate: 0.02, minPayment: 250 },
    { now: CLOCK, fmtMoney: (n) => `€${n}` },
  );
  check("label uses the injected formatter", rows[1].label === "+€100/mo", rows[1].label);
}

if (failures > 0) { console.error(`\n${failures} payoff-scenarios check(s) failed`); process.exit(1); }
console.log("\nAll payoff-scenarios checks passed");
