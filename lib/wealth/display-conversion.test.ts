/**
 * lib/wealth/display-conversion.test.ts  (SD-5)
 *
 * Proves convertWealthSnapshots is a correct, honest, PER-DATE display transform of
 * the SpaceSnapshot series that feeds the Wealth Time Machine:
 *
 *   npx tsx lib/wealth/display-conversion.test.ts
 *
 *   • EVERY absolute money field on each row is scaled by the rate for THAT row's
 *     date (per-date conversion, the NetWorthChart model) — numbers actually move,
 *   • a per-date rate is applied (two rows at two dates get their own rates),
 *   • the identity fast-path (from === target) returns the input array unchanged,
 *   • a rate MISS flags the row fxMiss (so the Time Machine drops it) — never a
 *     native magnitude blended into the converted series,
 *   • stored snapshots are NEVER mutated (pure value transform),
 *   • feeding the converted series through computeWealthTimeMachine changes the
 *     NUMERIC WealthResult (values, not just labels), and identity leaves it byte-equal.
 *
 * Pure — no DB, no prisma generate. A hand-built context applies known rates so "did
 * the number actually move" is checkable, not just "did the symbol change".
 */

import { convertWealthSnapshots } from "./display-conversion";
import { computeWealthTimeMachine } from "./wealth-time-machine";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot } from "@/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// A context with a real USD→EUR rate that DEPENDS ON THE DATE (0.5 in Jan, 0.4 in
// Jun) so per-date conversion is observable; a miss for any other currency/date.
const ctxEUR: ConversionContext = {
  target: "EUR",
  resolve: (from, dateISO) => {
    if (from !== "USD") return { kind: "miss", quote: from, requestedDateISO: dateISO };
    const rate = dateISO < "2026-06-01" ? 0.5 : 0.4;
    return { kind: "rate", rate, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" };
  },
};
// A context whose target IS the snapshot currency → identity path.
const ctxUSD: ConversionContext = {
  target: "USD",
  resolve: (from, d) => ({ kind: "miss", quote: from, requestedDateISO: d }),
};
// A context that MISSES the snapshot currency entirely (no rate anywhere).
const ctxGBP_miss: ConversionContext = {
  target: "GBP",
  resolve: (from, d) => ({ kind: "miss", quote: from, requestedDateISO: d }),
};

function snap(date: string, o: Partial<Snapshot> = {}): Snapshot {
  const totalCash = o.totalCash ?? 0, totalSavings = o.totalSavings ?? 0;
  const totalInvestments = o.totalInvestments ?? 0, totalCrypto = o.totalCrypto ?? 0;
  const totalAssets = o.totalAssets ?? totalCash + totalSavings + totalInvestments + totalCrypto;
  const totalDebt = o.totalDebt ?? 0;
  return {
    date, totalCash, totalSavings, totalInvestments, totalCrypto, totalDebt, totalAssets,
    netWorth: o.netWorth ?? totalAssets - totalDebt,
    cashOnHand: Math.max(totalCash, 0),
    ...(o.isEstimated ? { isEstimated: true } : {}),
    ...(o.fxMiss ? { fxMiss: true as const } : {}),
  };
}

const JAN = snap("2026-01-01", { totalCash: 5000, totalSavings: 10000, totalInvestments: 40000, totalCrypto: 1000, totalDebt: 20000 });
const JUN = snap("2026-06-01", { totalCash: 6000, totalSavings: 12000, totalInvestments: 52000, totalCrypto: 2000, totalDebt: 17000 });
const SERIES: Snapshot[] = [JAN, JUN];

console.log("Per-date conversion — every money field scaled by THAT date's rate");
{
  const out = convertWealthSnapshots(SERIES, "USD", ctxEUR);
  const jan = out[0], jun = out[1];
  // Jan rate 0.5
  check("Jan netWorth scaled ×0.5", near(jan.netWorth, JAN.netWorth * 0.5));
  check("Jan totalAssets scaled ×0.5", near(jan.totalAssets, JAN.totalAssets * 0.5));
  check("Jan totalDebt scaled ×0.5", near(jan.totalDebt, JAN.totalDebt * 0.5));
  check("Jan totalCash scaled ×0.5", near(jan.totalCash, JAN.totalCash * 0.5));
  check("Jan totalSavings scaled ×0.5", near(jan.totalSavings, JAN.totalSavings * 0.5));
  check("Jan totalInvestments scaled ×0.5", near(jan.totalInvestments, JAN.totalInvestments * 0.5));
  check("Jan totalCrypto scaled ×0.5", near(jan.totalCrypto, JAN.totalCrypto * 0.5));
  check("Jan cashOnHand scaled ×0.5", near(jan.cashOnHand, JAN.cashOnHand * 0.5));
  // Jun rate 0.4 — the SECOND date gets its OWN rate (per-date, not one global rate)
  check("Jun netWorth scaled ×0.4 (per-date rate, distinct from Jan)", near(jun.netWorth, JUN.netWorth * 0.4));
  check("Jun totalInvestments scaled ×0.4", near(jun.totalInvestments, JUN.totalInvestments * 0.4));
  check("dates + estimated flags preserved", jan.date === "2026-01-01" && jun.date === "2026-06-01");
}

console.log("Stored snapshots are never mutated (pure transform)");
{
  const beforeJan = JSON.stringify(JAN), beforeJun = JSON.stringify(JUN);
  convertWealthSnapshots(SERIES, "USD", ctxEUR);
  check("input row JAN unchanged", JSON.stringify(JAN) === beforeJan);
  check("input row JUN unchanged", JSON.stringify(JUN) === beforeJun);
}

console.log("Identity fast-path — from === target returns the input unchanged");
{
  const out = convertWealthSnapshots(SERIES, "USD", ctxUSD);
  check("identity returns the SAME array reference (no allocation)", out === SERIES);
}

console.log("Rate miss ⇒ row flagged fxMiss (mixed-unit honesty), never blended");
{
  const out = convertWealthSnapshots(SERIES, "USD", ctxGBP_miss);
  check("missed rows are flagged fxMiss", out.every((s) => s.fxMiss === true));
  // The Time Machine drops fxMiss points, so an all-missed series has no history.
  const r = computeWealthTimeMachine({ snapshots: out, asOf: "2026-07-01", compareTo: null, currency: "GBP" });
  check("all-missed series ⇒ Time Machine sees no usable history", r.hasHistory === false);
}

console.log("A pre-existing fxMiss row is left untouched (still dropped)");
{
  const withMiss = [...SERIES, snap("2026-07-01", { totalCash: 999999, fxMiss: true })];
  const out = convertWealthSnapshots(withMiss, "USD", ctxEUR);
  const missed = out.find((s) => s.date === "2026-07-01")!;
  check("stored fxMiss row keeps its native totalCash (not converted)", missed.totalCash === 999999 && missed.fxMiss === true);
}

console.log("End-to-end — display currency changes the NUMERIC WealthResult, not just labels");
{
  const asOf = "2026-07-01", compareTo = "2026-01-01";
  const usd = computeWealthTimeMachine({ snapshots: convertWealthSnapshots(SERIES, "USD", ctxUSD), asOf, compareTo, currency: "USD" });
  const eur = computeWealthTimeMachine({ snapshots: convertWealthSnapshots(SERIES, "USD", ctxEUR), asOf, compareTo, currency: "EUR" });
  // asOf resolves to JUN (rate 0.4): net worth genuinely differs, not merely relabeled.
  check("USD asOf net worth is the native magnitude", near(usd.asOfState.netWorth, JUN.netWorth));
  check("EUR asOf net worth is converted (×0.4), a DIFFERENT number", near(eur.asOfState.netWorth, JUN.netWorth * 0.4) && !near(eur.asOfState.netWorth, usd.asOfState.netWorth));
  // Composition slices moved too (values, not shares).
  check("EUR composition investments converted", near(eur.asOfState.composition.investments, JUN.totalInvestments * 0.4));
  // The deterministic explanation sentence is composed in the display currency.
  check("USD explanation names $ figures", (usd.explanation ?? "").includes("$"));
  check("EUR explanation names € figures (currency-consistent copy)", (eur.explanation ?? "").includes("€"));
  // Identity path leaves the whole result numerically equal to the pre-FX baseline.
  const identity = computeWealthTimeMachine({ snapshots: SERIES, asOf, compareTo, currency: "USD" });
  check("identity WealthResult byte-equal to the un-converted baseline", JSON.stringify(usd) === JSON.stringify(identity));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll wealth display-conversion checks passed");
