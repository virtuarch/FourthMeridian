/**
 * components/space/widgets/debt/payoff-scenarios.test.ts
 *
 * Pure tests for buildPayoffScenarios (house pattern: standalone tsx):
 *
 *   npx tsx components/space/widgets/debt/payoff-scenarios.test.ts
 *
 * Locks: the baseline is the payment THE USER CHOSE (never a minimum payment);
 * every row is a real `planPayoff` plan; "interest saved" is measured against
 * the chosen payment; unknown APR ⇒ no rows (no fabricated horizon); a chosen
 * payment that does not amortize still shows which extra WOULD; the start date
 * and formatter are injected, so output is deterministic.
 */

import { buildPayoffScenarios, PAYOFF_SCENARIO_EXTRAS } from "./payoff-scenarios";
import { payoffHorizonLabel } from "./payoff-copy";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const START = "2026-01-01";
/** One liability — the planner's selection when a single account is chosen. */
const one = (balance: number, aprPct: number | null) => [{ id: "a", balance, aprPct }];

console.log("1. Presets sit over the CHOSEN payment");
{
  const rows = buildPayoffScenarios({ liabilities: one(1174, 0), payment: 500, startISO: START });
  check("three preset rows", rows.length === 3 && PAYOFF_SCENARIO_EXTRAS.join() === "50,100,250");
  check("labels claim no currency without an injected formatter", rows.map((r) => r.label).join("|") === "+50/mo|+100/mo|+250/mo", rows.map((r) => r.label).join("|"));
  check("payments are chosen + extra (550 / 600 / 750)", rows.map((r) => r.payment).join() === "550,600,750");
  check("there is no 'Minimums' row", rows.every((r) => !/min/i.test(r.label)));
  // 1174 @ 0%, 600/mo: one full payment leaves 574; Feb has 28 days ⇒ first d with
  // 600·d/28 ≥ 574 is d = 27 ⇒ 1 month, 3 weeks, 6 days. Derived by hand, not by the engine.
  const r600 = rows.find((r) => r.extra === 100)!;
  check("+100 row: 1 month, 3 weeks, 6 days", payoffHorizonLabel(r600.plan) === "1 month, 3 weeks, 6 days", payoffHorizonLabel(r600.plan));
  check("+100 row: final payment 574", r600.plan.status === "paid_off" && r600.plan.finalPayment === 574);
  check("0% ⇒ nothing to save (0, shown as no chip)", rows.every((r) => r.interestSavedVsChosen === 0));
}

console.log("2. Interest saved is measured against the chosen payment");
{
  const rows = buildPayoffScenarios({ liabilities: one(10000, 24), payment: 400, startISO: START });
  const saved = rows.map((r) => r.interestSavedVsChosen ?? -1);
  check("every row saves interest vs the chosen 400", saved.every((s) => s > 0), saved.join());
  check("a bigger extra saves more", saved[0] < saved[1] && saved[1] < saved[2], saved.join());
  check("a bigger extra finishes sooner", rows.every((r, i) =>
    i === 0 || (r.plan.status === "paid_off" && rows[i - 1].plan.status === "paid_off"
      && r.plan.payoffISO < (rows[i - 1].plan as { payoffISO: string }).payoffISO)));
}

console.log("3. UNKNOWN APR ⇒ rows are qualified ESTIMATES (supersedes 'no rows')");
{
  const est = buildPayoffScenarios({ liabilities: one(1174, null), payment: 500, startISO: START });
  check("aprPct null ⇒ three rows", est.length === 3);
  check("every row's plan carries PRINCIPAL_ONLY", est.every((r) => r.plan.status === "paid_off" && r.plan.basis.interest === "PRINCIPAL_ONLY"));
  check("the horizon label does not overstate precision", est.every((r) => payoffHorizonLabel(r.plan).startsWith("About ")), payoffHorizonLabel(est[0].plan));
  check("no 'interest saved' is claimed when no interest was modelled (null, not 0)", est.every((r) => r.interestSavedVsChosen === null));
  const zero = buildPayoffScenarios({ liabilities: one(1174, 0), payment: 500, startISO: START });
  check("explicit 0 is a RATE ⇒ interest-aware rows, exact labels, a real 0 saved",
    zero.every((r) => r.plan.status === "paid_off" && r.plan.basis.interest === "INTEREST_AWARE" && !payoffHorizonLabel(r.plan).startsWith("About") && r.interestSavedVsChosen === 0));
  const mixed = buildPayoffScenarios({ liabilities: [{ id: "a", balance: 6000, aprPct: 24 }, { id: "u", balance: 4000, aprPct: null }], payment: 400, startISO: START });
  check("mixed ⇒ PARTIAL_INTEREST rows, with a saving measured on the known part",
    mixed.every((r) => r.plan.status === "paid_off" && r.plan.basis.interest === "PARTIAL_INTEREST" && (r.interestSavedVsChosen ?? 0) > 0));
}

console.log("4. Nothing owed / no payment ⇒ no rows");
{
  check("nothing owed ⇒ []", buildPayoffScenarios({ liabilities: one(0, 20), payment: 50, startISO: START }).length === 0);
  check("no liabilities ⇒ []", buildPayoffScenarios({ liabilities: [], payment: 50, startISO: START }).length === 0);
  check("payment 0 ⇒ []", buildPayoffScenarios({ liabilities: one(900, 20), payment: 0, startISO: START }).length === 0);
}

console.log("5. A chosen payment that does NOT amortize still shows which extra would");
{
  // 10,000 @ 24% ⇒ ~200/mo interest. Chosen 150 never amortizes; +50 (200) still
  // doesn't; +100 (250) and +250 (400) do.
  const rows = buildPayoffScenarios({ liabilities: one(10000, 24), payment: 150, startISO: START });
  check("+50 ⇒ still non-amortizing, honest label", rows[0].plan.status === "non_amortizing" && payoffHorizonLabel(rows[0].plan) === "Payment doesn't cover interest");
  check("+100 and +250 amortize", rows[1].plan.status === "paid_off" && rows[2].plan.status === "paid_off");
  check("no 'saved' figure against a baseline that has no schedule", rows.every((r) => r.interestSavedVsChosen === null));
}

console.log("6. Formatter injection + determinism");
{
  const rows = buildPayoffScenarios({ liabilities: one(900, 12), payment: 50, startISO: START }, { fmtMoney: (n) => `€${n}` });
  check("formatter drives the labels", rows[0].label === "+€50/mo");
  const a = JSON.stringify(buildPayoffScenarios({ liabilities: one(900, 12), payment: 50, startISO: START }));
  const b = JSON.stringify(buildPayoffScenarios({ liabilities: one(900, 12), payment: 50, startISO: START }));
  check("same input ⇒ identical rows", a === b);
}

if (failures > 0) { console.error(`\n${failures} payoff-scenarios check(s) failed`); process.exit(1); }
console.log("\nAll payoff-scenarios checks passed");
