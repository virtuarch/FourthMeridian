/**
 * lib/prices/coverage-binding.ts
 *
 * V26-PRICE-2 — the READ-ONLY I/O half of the coverage binding. Loads instrument
 * metadata and archived observation dates, resolves the provider history floor
 * from the registry, and hands everything to the pure core
 * (coverage-binding.core.ts) which decides.
 *
 * STRICTLY READ-ONLY, and structurally so:
 *   - no provider call. `historicalDepth` is a DECLARED property of an adapter;
 *     reading it constructs nothing and contacts nothing. No adapter method that
 *     performs I/O is reachable from this module.
 *   - no write. Nothing here touches priceArchive.writeBatch or any mutation.
 *   - no persistence of `unavailable`. Coverage is DERIVED on demand, never
 *     cached — a cache of a derivable fact eventually disagrees with its source,
 *     which is the SpaceSnapshot failure mode this programme is unwinding.
 *   - no scheduling change. Backfill and the daily cron are untouched; consuming
 *     these reports to plan acquisition is V26-PRICE-3.
 *
 * One archive read serves the whole batch: the union window is read once and
 * partitioned per instrument in memory, rather than one query per instrument.
 */

import { db } from "@/lib/db";
import { PriceBasis } from "@prisma/client";
import { priceArchive } from "./archive";
import { defaultPriceRegistry } from "./registry";
import type { PriceArchiveReader, PriceRegistry } from "./types";
import {
  resolveInstrumentCoverage,
  resolveProviderFloorISO,
  type InstrumentCoverage,
  type InstrumentMeta,
  type ObservedPriceDate,
} from "./coverage-binding.core";

/** One instrument over one window — typically its ownership window. */
export interface CoverageRequest {
  instrumentId: string;
  fromISO:      string;
  toISO:        string;
}

export interface LoadCoverageOptions {
  /** Default RAW_CLOSE — the canonical valuation series. */
  basis?:    PriceBasis;
  /** Registry override (DI seam). Default defaultPriceRegistry(). */
  registry?: PriceRegistry;
  /** Archive override (DI seam for probes/tests). Default priceArchive. */
  archive?:  PriceArchiveReader;
}

/**
 * Read observation dates for the union window, tolerating an archive that
 * implements only the older readRange. Both members are optional on
 * PriceArchiveReader, so the fallback chain is part of the contract, not a
 * defensive flourish.
 */
async function readObservations(
  archive:       PriceArchiveReader,
  instrumentIds: readonly string[],
  basis:         PriceBasis,
  fromISO:       string,
  toISO:         string,
): Promise<{ instrumentId: string; dateISO: string; currency: string }[]> {
  if (archive.readCoveredDates) {
    return archive.readCoveredDates(instrumentIds, basis, fromISO, toISO);
  }
  if (archive.readRange) {
    const rows = await archive.readRange(instrumentIds, basis, fromISO, toISO);
    return rows.map((r) => ({ instrumentId: r.instrumentId, dateISO: r.dateISO, currency: r.currency }));
  }
  throw new Error("[prices] coverage binding requires readCoveredDates or readRange");
}

/**
 * Resolve coverage for each request. Read-only.
 *
 * Output is deterministic: results are returned sorted by (instrumentId,
 * fromISO, toISO) regardless of input order, and every per-instrument
 * observation list is derived by filtering — never by Map iteration order.
 *
 * Throws on a request naming an unknown instrument: that is a caller bug, and
 * inventing an empty-metadata report for it would silently misclassify the
 * instrument as unpriceable.
 */
export async function loadInstrumentCoverage(
  requests: readonly CoverageRequest[],
  opts:     LoadCoverageOptions = {},
): Promise<InstrumentCoverage[]> {
  if (requests.length === 0) return [];

  const basis    = opts.basis    ?? PriceBasis.RAW_CLOSE;
  const registry = opts.registry ?? defaultPriceRegistry();
  const archive  = opts.archive  ?? priceArchive;

  const ordered = [...requests].sort(
    (a, b) =>
      a.instrumentId.localeCompare(b.instrumentId) ||
      (a.fromISO < b.fromISO ? -1 : a.fromISO > b.fromISO ? 1 : 0) ||
      (a.toISO   < b.toISO   ? -1 : a.toISO   > b.toISO   ? 1 : 0),
  );
  const instrumentIds = [...new Set(ordered.map((r) => r.instrumentId))].sort();

  const rows = await db.instrument.findMany({
    where:  { id: { in: instrumentIds } },
    select: {
      id: true, assetClass: true, tickerSymbol: true,
      marketIdentifierCode: true, currency: true,
    },
  });
  const metaById = new Map<string, InstrumentMeta>(
    rows.map((r) => [
      r.id,
      {
        instrumentId:         r.id,
        assetClass:           String(r.assetClass),
        tickerSymbol:         r.tickerSymbol,
        marketIdentifierCode: r.marketIdentifierCode,
        currency:             r.currency,
      },
    ]),
  );
  const unknown = instrumentIds.filter((id) => !metaById.has(id));
  if (unknown.length > 0) {
    throw new Error(`[prices] coverage requested for unknown instrument(s): ${unknown.join(", ")}`);
  }

  // One read over the union window, partitioned per instrument below.
  const unionFrom = ordered.reduce((m, r) => (r.fromISO < m ? r.fromISO : m), ordered[0].fromISO);
  const unionTo   = ordered.reduce((m, r) => (r.toISO   > m ? r.toISO   : m), ordered[0].toISO);
  const observations = await readObservations(archive, instrumentIds, basis, unionFrom, unionTo);

  const byInstrument = new Map<string, ObservedPriceDate[]>();
  for (const id of instrumentIds) byInstrument.set(id, []);
  for (const o of observations) {
    byInstrument.get(o.instrumentId)?.push({ dateISO: o.dateISO, currency: o.currency });
  }

  const providerFloorISO = resolveProviderFloorISO(registry, basis);

  return ordered.map((req) =>
    resolveInstrumentCoverage({
      meta:             metaById.get(req.instrumentId)!,
      basis,
      requestedFromISO: req.fromISO,
      requestedToISO:   req.toISO,
      // coverage.core.ts clips to the window; passing the union set is safe.
      observed:         byInstrument.get(req.instrumentId) ?? [],
      providerFloorISO,
    }),
  );
}
