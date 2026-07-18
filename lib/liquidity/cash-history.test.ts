/**
 * lib/liquidity/cash-history.test.ts
 *
 * Pure invariants for the Liquidity Balance-History helper (the cashNow snapshot series).
 * Mirrors the Debt clipDebtHistory contract: window clipping, fxMiss drop, ascending sort,
 * the cashNow = totalCash + totalSavings projection, and convert identity/currency relabel.
 * No DB, no clock, no network.
 *
 *     npx tsx lib/liquidity/cash-history.test.ts
 */

import type { Snapshot } from "@/types";
import { clipCashHistory, convertCashHistory } from "./cash-history";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function snap(date: string, cash: number, savings: number, extra: Partial<Snapshot> = {}): Snapshot {
  return {
    date,
    netWorth: cash + savings,
    totalAssets: cash + savings,
    totalDebt: 0,
    totalCash: cash,
    totalSavings: savings,
    totalInvestments: 0,
    totalCrypto: 0,
    cashOnHand: cash,
    ...extra,
  };
}

console.log("1. cashNow projection = totalCash + totalSavings (the 'Available now' tier)");
{
  const slice = clipCashHistory([snap("2025-01-01", 100, 25)], "2025-06-01", null, "USD");
  check("cashNow = checking + savings", slice?.points[0].cashNow === 125);
  check("isEstimated defaults false", slice?.points[0].isEstimated === false);
}

console.log("2. Window clipping — [compareTo, asOf], ascending, fxMiss dropped");
{
  const snaps = [
    snap("2025-03-01", 300, 0),
    snap("2025-01-01", 100, 0),
    snap("2025-02-01", 200, 0),
    snap("2025-05-01", 500, 0),                       // after asOf — excluded
    snap("2025-02-15", 999, 0, { fxMiss: true }),      // mixed-unit — dropped
    snap("2024-12-01", 50, 0),                         // before compareTo — excluded
  ];
  const slice = clipCashHistory(snaps, "2025-04-01", "2025-01-01", "USD");
  check("keeps only in-window points", slice?.points.length === 3);
  check("ascending by date", !!slice && slice.points.map((p) => p.date).join(",") === "2025-01-01,2025-02-01,2025-03-01");
  check("fxMiss point dropped", !slice?.points.some((p) => p.cashNow === 999));
  check("windowStart/windowAsOf recorded", slice?.windowStart === "2025-01-01" && slice?.windowAsOf === "2025-04-01");
}

console.log("3. Empty → null (workspace applies its own 'not enough history' gate)");
{
  check("no in-window rows ⇒ null", clipCashHistory([snap("2020-01-01", 1, 1)], "2019-01-01", null, "USD") === null);
  check("all fxMiss ⇒ null", clipCashHistory([snap("2025-01-01", 1, 1, { fxMiss: true })], "2025-06-01", null, "USD") === null);
}

console.log("4. isEstimated carried through for reconstructed rows");
{
  const slice = clipCashHistory([snap("2025-01-01", 10, 0, { isEstimated: true })], "2025-06-01", null, "USD");
  check("reconstructed row flagged", slice?.points[0].isEstimated === true);
}

console.log("5. convertCashHistory — identity when no ctx or same-currency, else relabel");
{
  const slice = clipCashHistory([snap("2025-01-01", 100, 0)], "2025-06-01", null, "USD")!;
  check("no ctx ⇒ same slice (identity)", convertCashHistory(slice, undefined) === slice);
  const sameCcy = convertCashHistory(slice, { target: "USD" } as never);
  check("ctx.target === slice currency ⇒ identity", sameCcy === slice);
}

if (failures > 0) { console.error(`\n${failures} cash-history check(s) failed`); process.exit(1); }
console.log("\nAll cash-history checks passed");
