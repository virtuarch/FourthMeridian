/**
 * lib/prices/backfill.ts
 *
 * A8-3A / V26-PRICE-3 — historical security-price backfill for a set of
 * instruments. The ONE implementation shared by every production entry point:
 * the connect-time trigger (lib/plaid/backgroundHistorySync.ts:243), the A9
 * constant-quantity fallback (lib/investments/holding-price-backfill.ts), and
 * the manual CLI (scripts/backfill-security-prices.ts).
 *
 * ── V26-PRICE-3: planning is now coverage-driven ─────────────────────────────
 * This module used to infer coverage from the archive's BLOCK EDGES — earliest
 * covered date and latest covered date — and subtract them from the requested
 * span. That encoded an assumption nothing enforced: that stored evidence forms
 * a single contiguous interval. It held only because one force-backfill had
 * written a dense block, and when it broke on 2026-07-15 a two-year historical
 * request collapsed to an empty window the moment the daily cron had written ANY
 * recent row — silently ending historical valuation about thirty days back, with
 * the request never reaching the vendor for the older span at all.
 *
 * Planning now runs:
 *
 *     requested window  →  coverage binding (PRICE-2)  →  acquisition plan (PRICE-3)
 *
 * so a gap BEHIND a front-edge block is simply one of the missing ranges, and
 * interior gaps — which the old edge arithmetic could not represent at all — are
 * planned like any other. resolveBackfillWindow and resolveForceBackfillWindows
 * are gone, along with the per-instrument min/max reads that fed them: there is
 * exactly one coverage authority now.
 *
 * The forceWindow option survives as what it always really was — an explicit
 * REQUESTED WINDOW rather than a different planning algorithm. Both paths take
 * the same route; only the window's origin differs (caller-specified, versus
 * derived from the instrument's earliest defensible activity).
 *
 * Doctrine unchanged: missing-only, resumable, idempotent, chunked, insert-only
 * via priceArchive.writeBatch, closed dates only, NO interpolation. A fully
 * covered instrument still costs zero network calls. Provider-unreachable dates
 * are never requested — coverage excludes them from missing ranges by
 * construction, so no run can chase a gap it could never close.
 */

import { db } from "@/lib/db";
import { PriceBasis } from "@prisma/client";
import { priceArchive } from "./archive";
import { fetchInstrumentWindow } from "./fetch";
import { defaultPriceRegistry } from "./registry";
import { yesterdayUTCISO, toISODateUTC } from "./config";
import { loadInstrumentCoverage, type CoverageRequest } from "./coverage-binding";
import { planAcquisition, type AcquisitionPlan } from "./acquisition-plan.core";
import type { PriceRegistry } from "./types";

export interface BackfillPricesOptions {
  /** Write when true; otherwise plan-only (dry run). Default false. */
  apply?:     boolean;
  /** Maximum inclusive calendar days per vendor request. Default 365. */
  chunkDays?: number;
  /** Registry override. Default defaultPriceRegistry() (Tiingo when keyed, else empty). */
  registry?:  PriceRegistry;
  /** Target end date (inclusive), "YYYY-MM-DD". Default yesterday UTC. */
  toISO?:     string;
  /**
   * Optional SOFT budget: an absolute epoch-ms deadline. Before starting each
   * instrument the loop checks the clock; once past the deadline it stops and
   * reports `skippedForBudget`. Remaining instruments are picked up on the next
   * run — resume is safe because planning is missing-only.
   *
   * NOTE: the daily cron (jobs/fetch-security-prices) fills yesterday's single
   * date only, NOT historical windows, so it does NOT resume a truncated
   * historical backfill; the next connect (or a manual script run) does.
   */
  deadlineEpochMs?: number;
  /**
   * An explicit REQUESTED WINDOW for every instrument, regardless of its earliest
   * real activity — the A9 constant-quantity fallback. Without it, an instrument
   * whose only activity is today (holdings-only, no transaction history) yields a
   * window starting today, leaving nothing to value historical days against.
   *
   * Since V26-PRICE-3 this selects the window, not a different planner: coverage
   * decides what is missing inside it either way.
   */
  forceWindow?: { fromISO: string; toISO: string };
  /** Per-instrument progress line sink (CLI passes console.log; default no-op). */
  onProgress?: (line: string) => void;
}

