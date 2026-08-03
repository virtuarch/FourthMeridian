/**
 * lib/snapshots/historical-work-window.core.ts
 *
 * V26-ORCH-1 — THE ONE PLANNER FOR "WHICH HISTORICAL DATES SHOULD WE REBUILD?"
 *
 * Pure: no Prisma, no DB, no clock, no network.
 *
 * ── What this replaces ───────────────────────────────────────────────────────
 * Three automatic triggers — wallet connection, the crypto cron, and manual
 * single-account sync — each passed `recentWealthWindow()`, a fixed 30-day span.
 * A newly connected wallet therefore built 30 days of history and stopped, even
 * though the price provider could serve a full year and the quantity was
 * licensed across all of it. Every deeper rebuild in this arc had to be run by
 * hand. Meanwhile the Plaid item path used `maxAvailableWealthWindow`, so two
 * triggers on the same database disagreed about how much history to build.
 *
 * ── Why `maxAvailableWealthWindow` alone is not the answer ───────────────────
 * It floors on the account set's earliest TRANSACTION. That is the right
 * evidence floor for cash, and the wrong one for a priced asset: the wallet that
 * motivated this slice has transactions from 2023-03-24 but its price provider
 * reaches only ~1 year back, so planning from 2023 would queue ~880 days of
 * which the great majority can only be refused as unpriceable. Correct, but
 * wasteful — and it made "how far back can we build?" unanswerable without
 * running the rebuild.
 *
 * This planner adds the missing term: the PRICE intersection. It composes the
 * existing helpers rather than replacing them; `recentWealthWindow` and
 * `wealthWindowFromEarliest` remain the building blocks for their own cases.
 *
 * ── The model ────────────────────────────────────────────────────────────────
 *     supportableFrom = MAX(evidence floor, blocking price floor)
 *     window          = [supportableFrom … writable ceiling], narrowed by mode
 *
 * MAX, not MIN: a date is supportable only where EVERY required term reaches it.
 * A requested range is never a term — it is an input to acquisition, never
 * evidence, and nothing here accepts one.
 *
 * ── Which price floor "blocks" ───────────────────────────────────────────────
 * Deliberately not "the earliest price of anything". A missing EQUITY price
 * lowers a day's coverage and the day is still written as a partial subtotal; a
 * missing CRYPTO price makes the day unwritable outright, because the crypto
 * no-fabrication guard refuses to assert a carried balance. So only the second
 * kind bounds the plan. The caller supplies it as `blockingPriceFloorISO`;
 * `null` means nothing blocks (a cash-only or equity-only set), NOT "unknown".
 *
 * Nothing here names an asset, a provider, a ticker, an account or a user.
 */

/** How the window was chosen. */
export type HistoricalWorkMode =
  /** First historical build for this account set — take everything supportable. */
  | "initial-full"
  /** Change was MEASURED; the window is narrowed to what it actually affected. */
  | "incremental"
  /** Change could not be measured — take everything supportable, conservatively. */
  | "fallback-full";

/**
 * Whether the caller was able to MEASURE what changed this run.
 *
 * The distinction is load-bearing and is the reason this slice does not fake
 * precision. "measured with nothing found" is a real answer meaning no
 * historical evidence moved; "unavailable" means the trigger has no way to tell,
 * and must therefore assume the worst. Collapsing them would either rebuild a
 * full year on every quiet refresh or silently skip a real change.
 */
export type ChangeDetection = "measured" | "unavailable";

export interface HistoricalWorkWindowInput {
  /**
   * Earliest date this account set has ANY account-level evidence for (earliest
   * transaction / observation). Null when the set has none, in which case
   * nothing deeper than the recent window exists to build.
   */
  evidenceFloorISO: string | null;
  /**
   * Earliest date at which every holding whose absence would make a whole day
   * unwritable can be priced. Null ⇒ no such holding, so prices do not bound the
   * plan. See the header for why equities deliberately do not appear here.
   */
  blockingPriceFloorISO: string | null;
  /** Latest writable snapshot date — normally yesterday (today's row is frozen). */
  writableToISO: string;
  /** Floor of the ordinary recent window, used when nothing deeper exists. */
  recentFromISO: string;
  /** True when this account set has no historical build yet. */
  initialBuild: boolean;
  /** Could this trigger measure what changed? */
  changeDetection: ChangeDetection;
  /**
   * Earliest date affected by evidence written during this run. Meaningful only
   * when `changeDetection === "measured"`; null there means nothing historical
   * changed.
   */
  impactedFromISO: string | null;
}

