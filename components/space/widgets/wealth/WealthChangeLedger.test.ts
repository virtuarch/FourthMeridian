/**
 * components/space/widgets/wealth/WealthChangeLedger.test.ts
 *
 * S6 — colocated ledger tests. Pure, DB-free (house pattern):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs \
 *     components/space/widgets/wealth/WealthChangeLedger.test.ts
 *
 * Locks the two honesty rules the ledger surface depends on:
 *   1. Reconciliation — the component deltas the ledger lists sum (assets up,
 *      liabilities down) to the Net Change total it prints (deltas.netWorth).
 *   2. Single forward-phrased attribution note — never a reserved source label
 *      (Market Growth / Contributions / Income / Spending / Fees).
 * Also checks the driverGood coloring rule (liabilities DOWN is good).
 */

import { computeWealthTimeMachine, WEALTH_EPSILON } from "@/lib/wealth/wealth-time-machine";
import type { WealthTimeMachineInput } from "@/lib/wealth/wealth-time-machine";
import type { Snapshot } from "@/types";
import { ATTRIBUTION_NOTE, driverGood } from "./WealthChangeLedger";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

function snap(date: string, o: Partial<Snapshot> = {}): Snapshot {
  const totalCash = o.totalCash ?? 0, totalSavings = o.totalSavings ?? 0;
  const totalInvestments = o.totalInvestments ?? 0, totalCrypto = o.totalCrypto ?? 0;
  const real = o.totalAssets != null ? o.totalAssets - (totalCash + totalSavings + totalInvestments + totalCrypto) : 0;
  const totalAssets = o.totalAssets ?? totalCash + totalSavings + totalInvestments + totalCrypto + (real > 0 ? real : 0);
  const totalDebt = o.totalDebt ?? 0;
  return {
    date, totalCash, totalSavings, totalInvestments, totalCrypto, totalDebt, totalAssets,
    netWorth: o.netWorth ?? totalAssets - totalDebt,
    cashOnHand: Math.max(totalCash, 0),
    ...(o.isEstimated ? { isEstimated: true } : {}),
    ...(o.fxMiss ? { fxMiss: true as const } : {}),
  };
}

// A comparison spanning movement in every asset class + liabilities paydown, plus
// a real-world-asset that moves only sub-epsilon (must be filtered from drivers).
const SERIES: Snapshot[] = [
  snap("2026-01-01", { totalCash: 5000, totalSavings: 10000, totalInvestments: 40000, totalCrypto: 3000, totalAssets: 78000.4, totalDebt: 20000 }),
  snap("2026-07-01", { totalCash: 7000, totalSavings: 12000, totalInvestments: 60000, totalCrypto: 8000, totalAssets: 107000.6, totalDebt: 16000 }),
];
const input = (o: Partial<WealthTimeMachineInput> = {}): WealthTimeMachineInput => ({
  snapshots: SERIES, asOf: "2026-07-01", compareTo: "2026-01-01", currency: "USD", ...o,
});

console.log("Reconciliation — listed component deltas sum to the Net Change total");
{
  const r = computeWealthTimeMachine(input());
  const c = r.deltas!.composition;
  // The ledger prints Net Change = deltas.netWorth.abs; the source-of-truth
  // reconciliation is (asset components up) − (liabilities up) = net worth change.
  const assetSum = c.cash + c.investments + c.crypto + c.real;
  const reconstructed = assetSum - c.liabilities;
  check("Σ(asset component Δ) − liabilities Δ ≈ Net Change", approx(reconstructed, r.deltas!.netWorth.abs, WEALTH_EPSILON * 6),
    `${reconstructed} vs ${r.deltas!.netWorth.abs}`);
  check("Net Change equals the read model's net worth delta", approx(r.deltas!.netWorth.abs, 107000.6 - 16000 - (78000.4 - 20000)),
    `${r.deltas!.netWorth.abs}`);
}

console.log("Drivers — epsilon-filtered, |Δ|-sorted, honestly signed");
{
  const r = computeWealthTimeMachine(input());
  const drivers = r.drivers!;
  check("sub-epsilon movers are filtered out of the listed rows", drivers.every((d) => Math.abs(d.delta) > WEALTH_EPSILON));
  const sorted = drivers.every((d, i) => i === 0 || Math.abs(drivers[i - 1].delta) >= Math.abs(d.delta));
  check("rows are |Δ|-sorted (largest mover first)", sorted);
  const invRow = drivers.find((d) => d.id === "investments");
  check("investments row is present and positive", !!invRow && invRow!.delta > 0);
}

console.log("driverGood — liabilities DOWN is good, assets UP is good");
{
  check("liabilities decreasing is good", driverGood({ id: "liabilities", label: "Liabilities", delta: -4000 }) === true);
  check("liabilities increasing is bad", driverGood({ id: "liabilities", label: "Liabilities", delta: 4000 }) === false);
  check("investments increasing is good", driverGood({ id: "investments", label: "Investments", delta: 20000 }) === true);
  check("investments decreasing is bad", driverGood({ id: "investments", label: "Investments", delta: -20000 }) === false);
}

console.log("Attribution note — single, forward-phrased; rows never use reserved source labels");
{
  const lc = ATTRIBUTION_NOTE.toLowerCase();
  check("note is forward-phrased ('arrives with historical valuation')", lc.includes("arrives with historical valuation"));

  // The A9 slot contract: driver ROWS must stay generic asset-class labels — never
  // a source-attribution term presented as a current fact.
  const RESERVED = ["market growth", "contributions", "income", "spending", "fees"];
  const r = computeWealthTimeMachine(input());
  const rowLabels = (r.drivers ?? []).map((d) => d.label.toLowerCase());
  check("driver rows carry only asset-class labels", rowLabels.length > 0 &&
    rowLabels.every((l) => !RESERVED.some((res) => l.includes(res))), rowLabels.join(", "));
  check("'Real World Assets' copy (not 'Real Assets'/'Real Estate') when the class moves",
    !rowLabels.some((l) => l === "real assets" || l === "real estate"));
}

if (failures > 0) { console.error(`\n${failures} ledger check(s) failed`); process.exit(1); }
console.log("\nAll ledger checks passed");
