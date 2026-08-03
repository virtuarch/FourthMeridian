/**
 * lib/prices/types.ts
 *
 * A8-1 — historical-price provider + read contracts. Pure types only: no
 * Prisma runtime, no network, no adapter implementations. Structural clone of
 * lib/fx/types.ts, keyed by `instrumentId` instead of a currency pair — symbol
 * changes / delistings / reuse are already solved by Instrument/InstrumentAlias,
 * so a price row and every read is id-keyed and a ticker never appears here.
 *
 * Date convention: dates cross this API as ISO calendar-date strings
 * ("YYYY-MM-DD", UTC). The archive column is DATE-typed; daily close is the
 * only granularity. Currency is the QUOTE currency of the price — no FX
 * conversion happens anywhere in lib/prices (that is A8-4's job, downstream).
 */

import type { PriceBasis } from "@prisma/client";
import type { CompletenessTier } from "@/lib/perspective-engine/types";

export type { PriceBasis };

/**
 * One (instrument, date, basis) price fact as supplied by a provider adapter.
 * Carries NO source field — provenance belongs to the batch (one adapter's
 * answer), exactly like FX RateResult.
 */
export interface PriceResult {
  instrumentId: string;
  dateISO:      string;   // "YYYY-MM-DD" — the market close date (closed dates only)
  basis:        PriceBasis;
  price:        number;   // quote-currency close; positive-finite (validated on write)
  currency:     string;   // ISO 4217 quote currency of `price`
}

/**
 * V26-S1-CA — a corporate action a PRICE vendor stated, in the same response as
 * its prices.
 *
 * This lives here, beside PriceResult, for one reason: it arrives on the same
 * HTTP call. It is deliberately NOT a price — it never enters the archive, never
 * gets a basis, and never participates in valuation. It is the TERM of an event,
 * carried out of the price pipeline to the corporate-action authority
 * (lib/investments/corporate-actions.core.ts), which is the only module allowed
 * to decide whether it may license a quantity replay.
 *
 * No `grade` field: the vendor states the term, this codebase grades the source.
 * An adapter must never be able to declare its own answer authoritative.
 */
export interface ProviderCorporateAction {
  instrumentId:  string;
  /** "YYYY-MM-DD", UTC — the date the vendor states the action took effect. */
  effectiveDate: string;
  /** Canonical kind ("SPLIT"); validated by the corporate-action authority. */
  kind:          string;
  /** Shares out per share in. Never 1.0 — "nothing happened" is not an action. */
  ratio:         number;
  /** The raw vendor fields this was read from. Evidence, never an input. */
  evidence?:     Record<string, unknown>;
}

/**
 * The facts routing needs in order to choose a provider, without loading an
 * Instrument row. V26-PRICE-PROVIDER-UNIFICATION — see ProviderResolution.
 */
export interface ProviderRoutingKey {
  /** Instrument.assetClass as a plain string ("EQUITY", "ETF", "CRYPTO", …). */
  assetClass:     string;
  /** Vendor-side identity resolved by the caller (Instrument.tickerSymbol today). */
  providerSymbol: string;
  basis:          PriceBasis;
}

/**
 * A provider adapter: a dumb fetcher. No storage, no symbol resolution above the
 * vendor call — those live above the adapter (fetch orchestration, A8-3). A new
 * provider is a new implementation of this interface plus a registry entry.
 */