export interface HistoricalWorkWindow {
  fromDate: string;
  toDate:   string;
  mode:     HistoricalWorkMode;
  /** Human-readable, ordered, non-empty — why this window and not a wider one. */
  reasons:  string[];
  /** Echoed inputs, so a caller can log or assert the derivation. */
  providerFloor: string | null;
  evidenceFloor: string | null;
  impactedFrom:  string | null;
  /**
   * True when there is genuinely nothing historical to rebuild — a measured run
   * in which no historical evidence moved. The caller may still regenerate the
   * recent/current interval; this only says a deep rebuild is not warranted.
   */
  historicalWorkRequired: boolean;
}

const maxISO = (a: string, b: string): string => (a > b ? a : b);

/**
 * Plan the historical rebuild window. Total and deterministic — never throws.
 *
 * A future capability-widening trigger supplies a lower `blockingPriceFloorISO`
 * and an `impactedFromISO` at the newly reachable date; no signature change is
 * needed for it, which is the point of taking floors as data rather than reading
 * a provider here.
 */
export function planHistoricalWorkWindow(
  input: HistoricalWorkWindowInput,
): HistoricalWorkWindow {
  const {
    evidenceFloorISO, blockingPriceFloorISO, writableToISO, recentFromISO,
    initialBuild, changeDetection, impactedFromISO,
  } = input;

  const reasons: string[] = [];

  // ── The supportable floor: every required term must reach the date ─────────
  let supportableFrom = evidenceFloorISO ?? recentFromISO;
  reasons.push(
    evidenceFloorISO
      ? `evidence reaches ${evidenceFloorISO}`
      : `no evidence floor — nothing deeper than the recent window exists (${recentFromISO})`,
  );
  if (blockingPriceFloorISO !== null) {
    if (blockingPriceFloorISO > supportableFrom) {
      reasons.push(`provider prices reach only ${blockingPriceFloorISO} — the binding constraint`);
      supportableFrom = blockingPriceFloorISO;
    } else {
      reasons.push(`provider prices reach ${blockingPriceFloorISO}, wider than the evidence floor`);
    }
  } else {
    reasons.push("no price-blocking holding — prices do not bound this plan");
  }

  // ── Mode ──────────────────────────────────────────────────────────────────
  let mode: HistoricalWorkMode;
  let fromDate: string;
  let historicalWorkRequired = true;

  if (initialBuild) {
    mode = "initial-full";
    fromDate = supportableFrom;
    reasons.push("initial build — taking the whole supportable interval");
  } else if (changeDetection === "unavailable") {
    mode = "fallback-full";
    fromDate = supportableFrom;
    reasons.push("change could not be measured — conservatively rebuilding the supportable interval");
  } else if (impactedFromISO === null) {
    // MEASURED, and nothing historical moved. A deep rebuild would be pure cost.
    mode = "incremental";
    fromDate = maxISO(supportableFrom, recentFromISO);
    historicalWorkRequired = false;
    reasons.push("measured: no historical evidence changed — recent interval only");
  } else {
    mode = "incremental";
    fromDate = maxISO(supportableFrom, impactedFromISO);
    reasons.push(
      impactedFromISO < supportableFrom
        ? `change reaches ${impactedFromISO}, earlier than anything supportable — clamped`
        : `change reaches ${impactedFromISO}`,
    );
  }

  // ── Ceiling ───────────────────────────────────────────────────────────────
  // Never plan past the writable boundary, and never invert the interval: a
  // floor later than the ceiling means there is simply nothing to build.
  const toDate = writableToISO;
  if (fromDate > toDate) {
    reasons.push(`supportable floor ${fromDate} is after the writable ceiling ${toDate} — nothing to build`);
    fromDate = toDate; // collapse to a single day rather than emit an inverted range
    historicalWorkRequired = false;
  }

  return {
    fromDate, toDate, mode, reasons,
    providerFloor: blockingPriceFloorISO,
    evidenceFloor: evidenceFloorISO,
    impactedFrom:  changeDetection === "measured" ? impactedFromISO : null,
    historicalWorkRequired,
  };
}
