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
import { recordCorporateActionTerms } from "@/lib/investments/corporate-actions";
import { defaultPriceRegistry } from "@/lib/prices/registry";
import { selectInstrumentsMissingDate } from "@/lib/prices/backfill-core";
import { resolvePriceability } from "@/lib/prices/coverage-binding.core";
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
    select:   {
      instrumentId: true,
      instrument: { select: { tickerSymbol: true, assetClass: true, marketIdentifierCode: true, currency: true } },
    },
    distinct: ["instrumentId"],
  });

  // V26-PRICE-3 — drop instruments no provider can price BEFORE selecting the
  // missing list. Previously a CASH instrument, an option, or one with a null
  // ticker was selected every single day, fetched, answered with nothing, and
  // therefore still "missing" tomorrow — an unbounded retry loop that produced
  // no row and no diagnostic, forever. Priceability comes from the ONE resolver
  // the coverage binding uses, so the cron and coverage cannot disagree.
  const unpriceable: string[] = [];
  const priceable = held.filter((h) => {
    const p = resolvePriceability({
      instrumentId:         h.instrumentId,
      assetClass:           String(h.instrument.assetClass),
      tickerSymbol:         h.instrument.tickerSymbol,
      marketIdentifierCode: h.instrument.marketIdentifierCode,
      currency:             h.instrument.currency,
    });
    if (!p.priceable) unpriceable.push(`${h.instrumentId}(${p.reason})`);
    return p.priceable;
  });
  if (unpriceable.length > 0) {
    console.log(`[prices-cron] ${dateISO}: skipping ${unpriceable.length} unpriceable instrument(s): ${unpriceable.sort().join(", ")}`);
  }

  const instrumentIds = [...new Set(priceable.map((h) => h.instrumentId))].sort();
  const symbolById = new Map(priceable.map((h) => [h.instrumentId, h.instrument.tickerSymbol]));
  const classById  = new Map(priceable.map((h) => [h.instrumentId, String(h.instrument.assetClass)]));

  // Batch coverage read for the target date, then select the missing.
  const covered = new Map<string, Set<string>>();
  const existing = (await priceArchive.readRange?.(instrumentIds, PriceBasis.RAW_CLOSE, dateISO, dateISO)) ?? [];
  for (const row of existing) {
    const set = covered.get(row.instrumentId) ?? new Set<string>();
    set.add(row.dateISO);
    covered.set(row.instrumentId, set);
  }
  const missing = selectInstrumentsMissingDate(instrumentIds, covered, dateISO);

  let fetched = 0, inserted = 0, failed = 0, actions = 0;
  for (const instrumentId of missing) {
    try {
      const res = await fetchInstrumentWindow(
        {
          instrumentId,
          assetClass:     classById.get(instrumentId) ?? "UNKNOWN",
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
        // V26-S1-CA — a split that happens TODAY is stated on today's row, in
        // this very response. Capturing it here is what keeps the terms
        // authority current without a second job or a second vendor call.
        if (res.corporateActions.length > 0) {
          try {
            actions += await recordCorporateActionTerms(res.source, res.corporateActions);
          } catch (e) {
            console.warn(`[prices-cron] ${dateISO}: corporate-action capture failed for ${instrumentId} (non-fatal): ${e instanceof Error ? e.message : e}`);
          }
        }
      }
    } catch (err) {
      failed++;
      console.warn(`[prices-cron] ${dateISO}: instrument ${instrumentId} failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`[prices-cron] ${dateISO}: ${instrumentIds.length} held, ${missing.length} missing, ${fetched} fetched, ${inserted} row(s) stored, ${actions} corporate action(s), ${failed} failed`);
  return { dateISO, status: "ok", instrumentsConsidered: instrumentIds.length, instrumentsMissing: missing.length, fetched, inserted, failed };
}
