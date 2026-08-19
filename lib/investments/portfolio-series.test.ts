/**
 * lib/investments/portfolio-series.test.ts  (SD-4 FU-CHART; consolidated)
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
 *
 * Consolidated file: absorbs
 *   - portfolio-series.crypto-state.test.ts (V26-CRYPTO-STATUS-1 era) — the
 *     series omits points whose crypto may not be asserted, reading the
 *     CANONICAL state resolved at the snapshot boundary (incl. route scan);
 *   - portfolio-series.confidence.test.ts (V26-INVESTMENTS-HISTORY era) — the
 *     chart's confidence contract: persisted-completeness classification and
 *     the pre-column no-op guarantee.
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
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
// Match CODE, not prose, in source scans: the modules deliberately EXPLAIN in
// comments why they no longer carry retired concepts, so a raw text search
// would flag its own documentation. Comments are stripped first (the same
// discipline the marketing-boundary directive scan uses).
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

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
  const series: PortfolioValuePoint[] = [
    { date: "2025-01-01", value: 100, currency: "USD", estimated: false, confidence: "observed",      coverageLabel: null },
    { date: "2025-02-01", value: 200, currency: "USD", estimated: true,  confidence: "reconstructed", coverageLabel: "3 of 4 positions valued" },
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

// ═══ Merged from portfolio-series.crypto-state.test.ts (V26-CRYPTO-STATUS-1 era) ═══
//
// The Investments series omits a point whose crypto may not be asserted,
// reading the CANONICAL state resolved at the snapshot boundary. (That file
// replaced the V26-CRYPTO-FLOOR-1 version, which decided the same question
// from the BTC price floor — unsafe as well as duplicated: the floor moves
// when a wider provider tier is configured, and acquiring older prices does
// not rewrite snapshots, so it would have silently re-blessed every stale
// row. The series now reads `cryptoAssertable` and derives nothing.)
{
  console.log("4. V26-CRYPTO-STATUS-1 — Investments series reads canonical crypto state");

  const cryptoRow = (over: Partial<SnapshotSeriesRow> = {}): SnapshotSeriesRow => ({
    date: "2025-01-15", totalInvestments: 5_049, totalCrypto: 15_516.70,
    isEstimated: true, cryptoAssertable: false, ...over,
  });
  const dates = (rows: readonly SnapshotSeriesRow[]): string[] =>
    buildPortfolioValueSeries(rows, "USD").map((p) => p.date);

  // A — `unavailable` (resolved ⇒ cryptoAssertable false) is omitted.
  check("A. unavailable crypto point is omitted",
    dates([cryptoRow()]).length === 0);

  // B — `legacy-unrecorded` resolves to the same assertability, so the series
  // needs no second rule to catch it. This is the shape of all 378 stale rows
  // before they were stamped, and of any row written before the status column.
  check("B. legacy-unrecorded material crypto point is omitted",
    dates([cryptoRow({ date: "2024-07-21", totalCrypto: 15_516.70, cryptoAssertable: false })]).length === 0);

  // C — `supported`.
  {
    const out = buildPortfolioValueSeries(
      [cryptoRow({ date: "2025-08-03", totalInvestments: 1_714.47, totalCrypto: 27_085.14, cryptoAssertable: true })], "USD");
    check("C. supported point is retained", out.length === 1);
    check("C. …with value = investments + crypto, unchanged",
      out[0].value === 1_714.47 + 27_085.14, String(out[0].value));
  }

  // D — an OBSERVED row resolves assertable at the boundary (observation is
  // checked FIRST there), so it rides through regardless of any status.
  check("D. observed point is retained",
    dates([cryptoRow({ date: "2026-07-19", isEstimated: false, cryptoAssertable: true })]).length === 1);

  // E — `none`: no material crypto is a legitimate zero and stays assertable.
  check("E. no-crypto point is retained",
    dates([cryptoRow({ totalCrypto: 0, cryptoAssertable: true })]).length === 1);
  check("E. stock-only Space is unaffected",
    dates([cryptoRow({ totalCrypto: 0, cryptoAssertable: true }), cryptoRow({ date: "2025-01-16", totalCrypto: 0, cryptoAssertable: true })]).length === 2);

  // F — an ABSENT field is the one backward-compatible case, and it is
  // deliberately permissive: a caller predating the resolved DTO behaves exactly
  // as it did before. Only an explicit `false` omits.
  {
    const legacyCaller: SnapshotSeriesRow = { date: "2024-07-21", totalInvestments: 11.65, totalCrypto: 15_516.70 };
    check("F. absent cryptoAssertable ⇒ prior behaviour (point kept)",
      dates([legacyCaller]).length === 1);
    check("F. only an explicit false omits",
      dates([{ ...legacyCaller, cryptoAssertable: true }]).length === 1 &&
      dates([{ ...legacyCaller, cryptoAssertable: false }]).length === 0);
  }

  // G — fxMiss remains an independent rule; the two compose.
  check("G. fxMiss still drops an otherwise-assertable point",
    dates([cryptoRow({ date: "2026-01-01", cryptoAssertable: true, fxMiss: true })]).length === 0);
  check("G. …and an unassertable point is dropped without fxMiss",
    dates([cryptoRow({ cryptoAssertable: false })]).length === 0);

  // H — the supported CoinGecko year is byte-identical to a run with no crypto
  // rule at all: the omission must touch nothing inside it.
  {
    const year: SnapshotSeriesRow[] = [
      cryptoRow({ date: "2025-08-03", totalCrypto: 27_085.14, cryptoAssertable: true }),
      cryptoRow({ date: "2026-01-01", totalCrypto: 21_070.78, cryptoAssertable: true }),
      cryptoRow({ date: "2026-07-19", totalCrypto: 15_516.70, isEstimated: false, cryptoAssertable: true }),
      cryptoRow({ date: "2026-08-02", totalCrypto: 15_247.12, cryptoAssertable: true }),
    ];
    const withField = buildPortfolioValueSeries(year, "USD");
    const withoutField = buildPortfolioValueSeries(
      year.map(({ cryptoAssertable: _drop, ...rest }) => rest), "USD");
    check("H. supported-year series is byte-identical",
      JSON.stringify(withField) === JSON.stringify(withoutField));
    check("H. …and ordering is preserved",
      JSON.stringify(withField.map((p) => p.date)) ===
      JSON.stringify(["2025-08-03", "2026-01-01", "2026-07-19", "2026-08-02"]));
  }

  // I — the real shape: contaminated below-floor rows omitted, supported kept.
  {
    const mixed: SnapshotSeriesRow[] = [
      cryptoRow({ date: "2024-07-21", cryptoAssertable: false }),
      cryptoRow({ date: "2025-07-30", cryptoAssertable: false }),
      cryptoRow({ date: "2025-08-02", cryptoAssertable: false }),
      cryptoRow({ date: "2025-08-03", totalCrypto: 27_085.14, cryptoAssertable: true }),
      cryptoRow({ date: "2025-08-04", totalCrypto: 27_485.25, cryptoAssertable: true }),
    ];
    check("I. contaminated rows omitted, series starts at the first assertable date",
      JSON.stringify(dates(mixed)) === JSON.stringify(["2025-08-03", "2025-08-04"]), JSON.stringify(dates(mixed)));
  }

  // J — STATIC: no floor, provider, date rule or materiality threshold may
  // remain anywhere in the Investments series path (route-file scan included).
  {
    const series = stripComments(readFileSync("lib/investments/portfolio-series.ts", "utf8"));
    const route  = stripComments(readFileSync("app/api/spaces/[id]/investments/space-data/route.ts", "utf8"));
    check("J. portfolio-series mentions no provider", !/coingecko/i.test(series));
    check("J. portfolio-series has no price-floor concept", !/priceFloor|FloorISO|historicalDepth/i.test(series));
    check("J. portfolio-series carries no materiality threshold",
      !/MATERIALITY|EPSILON/i.test(series));
    check("J. portfolio-series never reads the raw stored status column",
      !/cryptoValuationStatus/.test(series));
    check("J. the route no longer reads the BTC price floor",
      !/readBtcPriceFloorISO/.test(route) && !/coingecko/i.test(route));
  }
}

// ═══ Merged from portfolio-series.confidence.test.ts (V26-INVESTMENTS-HISTORY era) ═══
//
// The chart's confidence contract. The series builder is where a stored
// snapshot's persisted completeness becomes a state the chart can draw. This
// suite pins BOTH halves of that:
//   - the classification is correct for recorded rows, and
//   - it is a NO-OP for every row written before the completeness columns
//     existed, so shipping this changes nothing until a regeneration runs.
{
  const confRow = (over: Partial<SnapshotSeriesRow> = {}): SnapshotSeriesRow =>
    ({ date: "2026-06-24", totalInvestments: 100, totalCrypto: 0, ...over });
  const one = (r: SnapshotSeriesRow): PortfolioValuePoint => buildPortfolioValueSeries([r], "USD")[0];

  // ── 5.1. The no-op guarantee ──────────────────────────────────────────────
  console.log("5.1. Rows written before the completeness columns existed are unchanged");
  {
    const legacyEstimated = one(confRow({ isEstimated: true }));
    check("legacy estimated row is reconstructed, NOT unreliable",
      legacyEstimated.confidence === "reconstructed");
    check("no coverage label is invented", legacyEstimated.coverageLabel === null);
    check("the old `estimated` field is untouched", legacyEstimated.estimated === true);

    const legacyObserved = one(confRow({ isEstimated: false }));
    check("legacy observed row is observed", legacyObserved.confidence === "observed");
    check("`estimated` still false", legacyObserved.estimated === false);

    // The whole current history, in one assertion: today every row resolves
    // tier `unknown` with recorded=false, and none of them may go unreliable.
    const wholeHistory = buildPortfolioValueSeries(
      [confRow({ date: "2026-06-24", isEstimated: true, completenessTier: "unknown", completenessRecorded: false }),
       confRow({ date: "2026-06-25", isEstimated: true, completenessTier: "unknown", completenessRecorded: false }),
       confRow({ date: "2026-07-19", isEstimated: false, completenessTier: "observed", completenessRecorded: false })],
      "USD");
    check("an un-regenerated history contains NO unreliable points",
      wholeHistory.every((p) => p.confidence !== "unreliable"));
    check("and still distinguishes observed from reconstructed",
      wholeHistory.map((p) => p.confidence).join(",") === "reconstructed,reconstructed,observed");
  }

  // ── 5.2. Recorded rows classify ───────────────────────────────────────────
  console.log("5.2. Recorded completeness drives the classification");
  {
    const mostlyUnknown = one(confRow({
      isEstimated: true, completenessTier: "unknown", completenessRecorded: true,
      contributingComponentCount: 1, totalComponentCount: 19,
    }));
    const complete = one(confRow({
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
      one(confRow({ isEstimated: true, completenessTier: "incomplete", completenessRecorded: true })).confidence === "unreliable");
    check("recorded derived is a legitimate estimate",
      one(confRow({ isEstimated: true, completenessTier: "derived", completenessRecorded: true })).confidence === "reconstructed");
  }

  // ── 5.3. Values are untouched ─────────────────────────────────────────────
  console.log("5.3. Confidence never changes a value or drops a point");
  {
    const rows = [
      confRow({ date: "2026-06-24", totalInvestments: 11.65, totalCrypto: 14624.59, isEstimated: true, completenessTier: "unknown", completenessRecorded: true, contributingComponentCount: 1, totalComponentCount: 19 }),
      confRow({ date: "2026-07-19", totalInvestments: 5069.02, totalCrypto: 15516.70, isEstimated: false }),
    ];
    const s = buildPortfolioValueSeries(rows, "USD");
    check("no point is dropped for being unreliable", s.length === 2);
    check("value is still investments + crypto", near(s[0].value, 11.65 + 14624.59));
    check("the observed point is unchanged", near(s[1].value, 5069.02 + 15516.70));
    check("an fxMiss point is still the only thing dropped",
      buildPortfolioValueSeries([...rows, confRow({ date: "2026-07-20", fxMiss: true })], "USD").length === 2);
  }

  // ── 5.4. FX conversion can only degrade ───────────────────────────────────
  console.log("5.4. Display conversion degrades confidence, never rescues it");
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
    check("values still convert", near(out[0].value, 50));
  }

  // ── 5.5. The chart layer's precedence ─────────────────────────────────────
  console.log("5.5. basisOf — one derivation site, explicit basis wins");
  {
    check("no basis → falls back to `estimated` (Debt/Liquidity/Wealth unchanged)",
      basisOf({ estimated: true }) === "reconstructed" && basisOf({ estimated: false }) === "observed");
    check("explicit basis wins over estimated",
      basisOf({ estimated: true, basis: "unreliable" }) === "unreliable");
    check("explicit observed wins even when estimated is true",
      basisOf({ estimated: true, basis: "observed" }) === "observed");
  }

  // ── 5.6. The chart layer stays dumb ───────────────────────────────────────
  console.log("5.6. NEGATIVE guard — no confidence logic inside the chart component");
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
}

if (failures > 0) { console.error(`\n${failures} portfolio-series check(s) failed`); process.exit(1); }
console.log("\nAll portfolio-series checks passed");