export interface BackfillPricesResult {
  /** Instruments actually examined (< input length when the deadline stopped us early). */
  considered:         number;
  /** Instruments with at least one acquisition window (a plan line was emitted). */
  planned:            number;
  /** Instruments needing nothing: already complete, no expected dates, no defensible activity, or wholly below provider depth. */
  skipped:            number;
  /** Instruments that CANNOT be priced — CASH, options, missing provider symbol. Never retried. */
  skippedUnavailable: number;
  /** Instruments whose expected dates could not be produced (calendar horizon / unknown market). */
  skippedCalendarUnavailable: number;
  /** Instruments a fetch was attempted for (apply + a provider present). */
  fetchedInstruments: number;
  /** PriceObservation rows written. */
  inserted:           number;
  /** Instruments not started because the soft deadline was reached. */
  skippedForBudget:   number;
}

/**
 * Earliest defensible activity per instrument — first PositionObservation or
 * InvestmentEvent. Batched into two grouped queries rather than two per
 * instrument.
 *
 * NOTE (carried forward from the coverage investigation): a first OBSERVATION is
 * not first OWNERSHIP. An asset held before capture began has activity dated
 * later than it was actually acquired, so this floor can understate the true
 * window. Widening it to KNOWN ∪ POSSIBLE ownership is V26-PRICE-4's remit;
 * callers needing more history today pass forceWindow.
 */
async function earliestActivityByInstrument(ids: readonly string[]): Promise<Map<string, string>> {
  const [obs, evt] = await Promise.all([
    db.positionObservation.groupBy({
      by: ["instrumentId"],
      where: { instrumentId: { in: [...ids] }, deletedAt: null },
      _min: { date: true },
    }),
    db.investmentEvent.groupBy({
      by: ["instrumentId"],
      where: { instrumentId: { in: [...ids] } },
      _min: { date: true },
    }),
  ]);
  const out = new Map<string, string>();
  for (const row of [...obs, ...evt]) {
    const d = row._min.date;
    // InvestmentEvent.instrumentId is nullable — an event not attributable to an
    // instrument cannot bound that instrument's window, so it is skipped.
    if (!d || row.instrumentId === null) continue;
    const iso = toISODateUTC(d);
    const prior = out.get(row.instrumentId);
    if (prior === undefined || iso < prior) out.set(row.instrumentId, iso);
  }
  return out;
}

/** One-line plan description for the progress sink. */
function describePlan(plan: AcquisitionPlan): string {
  switch (plan.kind) {
    case "planned":
      return `${plan.windows.map((w) => `${w.fromISO}→${w.toISO}`).join(", ")} ` +
        `(${plan.windows.length} request(s), ${plan.missingExpectedCount} missing expected date(s)` +
        `${plan.unreachableCount > 0 ? `, ${plan.unreachableCount} below provider depth` : ""})`;
    case "no-op":
      return `nothing to acquire — ${plan.reason}` +
        (plan.unreachableCount > 0 ? ` (${plan.unreachableCount} date(s) below provider depth)` : "");
    case "unavailable":
      return `not priceable — ${plan.reasons.join(",")}`;
    case "calendar-unavailable":
      return plan.failure.code === "HORIZON_EXCEEDED"
        ? `NO EXPECTATIONS — ${plan.failure.calendarId} supports ` +
          `${plan.failure.supportedFromISO}→${plan.failure.supportedThroughISO}, ` +
          `asked ${plan.failure.requestedFromISO}→${plan.failure.requestedToISO}`
        : `NO EXPECTATIONS — no calendar for assetClass=${plan.failure.assetClass} mic=${plan.failure.mic ?? "NULL"}`;
    case "planning-error":
      return `PLANNING ERROR — ${plan.code}`;
  }
}

