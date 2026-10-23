/**
 * lib/prices/coverage.core.ts
 *
 * V26-PRICE-1 — the PURE historical-price coverage planner: given what evidence
 * was EXPECTED and what evidence EXISTS, state what is missing. No Prisma, no
 * network, no clock, no calendar data — fixture-tested.
 *
 * Why this module exists
 * ──────────────────────
 * lib/prices/backfill-core.ts answers "what should I fetch NEXT" — a plan. It
 * cannot answer "what is missing", and its empty window is ambiguous: nothing
 * needed and nothing obtainable look identical. Worse, the archive alone cannot
 * distinguish "the market was closed" from "we never fetched it" — both are an
 * absent row (service.ts: "Weekends and market holidays are ABSENT rows by
 * design"). This module takes the expected-date set as an INPUT (from a
 * TradingCalendar, types.ts) and turns absence into a structured, honest
 * statement.
 *
 * Scope: ONE instrument, ONE basis, ONE requested window. No aggregation — a
 * caller that wants a portfolio view aggregates these reports itself.
 *
 * NOT staleness. PRICE_MAX_STALE_DAYS is deliberately absent: coverage answers
 * whether evidence EXISTS; valuation (service.ts walk-back) decides whether
 * evidence is USABLE. Mixing them would put valuation policy inside an
 * acquisition planner, and would make every weekend look like a gap.
 *
 * ── DETERMINISM (a load-bearing contract, not an aspiration) ─────────────────
 * Identical inputs MUST produce byte-for-byte identical output, provable with
 * JSON.stringify. Enforced by construction:
 *
 *   - NO CLOCK. yesterdayUTCISO()/assertClosedDateISO() are never called; the
 *     window is fully specified by the caller. Nothing here reads Date.now().
 *   - SET SEMANTICS. expectedDates/observedDates are mathematical sets, not
 *     sequences: deduped and sorted ascending before ANY logic runs, so callers
 *     passing equivalent inputs in different orders get identical output.
 *   - NO ITERATION-ORDER LEAKS. Set/Map are used for membership tests only;
 *     every ordered output comes from an explicit sort or a declared constant
 *     order. JS Sets preserve INSERTION order, so iterating one would silently
 *     inherit caller ordering — never done here.
 *   - STABLE KEYS. The report is built as ONE object literal with every key
 *     always present (null/[] rather than omission), so key order — and
 *     therefore serialized bytes — cannot vary with the code path taken.
 *   - STABLE REASONS. Reasons accumulate in a Set and are emitted by filtering
 *     COVERAGE_REASONS, so the array is always in declaration order, never
 *     discovery order.
 *   - NO AMBIENT DATA. No timestamps, random ids, environment reads, locale
 *     formatting, floats, or provider-call results ever enter the output.
 *
 * ── What "complete" means (read this before trusting it) ─────────────────────
 * `complete` means NO ACTIONABLE EVIDENCE IS MISSING — not "the whole requested
 * window has prices". A window reaching back past every provider's historical
 * depth can be `complete` with a large `unreachableCount` and a
 * BEFORE_PROVIDER_DEPTH reason: everything obtainable was obtained. This keeps
 * `missingRanges` strictly a list of ACQUISITION TARGETS; padding it with
 * permanently unfillable dates would produce a gap no run could ever close.
 * The counts, not the state alone, tell the whole story.
 */

import type { PriceBasis } from "@prisma/client";
import { assertISODate } from "./config";

// ── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * Coverage states — deliberately NOT CompletenessTier. That vocabulary
 * (observed/derived/estimated/incomplete/unknown) describes VALUATION truth:
 * how well a number is known. This describes ACQUISITION truth: whether the
 * evidence was gathered. Overloading one onto the other would make "estimated"
 * mean two unrelated things.
 */
export type CoverageState = "complete" | "partial" | "unavailable";

