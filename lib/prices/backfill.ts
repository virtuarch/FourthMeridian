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
import { recordCorporateActionTerms } from "@/lib/investments/corporate-actions";
import { defaultPriceRegistry } from "./registry";
import { yesterdayUTCISO } from "./config";
import { loadInstrumentCoverage, type CoverageRequest } from "./coverage-binding";
import { planAcquisition, type AcquisitionPlan } from "./acquisition-plan.core";
import { loadOwnershipWindows } from "./ownership-window";
import { acquisitionCheckpointId } from "./acquisition-budget.core";
import { PROVIDER_OUTCOMES, type ProviderOutcome } from "./provider-errors";
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
  /** V26-S1-CA — corporate-action terms recorded from the same provider responses. */
  corporateActions:   number;
  /** Instruments not started because the soft deadline was reached. */
  skippedForBudget:   number;
  /**
   * V26-PRICE-4 — provider outcomes by classification. `source === null` alone
   * cannot separate a throttled run from a delisted tail, and a run that was
   * rate-limited into silence otherwise looks exactly like a complete one.
   */
  outcomes:           Record<ProviderOutcome, number>;
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

  const outcomes = Object.fromEntries(PROVIDER_OUTCOMES.map((o) => [o, 0])) as Record<ProviderOutcome, number>;
  const result: BackfillPricesResult = {
    considered: 0, planned: 0, skipped: 0, skippedUnavailable: 0,
    skippedCalendarUnavailable: 0, fetchedInstruments: 0, inserted: 0, corporateActions: 0,
    skippedForBudget: 0, outcomes,
  };
  const ids = [...new Set(instrumentIds)].sort();
  if (ids.length === 0) return result;

  // ── 1. Requested window per instrument ────────────────────────────────────
  // V26-PRICE-4 — the window comes from OWNERSHIP evidence, not from the first
  // observation alone. A first observation is dated when capture began, not when
  // the asset was acquired; using it as the floor silently truncates history
  // (BTC locally: direct evidence 2026-07-19, wallet transactions from
  // 2023-03-24). resolveOwnershipWindow widens to KNOWN ∪ POSSIBLE and keeps the
  // two distinguishable; UNKNOWN prehistory is never requested.
  const requests: CoverageRequest[] = [];
  let noEvidence = 0;
  if (opts.forceWindow) {
    for (const instrumentId of ids) {
      requests.push({ instrumentId, fromISO: opts.forceWindow.fromISO, toISO: opts.forceWindow.toISO });
    }
  } else {
    const ownership = await loadOwnershipWindows(ids, toISO);
    for (const instrumentId of ids) {
      const resolved = ownership.get(instrumentId);
      if (!resolved || resolved.kind !== "resolved") { noEvidence++; continue; }
      requests.push({
        instrumentId,
        fromISO: resolved.acquisitionFromISO,
        toISO:   resolved.acquisitionToISO,
      });
    }
  }
  result.considered += noEvidence;
  result.skipped    += noEvidence;
  if (requests.length === 0) return result;

  // ── 2. Coverage, then plan (one batched archive read for all instruments) ──
  const coverages = await loadInstrumentCoverage(requests, { basis: PriceBasis.RAW_CLOSE, registry });
  const plans = coverages.map((coverage) =>
    planAcquisition({ coverage, maxCalendarDaysPerRequest: chunkDays }),
  );

  // Provider symbols for the fetch stage — same identity the daily job resolves.
  const instruments = await db.instrument.findMany({
    where:  { id: { in: requests.map((r) => r.instrumentId) } },
    select: { id: true, tickerSymbol: true, assetClass: true },
  });
  const symbolById = new Map(instruments.map((i) => [i.id, i.tickerSymbol]));
  // assetClass is a ROUTING input (V26-PRICE-PROVIDER-UNIFICATION): the registry
  // picks the capable vendor from it, so equities and crypto share this loop.
  const classById = new Map(instruments.map((i) => [i.id, String(i.assetClass)]));

  // ── 3. Execute ────────────────────────────────────────────────────────────
  for (const plan of plans) {
    if (opts.deadlineEpochMs != null && Date.now() >= opts.deadlineEpochMs) {
      result.skippedForBudget = plans.length - (result.considered - noEvidence);
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
          assetClass:     classById.get(plan.instrumentId) ?? "UNKNOWN",
          providerSymbol: symbolById.get(plan.instrumentId) ?? "",
          basis:          PriceBasis.RAW_CLOSE,
          fromISO:        w.fromISO,
          toISO:          w.toISO,
        },
        registry,
      );
      result.outcomes[res.outcome]++;

      // Checkpoint identity is derived from WHAT the request is — provider,
      // instrument, requested window, chunk — never from execution order. A
      // position-based id ("chunk 3 of 7") breaks the moment the plan changes
      // shape, which it does on every run as coverage shrinks.
      const checkpoint = acquisitionCheckpointId(
        res.source ?? "unrouted", plan.instrumentId,
        plan.requestedFromISO, plan.requestedToISO, w,
      );

      if (res.outcome === "OK" && res.source) {
        // Append-only: writeBatch is insert-only with skipDuplicates, so an
        // already-stored observation is never overwritten by a re-fetch.
        const written = await priceArchive.writeBatch(res.source, res.rows);
        result.inserted += written.inserted;
        // V26-S1-CA — the same response also stated any corporate action in this
        // window. Recorded beside the prices, never inside them. Best-effort: a
        // terms failure must not lose a completed price acquisition, and its
        // consequence is a walk that keeps refusing — a refusal, not a wrong
        // number.
        if (res.corporateActions.length > 0) {
          try {
            const n = await recordCorporateActionTerms(res.source, res.corporateActions);
            result.corporateActions += n;
            log(`  ✓ ${checkpoint} — ${n} corporate action(s) recorded`);
          } catch (e) {
            log(`  · ${checkpoint} — corporate-action capture failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        log(`  ✓ ${checkpoint} — ${written.inserted} row(s)`);
      } else {
        log(`  · ${checkpoint} — ${res.outcome}${res.notes.length ? `: ${res.notes[res.notes.length - 1]}` : ""}`);
      }
    }
    result.fetchedInstruments++;
  }

  return result;
}
