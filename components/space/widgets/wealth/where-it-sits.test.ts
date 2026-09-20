/**
 * components/space/widgets/wealth/where-it-sits.test.ts
 *
 * Standalone tsx guard (house convention: exit 0/1).
 *
 *   npx tsx components/space/widgets/wealth/where-it-sits.test.ts
 *
 * REGRESSION — the "Where it sits" total did not account for debt. Its centre
 * figure was the presenter's Σ of ASSET slices, so in Net Worth mode every
 * dollar owed was missing from the number the card led with.
 *
 * The states below come out of the REAL authority (`computeWealthTimeMachine`
 * over snapshot rows), so "agrees with canonical net worth" is tested against
 * the canonical value, not against a fixture that was typed to agree.
 */

import { computeWealthTimeMachine, wealthCompositionItems } from "@/lib/wealth/wealth-time-machine";
import type { Snapshot } from "@/types";
import { whereItSitsTotal } from "./wealth-metric-facets";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function snap(date: string, o: { cash: number; savings: number; inv: number; crypto: number; debt: number; netWorth?: number }): Snapshot {
  const totalAssets = o.cash + o.savings + o.inv + o.crypto;
  return {
    date, totalCash: o.cash, totalSavings: o.savings, totalInvestments: o.inv, totalCrypto: o.crypto,
    totalDebt: o.debt, totalAssets, netWorth: o.netWorth ?? totalAssets - o.debt, cashOnHand: o.cash,
  } as Snapshot;
}
const stateOf = (s: Snapshot) =>
  computeWealthTimeMachine({ snapshots: [s], asOf: s.date, compareTo: null, currency: "USD" }).asOfState;

console.log("1. Assets add, liabilities subtract");
{
  const st = stateOf(snap("2026-09-01", { cash: 8000, savings: 13000, inv: 66000, crypto: 0, debt: 15000 }));
  const t = whereItSitsTotal("netWorth", st)!;
  const sliceSum = wealthCompositionItems(st.composition).reduce((s, i) => s + i.value, 0);
  check("the slices (positive assets) sum to 87,000", sliceSum === 87000, `${sliceSum}`);
  check("the displayed total is 72,000 — NOT the slices' 87,000", t.value === 72000 && t.value !== sliceSum, `${t.value}`);
  check("liabilities reduce the total by exactly what is owed", t.assets - t.value === 15000);
  check("the displayed total IS the canonical net worth", t.value === st.netWorth);
  check("assets − liabilities = net worth reconciles", t.reconciles && t.assets - t.liabilities === t.value);
  check("labelled net worth", t.label === "net worth");
}

console.log("2. More debt ⇒ a lower total, dollar for dollar");
{
  const a = whereItSitsTotal("netWorth", stateOf(snap("2026-09-01", { cash: 5000, savings: 0, inv: 0, crypto: 0, debt: 1000 })))!;
  const b = whereItSitsTotal("netWorth", stateOf(snap("2026-09-01", { cash: 5000, savings: 0, inv: 0, crypto: 0, debt: 3500 })))!;
  check("+2,500 debt ⇒ −2,500 total", a.value - b.value === 2500, `${a.value} → ${b.value}`);
  check("assets leg unchanged by debt", a.assets === b.assets);
}

console.log("3. Zero debt");
{
  const st = stateOf(snap("2026-09-01", { cash: 4000, savings: 6000, inv: 10000, crypto: 500, debt: 0 }));
  const t = whereItSitsTotal("netWorth", st)!;
  check("total equals total assets", t.value === 20500 && t.value === t.assets, `${t.value}`);
  check("liabilities leg is 0 (the card omits the reconciliation block)", t.liabilities === 0);
  check("still reconciles", t.reconciles);
}

console.log("4. Debt exceeding assets ⇒ a NEGATIVE total, not a clamped one");
{
  const t = whereItSitsTotal("netWorth", stateOf(snap("2026-09-01", { cash: 1000, savings: 0, inv: 0, crypto: 0, debt: 4000 })))!;
  check("total is −3,000", t.value === -3000, `${t.value}`);
}

console.log("5. The total is READ from the canonical aggregate, never rebuilt");
{
  // A snapshot whose stated net worth disagrees with assets − debt (it happens:
  // a refused/repaired aggregate). The card shows the CANONICAL figure and says
  // the triple does not reconcile — it does not print its own subtraction.
  const st = stateOf(snap("2026-09-01", { cash: 10000, savings: 0, inv: 0, crypto: 0, debt: 2000, netWorth: 7900 }));
  const t = whereItSitsTotal("netWorth", st)!;
  check("shows the canonical 7,900, not a locally derived 8,000", t.value === 7900, `${t.value}`);
  check("and reports that the triple does not reconcile", t.reconciles === false);
}

console.log("6. Only Net Worth takes a net total");
{
  const st = stateOf(snap("2026-09-01", { cash: 8000, savings: 0, inv: 0, crypto: 0, debt: 3000 }));
  for (const m of ["totalAssets", "totalLiabilities", "liquidNetWorth", "cash", "invested"] as const) {
    check(`${m} ⇒ null (its total is the slices it draws)`, whereItSitsTotal(m, st) === null);
  }
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