/**
 * Every reason a report can carry. DECLARATION ORDER IS EMISSION ORDER — the
 * `reasons` array is produced by filtering this tuple, so it never depends on
 * the order facts were discovered. Ordered: disqualifiers, then absence, then
 * positional gaps chronologically, then explanatory notes.
 *
 * Reasons are EXPLANATORY, not exclusively failures: a `complete` report can
 * carry NO_EXPECTED_DATES (complete because nothing was expected) — materially
 * different from complete because everything was fetched.
 */
export const COVERAGE_REASONS = [
  /** Caller-supplied: this instrument has no price series by nature (CASH). */
  "NOT_PRICEABLE",
  /** Caller-supplied: no resolvable vendor identity (e.g. a null tickerSymbol). */
  "NO_PROVIDER_SYMBOL",
  /** Some or all expected dates precede providerFloorISO — permanently unfillable. */
  "BEFORE_PROVIDER_DEPTH",
  /** Zero observed dates anywhere in the requested window. */
  "NO_COVERAGE",
  /** Missing dates earlier than the earliest observed date. */
  "BEFORE_FIRST_COVERAGE",
  /** Missing dates INSIDE the observed block — falsifies the contiguity
   *  assumption resolveForceBackfillWindows depends on (backfill-core.ts:99). */
  "INTERIOR_GAP",
  /** Missing dates later than the latest observed date. */
  "AFTER_LAST_COVERAGE",
  /** The window contains no expected market dates at all (e.g. a weekend). */
  "NO_EXPECTED_DATES",
  /** An observed date the calendar did not expect — the STALE-CALENDAR tripwire.
   *  Never changes `state`: an extra price is not a coverage failure. */
  "UNEXPECTED_OBSERVATION",
] as const;

export type CoverageReason = (typeof COVERAGE_REASONS)[number];

/**
 * Whether prices can exist for this instrument at all. A discriminated union
 * rather than a boolean + optional reason: the planner cannot know WHY an
 * instrument is unpriceable (a CASH asset class and a null ticker are different
 * problems with different fixes), and this shape makes it impossible to declare
 * something unpriceable without saying which.
 */
export type Priceability =
  | { priceable: true }
  | { priceable: false; reason: "NOT_PRICEABLE" | "NO_PROVIDER_SYMBOL" };

// ── Input / output ───────────────────────────────────────────────────────────

export interface CoverageInput {
  instrumentId:     string;
  basis:            PriceBasis;
  requestedFromISO: string;
  requestedToISO:   string;
  /** TradingCalendar.id — provenance of expectedDates, echoed into the report. */
  calendarId:       string;
  /** Expected market dates. SET semantics: order and duplicates are irrelevant.
   *  May be a superset of the window; dates outside it are clipped away. */
  expectedDates:    readonly string[];
  /** Archive dates present for (instrumentId, basis). Same set semantics. */
  observedDates:    readonly string[];
  /** Earliest date any adapter can serve; null ⇒ unbounded depth. */
  providerFloorISO: string | null;
  priceability:     Priceability;
}

/** One merged run of consecutive MISSING expected dates. */
export interface CoverageRange {
  /** First missing expected date in the run. */
  fromISO:       string;
  /** Last missing expected date in the run. */
  toISO:         string;
  /** Count of missing EXPECTED dates — never the calendar-day span. A Fri→Mon
   *  range spanning a weekend has expectedDates 2, not 4. */
  expectedDates: number;
}

