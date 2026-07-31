/**
 * lib/prices/coverage-binding.core.ts
 *
 * V26-PRICE-2 — the PURE half of the coverage binding: instrument metadata plus
 * already-loaded observations in, a CoverageReport or a CalendarFailure out. No
 * Prisma, no network, no clock (the *-core.ts convention). The I/O half is
 * coverage-binding.ts.
 *
 * This module owns the POLICY the planner deliberately does not:
 *   - priceability      — can this instrument have a market price at all?
 *   - calendar selection — which calendar governs its expected dates?
 *   - quote currency     — which observations count as evidence?
 *   - provider floor     — how far back can any registered adapter reach?
 *
 * coverage.core.ts takes all four as data and stays free of instrument-model and
 * provider knowledge; this module is where that knowledge is allowed to live.
 *
 * ── Two outcomes, not one ────────────────────────────────────────────────────
 * A request either yields a coverage report or a statement that expectations
 * could not be formed. HORIZON_EXCEEDED and NO_CALENDAR_FOR_MARKET are NOT
 * coverage reasons: a report computed over fabricated expectations would be
 * worse than no report, because every unexpected weekday would read as a real
 * gap. The discriminated union forces callers to handle both.
 *
 * ── Quote currency (OI-1) ────────────────────────────────────────────────────
 * coverage.core.ts is dates-only by design. Currency is checked HERE, at the
 * boundary that already knows the instrument's expected quote currency: an
 * observation in another currency does NOT count as coverage (its date becomes
 * missing, which is correct — there is no usable evidence for that date) and is
 * surfaced as `currencyMismatchCount` on the envelope. This keeps the planner
 * free of currency policy without letting a mismatched row masquerade as
 * evidence.
 */

import type { PriceBasis } from "@prisma/client";
import type { PriceProviderAdapter, PriceRegistry } from "./types";
import {
  coverageFor,
  type CoverageReport,
  type Priceability,
} from "./coverage.core";
import {
  calendarCoversWindow,
  horizonFailure,
  type BoundedTradingCalendar,
  type CalendarFailure,
} from "@/lib/calendar/trading-calendar";
import { cryptoCalendar } from "@/lib/calendar/crypto-calendar";
import { isUsEquityMarket, usEquityCalendar } from "@/lib/calendar/us-equity-calendar";

/**
 * Asset classes a registered historical price provider can serve. Everything
 * else is NOT_PRICEABLE — not a gap to chase, a question not to ask.
 *
 * OPTION is excluded deliberately: no registered adapter serves option chains,
 * so an option's absent prices are unavailable, not missing. MUTUAL_FUND would
 * need a NAV series no adapter provides. CASH has no market price by nature.
 */
const PRICEABLE_ASSET_CLASSES: ReadonlySet<string> = new Set(["EQUITY", "ETF", "CRYPTO"]);

/**
 * Quote currency assumed when an Instrument carries none. Every instrument and
 * every one of the 8,607 archived prices is USD today, and the surrounding code
 * (lib/crypto/btc-price.ts, the Tiingo adapter) assumes USD throughout. Stated
 * as a named constant so the assumption is visible rather than implied.
 */
export const DEFAULT_QUOTE_CURRENCY = "USD";

/** calendarId stamped when no calendar was consulted (instrument not priceable). */
export const NO_CALENDAR_ID = "none";

/** The instrument facts this layer needs. A projection, not the Prisma row. */
export interface InstrumentMeta {
  instrumentId:         string;
  assetClass:           string;
  tickerSymbol:         string | null;
  marketIdentifierCode: string | null;
  currency:             string | null;
}

/** One archived observation, reduced to what coverage cares about. */
export interface ObservedPriceDate {
  dateISO:  string;
  currency: string;
}

export type InstrumentCoverage =
  | {
      kind:                  "report";
      instrumentId:          string;
      expectedCurrency:      string;
      /** Observations dropped for quote-currency mismatch — diagnostic (OI-1). */
      currencyMismatchCount: number;
      report:                CoverageReport;
    }
  | {
      kind:         "calendar-unavailable";
      instrumentId: string;
      failure:      CalendarFailure;
    };

// ── Policy ───────────────────────────────────────────────────────────────────

/**
 * Can this instrument have a market price series?
 *
 * Order matters: the ASSET CLASS is checked before the symbol, because a CASH
 * instrument carrying a ticker (`CUR:USD` does) is not a symbol problem — it is
 * a category error, and reporting NO_PROVIDER_SYMBOL for it would send an
 * operator looking for identity data that would never help.
 */
export function resolvePriceability(meta: InstrumentMeta): Priceability {
  if (!PRICEABLE_ASSET_CLASSES.has(meta.assetClass)) {
    return { priceable: false, reason: "NOT_PRICEABLE" };
  }
  if (meta.tickerSymbol === null || meta.tickerSymbol.trim() === "") {
    return { priceable: false, reason: "NO_PROVIDER_SYMBOL" };
  }
  return { priceable: true };
}

export type CalendarSelection =
  | { kind: "calendar"; calendar: BoundedTradingCalendar }
  | { kind: "failure";  failure:  CalendarFailure };

