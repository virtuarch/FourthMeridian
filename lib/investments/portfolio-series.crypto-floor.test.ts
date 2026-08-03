/**
 * lib/investments/portfolio-series.crypto-floor.test.ts
 *
 * V26-CRYPTO-FLOOR-1 — the Investments series refuses a point whose crypto is a
 * stale carried balance. Standalone tsx, pure (no DB).
 *
 * Below the archive's earliest BTC price no crypto figure can have come from
 * evidence, so whatever is stored there is the wallet's then-current USD balance
 * carried backward. This series' value is investments + crypto, so an unknown
 * crypto makes the SUM unknown — the point is omitted, never asserted.
 */

import {
  buildPortfolioValueSeries, isUnvaluedLegacyCrypto, CRYPTO_MATERIALITY_EPSILON,
  type SnapshotSeriesRow,
} from "./portfolio-series";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const FLOOR = "2025-08-03"; // the archive's earliest stored BTC RAW_CLOSE date

const row = (over: Partial<SnapshotSeriesRow> = {}): SnapshotSeriesRow => ({
  date: "2025-01-15", totalInvestments: 5_049, totalCrypto: 15_516.70, isEstimated: true, ...over,
});

const dates = (rows: readonly SnapshotSeriesRow[]): string[] =>
  buildPortfolioValueSeries(rows, "USD", { cryptoPriceFloorISO: FLOOR }).map((p) => p.date);

function main(): void {
  console.log("V26-CRYPTO-FLOOR-1 — Investments series crypto-floor refusal\n");

  // 1 — a below-floor ESTIMATED row with material stale crypto is not a supported
  // investment value and must not appear.
  check("1. below-floor estimated row with stale crypto → omitted",
    dates([row()]).length === 0);
  check("1. …and the predicate says so directly",
    isUnvaluedLegacyCrypto(row(), FLOOR));

  // 3 — a supported date on/after the floor is included and unchanged.
  {
    const r = row({ date: "2025-08-03", totalCrypto: 27_085.14, totalInvestments: 1_714.47 });
    const out = buildPortfolioValueSeries([r], "USD", { cryptoPriceFloorISO: FLOOR });
    check("3. on-floor date included", out.length === 1 && out[0].date === "2025-08-03");
    check("3. …with value = investments + crypto, unchanged",
      out[0].value === 1_714.47 + 27_085.14, String(out[0].value));
    check("3. after-floor date included",
      dates([row({ date: "2026-01-01", totalCrypto: 21_070.78 })]).length === 1);
  }

  // 4 — a FROZEN OBSERVED below-floor row is a real balance observation, valid
  // regardless of price coverage. Other users' seeded spaces are exactly this.
  check("4. below-floor OBSERVED row → kept (observation, not a carried estimate)",
    dates([row({ isEstimated: false, totalCrypto: 4_847 })]).length === 1);
  check("4. …and the predicate agrees",
    !isUnvaluedLegacyCrypto(row({ isEstimated: false }), FLOOR));

  // 5 — a Space with no crypto is untouched, whatever the date.
  check("5. below-floor row with zero crypto → kept",
    dates([row({ totalCrypto: 0 })]).length === 1);
  check("5. immaterial crypto is not an unvalued component",
    !isUnvaluedLegacyCrypto(row({ totalCrypto: CRYPTO_MATERIALITY_EPSILON }), FLOOR));

  // 6 — a legacy row with NO metadata is judged on evidence (date vs floor), not
  // on the absence of metadata. 375 of the affected rows have a null tier.
  {
    const legacy: SnapshotSeriesRow = { date: "2024-07-21", totalInvestments: 11.65, totalCrypto: 15_516.70 };
    check("6. legacy row, no metadata, below floor + material crypto → omitted",
      dates([legacy]).length === 0);
    const legacyAfter: SnapshotSeriesRow = { date: "2026-02-01", totalInvestments: 100, totalCrypto: 15_000 };
    check("6. legacy row ABOVE the floor is NOT rejected for lacking metadata",
      dates([legacyAfter]).length === 1);
  }

  // 7 — no line bridge: the refused interval leaves a real date hole at the
  // series' start, and the surviving points keep their own dates (the chart's
  // gap doctrine works off date spacing, so it cannot bridge what isn't there).
  {
    const window: SnapshotSeriesRow[] = [
      row({ date: "2025-07-30" }), row({ date: "2025-08-01" }), row({ date: "2025-08-02" }),
      row({ date: "2025-08-03", totalCrypto: 27_085.14 }),
      row({ date: "2025-08-04", totalCrypto: 27_485.25 }),
    ];
    const out = dates(window);
    check("7. every below-floor point removed, every supported point kept",
      JSON.stringify(out) === JSON.stringify(["2025-08-03", "2025-08-04"]), JSON.stringify(out));
    check("7. the series now STARTS at the floor — nothing bridges to it",
      out[0] === FLOOR);
  }

  // 8 — absent a floor the refusal is inert, so every existing caller is
  // byte-for-byte unchanged. This is what keeps Net Worth / Liquidity / Debt /
  // AI / export (which read the snapshot directly) out of this change entirely.
  {
    const window = [row(), row({ date: "2025-08-03", totalCrypto: 27_085.14 })];
    const noOpts = buildPortfolioValueSeries(window, "USD");
    const nullFloor = buildPortfolioValueSeries(window, "USD", { cryptoPriceFloorISO: null });
    check("8. no options → unchanged (both points kept)", noOpts.length === 2);
    check("8. null floor → unchanged", nullFloor.length === 2);
    check("8. …and identical to the pre-change output",
      JSON.stringify(noOpts) === JSON.stringify(nullFloor));
  }

  // fxMiss still wins independently — the two omission rules compose.
  check("fxMiss point still dropped above the floor",
    dates([row({ date: "2026-01-01", fxMiss: true })]).length === 0);

  // The stored fields themselves are never mutated by this pure reshape.
  {
    const r = row();
    const before = JSON.stringify(r);
    buildPortfolioValueSeries([r], "USD", { cryptoPriceFloorISO: FLOOR });
    check("2. the row's own fields (stocks/cash/debt) are untouched by the series",
      JSON.stringify(r) === before);
  }

  console.log(failures === 0 ? "\nAll crypto-floor guards passed." : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