export interface CoverageReport {
  instrumentId:     string;
  basis:            PriceBasis;
  calendarId:       string;
  requestedFromISO: string;
  requestedToISO:   string;
  state:            CoverageState;
  /** Acquisition targets: ascending by fromISO, non-overlapping, merged over
   *  consecutive EXPECTED-DATE POSITIONS (not calendar adjacency), so a weekend
   *  or holiday between two missing trading days never fragments a range.
   *  INVARIANT: non-empty if and only if state === "partial". */
  missingRanges:    CoverageRange[];
  /** Expected dates within the window. */
  expectedCount:    number;
  /** Observed dates within the window, INCLUDING any the calendar did not expect. */
  observedCount:    number;
  /** Actionable expected dates with no observation — Σ missingRanges.expectedDates. */
  missingCount:     number;
  /** Expected dates before providerFloorISO. Excluded from missingRanges: they
   *  are not acquisition targets, and listing them would create a gap no run
   *  could ever close. */
  unreachableCount: number;
  /** Observed dates the calendar did not expect. Diagnostic only. */
  unexpectedCount:  number;
  /** Canonical COVERAGE_REASONS order. Always a subsequence of that tuple. */
  reasons:          CoverageReason[];
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Set normalization: validate, dedupe, sort ascending. ISO "YYYY-MM-DD" sorts
 * lexicographically in chronological order, so a plain string sort is correct
 * AND locale-independent (never `localeCompare`, which is locale-sensitive and
 * would break byte-for-byte determinism across environments).
 */
function normalizeDates(dates: readonly string[]): string[] {
  for (const d of dates) assertISODate(d);
  return [...new Set(dates)].sort();
}

/**
 * Merge missing dates into runs that are CONSECUTIVE IN THE EXPECTED-DATE
 * SEQUENCE. `sequence` must be ascending and contain every date in `missing`.
 * Both inputs are already sorted, so the output is ascending and non-overlapping
 * by construction.
 */
function mergeIntoRanges(missing: readonly string[], sequence: readonly string[]): CoverageRange[] {
  if (missing.length === 0) return [];
  const positionOf = new Map(sequence.map((d, i) => [d, i]));
  const ranges: CoverageRange[] = [];
  let start = 0;
  for (let i = 0; i < missing.length; i++) {
    const here = positionOf.get(missing[i]);
    const next = i + 1 < missing.length ? positionOf.get(missing[i + 1]) : undefined;
    // Break the run at the last element, or wherever the next missing date is
    // not the very next EXPECTED date (an intervening date was observed).
    if (next === undefined || here === undefined || next !== here + 1) {
      ranges.push({ fromISO: missing[start], toISO: missing[i], expectedDates: i - start + 1 });
      start = i + 1;
    }
  }
  return ranges;
}

/** Emit reasons in COVERAGE_REASONS declaration order — never discovery order. */
function emitReasons(collected: ReadonlySet<CoverageReason>): CoverageReason[] {
  return COVERAGE_REASONS.filter((r) => collected.has(r));
}

// ── The planner ──────────────────────────────────────────────────────────────

/**
 * Report what price evidence is missing for one (instrument, basis) over one
 * window. Pure and deterministic; see the DETERMINISM block above.
 *
 * Throws (programmer error, never a runtime condition to swallow) on a malformed
 * ISO date or an inverted window. A coverage report is consumed as a statement
 * about evidence — there is no honest report for a nonsensical window, so it is
 * rejected rather than smoothed into a misleading "complete".
 *
 * Decision order is part of the contract:
 *   1. validate + normalize + clip to the window
 *   2. not priceable                       → unavailable
 *   3. no expected dates                   → complete  (NO_EXPECTED_DATES)
 *   4. every expected date below the floor  → unavailable (BEFORE_PROVIDER_DEPTH)
 *   5. nothing actionable missing          → complete
 *   6. otherwise                           → partial + positional reasons
 */
export function coverageFor(input: CoverageInput): CoverageReport {
  const { requestedFromISO, requestedToISO, providerFloorISO, priceability } = input;

  assertISODate(requestedFromISO);
  assertISODate(requestedToISO);
  if (requestedFromISO > requestedToISO) {
    throw new Error(
      `[prices] coverageFor: inverted window "${requestedFromISO}" → "${requestedToISO}"`,
    );
  }
  if (providerFloorISO !== null) assertISODate(providerFloorISO);

  // Normalize as sets, then clip to the window (callers may pass a superset).
  const inWindow = (d: string): boolean => d >= requestedFromISO && d <= requestedToISO;
  const expected = normalizeDates(input.expectedDates).filter(inWindow);
  const observed = normalizeDates(input.observedDates).filter(inWindow);

  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);

