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
 * A provider adapter: a dumb fetcher. No storage, no failover, no symbol
 * resolution above the vendor call — those live above the adapter (fetch
 * orchestration, A8-3). A new provider is a new implementation of this
 * interface plus a registry entry. `resolveSymbol` maps an instrument's
 * external identity to the vendor's symbol OUTSIDE the archive key.
 */
export interface PriceProviderAdapter {
  /** Stable provenance identifier stored on PriceObservation.source (e.g. "plaid", "fixture"). */
  readonly source: string;
  /** Earliest ISO date this source can serve. */
  readonly historicalDepth: string;
  /** Which bases this source can serve (e.g. an equities vendor: RAW_CLOSE only). */
  supportedBases(): readonly PriceBasis[];
  /**
   * Fetch closed daily closes for ONE instrument over [fromISO, toISO] inclusive,
   * for the given basis. The adapter is handed the provider symbol/identity it
   * needs (resolved by the caller); it returns rows keyed by the same
   * instrumentId it was asked about. Complete-or-throw per adapter.
   */
  fetchDailyCloses(req: PriceFetchRequest): Promise<PriceResult[]>;
}

/** One instrument's fetch request over a bounded window. */
export interface PriceFetchRequest {
  instrumentId: string;
  /** Provider-side symbol/identity for this instrument (resolved outside the archive key). */
  providerSymbol: string;
  basis:   PriceBasis;
  fromISO: string;
  toISO:   string;
}

/** Ordered adapter collection; order = failover priority. */
export interface PriceRegistry {
  readonly adapters: readonly PriceProviderAdapter[];
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
