/**
 * lib/fx/fetch.ts
 *
 * MC1 Phase 1 Slice 3 — fetch orchestration (plan §3.4, D2). Pure
 * orchestration, NO persistence: callers (scripts/backfill-fx-rates.ts now,
 * the Slice 4 cron route later) store the result via fxArchive.writeBatch —
 * this module never touches the database.
 *
 * Contract:
 *   - One CLOSED date per call (assertClosedDateISO — programmer error otherwise).
 *   - Walk the registry in priority order; the FIRST adapter that returns a
 *     usable, validated batch wins; that batch stamps its true source.
 *   - Adapter failure (throw, bad shape, wrong date) → log and CONTINUE to
 *     the next adapter. Partial answers are never merged across adapters.
 *   - An adapter legitimately returning [] (e.g. Frankfurter on a non-banking
 *     day) is "no data from this source", not a failure — continue.
 *   - Deterministic: same registry + same adapter responses → same FetchDayResult.
 */

import { SUPPORTED_QUOTES, assertClosedDateISO } from "./config";
import type { FxRegistry, RateResult } from "./types";

export interface FetchDayResult {
  dateISO: string;
  /** Winning adapter, or null when no adapter produced data for this date. */
  source:  string | null;
  /** Canonical validated rows from the winning adapter ([] when source is null). */
  rates:   RateResult[];
  /** Non-fatal per-adapter notes, in registry order (skips + failures), for progress output. */
  notes:   string[];
}

/** Batch-level validation: every row canonical, on-date, positive-finite, in the served set. */
function validateBatch(rates: RateResult[], dateISO: string, served: readonly string[]): void {
  const servedSet = new Set(served);
  for (const r of rates) {
    if (r.base !== "USD") throw new Error(`non-USD base "${r.base}"`);
    if (r.dateISO !== dateISO) throw new Error(`off-date row ${r.dateISO} (want ${dateISO})`);
    if (!servedSet.has(r.quote)) throw new Error(`unrequested quote ${r.quote}`);
    if (!Number.isFinite(r.rate) || r.rate <= 0) throw new Error(`invalid rate for ${r.quote}`);
  }
}

/**
 * Fetch one closed day's rates through the registry's failover chain.
 * `quotes` defaults to the full approved list; the backfill passes the
 * still-missing subset for a date so an OXR run can top up a
 * Frankfurter-covered day (SAR/AED) without refetching the rest.
 */
export async function fetchDay(
  dateISO: string,
  registry: FxRegistry,
  quotes: readonly string[] = SUPPORTED_QUOTES,
): Promise<FetchDayResult> {
  assertClosedDateISO(dateISO);
  const notes: string[] = [];

  for (const adapter of registry.adapters) {
    const servable = adapter.supportedQuotes(quotes);
    if (servable.length === 0) {
      notes.push(`${adapter.source}: serves none of the requested quotes — skipped`);
      continue;
    }
    try {
      const rates = await adapter.fetchDailyRates(dateISO, servable);
      if (rates.length === 0) {
        notes.push(`${adapter.source}: no data for ${dateISO} (non-banking day for this source)`);
        continue;
      }
      validateBatch(rates, dateISO, servable);
      return { dateISO, source: adapter.source, rates, notes };
    } catch (e) {
      // Fail over — partial/invalid batches are discarded whole (plan D2).
      notes.push(`${adapter.source}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
  }

  return { dateISO, source: null, rates: [], notes };
}