export interface PriceProviderAdapter {
  /** Stable provenance identifier stored on PriceObservation.source (e.g. "tiingo", "coingecko"). */
  readonly source: string;
  /** Earliest ISO date this source can serve. */
  readonly historicalDepth: string;
  /**
   * V26-CAP-1 — the DECLARATION behind `historicalDepth`, so orchestration can
   * compare capability over time without recomputing depth itself.
   *
   * `historicalDepth` alone is not comparable across days for a rolling-window
   * provider: its floor advances one day every day, so a stored date would read
   * as "narrowed" daily. This states the KIND and, for a rolling window, the
   * depth that is actually stable.
   *
   * Optional so an adapter that has not declared one is simply not tracked —
   * absence must never be read as a capability claim.
   */
  readonly capability?: import("./provider-capability.core").CapabilityDeclaration;
  /** Which bases this source can serve (e.g. an equities vendor: RAW_CLOSE only). */
  supportedBases(): readonly PriceBasis[];
  /**
   * DECLARED capability: can this adapter serve this instrument? Routing ASKS
   * this — it never tries an adapter to find out, and it never falls through a
   * list. Required, not optional: an adapter that does not state what it serves
   * would reintroduce the positional guessing this replaces.
   */
  supportsInstrument(key: ProviderRoutingKey): boolean;
  /**
   * Fetch closed daily closes for ONE instrument over [fromISO, toISO] inclusive,
   * for the given basis. The adapter is handed the provider symbol/identity it
   * needs (resolved by the caller); it returns rows keyed by the same
   * instrumentId it was asked about. Complete-or-throw per adapter.
   */
  fetchDailyCloses(req: PriceFetchRequest): Promise<PriceResult[]>;
  /**
   * V26-S1-CA — the SAME window, also reporting any corporate action the vendor
   * stated in that response.
   *
   * OPTIONAL, exactly like `readRange?` / `readCoveredDates?` on
   * PriceArchiveReader: a vendor whose payload carries no corporate-action data
   * omits it, and callers MUST fall back to `fetchDailyCloses`. That keeps this
   * strictly additive — every existing adapter, fixture and test is unchanged.
   *
   * An adapter implementing this MUST NOT issue a second network request: the
   * whole point is that the terms were already inside the response the price
   * fetch paid for. Tiingo's daily-prices rows carry `splitFactor`; that field
   * was being parsed away, which is why TQQQ's history stopped at a split whose
   * ratio was sitting in the same payload as the prices around it.
   */
  fetchDailyClosesWithActions?(
    req: PriceFetchRequest,
  ): Promise<{ prices: PriceResult[]; corporateActions: ProviderCorporateAction[] }>;
}

/** One instrument's fetch request over a bounded window. */
export interface PriceFetchRequest {
  instrumentId: string;
  /** Instrument.assetClass — a routing input, not a vendor parameter. */
  assetClass: string;
  /** Provider-side symbol/identity for this instrument (resolved outside the archive key). */
  providerSymbol: string;
  basis:   PriceBasis;
  fromISO: string;
  toISO:   string;
}

/**
 * Adapter collection. ORDER IS NOT SIGNIFICANT: routing resolves exactly one
 * provider from declared capability (resolveProviderForInstrument), so changing
 * registration order cannot change which vendor serves an instrument.
 */
export interface PriceRegistry {
  readonly adapters: readonly PriceProviderAdapter[];
}

/**
 * The outcome of routing one instrument to one provider.
 *
 * Deliberately NOT "the first adapter that works". Order-dependent routing means
 * a registration edit silently repoints a price series at a different vendor,
 * and a provider hiccup silently substitutes another — both invisible in the
 * archive, which records `source` but not why. Every outcome here is a function
 * of declared capability alone.
 *
 * `ambiguous` is a configuration defect surfaced rather than resolved: two
 * adapters claiming one instrument have no capability-based winner, and picking
 * one would be exactly the positional guess being removed.
 */
export type ProviderResolution =
  | { kind: "provider";    adapter: PriceProviderAdapter }
  | { kind: "unsupported"; sourcesConsidered: string[] }
  | { kind: "ambiguous";   sources: string[] };

/**
 * V26-PRICE-1 — the source of EXPECTED market dates for one asset class.
 *
 * The price archive cannot tell "the market was closed" from "we never fetched
 * it": both are an absent row. A calendar supplies the missing half of that
 * judgement, so coverage.core.ts can report a genuine acquisition gap instead of
 * screaming about every weekend. `expectedDates` returns the dates a complete
 * archive WOULD contain over [fromISO, toISO] — trading days for an equity
 * calendar, every day for a 24/7 crypto calendar.
 *
 * Declared here (beside the other price contracts) with ZERO implementations —
 * V26-PRICE-1 ships only the pure planner, which receives the expected-date set
 * as data. Implementations and their holiday tables are V26-PRICE-2
 * (lib/calendar/), which imports this interface rather than redeclaring it.
 *
 * `id` is stamped onto a CoverageReport as `calendarId`, so a report is
 * self-describing about which expectations produced it — the diagnostic that
 * makes an UNEXPECTED_OBSERVATION actionable when a holiday table goes stale.
 */
export interface TradingCalendar {
  /** Stable provenance identifier, e.g. "us-equity", "crypto-247". */
  readonly id: string;
  /** Expected market dates in [fromISO, toISO] inclusive; ascending, deduped. */
  expectedDates(fromISO: string, toISO: string): readonly string[];
}

/** A resolution request: the price of `instrumentId` as-of `dateISO` on one basis. */
export interface PriceQuery {
  instrumentId: string;
  dateISO:      string;
  basis:        PriceBasis;
}