  const reasons = new Set<CoverageReason>();

  // Stale-calendar tripwire — computed on every path, never affects `state`.
  const unexpectedCount = observed.reduce((n, d) => (expectedSet.has(d) ? n : n + 1), 0);
  if (unexpectedCount > 0) reasons.add("UNEXPECTED_OBSERVATION");

  // Expected dates the archive can never obtain. `expected` is ascending, so
  // these are always a strict PREFIX of it — which is why merging over
  // `actionable` positions below is equivalent to merging over `expected`.
  const unreachableCount =
    providerFloorISO === null
      ? 0
      : expected.reduce((n, d) => (d < providerFloorISO ? n + 1 : n), 0);

  // Every return path funnels through here: ONE object literal, every key
  // present, so serialized key order cannot vary with the branch taken.
  const finish = (state: CoverageState, missingRanges: CoverageRange[]): CoverageReport => ({
    instrumentId:     input.instrumentId,
    basis:            input.basis,
    calendarId:       input.calendarId,
    requestedFromISO,
    requestedToISO,
    state,
    missingRanges,
    expectedCount:    expected.length,
    observedCount:    observed.length,
    missingCount:     missingRanges.reduce((n, r) => n + r.expectedDates, 0),
    unreachableCount,
    unexpectedCount,
    reasons:          emitReasons(reasons),
  });

  // 2. Not priceable — terminal for this window. No acquisition targets: a
  //    CASH instrument or one with no vendor identity has nothing to fetch.
  //    BEFORE_PROVIDER_DEPTH is deliberately NOT added here; the priceability
  //    reason is the whole story and depth is noise beside it.
  if (!priceability.priceable) {
    reasons.add(priceability.reason);
    return finish("unavailable", []);
  }

  // 3. Nothing was expected (e.g. an equity window covering only a weekend).
  //    Vacuously complete — but the reason distinguishes it from real coverage.
  if (expected.length === 0) {
    reasons.add("NO_EXPECTED_DATES");
    return finish("complete", []);
  }

  // 4. The entire window predates every provider's depth — unobtainable, and
  //    unlike case 3 that is a real limitation, not a quiet success.
  if (unreachableCount === expected.length) {
    reasons.add("BEFORE_PROVIDER_DEPTH");
    return finish("unavailable", []);
  }
  if (unreachableCount > 0) reasons.add("BEFORE_PROVIDER_DEPTH");

  const actionable =
    providerFloorISO === null ? expected : expected.filter((d) => d >= providerFloorISO);
  const missing = actionable.filter((d) => !observedSet.has(d));

  // 5. Everything obtainable was obtained. See the "complete" note in the header:
  //    unreachableCount may still be > 0, disclosed via BEFORE_PROVIDER_DEPTH.
  if (missing.length === 0) return finish("complete", []);

  // 6. Partial — locate the gaps relative to the observed block.
  if (observed.length === 0) {
    reasons.add("NO_COVERAGE");
  } else {
    const firstObserved = observed[0];
    const lastObserved  = observed[observed.length - 1];
    // A missing date is never itself observed, so the comparisons are strict.
    if (missing.some((d) => d < firstObserved)) reasons.add("BEFORE_FIRST_COVERAGE");
    if (missing.some((d) => d > firstObserved && d < lastObserved)) reasons.add("INTERIOR_GAP");
    if (missing.some((d) => d > lastObserved)) reasons.add("AFTER_LAST_COVERAGE");
  }

  return finish("partial", mergeIntoRanges(missing, actionable));
}
