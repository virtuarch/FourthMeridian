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
  /**
   * V26-QUANTITY-1H — the earliest transaction date the provider actually
   * RETURNED, or null when none were. This is the only demonstrable evidence of
   * where provider history begins, and it bounds every claim below.
   */
  earliestReturnedISO: string | null;
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

  // ── The correction that makes COMPLETE honest (V26-QUANTITY-1H) ─────────
  //
  // `COMPLETE` proves pagination reconciled against the provider's reported
  // total. It does NOT prove the provider holds history back to
  // `requestedFromISO`: that total is itself window-scoped, so a window
  // reaching past the provider's own floor reconciles perfectly while
  // containing nothing. Before this clamp, a request for
  // 2024-08-01→2026-08-01 against an item whose history begins 2025-07-31
  // licensed 364 days in which "no activity" and "no history" are
  // indistinguishable — and backward replay would have stamped a manufactured
  // opening onto the earlier date.
  //
  // So a record licenses only from the earliest date it actually returned
  // evidence for. A record that returned NOTHING licenses nothing at all: a
  // reconciled empty window is silence, and silence is not proof of no
  // activity. We under-claim deliberately — if there genuinely was no activity
  // early in a window, we forgo those days rather than assert them.
  const withEvidence = licensing.filter((r) => r.earliestReturnedISO !== null);
  const merged = mergeIntervals(withEvidence.map((r) => ({
    fromISO: maxISO(r.requestedFromISO, r.earliestReturnedISO!),
    toISO: r.requestedToISO,
  })));

  if (merged.length === 0) {
    const empty = licensing.length - withEvidence.length;
    return {
      kind: "UNKNOWN",
      reason: `${label}: ${licensing.length} reconciled window(s), ${empty} of which returned no ` +
        "transactions — pagination completing over an empty window proves the provider was asked, " +
        "not that it holds history there",
    };
  }

  // Clip to the request, then judge.
  const clipped = merged
    .map((i) => ({ fromISO: maxISO(i.fromISO, requestedFromISO), toISO: minISO(i.toISO, requestedToISO) }))
    .filter((i) => i.toISO >= i.fromISO);

  if (clipped.length === 0) {
    return {
      kind: "UNKNOWN",
      reason: `${label}: ${withEvidence.length} evidenced window(s) recorded, none overlapping the requested interval`,
    };
  }

  if (clipped.length === 1 &&
      clipped[0].fromISO === requestedFromISO && clipped[0].toISO === requestedToISO) {
    return {
      kind: "COMPLETE",
      fromISO: requestedFromISO,
      toISO: requestedToISO,
      source: `${label}: ${withEvidence.length} reconciled window(s) with returned evidence span the requested interval`,
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
