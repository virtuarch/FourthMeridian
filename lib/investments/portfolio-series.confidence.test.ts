/**
 * lib/investments/portfolio-series.confidence.test.ts
 *
 * V26-INVESTMENTS-HISTORY — the chart's confidence contract.
 *
 * The series builder is where a stored snapshot's persisted completeness becomes
 * a state the chart can draw. This suite pins BOTH halves of that:
 *
 *   - the classification is correct for recorded rows, and
 *   - it is a NO-OP for every row written before the completeness columns
 *     existed, so shipping this changes nothing until a regeneration runs.
 *
 * Standalone tsx script:  npx tsx lib/investments/portfolio-series.confidence.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildPortfolioValueSeries, convertPortfolioValueSeries,
  type SnapshotSeriesRow, type PortfolioValuePoint,
} from "./portfolio-series";
import { basisOf } from "@/components/space/widgets/charts/trend-runs.core";
import type { ConversionContext } from "@/lib/money/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function row(over: Partial<SnapshotSeriesRow> = {}): SnapshotSeriesRow {
  return { date: "2026-06-24", totalInvestments: 100, totalCrypto: 0, ...over };
}
const one = (r: SnapshotSeriesRow): PortfolioValuePoint => buildPortfolioValueSeries([r], "USD")[0];

function main(): void {
  // ── 1. The no-op guarantee ────────────────────────────────────────────────
  console.log("1. Rows written before the columns existed are unchanged");
  {
    const legacyEstimated = one(row({ isEstimated: true }));
    check("legacy estimated row is reconstructed, NOT unreliable",
      legacyEstimated.confidence === "reconstructed");
    check("no coverage label is invented", legacyEstimated.coverageLabel === null);
    check("the old `estimated` field is untouched", legacyEstimated.estimated === true);

    const legacyObserved = one(row({ isEstimated: false }));
    check("legacy observed row is observed", legacyObserved.confidence === "observed");
    check("`estimated` still false", legacyObserved.estimated === false);

    // The whole current history, in one assertion: today every row resolves
    // tier `unknown` with recorded=false, and none of them may go unreliable.
    const wholeHistory = buildPortfolioValueSeries(
      [row({ date: "2026-06-24", isEstimated: true, completenessTier: "unknown", completenessRecorded: false }),
       row({ date: "2026-06-25", isEstimated: true, completenessTier: "unknown", completenessRecorded: false }),
       row({ date: "2026-07-19", isEstimated: false, completenessTier: "observed", completenessRecorded: false })],
      "USD");
    check("an un-regenerated history contains NO unreliable points",
      wholeHistory.every((p) => p.confidence !== "unreliable"));
    check("and still distinguishes observed from reconstructed",
      wholeHistory.map((p) => p.confidence).join(",") === "reconstructed,reconstructed,observed");
  }

  // ── 2. Recorded rows classify ─────────────────────────────────────────────
  console.log("2. Recorded completeness drives the classification");
  {
    const mostlyUnknown = one(row({
      isEstimated: true, completenessTier: "unknown", completenessRecorded: true,
      contributingComponentCount: 1, totalComponentCount: 19,
    }));
    const complete = one(row({
      isEstimated: true, completenessTier: "estimated", completenessRecorded: true,
      contributingComponentCount: 19, totalComponentCount: 19,
    }));
    check("1-of-19 @ unknown is unreliable", mostlyUnknown.confidence === "unreliable");
    check("19-of-19 @ estimated is reconstructed", complete.confidence === "reconstructed");
    check("BOTH still carry estimated=true — the old bit cannot separate them",
      mostlyUnknown.estimated === true && complete.estimated === true);
    check("the coverage label is built by the canonical author",
      mostlyUnknown.coverageLabel === "1 of 19 positions valued");
    check("a complete row discloses its coverage too",
      complete.coverageLabel === "19 of 19 positions valued");
    check("recorded incomplete is also unreliable",
      one(row({ isEstimated: true, completenessTier: "incomplete", completenessRecorded: true })).confidence === "unreliable");
    check("recorded derived is a legitimate estimate",
      one(row({ isEstimated: true, completenessTier: "derived", completenessRecorded: true })).confidence === "reconstructed");
  }

  // ── 3. Values are untouched ───────────────────────────────────────────────
  console.log("3. Confidence never changes a value or drops a point");
  {
    const rows = [
      row({ date: "2026-06-24", totalInvestments: 11.65, totalCrypto: 14624.59, isEstimated: true, completenessTier: "unknown", completenessRecorded: true, contributingComponentCount: 1, totalComponentCount: 19 }),
      row({ date: "2026-07-19", totalInvestments: 5069.02, totalCrypto: 15516.70, isEstimated: false }),
    ];
    const s = buildPortfolioValueSeries(rows, "USD");
    check("no point is dropped for being unreliable", s.length === 2);
    check("value is still investments + crypto", Math.abs(s[0].value - (11.65 + 14624.59)) < 1e-9);
    check("the observed point is unchanged", Math.abs(s[1].value - (5069.02 + 15516.70)) < 1e-9);
    check("an fxMiss point is still the only thing dropped",
      buildPortfolioValueSeries([...rows, row({ date: "2026-07-20", fxMiss: true })], "USD").length === 2);
  }

  // ── 4. FX conversion can only degrade ─────────────────────────────────────
  console.log("4. Display conversion degrades confidence, never rescues it");
  {
    const walkedBack: ConversionContext = {
      target: "EUR",
      resolve: (from, d) => (from === "USD"
        ? { kind: "rate", rate: 0.5, requestedDateISO: d, effectiveDates: { from: "2025-01-01", to: "2025-01-01" }, staleness: "walked-back" }
        : { kind: "miss", quote: from, requestedDateISO: d }),
    };
    const src: PortfolioValuePoint[] = [
      { date: "2026-01-01", value: 100, currency: "USD", estimated: false, confidence: "observed",      coverageLabel: null },
      { date: "2026-01-02", value: 200, currency: "USD", estimated: true,  confidence: "unreliable",    coverageLabel: "1 of 19 positions valued" },
      { date: "2026-01-03", value: 300, currency: "USD", estimated: true,  confidence: "reconstructed", coverageLabel: null },
    ];
    const out = convertPortfolioValueSeries(src, walkedBack, "2026-01-03");
    check("a walked-back rate degrades observed → reconstructed", out[0].confidence === "reconstructed");
    check("an unreliable point is NOT rescued to reconstructed", out[1].confidence === "unreliable");
    check("a reconstructed point does not become unreliable", out[2].confidence === "reconstructed");
    check("the coverage label survives conversion", out[1].coverageLabel === "1 of 19 positions valued");
    check("values still convert", Math.abs(out[0].value - 50) < 1e-9);
  }

  // ── 5. The chart layer's precedence ───────────────────────────────────────
  console.log("5. basisOf — one derivation site, explicit basis wins");
  {
    check("no basis → falls back to `estimated` (Debt/Liquidity/Wealth unchanged)",
      basisOf({ estimated: true }) === "reconstructed" && basisOf({ estimated: false }) === "observed");
    check("explicit basis wins over estimated",
      basisOf({ estimated: true, basis: "unreliable" }) === "unreliable");
    check("explicit observed wins even when estimated is true",
      basisOf({ estimated: true, basis: "observed" }) === "observed");
  }

  // ── 6. The chart layer stays dumb ─────────────────────────────────────────
  console.log("6. NEGATIVE guard — no confidence logic inside the chart component");
  {
    const CHART = readFileSync(path.join(process.cwd(), "components/space/widgets/charts/TrendChart.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    check("TrendChart never reads a completeness tier", !/completenessTier|CompletenessTier/.test(CHART));
    check("TrendChart never reads component counts",
      !/contributingComponentCount|totalComponentCount/.test(CHART));
    check("TrendChart never imports the snapshot completeness core",
      !/snapshot-completeness/.test(CHART));
    check("TrendChart builds no coverage sentence of its own",
      !/positions valued/.test(CHART));

    const HIST = readFileSync(path.join(process.cwd(), "components/space/widgets/investments/InvestmentsBalanceHistory.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    check("the Investments adapter classifies nothing either",
      !/completenessTier|contributingComponentCount|positions valued/.test(HIST));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll portfolio-series confidence guards passed.");
  process.exit(0);
}

main();
