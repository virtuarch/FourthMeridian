/**
 * lib/prices/backfill.ts
 *
 * A8-3A — reusable historical security-price backfill for a set of instruments.
 *
 * The DB orchestration extracted from scripts/backfill-security-prices.ts so
 * BOTH the CLI (a thin wrapper: arg parsing + console output) and the
 * connect-time trigger (lib/plaid/backgroundHistorySync.ts) share ONE
 * implementation instead of duplicating it.
 *
 * Per instrument: window = [earliest defensible activity (first observation /
 * event), toISO], resumed from the latest already-covered RAW_CLOSE date
 * (missing-only), split into bounded chunks, fetched through the provider
 * failover chain, and written via priceArchive.writeBatch (insert-only,
 * skipDuplicates, closed-dates-only — never updates, never deletes). A
 * fully-covered instrument is skipped without a network call. NO interpolation.
 * Idempotent + resumable: a re-run (or a budget-truncated run resumed on the
 * next connect) fetches only what is still missing.
 */

import { db } from "@/lib/db";
import { PriceBasis } from "@prisma/client";
import { priceArchive } from "./archive";
import { fetchInstrumentWindow } from "./fetch";
import { defaultPriceRegistry } from "./registry";
import { resolveBackfillWindow, chunkWindow } from "./backfill-core";
import { yesterdayUTCISO, toISODateUTC } from "./config";
import type { PriceRegistry } from "./types";

export interface BackfillPricesOptions {
  /** Write when true; otherwise plan-only (dry run). Default false. */
  apply?:     boolean;
  /** Chunk size in days — one vendor call per chunk. Default 365. */
  chunkDays?: number;
  /** Registry override. Default defaultPriceRegistry() (Tiingo when keyed, else empty). */
  registry?:  PriceRegistry;
  /** Target end date (inclusive), "YYYY-MM-DD". Default yesterday UTC. */
  toISO?:     string;
  /**
   * Optional SOFT budget: an absolute epoch-ms deadline. Before starting each
   * instrument the loop checks the clock; once past the deadline it stops and
   * reports `skippedForBudget`. The remaining instruments are picked up on the
   * next backfill run — resume is safe because coverage is missing-only.
   *
   * NOTE: the daily cron (jobs/fetch-security-prices) only fills yesterday's
   * single date, NOT historical windows, so it does NOT resume a truncated
   * historical backfill; the next connect (or a manual script run) does.
   */
  deadlineEpochMs?: number;
  /**
   * A9 constant-quantity fallback: fetch this fixed window for EVERY instrument,
   * regardless of its earliest real activity. Without it, an instrument whose
   * earliest activity is today (holdings-only, no transaction history) resolves a
   * null window and no prices are fetched — leaving nothing to value historical
   * days against. Still missing-only (resumes from already-covered dates).
   */
  forceWindow?: { fromISO: string; toISO: string };
  /** Per-instrument progress line sink (CLI passes console.log; default no-op). */
  onProgress?: (line: string) => void;
}

export interface BackfillPricesResult {
  /** Instruments actually examined (< input length when the deadline stopped us early). */
  considered:         number;
  /** Instruments with a non-empty window (a plan line was emitted). */
  planned:            number;
  /** Instruments with no defensible activity or already fully covered. */
  skipped:            number;
  /** Instruments a fetch was attempted for (apply + a provider present). */
  fetchedInstruments: number;
  /** PriceObservation rows written. */
  inserted:           number;
  /** Instruments not started because the soft deadline was reached. */
  skippedForBudget:   number;
}

async function earliestActivityISO(instrumentId: string): Promise<string | null> {
  const [obs, evt] = await Promise.all([
    db.positionObservation.findFirst({
      where: { instrumentId, deletedAt: null }, orderBy: { date: "asc" }, select: { date: true },
    }),
    db.investmentEvent.findFirst({
      where: { instrumentId }, orderBy: { date: "asc" }, select: { date: true },
    }),
  ]);
  const dates = [obs?.date, evt?.date].filter((d): d is Date => d != null).map(toISODateUTC);
  return dates.length ? dates.sort()[0] : null;
}