/**
 * Backfill historical RAW_CLOSE prices for the given instruments. Caller-scoped.
 * Returns metrics; never throws for a per-instrument vendor failure
 * (fetchInstrumentWindow absorbs adapter failures and reports source null).
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
    considered: 0, planned: 0, skipped: 0, skippedUnavailable: 0,
    skippedCalendarUnavailable: 0, fetchedInstruments: 0, inserted: 0, skippedForBudget: 0,
  };
  const ids = [...new Set(instrumentIds)].sort();
  if (ids.length === 0) return result;

  // ── 1. Requested window per instrument ────────────────────────────────────
  const requests: CoverageRequest[] = [];
  let noActivity = 0;
  if (opts.forceWindow) {
    for (const instrumentId of ids) {
      requests.push({ instrumentId, fromISO: opts.forceWindow.fromISO, toISO: opts.forceWindow.toISO });
    }
  } else {
    const earliest = await earliestActivityByInstrument(ids);
    for (const instrumentId of ids) {
      const from = earliest.get(instrumentId);
      // No defensible activity, or activity beyond the target — never backfill
      // arbitrary history for an unused instrument.
      if (from === undefined || from > toISO) { noActivity++; continue; }
      requests.push({ instrumentId, fromISO: from, toISO });
    }
  }
  result.considered += noActivity;
  result.skipped    += noActivity;
  if (requests.length === 0) return result;

  // ── 2. Coverage, then plan (one batched archive read for all instruments) ──
  const coverages = await loadInstrumentCoverage(requests, { basis: PriceBasis.RAW_CLOSE, registry });
  const plans = coverages.map((coverage) =>
    planAcquisition({ coverage, maxCalendarDaysPerRequest: chunkDays }),
  );

  // Provider symbols for the fetch stage — same identity the daily job resolves.
  const instruments = await db.instrument.findMany({
    where:  { id: { in: requests.map((r) => r.instrumentId) } },
    select: { id: true, tickerSymbol: true },
  });
  const symbolById = new Map(instruments.map((i) => [i.id, i.tickerSymbol]));

  // ── 3. Execute ────────────────────────────────────────────────────────────
  for (const plan of plans) {
    if (opts.deadlineEpochMs != null && Date.now() >= opts.deadlineEpochMs) {
      result.skippedForBudget = plans.length - (result.considered - noActivity);
      log(`⏱ budget reached — deferring ${result.skippedForBudget} instrument(s) to the next backfill run`);
      break;
    }
    result.considered++;

    if (plan.kind !== "planned") {
      if (plan.kind === "unavailable") result.skippedUnavailable++;
      else if (plan.kind === "calendar-unavailable" || plan.kind === "planning-error") result.skippedCalendarUnavailable++;
      else result.skipped++;
      // Anything that is not a benign no-op is surfaced: a silent skip is what
      // made the 2026-07-15 collapse invisible until traced against the DB.
      if (plan.kind !== "no-op") log(`• ${plan.instrumentId}: ${describePlan(plan)}`);
      continue;
    }

    result.planned++;
    log(`• ${plan.instrumentId}: ${describePlan(plan)}`);

    if (!apply || registry.adapters.length === 0) continue;
    for (const w of plan.windows) {
      const res = await fetchInstrumentWindow(
        {
          instrumentId:   plan.instrumentId,
          providerSymbol: symbolById.get(plan.instrumentId) ?? "",
          basis:          PriceBasis.RAW_CLOSE,
          fromISO:        w.fromISO,
          toISO:          w.toISO,
        },
        registry,
      );
      if (res.source && res.rows.length > 0) {
        const written = await priceArchive.writeBatch(res.source, res.rows);
        result.inserted += written.inserted;
      }
    }
    result.fetchedInstruments++;
  }

  return result;
}
