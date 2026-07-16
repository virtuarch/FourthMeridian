/**
 * lib/debt/display-conversion.test.ts
 *
 * Pure unit tests for convertDebtHistory — the SD-6 integration-gate FX fix that
 * closed the last symbol-only relabel (the Debt Balance-Over-Time slice). Mirrors
 * lib/wealth/display-conversion.test.ts: per-date conversion, identity fast paths,
 * drop-on-miss series semantics (a missed date is removed, never blended in at a
 * native magnitude), and purity.
 *
 *   npx tsx lib/debt/display-conversion.test.ts
 */

import { convertDebtHistory } from "./display-conversion";
import type { DebtHistoryPoint, DebtHistorySlice } from "@/lib/debt-space-data";
import type { ConversionContext } from "@/lib/money/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// USD→EUR rate that DEPENDS ON THE DATE (0.5 before Jun, 0.4 from Jun) so per-date
// conversion is observable; a miss for any other currency.
const ctxEUR: ConversionContext = {
  target: "EUR",
  resolve: (from, dateISO) => {
    if (from !== "USD") return { kind: "miss", quote: from, requestedDateISO: dateISO };
    const rate = dateISO < "2026-06-01" ? 0.5 : 0.4;
    return { kind: "rate", rate, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" };
  },
};
// Target IS the slice currency → identity path.
const ctxUSD: ConversionContext = {
  target: "USD",
  resolve: (from, d) => ({ kind: "miss", quote: from, requestedDateISO: d }),
};
// Target ≠ slice currency but NO rate anywhere → every point misses → all dropped.
const ctxEUR_allMiss: ConversionContext = {
  target: "EUR",
  resolve: (from, d) => ({ kind: "miss", quote: from, requestedDateISO: d }),
};
// Converts only the Jan date; Jun misses → Jun dropped, Jan kept.
const ctxEUR_partialMiss: ConversionContext = {
  target: "EUR",
  resolve: (from, dateISO) =>
    from === "USD" && dateISO < "2026-06-01"
      ? { kind: "rate", rate: 0.5, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" }
      : { kind: "miss", quote: from, requestedDateISO: dateISO },
};

function pt(date: string, totalDebt: number, isEstimated = false): DebtHistoryPoint {
  return { date, totalDebt, isEstimated };
}
function slice(points: DebtHistoryPoint[], currency = "USD"): DebtHistorySlice {
  return { points, currency, windowStart: points[0]?.date ?? null, windowAsOf: points[points.length - 1]?.date ?? "2026-06-01" };
}

const JAN = pt("2026-01-01", 20000, true);   // estimated (backfilled) — flag must survive FX
const JUN = pt("2026-06-01", 17000, false);
const BASE = slice([JAN, JUN], "USD");

console.log("Identity — target === slice currency returns the SAME object (byte-identical)");
{
  const out = convertDebtHistory(BASE, ctxUSD);
  check("returns the input reference unchanged", out === BASE);
}

console.log("Identity — no ctx (kill switch) returns the SAME object");
{
  const out = convertDebtHistory(BASE, undefined);
  check("returns the input reference unchanged", out === BASE);
}

console.log("null slice → null");
{
  check("null in → null out", convertDebtHistory(null, ctxEUR) === null);
}

console.log("Per-date conversion — each point scaled by THAT date's rate; currency restamped");
{
  const out = convertDebtHistory(BASE, ctxEUR)!;
  check("two points retained", out.points.length === 2);
  check("Jan totalDebt scaled ×0.5", near(out.points[0].totalDebt, 20000 * 0.5));
  check("Jun totalDebt scaled ×0.4 (distinct per-date rate)", near(out.points[1].totalDebt, 17000 * 0.4));
  check("currency restamped to the display target", out.currency === "EUR");
  check("estimated flag (backfilled row) preserved through FX", out.points[0].isEstimated === true && out.points[1].isEstimated === false);
  check("dates preserved", out.points[0].date === "2026-01-01" && out.points[1].date === "2026-06-01");
}

console.log("Drop-on-miss — a missed date is removed, never blended at a native magnitude");
{
  const all = convertDebtHistory(BASE, ctxEUR_allMiss)!;
  check("every point missed ⇒ empty series (no native magnitudes leak through)", all.points.length === 0);
  check("currency still restamped", all.currency === "EUR");

  const partial = convertDebtHistory(BASE, ctxEUR_partialMiss)!;
  check("only the convertible date survives", partial.points.length === 1 && partial.points[0].date === "2026-01-01");
  check("survivor is converted (×0.5), not native", near(partial.points[0].totalDebt, 20000 * 0.5));
}

console.log("Purity — the input slice + points are never mutated");
{
  const before = JSON.stringify(BASE);
  convertDebtHistory(BASE, ctxEUR);
  check("input slice unchanged after conversion", JSON.stringify(BASE) === before);
}

if (failures > 0) { console.error(`\n${failures} convertDebtHistory check(s) failed`); process.exit(1); }
console.log("\nAll convertDebtHistory checks passed");
