/**
 * lib/data/snapshot-summary.core.test.ts
 *
 * REVIEW-3 B-4 (E4, matrix row 13) — the Spaces-launcher card reads snapshots
 * through the SAME per-row authority as the full read boundary. This suite
 * executes the pure half (lib/data/snapshot-summary.core.ts) directly:
 *
 *   1. admissibility — a row whose netWorth may not be asserted (unassertable
 *      crypto on a COMPUTED row) never becomes a card figure; the card falls
 *      back to the previous ADMISSIBLE point, or to the explicit no-figure
 *      state when none exists;
 *   2. currency honesty — a NON-USD fixture proves the value produced is in
 *      the effective target (converted at the point's own date), and a rate
 *      MISS drops the point rather than relabelling the native magnitude;
 *   3. markers — reconstructed rows and display-converted points carry
 *      `estimated: true`;
 *   4. the canonical window change runs over the ADMISSIBLE series only.
 *
 * Standalone tsx script:  npx tsx lib/data/snapshot-summary.core.test.ts
 */

import {
  admissibleNetWorthSeries, summarizeNetWorthSeries, resolveSnapshotRowProvenance,
  type RawSnapshotRow,
} from "./snapshot-summary.core";
import type { ConversionContext } from "@/lib/money/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** A stored row with sound identities (netWorth = totalAssets − debt, …). */
function row(over: Partial<RawSnapshotRow> & { date: Date }): RawSnapshotRow {
  const base = {
    stocks: 0, crypto: 0, total: 0, cash: 1000, savings: 500, debt: 200,
    totalAssets: 1500, netWorth: 1300, netLiquid: 1300, cashOnHand: 1000,
    isEstimated: false, reportingCurrency: "USD",
  };
  return { ...base, ...over };
}

