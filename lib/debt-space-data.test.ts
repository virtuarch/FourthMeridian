/**
 * lib/debt-space-data.test.ts  (SD-4 contract priming — Debt)
 *
 * Pure fixture test for the Debt composition contract (house convention, no
 * prisma generate):  npx tsx lib/debt-space-data.test.ts
 *
 * Pins the NARROW time-composition boundary: the lens is carried verbatim, its
 * as-of completeness is re-surfaced (a pointer, not a recompute), the snapshot
 * history is clipped to [compareTo, asOf] with fxMiss dropped and sorted ascending,
 * the snapshot-currency basis is carried explicitly, and FICO passes through. The
 * contract computes NO debt figure of its own.
 */

import { assembleDebtSpaceData } from "./debt-space-data";
import type { Snapshot } from "@/types";
import type { Completeness, LensResult } from "@/lib/perspective-engine/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const COMPLETENESS: Completeness = {
  tier: "derived",
  conflict: false,
  reason: "Card balances reconstructed as of 2026-06-30; installment loans held flat.",
  coverageFrom: "2026-01-01",
  byComponent: { revolving: "derived", installment: "estimated" },
};

function lensFixture(withCompleteness: boolean): LensResult {
  return {
    lensId: "debt",
    lensVersion: 1,
    scope: { spaceId: "space-1", userId: "user-1" },
    computedAt: "2026-06-30T00:00:00.000Z",
    status: "ok",
    verdict: "Your debt is trending down.",
    headline: { id: "total", label: "Total debt", value: 4200, format: "currency" },
    metrics: [],
    assumptions: [],
    provenance: { accountIds: ["a1"], tierCounts: { full: 1, balanceOnly: 0, summaryOnly: 0 }, dataAsOf: "2026-06-29", redactions: [] },
    ...(withCompleteness ? { completeness: COMPLETENESS } : {}),
  };
}

// Snapshots: one before the window, several inside, one fxMiss (must drop), one
// exactly at asOf, deliberately out of order to prove the sort.
const SNAPSHOTS: Snapshot[] = [
  { date: "2026-05-01", netWorth: 0, totalAssets: 0, totalDebt: 5000, totalCash: 0, totalSavings: 0, totalInvestments: 0, totalCrypto: 0, cashOnHand: 0 },
  { date: "2026-03-15", netWorth: 0, totalAssets: 0, totalDebt: 6000, totalCash: 0, totalSavings: 0, totalInvestments: 0, totalCrypto: 0, cashOnHand: 0 }, // before compareTo
  { date: "2026-06-30", netWorth: 0, totalAssets: 0, totalDebt: 4200, totalCash: 0, totalSavings: 0, totalInvestments: 0, totalCrypto: 0, cashOnHand: 0, isEstimated: true },
  { date: "2026-06-01", netWorth: 0, totalAssets: 0, totalDebt: 4800, totalCash: 0, totalSavings: 0, totalInvestments: 0, totalCrypto: 0, cashOnHand: 0, fxMiss: true }, // must drop
  { date: "2026-04-10", netWorth: 0, totalAssets: 0, totalDebt: 5500, totalCash: 0, totalSavings: 0, totalInvestments: 0, totalCrypto: 0, cashOnHand: 0 },
  { date: "2026-08-01", netWorth: 0, totalAssets: 0, totalDebt: 4000, totalCash: 0, totalSavings: 0, totalInvestments: 0, totalCrypto: 0, cashOnHand: 0 }, // after asOf
];

console.log("DebtSpaceData — assembleDebtSpaceData");

const lens = lensFixture(true);
const data = assembleDebtSpaceData({
  asOf: "2026-06-30",
  compareTo: "2026-04-01",
  lens,
  snapshots: SNAPSHOTS,
  snapshotCurrency: "USD",
  fico: { score: 720, updatedAt: "2026-06-15" },
});

check("lens carried verbatim (same reference)", data.lens === lens);
check("completeness re-surfaced === lens.completeness", data.completeness === COMPLETENESS);
check("asOf / compareTo echoed", data.asOf === "2026-06-30" && data.compareTo === "2026-04-01");
check("fico passthrough", data.fico.score === 720 && data.fico.updatedAt === "2026-06-15");

const h = data.history!;
check("history present", h != null);
check("history currency basis carried", h.currency === "USD");
check("window bounds carried", h.windowStart === "2026-04-01" && h.windowAsOf === "2026-06-30");
check(
  "clipped to [compareTo, asOf] — drops before-window and after-asOf",
  h.points.every((p) => p.date >= "2026-04-01" && p.date <= "2026-06-30"),
  JSON.stringify(h.points.map((p) => p.date)),
);
check("fxMiss point dropped", h.points.every((p) => p.date !== "2026-06-01"));
check("before-compareTo point (2026-03-15) dropped", h.points.every((p) => p.date !== "2026-03-15"));
check("after-asOf point (2026-08-01) dropped", h.points.every((p) => p.date !== "2026-08-01"));
check(
  "ascending by date",
  h.points.map((p) => p.date).join(",") === "2026-04-10,2026-05-01,2026-06-30",
  h.points.map((p) => p.date).join(","),
);
check("isEstimated projected", h.points.find((p) => p.date === "2026-06-30")?.isEstimated === true);
check("observed point not flagged estimated", h.points.find((p) => p.date === "2026-05-01")?.isEstimated === false);

// ── Edge cases ──
const noLower = assembleDebtSpaceData({ asOf: "2026-06-30", lens, snapshots: SNAPSHOTS, snapshotCurrency: "USD" });
check("no compareTo ⇒ full history up to asOf (includes 2026-03-15)", noLower.history!.points.some((p) => p.date === "2026-03-15"));
check("no compareTo ⇒ still clips after-asOf", noLower.history!.points.every((p) => p.date <= "2026-06-30"));
check("no compareTo ⇒ compareTo null, windowStart null", noLower.compareTo === null && noLower.history!.windowStart === null);
check("default fico ⇒ nulls", noLower.fico.score === null && noLower.fico.updatedAt === null);

const noHistory = assembleDebtSpaceData({ asOf: "2026-06-30", lens, snapshots: [], snapshotCurrency: "USD" });
check("empty snapshots ⇒ history null", noHistory.history === null);

const allAfter = assembleDebtSpaceData({ asOf: "2020-01-01", lens, snapshots: SNAPSHOTS, snapshotCurrency: "USD" });
check("window before all data ⇒ history null", allAfter.history === null);

const presentDayLens = lensFixture(false);
const noCompleteness = assembleDebtSpaceData({ asOf: "2026-06-30", lens: presentDayLens, snapshots: SNAPSHOTS, snapshotCurrency: "USD" });
check("lens without completeness ⇒ completeness null (present-day branch)", noCompleteness.completeness === null);

const noLens = assembleDebtSpaceData({ asOf: "2026-06-30", lens: null, snapshots: SNAPSHOTS, snapshotCurrency: "USD" });
check("absent lens ⇒ lens null, completeness null, history still clipped", noLens.lens === null && noLens.completeness === null && noLens.history !== null);

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll DebtSpaceData checks passed");
