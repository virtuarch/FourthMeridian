/**
 * lib/fx/service.ts
 *
 * MC1 Phase 1 Slice 2 — the pure rate-resolution engine (plan §3.3).
 * Deterministic by construction: a pure function over an immutable append-only
 * archive — the same query returns the same answer in 2030 as it does today.
 *
 * Algorithm (plan §3.3):
 *   1. from === to           → rate 1, "exact", zero lookups (identity fast path).
 *   2. Cross-rate via USD    → rate(from→to) = usdRate(to) / usdRate(from);
 *                              usdRate(USD) = 1 by definition (no self-row stored).
 *   3. Per leg               → exact-date row, else latest row within
 *                              MAX_STALE_DAYS walk-back (one indexed query),
 *                              else the leg is a miss.
 *   4. Misses are VALUES     → RateMiss, never a throw. Throwing is reserved
 *                              for programmer errors (unsupported currency,
 *                              malformed date).
 *   5. Request-scope memo    → a service instance memoizes every resolution
 *                              (hits AND misses). Safe because the archive is
 *                              immutable for closed dates; a miss can only be
 *                              filled by a later backfill run, which is why the
 *                              intended instance lifetime is one request.
 *
 * Depends only on the FxArchiveReader seam (types.ts) — no Prisma, no network:
 * production passes lib/fx/archive.ts's implementation; tests inject fakes.
 */

import { FX_BASE, MAX_STALE_DAYS, assertISODate, isSupportedCurrency } from "./config";
import type { FxArchiveReader, Resolution } from "./types";

export interface FxService {
  getRateForDate(from: string, to: string, dateISO: string): Promise<Resolution>;
}

interface Leg {
  rate:    number;
  dateISO: string; // effective archive date this leg used
  exact:   boolean;
}

/** Create a resolution service over an archive reader. One instance per request (memo scope). */
export function createFxService(archive: FxArchiveReader): FxService {
  const memo = new Map<string, Resolution>();

  /** USD→quote leg: definitional for USD, archive-resolved (exact or walk-back) otherwise. */
  async function usdLeg(quote: string, dateISO: string): Promise<Leg | null> {
    if (quote === FX_BASE) return { rate: 1, dateISO, exact: true };
    const row = await archive.readLatestOnOrBefore(FX_BASE, quote, dateISO, MAX_STALE_DAYS);
    if (!row) return null;
    return { rate: row.rate, dateISO: row.dateISO, exact: row.dateISO === dateISO };
  }

  return {
    async getRateForDate(from, to, dateISO) {
      // Programmer-error guards (throw — plan §3.3.6): everything past this
      // point returns values, never throws.
      assertISODate(dateISO);
      if (!isSupportedCurrency(from)) throw new Error(`[fx] unsupported currency: "${from}"`);
      if (!isSupportedCurrency(to))   throw new Error(`[fx] unsupported currency: "${to}"`);

      const key = `${dateISO}|${from}|${to}`;
      const cached = memo.get(key);
      if (cached) return cached;

      let result: Resolution;

      if (from === to) {
        // Identity fast path — the entire USD-only era costs zero lookups.
        result = {
          kind: "rate",
          rate: 1,
          requestedDateISO: dateISO,
          effectiveDates: { from: dateISO, to: dateISO },
          staleness: "exact",
        };
      } else {
        // `from` leg checked first — deterministic RateMiss attribution when
        // both legs are missing (types.ts contract).
        const legFrom = await usdLeg(from, dateISO);
        if (!legFrom) {
          result = { kind: "miss", quote: from, requestedDateISO: dateISO };
        } else {
          const legTo = await usdLeg(to, dateISO);
          if (!legTo) {
            result = { kind: "miss", quote: to, requestedDateISO: dateISO };
          } else {
            result = {
              kind: "rate",
              rate: legTo.rate / legFrom.rate,
              requestedDateISO: dateISO,
              effectiveDates: { from: legFrom.dateISO, to: legTo.dateISO },
              staleness: legFrom.exact && legTo.exact ? "exact" : "walked-back",
            };
          }
        }
      }

      memo.set(key, result);
      return result;
    },
  };
}
