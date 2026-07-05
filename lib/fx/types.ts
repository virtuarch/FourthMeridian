/**
 * lib/fx/types.ts
 *
 * MC1 Phase 1 Slice 2 — FX provider layer type contracts. Pure types only:
 * no Prisma, no network, no provider implementations (adapters are Slice 3).
 * See docs/initiatives/mc1/MC1_PHASE1_FX_PROVIDER_LAYER_PLAN.md §3.1/§3.3.
 *
 * Date convention: all dates cross this API as ISO calendar-date strings
 * ("YYYY-MM-DD", UTC). The archive's column is DATE-typed; daily close is the
 * only granularity (plan D4).
 */

/** One (date, base→quote) rate fact as supplied by a provider. Base is always USD (plan §3.3). */
export interface RateResult {
  dateISO: string; // "YYYY-MM-DD" — valuation date (closed dates only)
  base:    "USD";
  quote:   string; // ISO 4217
  rate:    number; // 1 base = rate quote
}

/**
 * A provider adapter: a dumb fetcher. No storage, no failover, no selection
 * logic — those live above the adapter (fetch.ts, Slice 3). A new provider is
 * a new implementation of this interface plus a registry entry.
 */
export interface FxProviderAdapter {
  /** Stable provenance identifier stored on FxRate.source (e.g. "openexchangerates"). */
  readonly source: string;
  /** Earliest ISO date this source can serve. */
  readonly historicalDepth: string;
  /** The subset of the requested quotes this source can serve (e.g. ECB has no SAR/AED). */
  supportedQuotes(quotes: readonly string[]): string[];
  /** Fetch one closed day's rates, base USD implied. Complete-or-throw per adapter. */
  fetchDailyRates(dateISO: string, quotes: readonly string[]): Promise<RateResult[]>;
}

/** Ordered adapter collection; order = failover priority (plan D2). */
export interface FxRegistry {
  readonly adapters: readonly FxProviderAdapter[];
}

/** A resolution request: convert `from` into `to` as of `dateISO`. */
export interface RateQuery {
  from:    string;
  to:      string;
  dateISO: string;
}

/**
 * Resolution failure as a VALUE, never a throw (plan §3.3.6). `quote` is the
 * first leg that could not be resolved (the `from` leg is checked first —
 * deterministic when both legs are missing).
 */
export interface RateMiss {
  kind:             "miss";
  quote:            string;
  requestedDateISO: string;
}

/** Successful resolution. `staleness` feeds Phase 2's `estimated` flag; Phase 1 only reports. */
export interface ResolvedRate {
  kind:             "rate";
  rate:             number;
  requestedDateISO: string;
  /** Effective archive date each leg actually used (may differ per leg after walk-back). */
  effectiveDates:   { from: string; to: string };
  staleness:        "exact" | "walked-back";
}

export type Resolution = ResolvedRate | RateMiss;

/**
 * The read seam the resolution service depends on. lib/fx/archive.ts provides
 * the Prisma-backed implementation; unit tests inject an in-memory fake —
 * service.ts never imports Prisma (plan §4: tests run without `prisma generate`).
 */
export interface FxArchiveReader {
  /**
   * Latest stored (base→quote) rate with date in [dateISO − maxStaleDays, dateISO],
   * or null if none exists in that window.
   */
  readLatestOnOrBefore(
    base: string,
    quote: string,
    dateISO: string,
    maxStaleDays: number,
  ): Promise<{ dateISO: string; rate: number } | null>;
}

/** Full archive contract (reader + append-only writer). Implemented by lib/fx/archive.ts. */
export interface FxArchive extends FxArchiveReader {
  /** Exact-date point read, or null. */
  readRate(dateISO: string, base: string, quote: string): Promise<number | null>;
  /**
   * Insert-only batch write (skipDuplicates — re-fetch is a no-op; plan D8).
   * `source` is the providing adapter's identifier — provenance belongs to the
   * batch (one adapter's complete answer, plan D2), which is why RateResult
   * itself carries no source field. Must reject rows dated after yesterday
   * UTC (append-only, closed dates only). Never updates, never deletes.
   */
  writeBatch(source: string, rows: readonly RateResult[]): Promise<{ attempted: number; inserted: number }>;
}