/**
 * Which calendar governs this instrument's expected dates.
 *
 * Equities and ETFs are matched by MARKET IDENTITY, never by asset class alone:
 * a foreign listing is not on the US holiday schedule, and assuming it were
 * would silently manufacture expectations on days its market was open and
 * suppress them on days it was not. An unrecognised or absent MIC therefore
 * yields NO_CALENDAR_FOR_MARKET rather than a guess.
 *
 * Costless on current data: the only equities lacking a MIC are the three that
 * also lack a ticker, and those are already NO_PROVIDER_SYMBOL before reaching
 * here.
 */
export function selectCalendar(meta: InstrumentMeta): CalendarSelection {
  if (meta.assetClass === "CRYPTO") {
    return { kind: "calendar", calendar: cryptoCalendar };
  }
  if (meta.assetClass === "EQUITY" || meta.assetClass === "ETF") {
    if (isUsEquityMarket(meta.marketIdentifierCode)) {
      return { kind: "calendar", calendar: usEquityCalendar };
    }
  }
  return {
    kind: "failure",
    failure: {
      code:       "NO_CALENDAR_FOR_MARKET",
      assetClass: meta.assetClass,
      mic:        meta.marketIdentifierCode,
    },
  };
}

/**
 * The earliest date ANY registered adapter serving `basis` can reach, or null
 * when no such adapter exists.
 *
 * Null means "unbounded depth" to the planner, which is the right COVERAGE
 * answer: whether a provider currently exists to fetch a date does not change
 * whether the evidence is missing. Acquisition feasibility is PRICE-3/PRICE-4's
 * question. Without this separation, deleting an API key would silently
 * reclassify real gaps as unreachable.
 *
 * Deterministic: adapters are compared by declared `historicalDepth`, sorted, and
 * the earliest wins — never registry order.
 */
export function resolveProviderFloorISO(
  registry: PriceRegistry,
  basis:    PriceBasis,
): string | null {
  const depths = registry.adapters
    .filter((a: PriceProviderAdapter) => a.supportedBases().includes(basis))
    .map((a: PriceProviderAdapter) => a.historicalDepth)
    .sort();
  return depths.length > 0 ? depths[0] : null;
}

// ── Resolution ───────────────────────────────────────────────────────────────

export interface ResolveCoverageInput {
  meta:             InstrumentMeta;
  basis:            PriceBasis;
  requestedFromISO: string;
  requestedToISO:   string;
  /** Archived observations for this instrument and basis, any order. */
  observed:         readonly ObservedPriceDate[];
  providerFloorISO: string | null;
}

/**
 * Resolve one instrument's coverage. Pure and deterministic: the same metadata,
 * observations and window always produce byte-identical output, and the
 * observation list is treated as a set (coverage.core.ts normalizes it).
 */
export function resolveInstrumentCoverage(input: ResolveCoverageInput): InstrumentCoverage {
  const { meta, basis, requestedFromISO, requestedToISO, providerFloorISO } = input;

  // Quote currency is applied FIRST, so a mismatch is counted on every path —
  // including the unpriceable one, where a stray priced row is itself the news.
  const expectedCurrency = meta.currency ?? DEFAULT_QUOTE_CURRENCY;
  const matching: string[] = [];
  let currencyMismatchCount = 0;
  for (const o of input.observed) {
    if (o.currency === expectedCurrency) matching.push(o.dateISO);
    else currencyMismatchCount++;
  }

  const priceability = resolvePriceability(meta);

  // Not priceable — no calendar is consulted, so no expectations are claimed.
  // Observations are still passed through: a CASH instrument holding price rows
  // surfaces as UNEXPECTED_OBSERVATION, which is a genuine finding.
  if (!priceability.priceable) {
    return {
      kind:             "report",
      instrumentId:     meta.instrumentId,
      expectedCurrency,
      currencyMismatchCount,
      report: coverageFor({
        instrumentId:  meta.instrumentId,
        basis,
        requestedFromISO,
        requestedToISO,
        calendarId:    NO_CALENDAR_ID,
        expectedDates: [],
        observedDates: matching,
        providerFloorISO,
        priceability,
      }),
    };
  }

  const selection = selectCalendar(meta);
  if (selection.kind === "failure") {
    return { kind: "calendar-unavailable", instrumentId: meta.instrumentId, failure: selection.failure };
  }
  const calendar = selection.calendar;

  if (!calendarCoversWindow(calendar, requestedFromISO, requestedToISO)) {
    return {
      kind:         "calendar-unavailable",
      instrumentId: meta.instrumentId,
      failure:      horizonFailure(calendar, requestedFromISO, requestedToISO),
    };
  }

  return {
    kind:             "report",
    instrumentId:     meta.instrumentId,
    expectedCurrency,
    currencyMismatchCount,
    report: coverageFor({
      instrumentId:  meta.instrumentId,
      basis,
      requestedFromISO,
      requestedToISO,
      calendarId:    calendar.id,
      expectedDates: calendar.expectedDates(requestedFromISO, requestedToISO),
      observedDates: matching,
      providerFloorISO,
      priceability,
    }),
  };
}
