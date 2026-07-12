/**
 * lib/prices/providers/fixture.ts
 *
 * A8-1 — deterministic fixture price provider. Ships in the spine so every
 * downstream consumer (A8-3 backfill/job, A8-4 valuation) is testable before a
 * real vendor exists, mirroring the FX fixture-provider precedent. It serves
 * prices from an in-memory table keyed by (instrumentId, basis, dateISO); it
 * fabricates nothing — a date with no seeded row is simply absent (a weekend /
 * holiday / pre-listing gap the read service walks back over), never
 * interpolated.
 *
 * Pure and offline: no network, no clock, no Prisma. `providerSymbol` is
 * accepted (the real adapter contract passes it) but the fixture keys on
 * instrumentId, so tests need not thread symbols.
 */

import type { PriceBasis, PriceFetchRequest, PriceProviderAdapter, PriceResult } from "../types";

/** One seeded close: instrument + basis + date + price (+ optional currency, default USD). */
export interface FixturePrice {
  instrumentId: string;
  basis:        PriceBasis;
  dateISO:      string;
  price:        number;
  currency?:    string;
}

export interface FixtureProviderOptions {
  source?:          string;
  historicalDepth?: string;
  /** Bases this fixture claims to serve; defaults to the seeded bases. */
  bases?:           readonly PriceBasis[];
}

/**
 * Build a fixture adapter over a fixed set of seeded closes. Deterministic:
 * identical seed + identical request ⇒ identical rows, in ascending (date)
 * order. Rows outside the requested [fromISO, toISO] window or a different basis
 * are not returned (the vendor-contract shape the real adapter must honor).
 */
export function createFixturePriceProvider(
  seed: readonly FixturePrice[],
  opts: FixtureProviderOptions = {},
): PriceProviderAdapter {
  const source = opts.source ?? "fixture";
  const rows = [...seed].sort(
    (a, b) => a.instrumentId.localeCompare(b.instrumentId) || a.dateISO.localeCompare(b.dateISO),
  );
  const seededBases = opts.bases ?? [...new Set(seed.map((s) => s.basis))];
  const depth = opts.historicalDepth ?? (rows[0]?.dateISO ?? "1970-01-01");

  return {
    source,
    historicalDepth: depth,
    supportedBases() {
      return seededBases;
    },
    async fetchDailyCloses(req: PriceFetchRequest): Promise<PriceResult[]> {
      return rows
        .filter(
          (r) =>
            r.instrumentId === req.instrumentId &&
            r.basis === req.basis &&
            r.dateISO >= req.fromISO &&
            r.dateISO <= req.toISO,
        )
        .map((r) => ({
          instrumentId: r.instrumentId,
          dateISO:      r.dateISO,
          basis:        r.basis,
          price:        r.price,
          currency:     r.currency ?? "USD",
        }));
    },
  };
}
