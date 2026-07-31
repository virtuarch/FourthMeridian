/**
 * lib/investments/event-coverage.core.ts
 *
 * V26-QUANTITY-1E′ — the pure half of the ingestion-coverage authority. No
 * Prisma, no network, no clock. Turns an append-only ledger of ingest attempts
 * into the `EventStreamCompleteness` that QUANTITY-1C.1 requires as input.
 *
 * ── What a COMPLETE row actually claims ─────────────────────────────────────
 *
 * Exactly this: the provider fully answered a request for
 * [requestedFrom, requestedTo] — every page was fetched and the row count
 * reconciled against the provider's own reported total.
 *
 * It does NOT claim the provider's history reaches `requestedFrom`. Plaid does
 * not report where its own history begins, so a request extending past that
 * boundary returns exactly what a genuinely empty interval returns. Coverage
 * derived here is therefore an upper bound on what is known, and the arc ledger
 * carries this as an open limitation (B-7) rather than pretending otherwise.
 *
 * The one thing this module is for: a COMPLETE window with ZERO events is the
 * only evidence that an empty interval means "nothing happened" rather than
 * "nothing was imported". Everything else follows from that.
 */

import type { EventStreamCompleteness } from "./quantity-replay.core";

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

function assertISO(s: string, label: string): void {
  if (!ISO_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new Error(`[event-coverage] invalid ${label}: "${s}"`);
  }
}
function shiftISO(dateISO: string, days: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}
const minISO = (a: string, b: string) => (a < b ? a : b);
const maxISO = (a: string, b: string) => (a > b ? a : b);

/** One ledger row, reduced to what the decision needs. Order irrelevant. */
export interface CoverageRecord {
  requestedFromISO: string;
  requestedToISO:   string;
  /** Mirrors the `InvestmentCoverageOutcome` enum, carried as data. */
  outcome:          string;
  fetchedCount:     number;
}

/**
 * Outcomes that license a coverage claim.
 *
 * Only COMPLETE. PARTIAL means the provider answered with fewer rows than it
 * reported — the window is demonstrably not fully recorded, and treating its
 * covered prefix as complete would be guessing where the shortfall fell.
 * FAILED, DISABLED, CONSENT_REQUIRED and NOT_READY all mean the window was
 * never successfully read, and a request that was never answered is not weaker
 * evidence than one that was — it is no evidence at all.
 */
export const COVERAGE_LICENSING_OUTCOMES: ReadonlySet<string> = new Set(["COMPLETE"]);

export interface Interval { fromISO: string; toISO: string }

/**
 * Merge overlapping and day-adjacent intervals into a minimal disjoint set.
 *
 * Adjacency matters: two windows meeting at `[…, 03-31]` and `[04-01, …]` cover
 * April 1st's predecessor and April 1st with no hole between them, and treating
 * them as separate would invent a gap that does not exist.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => i.toISO >= i.fromISO)
    .sort((a, b) => (a.fromISO < b.fromISO ? -1 : a.fromISO > b.fromISO ? 1
      : a.toISO < b.toISO ? -1 : a.toISO > b.toISO ? 1 : 0));
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.fromISO <= shiftISO(last.toISO, 1)) {
      if (i.toISO > last.toISO) last.toISO = i.toISO;
    } else {
      out.push({ fromISO: i.fromISO, toISO: i.toISO });
    }
  }
  return out;
}

export interface CompletenessArgs {
  records:          readonly CoverageRecord[];
  requestedFromISO: string;
  requestedToISO:   string;
  /** Names the authority in the emitted `source` / `reason`. */
  sourceLabel?:     string;
}

/**
 * Decide `EventStreamCompleteness` for a requested interval.
 *
 * Deterministic: identical input yields byte-identical output. The result is
 * always the WEAKEST claim the ledger supports —
 *
 *   COMPLETE  the merged licensing windows cover every day of the request;
 *   PARTIAL   they cover some of it, reported as the single largest contiguous
 *             component (1C.1's PARTIAL carries one interval, and reporting the
 *             largest under-claims for any others rather than over-claiming);
 *   UNKNOWN   no licensing window touches the request at all.
 */
export function eventStreamCompletenessFor(args: CompletenessArgs): EventStreamCompleteness {
  const { requestedFromISO, requestedToISO } = args;
  assertISO(requestedFromISO, "requestedFromISO");
  assertISO(requestedToISO, "requestedToISO");
  const label = args.sourceLabel ?? "InvestmentEventCoverage";

  if (requestedToISO < requestedFromISO) {
    return { kind: "UNKNOWN", reason: `${label}: requested interval is inverted` };
  }

  const licensing = args.records.filter((r) => COVERAGE_LICENSING_OUTCOMES.has(r.outcome));
  if (licensing.length === 0) {
    const seen = args.records.length;
    return {
      kind: "UNKNOWN",
      reason: seen === 0
        ? `${label}: no ingest attempt has been recorded for this account`
        : `${label}: ${seen} recorded attempt(s), none COMPLETE — no window was fully read`,
    };
  }

  for (const r of licensing) {
    assertISO(r.requestedFromISO, "record.requestedFromISO");
    assertISO(r.requestedToISO, "record.requestedToISO");
  }

  const merged = mergeIntervals(licensing.map((r) => ({
    fromISO: r.requestedFromISO, toISO: r.requestedToISO,
  })));

  // Clip to the request, then judge.
  const clipped = merged
    .map((i) => ({ fromISO: maxISO(i.fromISO, requestedFromISO), toISO: minISO(i.toISO, requestedToISO) }))
    .filter((i) => i.toISO >= i.fromISO);

  if (clipped.length === 0) {
    return {
      kind: "UNKNOWN",
      reason: `${label}: ${licensing.length} COMPLETE window(s) recorded, none overlapping the requested interval`,
    };
  }

  if (clipped.length === 1 &&
      clipped[0].fromISO === requestedFromISO && clipped[0].toISO === requestedToISO) {
    return {
      kind: "COMPLETE",
      fromISO: requestedFromISO,
      toISO: requestedToISO,
      source: `${label}: ${licensing.length} COMPLETE window(s) span the requested interval`,
    };
  }

  const largest = clipped.reduce((best, i) => (spanDays(i) > spanDays(best) ? i : best), clipped[0]);
  return {
    kind: "PARTIAL",
    coveredFromISO: largest.fromISO,
    coveredToISO:   largest.toISO,
    reason: `${label}: ${clipped.length} covered component(s) inside the request; ` +
      `reporting the largest (${largest.fromISO}→${largest.toISO}) — any others are ` +
      "deliberately under-claimed rather than merged across a hole",
  };
}

function spanDays(i: Interval): number {
  return (Date.parse(`${i.toISO}T00:00:00Z`) - Date.parse(`${i.fromISO}T00:00:00Z`)) / MS_PER_DAY;
}
