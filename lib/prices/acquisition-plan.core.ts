/**
 * lib/prices/acquisition-plan.core.ts
 *
 * V26-PRICE-3 — the PURE translation from "what evidence is missing" to "what
 * should be requested". No Prisma, no network, no clock, no registry access.
 *
 * This module replaces the single-contiguous-interval assumption that
 * backfill-core.ts encoded (removed in this slice). That assumption held only by
 * accident of usage: one force-backfill wrote a dense block, so subtracting the
 * block's edges happened to yield the right answer. Nothing enforced it and
 * nothing could detect its violation — and when it broke on 2026-07-15, a
 * two-year historical request collapsed to an empty window the moment the daily
 * cron had written ANY recent row, silently ending historical valuation about
 * thirty days back. Planning from an explicit missing-date set cannot fail that
 * way: the gap behind a front-edge block is simply one of the ranges.
 *
 * ── Why the result is not AcquisitionWindow[] ────────────────────────────────
 * An empty array cannot distinguish "nothing to do" from "nothing may be done"
 * from "we could not form the question". Those demand different operator
 * responses — extend a table, fix instrument identity, wait for a vendor, or do
 * nothing at all — so the plan is a discriminated union in which every zero-window
 * outcome names its own cause. `windows` is present on every variant so a caller
 * that only wants requests never has to branch.
 *
 * ── Layering ────────────────────────────────────────────────────────────────
 *   calendar generation → binding result → acquisition planning → PRICE-4 effects
 *
 * The input is the PRICE-2 binding's own InstrumentCoverage union, so calendar
 * failure arrives as a first-class case. CalendarFailure is NOT pushed down into
 * coverage.core.ts and HORIZON_EXCEEDED is NOT a coverage reason — a report over
 * fabricated expectations would be worse than no report.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 * PRICE_MAX_STALE_DAYS. Valuation staleness is unrelated to acquisition: whether
 * a stored price may be walked back to value a date says nothing about whether
 * the archive should hold that date. Provider identity, credentials, rate limits
 * and registry state are also absent — the chunk constraint arrives as a plain
 * number so this module can be reasoned about without a vendor in scope.
 */

import type { CoverageReason, CoverageReport } from "./coverage.core";
import type { CalendarFailure } from "@/lib/calendar/trading-calendar";
import type { InstrumentCoverage } from "./coverage-binding.core";
import { chunkWindow } from "./backfill-core";

/** One inclusive provider request window. */
export interface AcquisitionWindow {
  fromISO: string;
  toISO:   string;
  /** Inclusive CALENDAR days requested — the vendor-cost unit, not expected dates. */
  requestDays: number;
}

/** Why a plan produced no windows, when the instrument itself is fine. */
export type NoOpReason =
  /** Every actionable expected date is already archived. */
  | "COMPLETE"
  /** The window contains no expected market dates at all (e.g. a weekend). */
  | "NO_EXPECTED_DATES"
  /** Every expected date precedes provider depth — unfillable, not missing. */
  | "BEFORE_PROVIDER_DEPTH";

export type AcquisitionPlan =
  | {
      kind:                 "planned";
      instrumentId:         string;
      calendarId:           string;
      requestedFromISO:     string;
      requestedToISO:       string;
      windows:              AcquisitionWindow[];
      /** Missing expected dates the windows exist to acquire. */
      missingExpectedCount: number;
      /** Σ requestDays — what the vendor is actually asked for. */
      requestDayCount:      number;
      /** Expected dates below provider depth, excluded from every window. */
      unreachableCount:     number;
    }
  | {
      kind:             "no-op";
      instrumentId:     string;
      calendarId:       string;
      requestedFromISO: string;
      requestedToISO:   string;
      reason:           NoOpReason;
      windows:          [];
      unreachableCount: number;
    }
  | {
      /** The INSTRUMENT cannot be priced — never retry it, in any window. */
      kind:             "unavailable";
      instrumentId:     string;
      calendarId:       string;
      requestedFromISO: string;
      requestedToISO:   string;
      reasons:          CoverageReason[];
      windows:          [];
    }
  | {
      /** Expected dates could not be produced, so nothing may be inferred. */
      kind:         "calendar-unavailable";
      instrumentId: string;
      failure:      CalendarFailure;
      windows:      [];
    }
  | {
      /**
       * A tripwire, not an expected outcome. Coverage guarantees
       * missingRanges non-empty ⟺ partial, so a partial report must yield
       * windows. If it ever does not, the caller is told explicitly rather than
       * receiving an empty array indistinguishable from success.
       */
      kind:             "planning-error";
      instrumentId:     string;
      calendarId:       string;
      requestedFromISO: string;
      requestedToISO:   string;
      code:             "PARTIAL_WITHOUT_WINDOWS";
      windows:          [];
    };

