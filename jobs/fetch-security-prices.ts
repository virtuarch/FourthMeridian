/**
 * jobs/fetch-security-prices.ts
 *
 * A8-3A — daily historical-price fetch job body. Invoked by the per-job route
 * (app/api/jobs/fetch-security-prices/route.ts) and the dispatcher registry;
 * mirrors jobs/fetch-fx-rates.ts's posture:
 *   - Target = the previous closed UTC day (the newest date the append-only
 *     price archive accepts).
 *   - Consider only HELD instruments (a live, non-superseded, non-deleted
 *     position with quantity > 0) — never arbitrary instruments.
 *   - Fetch ONLY the instruments still missing that date — a re-run (or a day
 *     already captured same-day by A8-2) is a network-free no-op.
 *   - One pass through the provider failover chain per instrument — no retries
 *     beyond failover; non-fatal per instrument (one bad instrument never fails
 *     the job).
 *   - All writes via priceArchive.writeBatch (insert-only, skipDuplicates,
 *     closed-dates-only). No conversion, no valuation, no consumers.
 *
 * VENDOR-GATED: defaultPriceRegistry() is EMPTY until a licensed vendor is
 * selected (A8-3B, externally blocked). With no adapter the job returns
 * "no-provider" before touching the database — a clean no-op that activates the
 * day a vendor drops into the registry seam.
 */

import { db } from "@/lib/db";
import { PriceBasis } from "@prisma/client";
import { priceArchive } from "@/lib/prices/archive";
import { fetchInstrumentWindow } from "@/lib/prices/fetch";
import { defaultPriceRegistry } from "@/lib/prices/registry";
import { selectInstrumentsMissingDate } from "@/lib/prices/backfill-core";
import { yesterdayUTCISO } from "@/lib/prices/config";

export interface FetchSecurityPricesResult {
  dateISO: string;
  status: "ok" | "no-provider";
  instrumentsConsidered: number;
  instrumentsMissing: number;
  /** Instruments a provider returned data for. */
  fetched: number;
  inserted: number;
  failed: number;
}

export async function fetchSecurityPrices(now: Date = new Date()): Promise<FetchSecurityPricesResult> {
  const dateISO = yesterdayUTCISO(now);
  const registry = defaultPriceRegistry();

  const empty: FetchSecurityPricesResult = {
    dateISO, status: "no-provider", instrumentsConsidered: 0, instrumentsMissing: 0, fetched: 0, inserted: 0, failed: 0,
  };

  // Vendor gate: no adapter ⇒ no-op before any DB work (deferred, not fabricated).
  if (registry.adapters.length === 0) {
    console.log(`[prices-cron] ${dateISO}: no price provider configured — no-op (vendor gate)`);
    return empty;
  }

  // Held instruments: a live (non-superseded, non-deleted) position with qty > 0.
  const held = await db.positionObservation.findMany({
    where:    { supersededById: null, deletedAt: null, quantity: { gt: 0 } },
    select:   { instrumentId: true, instrument: { select: { tickerSymbol: true } } },
    distinct: ["instrumentId"],
  });
  const instrumentIds = [...new Set(held.map((h) => h.instrumentId))].sort();
  const symbolById = new Map(held.map((h) => [h.instrumentId, h.instrument.tickerSymbol]));

  // Batch coverage read for the target date, then select the missing.
  const covered = new Map<string, Set<string>>();
  const existing = (await priceArchive.readRange?.(instrumentIds, PriceBasis.RAW_CLOSE, dateISO, dateISO)) ?? [];
  for (const row of existing) {
    const set = covered.get(row.instrumentId) ?? new Set<string>();
    set.add(row.dateISO);
    covered.set(row.instrumentId, set);
  }
  const missing = selectInstrumentsMissingDate(instrumentIds, covered, dateISO);

  let fetched = 0, inserted = 0, failed = 0;
  for (const instrumentId of missing) {
    try {
      const res = await fetchInstrumentWindow(
        {
          instrumentId,
          providerSymbol: symbolById.get(instrumentId) ?? "",
          basis: PriceBasis.RAW_CLOSE,
          fromISO: dateISO,
          toISO: dateISO,
        },
        registry,
      );
      if (res.source && res.rows.length > 0) {
        fetched++;
        const w = await priceArchive.writeBatch(res.source, res.rows);
        inserted += w.inserted;
      }
    } catch (err) {
      failed++;
      console.warn(`[prices-cron] ${dateISO}: instrument ${instrumentId} failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`[prices-cron] ${dateISO}: ${instrumentIds.length} held, ${missing.length} missing, ${fetched} fetched, ${inserted} row(s) stored, ${failed} failed`);
  return { dateISO, status: "ok", instrumentsConsidered: instrumentIds.length, instrumentsMissing: missing.length, fetched, inserted, failed };
}