async function latestCoveredISO(instrumentId: string): Promise<string | null> {
  const row = await db.priceObservation.findFirst({
    where: { instrumentId, basis: PriceBasis.RAW_CLOSE }, orderBy: { date: "desc" }, select: { date: true },
  });
  return row ? toISODateUTC(row.date) : null;
}

/**
 * Backfill historical RAW_CLOSE prices for the given instruments. Caller-scoped:
 * the CLI passes every held instrument (optionally filtered); the connect
 * trigger passes only a newly-connected account's held instrument ids. Returns
 * metrics; never throws for a per-instrument vendor failure (fetchInstrumentWindow
 * absorbs adapter failures and reports source null).
 */
export async function backfillPricesForInstruments(
  instrumentIds: readonly string[],
  opts:          BackfillPricesOptions = {},
): Promise<BackfillPricesResult> {
  const apply     = opts.apply ?? false;
  const chunkDays = opts.chunkDays ?? 365;
  const registry  = opts.registry ?? defaultPriceRegistry();
  const toISO     = opts.toISO ?? yesterdayUTCISO();
  const log       = opts.onProgress ?? (() => {});

  const result: BackfillPricesResult = {
    considered: 0, planned: 0, skipped: 0, fetchedInstruments: 0, inserted: 0, skippedForBudget: 0,
  };
  const ids = [...instrumentIds];
  if (ids.length === 0) return result;

  // Resolve provider symbols once (Instrument.tickerSymbol) — same identity the
  // daily job resolves; a missing ticker degrades to "" (the adapter returns []).
  const instruments = await db.instrument.findMany({
    where:  { id: { in: ids } },
    select: { id: true, tickerSymbol: true },
  });
  const symbolById = new Map(instruments.map((i) => [i.id, i.tickerSymbol]));

  for (const instrumentId of ids) {
    // Soft budget: stop before starting a new instrument once past the deadline.
    if (opts.deadlineEpochMs != null && Date.now() >= opts.deadlineEpochMs) {
      result.skippedForBudget = ids.length - result.considered;
      log(`⏱ budget reached — deferring ${result.skippedForBudget} instrument(s) to the next backfill run`);
      break;
    }
    result.considered++;

    const [earliest, covered] = await Promise.all([earliestActivityISO(instrumentId), latestCoveredISO(instrumentId)]);
    // forceWindow (A9 constant-quantity fallback) treats its fromISO as the
    // instrument's floor, so a currently-held instrument with no pre-today
    // activity still gets its historical window fetched; covered still gates it
    // (missing-only).
    const window = opts.forceWindow
      ? resolveBackfillWindow(opts.forceWindow.fromISO, covered, opts.forceWindow.toISO)
      : resolveBackfillWindow(earliest, covered, toISO);
    if (!window) { result.skipped++; continue; }
    const chunks = chunkWindow(window.fromISO, window.toISO, chunkDays);
    result.planned++;
    log(`• ${instrumentId}: ${window.fromISO}→${window.toISO} (${chunks.length} chunk(s)${covered ? `, resume from ${covered}` : ""})`);

    if (!apply || registry.adapters.length === 0) continue;
    for (const c of chunks) {
      const res = await fetchInstrumentWindow(
        { instrumentId, providerSymbol: symbolById.get(instrumentId) ?? "", basis: PriceBasis.RAW_CLOSE, fromISO: c.fromISO, toISO: c.toISO },
        registry,
      );
      if (res.source && res.rows.length > 0) {
        const w = await priceArchive.writeBatch(res.source, res.rows);
        result.inserted += w.inserted;
      }
    }
    result.fetchedInstruments++;
  }

  return result;
}
