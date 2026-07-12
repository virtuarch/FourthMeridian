/**
 * lib/prices/service.ts
 *
 * A8-1 — the pure price-resolution engine. Deterministic by construction: a
 * pure function over an immutable append-only archive — the same query returns
 * the same answer in 2030 as it does today. Clone of lib/fx/service.ts, keyed
 * by instrument + basis.
 *
 * Algorithm:
 *   1. Exact-date row for (instrumentId, basis)  → tier "observed", staleDays 0.
 *   2. Else latest row within PRICE_MAX_STALE_DAYS (one indexed walk-back)
 *                                                 → tier "estimated", staleDays > 0,
 *                                                   returning the ACTUAL source date.
 *   3. Else a PriceMiss VALUE (never a throw). The caller maps a miss to the
 *      canonical `incomplete` tier — a gap statement, never a fabricated number.
 *   4. Basis isolation: the basis is part of every read; RAW_CLOSE never falls
 *      through to ADJUSTED_CLOSE, NAV never to RAW_CLOSE, CRYPTO_DAILY stays
 *      distinct. No silent mixing.
 *   5. Request-scope memo: a service instance memoizes every resolution (hits
 *      AND misses). Safe because the archive is immutable for closed dates; a
 *      miss can only be filled by a later backfill, hence one instance per
 *      request.
 *
 * Weekends and market holidays are ABSENT rows by design — the walk-back + the
 * staleness bound handle them; no calendar is invented and nothing is ever
 * interpolated. Depends only on the PriceArchiveReader seam (types.ts) — no
 * Prisma, no network: production passes lib/prices/archive.ts; tests inject fakes.
 */

import { PRICE_MAX_STALE_DAYS, assertISODate, daysBetweenISO } from "./config";
import type { PriceArchiveReader, PriceBasis, PriceResolution } from "./types";

export interface PriceService {
  getPriceAsOf(instrumentId: string, dateISO: string, basis: PriceBasis): Promise<PriceResolution>;
}

/** Create a resolution service over an archive reader. One instance per request (memo scope). */
export function createPriceService(archive: PriceArchiveReader): PriceService {
  const memo = new Map<string, PriceResolution>();

  return {
    async getPriceAsOf(instrumentId, dateISO, basis) {
      // Programmer-error guard (throw); everything past here returns a value.
      assertISODate(dateISO);

      const key = `${instrumentId}|${dateISO}|${basis}`;
      const cached = memo.get(key);
      if (cached) return cached;

      const row = await archive.readLatestOnOrBefore(
        instrumentId,
        basis,
        dateISO,
        PRICE_MAX_STALE_DAYS,
      );

      let result: PriceResolution;
      if (!row) {
        result = {
          kind: "miss",
          instrumentId,
          basis,
          requestedDateISO: dateISO,
          reason: `No ${basis} price within ${PRICE_MAX_STALE_DAYS} days of ${dateISO}.`,
        };
      } else {
        const staleDays = daysBetweenISO(row.dateISO, dateISO);
        result = {
          kind: "price",
          price: row.price,
          currency: row.currency,
          basis,
          requestedDateISO: dateISO,
          effectiveDateISO: row.dateISO,
          staleDays,
          // Exact date ⇒ observed; a walked-back flat-hold ⇒ estimated (matching
          // convertMoney's walked-back ⇒ estimated and the S1 "FX walk-back
          // miss" ⇒ estimated ruling). Never "derived" — a price is not computed
          // from other observed anchors, it is the nearest observed close.
          tier: staleDays === 0 ? "observed" : "estimated",
        };
      }

      memo.set(key, result);
      return result;
    },
  };
}