export interface PlanAcquisitionInput {
  coverage: InstrumentCoverage;
  /**
   * Maximum inclusive CALENDAR days per provider request. An input, never read
   * from the registry: this module must stay reasonable about without a vendor
   * configured, and a caller may legitimately plan under a hypothetical limit.
   */
  maxCalendarDaysPerRequest: number;
}

/** Inclusive whole-day span, both endpoints counted. */
function inclusiveDays(fromISO: string, toISO: string): number {
  const ms = Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * Which reasons mark the INSTRUMENT unpriceable, as opposed to this particular
 * window being unreachable. The distinction drives retry policy: an unpriceable
 * instrument must never be retried, while a below-depth window says nothing
 * about the instrument at all.
 */
const INSTRUMENT_LEVEL_REASONS: ReadonlySet<CoverageReason> = new Set<CoverageReason>([
  "NOT_PRICEABLE",
  "NO_PROVIDER_SYMBOL",
]);

/**
 * Translate one coverage outcome into an acquisition plan.
 *
 * Deterministic: windows are emitted in ascending order derived from the
 * report's already-ascending missing ranges, never from Set or Map iteration,
 * and no ambient time or randomness is consulted.
 *
 * The Friday→Monday case is deliberately ONE request. A CoverageRange's bounds
 * are already calendar dates (the first and last missing EXPECTED dates), so a
 * weekend inside a range is spanned, not split — the vendor simply returns no
 * weekend rows. Splitting on non-expected days would multiply requests for
 * nothing. Conversely two runs separated by a COVERED expected date stay
 * separate, because coverage already broke the run there.
 */
export function planAcquisition(input: PlanAcquisitionInput): AcquisitionPlan {
  const { coverage, maxCalendarDaysPerRequest } = input;

  if (coverage.kind === "calendar-unavailable") {
    return { kind: "calendar-unavailable", instrumentId: coverage.instrumentId, failure: coverage.failure, windows: [] };
  }

  const report: CoverageReport = coverage.report;
  const base = {
    instrumentId:     report.instrumentId,
    calendarId:       report.calendarId,
    requestedFromISO: report.requestedFromISO,
    requestedToISO:   report.requestedToISO,
  };

  if (report.state === "unavailable") {
    // Below-depth is a WINDOW limitation; unpriceable is an INSTRUMENT verdict.
    const instrumentLevel = report.reasons.filter((r) => INSTRUMENT_LEVEL_REASONS.has(r));
    if (instrumentLevel.length === 0) {
      return { kind: "no-op", ...base, reason: "BEFORE_PROVIDER_DEPTH", windows: [], unreachableCount: report.unreachableCount };
    }
    return { kind: "unavailable", ...base, reasons: report.reasons, windows: [] };
  }

  if (report.state === "complete") {
    return {
      kind:             "no-op",
      ...base,
      reason:           report.expectedCount === 0 ? "NO_EXPECTED_DATES" : "COMPLETE",
      windows:          [],
      unreachableCount: report.unreachableCount,
    };
  }

  // Partial — one request per missing run, each chunked to the request limit.
  const windows: AcquisitionWindow[] = [];
  for (const range of report.missingRanges) {
    for (const c of chunkWindow(range.fromISO, range.toISO, maxCalendarDaysPerRequest)) {
      windows.push({ fromISO: c.fromISO, toISO: c.toISO, requestDays: inclusiveDays(c.fromISO, c.toISO) });
    }
  }

  if (windows.length === 0) {
    return { kind: "planning-error", ...base, code: "PARTIAL_WITHOUT_WINDOWS", windows: [] };
  }

  return {
    kind:                 "planned",
    ...base,
    windows,
    missingExpectedCount: report.missingCount,
    requestDayCount:      windows.reduce((n, w) => n + w.requestDays, 0),
    unreachableCount:     report.unreachableCount,
  };
}
