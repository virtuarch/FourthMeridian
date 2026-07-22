/**
 * lib/prices/fetch.ts
 *
 * A8-3A — fetch orchestration (clone of lib/fx/fetch.ts). Pure orchestration, NO
 * persistence: callers (scripts/backfill-security-prices.ts, jobs/fetch-security-
 * prices.ts) store the result via priceArchive.writeBatch — this module never
 * touches the database.
 *
 * Contract:
 *   - One instrument + one basis + one CLOSED-date window per call.
 *   - Walk the registry in priority order; the FIRST adapter that both serves
 *     the basis and returns a usable, validated batch wins; that batch stamps
 *     its true source (provenance).
 *   - An adapter that does not serve the basis is skipped (noted).
 *   - Adapter failure (throw, bad shape, off-window/off-instrument/off-basis row,
 *     non-positive price) → log and CONTINUE to the next adapter. Partial answers
 *     are never merged across adapters (a whole batch is accepted or discarded).
 *   - An adapter legitimately returning [] (no data for this instrument/window,
 *     e.g. a delisted tail) is "no data", not a failure — continue.
 *   - Deterministic: same registry + same adapter responses → same result.
 *   - NEVER interpolates: absent trading days simply do not appear.
 */

import { assertISODate } from "./config";
import type { PriceFetchRequest, PriceRegistry, PriceResult } from "./types";

export interface InstrumentFetchResult {
  instrumentId: string;
  basis:   PriceFetchRequest["basis"];
  fromISO: string;
  toISO:   string;
  /** Winning adapter, or null when no adapter produced data for this window. */
  source:  string | null;
  /** Validated rows from the winning adapter ([] when source is null). */
  rows:    PriceResult[];
  /** Per-adapter notes in registry order (skips + failures), for progress output. */
  notes:   string[];
}

/** Batch validation: every row on-instrument, on-basis, in-window, positive-finite. */
function validateBatch(rows: PriceResult[], req: PriceFetchRequest): void {
  for (const r of rows) {
    assertISODate(r.dateISO);
    if (r.instrumentId !== req.instrumentId) throw new Error(`off-instrument row ${r.instrumentId}`);
    if (r.basis !== req.basis) throw new Error(`off-basis row ${r.basis} (want ${req.basis})`);
    if (r.dateISO < req.fromISO || r.dateISO > req.toISO) throw new Error(`off-window row ${r.dateISO}`);
    if (!Number.isFinite(r.price) || r.price <= 0) throw new Error(`invalid price for ${r.dateISO}`);
    if (!r.currency) throw new Error(`missing currency for ${r.dateISO}`);
  }
}

/**
 * Fetch one instrument's closed daily closes over [fromISO, toISO] on one basis
 * through the registry's failover chain. No persistence — the caller writes the
 * returned rows via the archive.
 */
export async function fetchInstrumentWindow(
  req: PriceFetchRequest,
  registry: PriceRegistry,
): Promise<InstrumentFetchResult> {
  assertISODate(req.fromISO);
  assertISODate(req.toISO);
  const base: Omit<InstrumentFetchResult, "source" | "rows" | "notes"> = {
    instrumentId: req.instrumentId, basis: req.basis, fromISO: req.fromISO, toISO: req.toISO,
  };
  const notes: string[] = [];

  for (const adapter of registry.adapters) {
    if (!adapter.supportedBases().includes(req.basis)) {
      notes.push(`${adapter.source}: does not serve ${req.basis} — skipped`);
      continue;
    }
    try {
      const rows = await adapter.fetchDailyCloses(req);
      if (rows.length === 0) {
        notes.push(`${adapter.source}: no data for ${req.instrumentId} in [${req.fromISO}, ${req.toISO}]`);
        continue;
      }
      validateBatch(rows, req);
      return { ...base, source: adapter.source, rows, notes };
    } catch (e) {
      notes.push(`${adapter.source}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
  }

  return { ...base, source: null, rows: [], notes };
}