function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** EUR-target context: 1 USD = 0.5 EUR on any date except MISS_DATE. */
const MISS_DATE = "2026-08-02";
const eurCtx: ConversionContext = Object.freeze({
  target: "EUR",
  resolve(from: string, dateISO: string) {
    if (from === "EUR") return { kind: "rate" as const, rate: 1, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" as const };
    if (dateISO === MISS_DATE) return { kind: "miss" as const, quote: from, requestedDateISO: dateISO };
    return { kind: "rate" as const, rate: 0.5, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" as const };
  },
});

console.log("snapshot-summary.core — the launcher shares the read boundary's admissibility\n");

// ── 1. Non-assertable latest row never renders as a plain number ─────────────
console.log("1. Aggregate authorisation governs the card figure");
{
  // A COMPUTED (isEstimated) row whose crypto may not be asserted: the same
  // 378-row class the Wealth chart refuses and the AI receives as null.
  const contaminated = row({
    date: d("2026-08-10"), isEstimated: true,
    crypto: 900, total: 900, totalAssets: 2400, netWorth: 2200, cryptoValuationStatus: null,
  });
  const p = resolveSnapshotRowProvenance(contaminated);
  check("fixture is genuinely non-assertable (netWorth UNAVAILABLE)",
    p.aggregates.netWorth.assertable === false);

  const good = row({ date: d("2026-08-09") });
  const series = admissibleNetWorthSeries([good, contaminated], "USD", null);
  check("the non-assertable latest row is omitted", series.length === 1);
  const s = summarizeNetWorthSeries(series);
  check("card shows the previous ADMISSIBLE point", s.netWorth === 1300);
  check("asOf is the date of the number actually shown", s.asOf === d("2026-08-09").toISOString());

  const none = summarizeNetWorthSeries(admissibleNetWorthSeries([contaminated], "USD", null));
  check("no admissible point ⇒ explicit no-figure state",
    none.netWorth === 0 && none.trend.length === 0 && none.asOf === null && none.change === null);
}

// ── 2. Non-USD honesty: the label matches the amount actually computed ───────
console.log("\n2. Currency of the amount actually computed (non-USD fixture)");
{
  // EUR Space with one legacy USD-stamped row and one on-stamp EUR row.
  const usdStamped = row({ date: d("2026-08-01"), reportingCurrency: "USD" });          // 1300 USD
  const eurStamped = row({ date: d("2026-08-03"), reportingCurrency: "EUR" });          // 1300 EUR
  const series = admissibleNetWorthSeries([usdStamped, eurStamped], "EUR", eurCtx);

  check("off-stamp point converts at its own date (1300 USD → 650 EUR)",
    series[0]?.value === 650, `got ${series[0]?.value}`);
  check("on-stamp point passes through untouched (1300 EUR)", series[1]?.value === 1300);
  check("display-converted point carries the estimated marker", series[0]?.estimated === true);
  check("on-stamp observed point carries no marker", series[1]?.estimated === false);

  // A rate MISS excludes the point — never a native magnitude relabelled EUR.
  const missRow = row({ date: d(MISS_DATE), reportingCurrency: "USD" });
  const withMiss = admissibleNetWorthSeries([missRow, eurStamped], "EUR", eurCtx);
  check("rate miss drops the point (never relabels 1300 USD as EUR)",
    withMiss.length === 1 && withMiss[0].value === 1300 && withMiss[0].date.getTime() === d("2026-08-03").getTime());
}

// ── 3. Reconstructed rows carry their marker ─────────────────────────────────
console.log("\n3. Reconstruction marker");
{
  const reconstructed = row({ date: d("2026-08-05"), isEstimated: true });
  const s = summarizeNetWorthSeries(admissibleNetWorthSeries([reconstructed], "USD", null));
  check("an isEstimated row summarizes with estimated: true", s.estimated === true);
  const observed = row({ date: d("2026-08-06") });
  const s2 = summarizeNetWorthSeries(admissibleNetWorthSeries([reconstructed, observed], "USD", null));
  check("marker reflects the point SHOWN (latest observed ⇒ false)", s2.estimated === false);
}

// ── 3b. FX-partial live rows (recorded 'incomplete') are marked, not fact ────
console.log("\n3b. FX-partial disclosure carries the marker");
{
  // The live writer's REVIEW-3 row-33 disclosure: isEstimated=false but a
  // recorded 'incomplete' tier (an FX-unavailable account was excluded).
  const partial = row({ date: d("2026-08-07"), completenessTier: "incomplete" });
  const s = summarizeNetWorthSeries(admissibleNetWorthSeries([partial], "USD", null));
  check("an assertable PARTIAL sum still shows (identities hold)", s.netWorth === 1300);
  check("but it is marked estimated — never presented as an observation", s.estimated === true);
}

// ── 4. The window change runs over the admissible series only ────────────────
console.log("\n4. canonicalWindowChange over ADMISSIBLE points");
{
  // Opening point one month back is admissible; a contaminated row sits between.
  const open = row({ date: d("2026-07-05"), netWorth: 1000, totalAssets: 1200, netLiquid: 1000, cash: 800, savings: 400, cashOnHand: 800 });
  const bad = row({
    date: d("2026-07-20"), isEstimated: true,
    crypto: 900, total: 900, totalAssets: 2400, netWorth: 2200,
  });
  const close = row({ date: d("2026-08-06") });
  const s = summarizeNetWorthSeries(admissibleNetWorthSeries([open, bad, close], "USD", null));
  check("change exists and closes on the admissible latest", s.change?.toValue === 1300);
  check("change opens on an admissible point (1000)", s.change?.fromValue === 1000);

  // If the ONLY point reaching back a month is inadmissible, the window refuses
  // rather than comparing against a number no surface may assert.
  const s2 = summarizeNetWorthSeries(admissibleNetWorthSeries(
    [row({ ...bad, date: d("2026-07-05") } as RawSnapshotRow & { date: Date }), close], "USD", null,
  ));
  check("an inadmissible opening point can never anchor the 1M claim", s2.change === null);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll snapshot-summary.core checks passed");
