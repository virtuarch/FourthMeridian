/**
 * lib/prices/coverage-binding.core.test.ts
 *
 * V26-PRICE-2 — pure coverage-binding fixtures. Standalone tsx script:
 *
 *     npx tsx lib/prices/coverage-binding.core.test.ts
 *
 * Covers the four policies the binding owns and the planner does not:
 * priceability, calendar selection, quote currency (OI-1), and provider floor.
 *
 * Every fake adapter's fetchDailyCloses THROWS. If any coverage path ever
 * reaches a provider, these tests fail loudly instead of quietly making a
 * network call — the read-only guarantee asserted rather than asserted-about.
 */

import { PriceBasis } from "@prisma/client";
import type { PriceProviderAdapter, PriceRegistry } from "./types";
import {
  resolveInstrumentCoverage,
  resolvePriceability,
  resolveProviderFloorISO,
  selectCalendar,
  DEFAULT_QUOTE_CURRENCY,
  NO_CALENDAR_ID,
  type InstrumentMeta,
  type ObservedPriceDate,
} from "./coverage-binding.core";
import { US_EQUITY_CALENDAR_ID } from "@/lib/calendar/us-equity-calendar";
import { CRYPTO_CALENDAR_ID } from "@/lib/calendar/crypto-calendar";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function meta(over: Partial<InstrumentMeta> = {}): InstrumentMeta {
  return {
    instrumentId:         "inst_1",
    assetClass:           "EQUITY",
    tickerSymbol:         "AAPL",
    marketIdentifierCode: "XNAS",
    currency:             "USD",
    ...over,
  };
}

/** A provider that cannot be called without failing the suite. */
function fakeAdapter(source: string, depth: string, bases: PriceBasis[]): PriceProviderAdapter {
  return {
    source,
    historicalDepth: depth,
    supportedBases: () => bases,
    fetchDailyCloses: async () => {
      throw new Error(`[test] a read-only coverage path called provider "${source}"`);
    },
  };
}
const registryOf = (...adapters: PriceProviderAdapter[]): PriceRegistry => ({ adapters });

const usd = (dates: readonly string[]): ObservedPriceDate[] =>
  dates.map((d) => ({ dateISO: d, currency: "USD" }));

// Mon 2026-01-05 → Fri 2026-01-16, ten US trading days (no holiday inside).
const WEEK2_FROM = "2026-01-05";
const WEEK2_TO   = "2026-01-16";
const TRADING = [
  "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09",
  "2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15", "2026-01-16",
];

function resolve(over: {
  meta?: InstrumentMeta; observed?: ObservedPriceDate[];
  from?: string; to?: string; floor?: string | null;
} = {}) {
  return resolveInstrumentCoverage({
    meta:             over.meta ?? meta(),
    basis:            PriceBasis.RAW_CLOSE,
    requestedFromISO: over.from ?? WEEK2_FROM,
    requestedToISO:   over.to   ?? WEEK2_TO,
    observed:         over.observed ?? usd(TRADING),
    providerFloorISO: over.floor === undefined ? null : over.floor,
  });
}

