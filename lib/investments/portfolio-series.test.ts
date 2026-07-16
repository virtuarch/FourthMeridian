/**
 * lib/investments/portfolio-series.test.ts  (SD-4 FU-CHART)
 *
 * Pins the canonical Portfolio Value Over Time series build + display conversion:
 *   npx tsx lib/investments/portfolio-series.test.ts
 *
 *   • value = totalInvestments + totalCrypto (two DISJOINT buckets, each asset ONCE —
 *     no historical BTC double-count; never `stocks` alone, never a crypto-included sum),
 *   • fxMiss points are dropped (honest omission),
 *   • estimated rides through per point,
 *   • display conversion scales values by the rate; identity when currency === target.
 *
 * Pure — no DB, no prisma. Also a NEGATIVE guard: the module must NOT reach for a
 * per-date valuation sampler (getInvestmentValueAsOf) — the forbidden N×date path.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildPortfolioValueSeries, convertPortfolioValueSeries } from "./portfolio-series";
import type { ConversionContext } from "@/lib/money/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// ── buildPortfolioValueSeries ────────────────────────────────────────────────────
{
  const snaps = [
    { date: "2025-01-01", totalInvestments: 100, totalCrypto: 20, isEstimated: true },   // 120, estimated
    { date: "2025-02-01", totalInvestments: 150, totalCrypto: 0 },                        // 150
    { date: "2025-03-01", totalInvestments: 200, totalCrypto: 30, fxMiss: true },         // DROPPED
    { date: "2025-04-01", totalInvestments: 180, totalCrypto: 40 },                       // 220
  ];
  const series = buildPortfolioValueSeries(snaps, "USD");

  console.log("1. Bucket rule: investments + crypto, each asset once; fxMiss dropped");
  check("fxMiss point excluded (3 → 3 kept of 4)", series.length === 3);
  check("point 1 = 100+20 = 120 (crypto counted once)", near(series[0].value, 120));
  check("point 2 = 150+0 = 150", near(series[1].value, 150));
  check("point 3 (post-drop) = 180+40 = 220", near(series[2].value, 220));
  check("estimated rides through per point", series[0].estimated === true && series[1].estimated === false);
  check("currency stamped", series.every((p) => p.currency === "USD"));
  check("dates preserved in order", series.map((p) => p.date).join(",") === "2025-01-01,2025-02-01,2025-04-01");
}

// ── convertPortfolioValueSeries ──────────────────────────────────────────────────
{
  const series = [
    { date: "2025-01-01", value: 100, currency: "USD", estimated: false },
    { date: "2025-02-01", value: 200, currency: "USD", estimated: true },
  ];
  const ctxEUR: ConversionContext = {
    target: "EUR",
    resolve: (from, d) => (from === "USD"
      ? { kind: "rate", rate: 0.5, requestedDateISO: d, effectiveDates: { from: d, to: d }, staleness: "exact" }
      : { kind: "miss", quote: from, requestedDateISO: d }),
  };
  const ctxUSD: ConversionContext = { target: "USD", resolve: (from, d) => ({ kind: "miss", quote: from, requestedDateISO: d }) };

  console.log("2. Display conversion — values scale, identity when target === currency");
  const eur = convertPortfolioValueSeries(series, ctxEUR, "2025-02-01");
  check("value 100 → 50 @0.5", near(eur[0].value, 50));
  check("value 200 → 100 @0.5", near(eur[1].value, 100));
  check("currency relabeled EUR", eur.every((p) => p.currency === "EUR"));
  check("estimated preserved", eur[1].estimated === true);
  const usd = convertPortfolioValueSeries(series, ctxUSD, "2025-02-01");
  check("identity: same values when target === USD", usd[0] === series[0] && usd[1] === series[1]);
}

// ── NEGATIVE guard — no N×date valuation sampler in this authority ───────────────
{
  const SRC = readFileSync(path.join(process.cwd(), "lib/investments/portfolio-series.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  console.log("3. No forbidden per-date valuation sampler (reuse persisted snapshots only)");
  check("does not call getInvestmentValueAsOf (no N×date sampler)", !SRC.includes("getInvestmentValueAsOf"));
  check("does not reconstruct from live holdings", !SRC.includes("getCurrentPositions") && !SRC.includes("getInvestmentsTimeMachine"));
}

if (failures > 0) { console.error(`\n${failures} portfolio-series check(s) failed`); process.exit(1); }
console.log("\nAll portfolio-series checks passed");
