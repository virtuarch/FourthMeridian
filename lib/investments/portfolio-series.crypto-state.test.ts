/**
 * lib/investments/portfolio-series.crypto-state.test.ts
 *
 * V26-CRYPTO-STATUS-1 — the Investments series omits a point whose crypto may
 * not be asserted, reading the CANONICAL state resolved at the snapshot
 * boundary. Standalone tsx, pure (no DB).
 *
 * This file replaces the V26-CRYPTO-FLOOR-1 version, which decided the same
 * question from the BTC price floor. That rule was unsafe as well as duplicated:
 * the floor moves when a wider provider tier is configured, and acquiring older
 * prices does not rewrite snapshots — so it would have silently re-blessed every
 * stale row. The series now reads `cryptoAssertable` and derives nothing.
 */

import {
  buildPortfolioValueSeries, type SnapshotSeriesRow,
} from "./portfolio-series";
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const row = (over: Partial<SnapshotSeriesRow> = {}): SnapshotSeriesRow => ({
  date: "2025-01-15", totalInvestments: 5_049, totalCrypto: 15_516.70,
  isEstimated: true, cryptoAssertable: false, ...over,
});

const dates = (rows: readonly SnapshotSeriesRow[]): string[] =>
  buildPortfolioValueSeries(rows, "USD").map((p) => p.date);

function main(): void {
  console.log("V26-CRYPTO-STATUS-1 — Investments series reads canonical crypto state\n");

  // A — `unavailable` (resolved ⇒ cryptoAssertable false) is omitted.
  check("A. unavailable crypto point is omitted",
    dates([row()]).length === 0);

  // B — `legacy-unrecorded` resolves to the same assertability, so the series
  // needs no second rule to catch it. This is the shape of all 378 stale rows
  // before they were stamped, and of any row written before the status column.
  check("B. legacy-unrecorded material crypto point is omitted",
    dates([row({ date: "2024-07-21", totalCrypto: 15_516.70, cryptoAssertable: false })]).length === 0);

  // C — `supported`.
  {
    const out = buildPortfolioValueSeries(
      [row({ date: "2025-08-03", totalInvestments: 1_714.47, totalCrypto: 27_085.14, cryptoAssertable: true })], "USD");
    check("C. supported point is retained", out.length === 1);
    check("C. …with value = investments + crypto, unchanged",
      out[0].value === 1_714.47 + 27_085.14, String(out[0].value));
  }

  // D — an OBSERVED row resolves assertable at the boundary (observation is
  // checked FIRST there), so it rides through regardless of any status.
  check("D. observed point is retained",
    dates([row({ date: "2026-07-19", isEstimated: false, cryptoAssertable: true })]).length === 1);

  // E — `none`: no material crypto is a legitimate zero and stays assertable.
  check("E. no-crypto point is retained",
    dates([row({ totalCrypto: 0, cryptoAssertable: true })]).length === 1);
  check("E. stock-only Space is unaffected",
    dates([row({ totalCrypto: 0, cryptoAssertable: true }), row({ date: "2025-01-16", totalCrypto: 0, cryptoAssertable: true })]).length === 2);

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
    dates([row({ date: "2026-01-01", cryptoAssertable: true, fxMiss: true })]).length === 0);
  check("G. …and an unassertable point is dropped without fxMiss",
    dates([row({ cryptoAssertable: false })]).length === 0);

  // H — the supported CoinGecko year is byte-identical to a run with no crypto
  // rule at all: the omission must touch nothing inside it.
  {
    const year: SnapshotSeriesRow[] = [
      row({ date: "2025-08-03", totalCrypto: 27_085.14, cryptoAssertable: true }),
      row({ date: "2026-01-01", totalCrypto: 21_070.78, cryptoAssertable: true }),
      row({ date: "2026-07-19", totalCrypto: 15_516.70, isEstimated: false, cryptoAssertable: true }),
      row({ date: "2026-08-02", totalCrypto: 15_247.12, cryptoAssertable: true }),
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
      row({ date: "2024-07-21", cryptoAssertable: false }),
      row({ date: "2025-07-30", cryptoAssertable: false }),
      row({ date: "2025-08-02", cryptoAssertable: false }),
      row({ date: "2025-08-03", totalCrypto: 27_085.14, cryptoAssertable: true }),
      row({ date: "2025-08-04", totalCrypto: 27_485.25, cryptoAssertable: true }),
    ];
    check("I. contaminated rows omitted, series starts at the first assertable date",
      JSON.stringify(dates(mixed)) === JSON.stringify(["2025-08-03", "2025-08-04"]), JSON.stringify(dates(mixed)));
  }

  // J — STATIC: no floor, provider, date rule or materiality threshold may
  // remain anywhere in the Investments series path.
  {
    // Match CODE, not prose: the modules deliberately EXPLAIN in comments why
    // they no longer carry these concepts, so a raw text search would flag its
    // own documentation. Comments are stripped first (the same discipline the
    // marketing-boundary directive scan uses).
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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

  console.log(failures === 0 ? "\nAll canonical crypto-state guards passed." : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
