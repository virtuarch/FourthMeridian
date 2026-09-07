/**
 * components/space/widgets/wealth/wealth-trend-points.test.ts  (OVERVIEW-CONSOLIDATION)
 *
 * The unified Assets balance history: All · Cash · Investments are projections
 * of the SAME SpaceSnapshot rows the former peer lenses plotted, with the SAME
 * arithmetic — proven against those lenses' own authorities:
 *   • Cash        === lib/liquidity/cash-history clipCashHistory (cashNow)
 *   • Investments === lib/investments/portfolio-series buildPortfolioValueSeries
 *   • All         === totalAssets, and cash + invested never exceeds it (no double count)
 * and the Investments lens's per-point confidence + coverage disclosures survive
 * the unified chart path (a refused point becomes a gap, never a bare total).
 *
 *   npx tsx components/space/widgets/wealth/wealth-trend-points.test.ts
 */

import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import { clipCashHistory } from "@/lib/liquidity/cash-history";
import { buildPortfolioValueSeries } from "@/lib/investments/portfolio-series";
import type { Snapshot } from "@/types";
import { projectWealthTrendPoints } from "./wealth-trend-points";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function snap(date: string, o: Partial<Snapshot> & { totalCash: number; totalSavings: number; totalInvestments: number; totalCrypto: number; totalDebt: number; real?: number }): Snapshot {
  const real = o.real ?? 0;
  const totalAssets = o.totalCash + o.totalSavings + o.totalInvestments + o.totalCrypto + real;
  const { real: _r, ...rest } = o;
  return {
    date,
    netWorth: totalAssets - o.totalDebt,
    totalAssets,
    cashOnHand: o.totalCash,
    netLiquid: o.totalCash + o.totalSavings - o.totalDebt,
    ...rest,
  } as Snapshot;
}

const ROWS: Snapshot[] = [
  snap("2026-08-01", { totalCash: 1_000, totalSavings: 4_000, totalInvestments: 10_000, totalCrypto: 2_000, totalDebt: 500, real: 50_000, isEstimated: true,
    completenessTier: "estimated", completenessRecorded: true, contributingComponentCount: 2, totalComponentCount: 5 }),
  snap("2026-08-10", { totalCash: 1_500, totalSavings: 4_000, totalInvestments: 11_000, totalCrypto: 2_500, totalDebt: 400, real: 50_000,
    completenessTier: "observed", completenessRecorded: true, contributingComponentCount: 5, totalComponentCount: 5 }),
  // A row whose crypto may NOT be asserted: the Investments authority refuses it;
  // the wealth read model does not (cash/debt are untouched by crypto).
  snap("2026-08-15", { totalCash: 1_600, totalSavings: 4_000, totalInvestments: 11_200, totalCrypto: 2_600, totalDebt: 400, real: 50_000, cryptoAssertable: false }),
  snap("2026-08-20", { totalCash: 1_700, totalSavings: 4_100, totalInvestments: 11_400, totalCrypto: 2_700, totalDebt: 300, real: 50_000,
    completenessTier: "observed", completenessRecorded: true, contributingComponentCount: 5, totalComponentCount: 5 }),
];

const result = computeWealthTimeMachine({ snapshots: ROWS, asOf: "2026-08-20", compareTo: "2026-08-01", currency: "USD" });
const invested = buildPortfolioValueSeries(ROWS, "USD");
const cash = clipCashHistory(ROWS, "2026-08-20", "2026-08-01", "USD")!;

console.log("1. All === totalAssets");
{
  const all = projectWealthTrendPoints(result, "totalAssets");
  check("one point per snapshot row", all.length === ROWS.length);
  check("values are the persisted totalAssets", all.every((p, i) => p.value === ROWS[i].totalAssets));
}

console.log("2. Cash slice matches the Liquidity authority (cashNow = totalCash + totalSavings)");
{
  const pts = projectWealthTrendPoints(result, "cash");
  check("same dates as clipCashHistory", pts.map((p) => p.date).join() === cash.points.map((p) => p.date).join());
  check("same values as clipCashHistory.cashNow", pts.every((p, i) => p.value === cash.points[i].cashNow));
  check("estimated flag rides through", pts[0].estimated === true && pts[1].estimated === false);
}

console.log("3. Investments slice matches the Investments authority (stocks + crypto)");
{
  const pts = projectWealthTrendPoints(result, "invested", invested);
  check("the refused (unassertable-crypto) date is a GAP, not a bare total",
    !pts.some((p) => p.date === "2026-08-15") && invested.every((p) => p.date !== "2026-08-15"));
  check("remaining dates match buildPortfolioValueSeries exactly", pts.map((p) => p.date).join() === invested.map((p) => p.date).join());
  check("values identical to the portfolio series", pts.every((p, i) => p.value === invested[i].value));
  check("no cross-derivation: value === totalInvestments + totalCrypto on the row",
    pts.every((p) => { const r = ROWS.find((s) => s.date === p.date)!; return p.value === r.totalInvestments + r.totalCrypto; }));
}

console.log("4. Investment confidence / coverage SURVIVE the unified chart path");
{
  const pts = projectWealthTrendPoints(result, "invested", invested);
  const first = pts.find((p) => p.date === "2026-08-01")!;
  const second = pts.find((p) => p.date === "2026-08-10")!;
  check("three-state basis carried per point (reconstructed on the rebuilt row)", first.basis === "reconstructed");
  check("observed row stays observed", second.basis === "observed");
  check("coverage label carried verbatim ('2 of 5 positions valued')", first.coverageLabel === "2 of 5 positions valued");
  check("basis + coverage come from the SAME authority object", first.basis === invested[0].confidence && first.coverageLabel === invested[0].coverageLabel);
  const bare = projectWealthTrendPoints(result, "invested");
  check("without the portfolio series the slice degrades to the two-state flag (no invented basis)",
    bare.every((p) => p.basis === undefined && p.coverageLabel === undefined));
  const other = projectWealthTrendPoints(result, "cash", invested);
  check("the join is applied ONLY to the invested slice", other.every((p) => p.basis === undefined));
}

console.log("5. No double count — Cash + Investments are disjoint dimensions of All");
{
  const all = projectWealthTrendPoints(result, "totalAssets");
  const c = projectWealthTrendPoints(result, "cash");
  const i = projectWealthTrendPoints(result, "invested");
  check("cash + invested ≤ totalAssets on every date (the remainder is real-world assets)",
    all.every((p, k) => c[k].value + i[k].value <= p.value + 1e-9));
  check("cash + invested + real === totalAssets exactly on this fixture",
    all.every((p, k) => Math.abs(c[k].value + i[k].value + 50_000 - p.value) < 1e-9));
  check("the as-of state exposes the same disjoint figures (hero secondary stats)",
    result.asOfState.cash === 5_800 && result.asOfState.invested === 14_100 && result.asOfState.totalAssets === 69_900);
  check("deltas exist for both slices (ledger reconciliation)", result.deltas?.cash.abs === 800 && result.deltas?.invested.abs === 2_100);
}

console.log("6. Liquid Net Worth is still computed and still plottable");
{
  const pts = projectWealthTrendPoints(result, "liquidNetWorth");
  check("liquidNetWorth series present", pts.length === ROWS.length && pts[3].value === 1_700 + 4_100 - 300);
  check("as-of state carries liquidNetWorth", result.asOfState.liquidNetWorth === 5_500);
}

if (failures > 0) { console.error(`\n${failures} wealth-trend-points check(s) failed`); process.exit(1); }
console.log("\nAll wealth-trend-points checks passed");