/**
 * Resolution failure as a VALUE, never a throw: no priced row on or within
 * PRICE_MAX_STALE_DAYS before the requested date (a weekend/holiday gap wider
 * than the bound, a never-priced instrument, or a delisted tail). Callers map
 * this to the canonical `incomplete` tier — a gap statement, never a number.
 */
export interface PriceMiss {
  kind:             "miss";
  instrumentId:     string;
  basis:            PriceBasis;
  requestedDateISO: string;
  /** Deterministic, name-free reason ("no price within N days of D"). */
  reason:           string;
}

/**
 * Successful resolution. `tier` is the canonical trust tier (imported, never
 * minted): "observed" for an exact-date close, "estimated" for a walked-back
 * flat-hold within the staleness bound. `staleDays` is 0 on an exact hit.
 */
export interface ResolvedPrice {
  kind:             "price";
  price:            number;
  currency:         string;
  basis:            PriceBasis;
  requestedDateISO: string;
  /** The archive date the returned price actually came from (≤ requested). */
  effectiveDateISO: string;
  staleDays:        number;
  tier:             CompletenessTier; // "observed" | "estimated"
}

export type PriceResolution = ResolvedPrice | PriceMiss;

/**
 * The read seam the resolution service depends on. lib/prices/archive.ts
 * provides the Prisma-backed implementation; unit tests inject an in-memory
 * fake — service.ts never imports Prisma (the suite runs the service without a
 * database, exactly like lib/fx/service.test.ts).
 */
export interface PriceArchiveReader {
  /**
   * Latest stored price for (instrumentId, basis) with date in
   * [dateISO − maxStaleDays, dateISO], or null if none. Basis is part of the
   * filter — a RAW_CLOSE read never returns an ADJUSTED_CLOSE/NAV row.
   */
  readLatestOnOrBefore(
    instrumentId: string,
    basis:        PriceBasis,
    dateISO:      string,
    maxStaleDays: number,
  ): Promise<{ dateISO: string; price: number; currency: string } | null>;

  /**
   * Batch window read (the A8-4 valuation access pattern): every stored row for
   * the given instrument ids on ONE basis with date in [fromISO, toISO]
   * inclusive, any order. Lets a caller preload one window in a single query and
   * resolve many (instrument, date) pairs from an in-memory snapshot with
   * identical walk-back semantics.
   *
   * OPTIONAL: pure in-memory fakes may omit it; callers MUST fall back to the
   * per-date `readLatestOnOrBefore` path when it is absent.
   */
  readRange?(
    instrumentIds: readonly string[],
    basis:         PriceBasis,
    fromISO:       string,
    toISO:         string,
  ): Promise<{ instrumentId: string; dateISO: string; price: number; currency: string }[]>;

  /**
   * V26-PRICE-2 — the COVERAGE access pattern: which dates exist, without the
   * prices. Same window and index as readRange, but it deliberately does not
   * return `price`: coverage planning must never see a value it has no business
   * judging, and the read stays cheap over long ownership windows.
   *
   * `currency` IS returned, because the binding filters observations by the
   * instrument's expected quote currency before counting them as evidence — a
   * row in the wrong currency is not coverage (OI-1). That check has to happen
   * somewhere above the dates-only planner, and this is the read that feeds it.
   *
   * OPTIONAL, exactly like readRange: in-memory fakes may omit it, and callers
   * MUST fall back to readRange when it is absent.
   */
  readCoveredDates?(
    instrumentIds: readonly string[],
    basis:         PriceBasis,
    fromISO:       string,
    toISO:         string,
  ): Promise<{ instrumentId: string; dateISO: string; currency: string }[]>;
}

/** Full archive contract (reader + append-only writer). Implemented by lib/prices/archive.ts. */
export interface PriceArchive extends PriceArchiveReader {
  /** Exact-date point read, or null. */
  readPrice(instrumentId: string, dateISO: string, basis: PriceBasis): Promise<{ price: number; currency: string } | null>;
  /**
   * Insert-only batch write (skipDuplicates — re-fetch is a no-op against the
   * @@unique([instrumentId, date, basis]) anchor). `source` is provenance for
   * the batch. Rejects rows dated after yesterday UTC (closed dates only).
   * Never updates, never deletes — closed-date price facts are immutable.
   */
  writeBatch(source: string, rows: readonly PriceResult[]): Promise<{ attempted: number; inserted: number }>;
}