function main(): void {
  // ── 1. Priceability ───────────────────────────────────────────────────────
  console.log("1. priceability");
  {
    check("EQUITY with a ticker is priceable", resolvePriceability(meta()).priceable);
    check("ETF is priceable", resolvePriceability(meta({ assetClass: "ETF", marketIdentifierCode: "ARCX" })).priceable);
    check("CRYPTO is priceable",
      resolvePriceability(meta({ assetClass: "CRYPTO", tickerSymbol: "BTC", marketIdentifierCode: null })).priceable);

    const cash = resolvePriceability(meta({ assetClass: "CASH", tickerSymbol: "CUR:USD" }));
    check("CASH is NOT_PRICEABLE even though it carries a ticker",
      !cash.priceable && cash.reason === "NOT_PRICEABLE");

    const opt = resolvePriceability(meta({ assetClass: "OPTION", tickerSymbol: "NVDA260522C00232500" }));
    check("OPTION is NOT_PRICEABLE (no registered adapter serves options)",
      !opt.priceable && opt.reason === "NOT_PRICEABLE");

    const nul = resolvePriceability(meta({ tickerSymbol: null }));
    check("EQUITY without a ticker is NO_PROVIDER_SYMBOL",
      !nul.priceable && nul.reason === "NO_PROVIDER_SYMBOL");

    const blank = resolvePriceability(meta({ tickerSymbol: "   " }));
    check("a whitespace ticker is NO_PROVIDER_SYMBOL",
      !blank.priceable && blank.reason === "NO_PROVIDER_SYMBOL");

    const unk = resolvePriceability(meta({ assetClass: "UNKNOWN" }));
    check("an unsupported class is NOT_PRICEABLE",
      !unk.priceable && unk.reason === "NOT_PRICEABLE");
  }

  // ── 2. Calendar selection ─────────────────────────────────────────────────
  console.log("2. calendar selection");
  {
    const us = selectCalendar(meta());
    check("EQUITY on XNAS → US equity calendar",
      us.kind === "calendar" && us.calendar.id === US_EQUITY_CALENDAR_ID);
    const arca = selectCalendar(meta({ assetClass: "ETF", marketIdentifierCode: "ARCX" }));
    check("ETF on ARCX → US equity calendar",
      arca.kind === "calendar" && arca.calendar.id === US_EQUITY_CALENDAR_ID);
    const btc = selectCalendar(meta({ assetClass: "CRYPTO", marketIdentifierCode: null }));
    check("CRYPTO → 24/7 calendar (MIC irrelevant)",
      btc.kind === "calendar" && btc.calendar.id === CRYPTO_CALENDAR_ID);

    const noMic = selectCalendar(meta({ marketIdentifierCode: null }));
    check("EQUITY without a MIC → NO_CALENDAR_FOR_MARKET, never a US guess",
      noMic.kind === "failure" && noMic.failure.code === "NO_CALENDAR_FOR_MARKET");
    const foreign = selectCalendar(meta({ marketIdentifierCode: "XLON" }));
    check("a London listing → NO_CALENDAR_FOR_MARKET",
      foreign.kind === "failure" && foreign.failure.code === "NO_CALENDAR_FOR_MARKET");
    check("the failure carries the diagnosing fields",
      foreign.kind === "failure" && foreign.failure.code === "NO_CALENDAR_FOR_MARKET" &&
      foreign.failure.assetClass === "EQUITY" && foreign.failure.mic === "XLON");
  }

  // ── 3. Provider floor ─────────────────────────────────────────────────────
  console.log("3. provider floor");
  {
    check("an empty registry yields null (unbounded — coverage ≠ acquisition)",
      resolveProviderFloorISO(registryOf(), PriceBasis.RAW_CLOSE) === null);
    check("one adapter yields its declared depth",
      resolveProviderFloorISO(registryOf(fakeAdapter("t", "1990-01-01", [PriceBasis.RAW_CLOSE])),
        PriceBasis.RAW_CLOSE) === "1990-01-01");
    check("two adapters yield the EARLIEST depth, not registry order",
      resolveProviderFloorISO(
        registryOf(
          fakeAdapter("late", "2015-01-01", [PriceBasis.RAW_CLOSE]),
          fakeAdapter("early", "1990-01-01", [PriceBasis.RAW_CLOSE]),
        ), PriceBasis.RAW_CLOSE) === "1990-01-01");
    check("an adapter not serving the basis is ignored",
      resolveProviderFloorISO(
        registryOf(fakeAdapter("nav-only", "1980-01-01", [PriceBasis.NAV])),
        PriceBasis.RAW_CLOSE) === null);
  }

  // ── 4. Reports ────────────────────────────────────────────────────────────
  console.log("4. reports");
  {
    const full = resolve();
    check("a fully covered equity window is complete",
      full.kind === "report" && full.report.state === "complete" &&
      full.report.calendarId === US_EQUITY_CALENDAR_ID);
    check("weekends never count as missing",
      full.kind === "report" && full.report.expectedCount === 10);

    // The whole point: no rows on Sat/Sun, yet coverage is complete.
    check("an equity is NOT partial merely because weekends lack rows",
      full.kind === "report" && full.report.missingRanges.length === 0);

    const gap = resolve({ observed: usd(TRADING.filter((d) => d !== "2026-01-07")) });
    check("an interior missing trading day is detected",
      gap.kind === "report" && gap.report.state === "partial" &&
      eq(gap.report.missingRanges, [{ fromISO: "2026-01-07", toISO: "2026-01-07", expectedDates: 1 }]));

    // A holiday inside the window must not be reported as a gap.
    const mlk = resolveInstrumentCoverage({
      meta: meta(), basis: PriceBasis.RAW_CLOSE,
      requestedFromISO: "2026-01-16", requestedToISO: "2026-01-21",
      observed: usd(["2026-01-16", "2026-01-20", "2026-01-21"]),
      providerFloorISO: null,
    });
    check("MLK Day inside the window is not a gap",
      mlk.kind === "report" && mlk.report.state === "complete" && mlk.report.expectedCount === 3);

    const btc = resolveInstrumentCoverage({
      meta: meta({ instrumentId: "inst_btc", assetClass: "CRYPTO", tickerSymbol: "BTC", marketIdentifierCode: null }),
      basis: PriceBasis.RAW_CLOSE,
      requestedFromISO: "2026-01-09", requestedToISO: "2026-01-12",
      observed: usd(["2026-01-09", "2026-01-12"]),
      providerFloorISO: null,
    });
    check("for BTC the same weekend IS a gap",
      btc.kind === "report" && btc.report.state === "partial" &&
      eq(btc.report.missingRanges, [{ fromISO: "2026-01-10", toISO: "2026-01-11", expectedDates: 2 }]));
    check("BTC's report is stamped with the crypto calendar",
      btc.kind === "report" && btc.report.calendarId === CRYPTO_CALENDAR_ID);
  }

  // ── 5. Quote currency (OI-1) ──────────────────────────────────────────────
  console.log("5. quote currency");
  {
    const mixed = resolve({
      observed: [
        ...usd(TRADING.filter((d) => d !== "2026-01-07")),
        { dateISO: "2026-01-07", currency: "EUR" }, // right date, wrong currency
      ],
    });
    check("a wrong-currency row does NOT count as coverage",
      mixed.kind === "report" && mixed.report.state === "partial" &&
      eq(mixed.report.missingRanges, [{ fromISO: "2026-01-07", toISO: "2026-01-07", expectedDates: 1 }]));
    check("the mismatch is surfaced diagnostically",
      mixed.kind === "report" && mixed.currencyMismatchCount === 1);
    check("the expected currency is reported",
      mixed.kind === "report" && mixed.expectedCurrency === "USD");
    check("a wrong-currency row is not counted as observed either",
      mixed.kind === "report" && mixed.report.observedCount === 9);

    const gbp = resolve({ meta: meta({ currency: "GBP" }), observed: usd(TRADING) });
    check("expected currency follows the instrument, not a hardcoded USD",
      gbp.kind === "report" && gbp.expectedCurrency === "GBP" && gbp.currencyMismatchCount === 10);
    check("every observation mismatching ⇒ nothing observed ⇒ NO_COVERAGE",
      gbp.kind === "report" && gbp.report.reasons.includes("NO_COVERAGE"));

    const nul = resolve({ meta: meta({ currency: null }) });
    check("a null instrument currency falls back to the declared default",
      nul.kind === "report" && nul.expectedCurrency === DEFAULT_QUOTE_CURRENCY);
  }

  // ── 6. Unavailable instruments ────────────────────────────────────────────
  console.log("6. unavailable instruments");
  {
    const cash = resolve({ meta: meta({ assetClass: "CASH", tickerSymbol: "CUR:USD" }), observed: [] });
    check("CASH → unavailable, no acquisition targets",
      cash.kind === "report" && cash.report.state === "unavailable" &&
      cash.report.missingRanges.length === 0 &&
      eq(cash.report.reasons, ["NOT_PRICEABLE"]));
    check("no calendar is claimed for an unpriceable instrument",
      cash.kind === "report" && cash.report.calendarId === NO_CALENDAR_ID &&
      cash.report.expectedCount === 0);

    // Production had 7 price rows against CUR:USD — that is itself the finding.
    const strayCash = resolve({
      meta: meta({ assetClass: "CASH", tickerSymbol: "CUR:USD" }),
      observed: usd(["2026-01-05", "2026-01-06"]),
    });
    check("stray rows on an unpriceable instrument surface as a diagnostic",
      strayCash.kind === "report" &&
      eq(strayCash.report.reasons, ["NOT_PRICEABLE", "UNEXPECTED_OBSERVATION"]) &&
      strayCash.report.unexpectedCount === 2);

    const noSym = resolve({ meta: meta({ tickerSymbol: null }), observed: [] });
    check("a null-ticker equity → unavailable / NO_PROVIDER_SYMBOL",
      noSym.kind === "report" && noSym.report.state === "unavailable" &&
      eq(noSym.report.reasons, ["NO_PROVIDER_SYMBOL"]));
    check("priceability is decided BEFORE calendar selection",
      noSym.kind === "report" && noSym.report.calendarId === NO_CALENDAR_ID);
  }

  // ── 7. Calendar failures are not coverage reports ─────────────────────────
  console.log("7. calendar failures are a different kind");
  {
    const horizon = resolve({ from: "2023-06-01", to: "2023-06-30" });
    check("a pre-horizon window yields calendar-unavailable, NOT a report",
      horizon.kind === "calendar-unavailable" && horizon.failure.code === "HORIZON_EXCEEDED");
    check("the horizon failure discloses both bounds and the request",
      horizon.kind === "calendar-unavailable" && horizon.failure.code === "HORIZON_EXCEEDED" &&
      horizon.failure.calendarId === US_EQUITY_CALENDAR_ID &&
      horizon.failure.supportedFromISO === "2024-01-01" &&
      horizon.failure.supportedThroughISO === "2027-12-31" &&
      horizon.failure.requestedFromISO === "2023-06-01");

    check("a post-horizon window also fails",
      resolve({ from: "2027-12-01", to: "2028-02-01" }).kind === "calendar-unavailable");

    const foreign = resolve({ meta: meta({ marketIdentifierCode: "XLON" }) });
    check("an unknown market yields calendar-unavailable",
      foreign.kind === "calendar-unavailable" && foreign.failure.code === "NO_CALENDAR_FOR_MARKET");

    // Crypto is unbounded, so the same window that breaks the equity calendar works.
    const oldBtc = resolve({
      meta: meta({ assetClass: "CRYPTO", tickerSymbol: "BTC", marketIdentifierCode: null }),
      from: "2013-01-01", to: "2013-01-05", observed: [],
    });
    check("crypto has no horizon — a 2013 window still reports",
      oldBtc.kind === "report" && oldBtc.report.state === "partial" &&
      oldBtc.report.expectedCount === 5);
  }

  // ── 8. Determinism ────────────────────────────────────────────────────────
  console.log("8. determinism");
  {
    const base = usd(TRADING.filter((d) => d !== "2026-01-07"));
    const shuffled = [...base].reverse().concat(base); // reordered + duplicated
    check("shuffled and duplicated observations → byte-identical output",
      JSON.stringify(resolve({ observed: shuffled })) === JSON.stringify(resolve({ observed: base })));
    check("repeat invocation → byte-identical output",
      JSON.stringify(resolve()) === JSON.stringify(resolve()));

    const keys = [
      Object.keys(resolve()),
      Object.keys(resolve({ meta: meta({ assetClass: "CASH", tickerSymbol: "CUR:USD" }) })),
    ].map((k) => k.join(","));
    check("report envelopes share one key order", new Set(keys).size === 1, keys.join(" | "));
  }

  console.log(failures === 0 ? "\nAll coverage-binding core checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
