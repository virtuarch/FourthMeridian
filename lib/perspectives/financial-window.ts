/**
 * lib/perspectives/financial-window.ts
 *
 * THE canonical financial window. Pure — no clock, no Date arithmetic of its
 * own, no timezone handling. It resolves one selected range into the interval
 * semantics each KIND of financial question needs.
 *
 * ── The defect this replaces ─────────────────────────────────────────────────
 * Two independent parsers decided what a selected range meant:
 *
 *   compareToForPreset()  UTC-naive string math, exclusive lower bound
 *   periodRange()         local-time `Date` math, inclusive [start, end]
 *
 * They disagreed on the boundary AND on the timezone, so Cash Flow counted the
 * opening day's transactions while Investments did not — for the same slice.
 * The bug was never that the two conventions differ. Both are correct for their
 * own question. The bug was that TWO PARSERS existed, so nothing guaranteed the
 * conventions were applied deliberately rather than by accident.
 *
 * ── Two questions, two intervals, one range ──────────────────────────────────
 * The selected range stays one thing — Jul 4 → Aug 4. What differs is how a
 * question reads it:
 *
 *   STOCK   balances, portfolio values, performance, period change.
 *           The endpoints are POINTS: the opening balance is measured AT
 *           `openingISO` and already contains everything that happened on that
 *           day. So when a stock claim attributes its change to flows, it must
 *           use the HALF-OPEN attribution window `(opening, closing]` — counting
 *           the opening day's events again would double-count them against a
 *           balance that already includes them.
 *
 *   FLOW    Cash Flow, Activity, buys, sells, dividends, income, spending.
 *           A CLOSED calendar window `[from, to]`: every event on the dates the
 *           user can see. "Spending Jul 4 → Aug 4" means both endpoints, and a
 *           user who can see Jul 4 in the range expects Jul 4's coffee in it.
 *
 * Neither convention is forced onto the other. The authority just says which
 * one a caller is entitled to, and a caller must say which question it asks.
 */

import { compareToForPreset, type TimePreset } from "./time-range";

/** Which KIND of financial question a consumer is asking. */
export const CLAIM_KINDS = ["stock", "flow"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/**
 * Endpoints for a STOCK claim.
 *
 * `openingISO` / `closingISO` are POINTS — dates at which a balance is measured,
 * never a span. `attribution` is the only span a stock claim may use, and it is
 * half-open for the reason above.
 */
export interface StockInterval {
  openingISO: string;
  closingISO: string;
  /** Events that MOVED the balance between the two points: (opening, closing]. */
  attribution: {
    /** EXCLUSIVE. The opening balance already contains this day. */
    fromExclusiveISO: string;
    /** INCLUSIVE. The closing balance is measured at end of this day. */
    toInclusiveISO: string;
  };
}

/** Endpoints for a FLOW claim: the displayed calendar dates, both included. */
export interface FlowInterval {
  fromInclusiveISO: string;
  toInclusiveISO: string;
}

export interface FinancialWindow {
  preset: TimePreset;
  /** The selected pair, exactly as the user chose it. */
  fromISO: string;
  toISO: string;
  stock: StockInterval;
  flow: FlowInterval;
}

/**
 * Resolve a selected range into both interval semantics.
 *
 * `fromISO` is the shell's Compare To and `toISO` its As Of — the ONE pair every
 * surface already shares. Nothing is re-derived from a preset here: presets are
 * `compareToForPreset`'s job, and calling it is how this module avoids becoming
 * the second parser it exists to remove.
 */
export function resolveFinancialWindow(args: {
  preset: TimePreset;
  asOf: string;
  compareTo: string | null;
  coverageFrom?: string | null;
}): FinancialWindow {
  const { preset, asOf } = args;
  // A preset's own compareTo wins; a CUSTOM pair keeps what the user set. When
  // neither exists the window degenerates to a single day, which is honest —
  // a range with no start is a point, not "everything".
  const fromISO =
    args.compareTo
    ?? compareToForPreset(preset, asOf, args.coverageFrom ?? null)
    ?? asOf;

  return {
    preset,
    fromISO,
    toISO: asOf,
    stock: {
      openingISO: fromISO,
      closingISO: asOf,
      attribution: { fromExclusiveISO: fromISO, toInclusiveISO: asOf },
    },
    flow: { fromInclusiveISO: fromISO, toInclusiveISO: asOf },
  };
}

// ── Membership predicates — the ONLY place a boundary rule is applied ────────

/**
 * Is a dated event inside a FLOW claim's window? Closed on both ends.
 *
 * Exported as a predicate rather than left to each caller's `>=`/`<=` so a
 * boundary can never drift one surface at a time.
 */
export function inFlowInterval(dateISO: string, flow: FlowInterval): boolean {
  return dateISO >= flow.fromInclusiveISO && dateISO <= flow.toInclusiveISO;
}

/** Is a dated event inside a STOCK claim's attribution window? Half-open. */
export function inStockAttribution(dateISO: string, stock: StockInterval): boolean {
  return dateISO > stock.attribution.fromExclusiveISO && dateISO <= stock.attribution.toInclusiveISO;
}

/**
 * The two windows differ by exactly one day — the opening day — and that is the
 * whole point. Exposed so a probe can assert the difference is DELIBERATE rather
 * than discovering it as a mismatch.
 */
export function windowsDifferByOpeningDay(w: FinancialWindow): boolean {
  return w.flow.fromInclusiveISO === w.stock.attribution.fromExclusiveISO;
}
