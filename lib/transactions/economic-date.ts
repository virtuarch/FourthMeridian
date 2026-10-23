/**
 * lib/transactions/economic-date.ts   (v2.6-L4B — DERIVED ECONOMIC DATE)
 *
 * THE canonical answer to "when did this economic event actually happen?"
 * Pure: no DB, no React, no clock. **DERIVED ONLY — nothing is persisted, and
 * `Transaction.date` is never written.**
 *
 * ── Two dates, both real ────────────────────────────────────────────────────
 *
 *     economicDate   when the activity occurred      (derived, this module)
 *     postingDate    when the provider posted it     (Transaction.date, stored)
 *
 * A coffee bought on Friday and posted on Sunday is a Friday event that settled
 * on Sunday. Both facts are true and the product needs both: posted-basis
 * reconstruction depends on `date`, and a closed period depends on economicDate.
 * Measured on the corpus, **2,813 of 4,402 active rows (63.9%) carry a posting
 * date later than the day the event occurred, and 147 of those cross a MONTH
 * boundary** — so "a closed period is closed" is not a hypothetical.
 *
 * ⚠️ That month figure previously read "4" here. It was wrong: re-measured by the
 * authority and independently by raw SQL (both agree at 147), the population a
 * closed-period report would silently absorb is 37× larger than this file
 * claimed. The day-mover count was right; only the month count was understated.
 * v2.6-TRUTH-1.
 *
 * ── The credibility bound, derived from the evidence ────────────────────────
 *
 * Observed `date − authorizedAt` over 3,996 active rows:
 *
 *     0d 1183 · 1d 1809 · 2d 772 · 3d 191 · 4d 21 · 5d 12 · 6d 4 · 7d 1 · 8d 1
 *     …then NOTHING until…
 *     38d 2
 *
 * A smooth decay to 8 days, a 30-day empty gap, then two outliers. The bound is
 * placed inside that gap at **14 days**: comfortably above every credible
 * observation (the 8-day row is the last of a continuous decay) and far below
 * the outliers. It is not a round number chosen for feel — it is the middle of
 * an empty region the data drew itself.
 *
 * The two outliers, read directly rather than assumed:
 *
 *     Amex Platinum · "AplPay Hunger StatioRIYADH SA" · authorized 2025-04-14 ·
 *     posted 2025-05-22 · −10.88 and −14.15 · both POSTED · no pendingTransactionRef
 *
 * Two rows, same merchant, same pair of dates, a foreign Apple Pay merchant.
 * Whether that is a genuine 38-day authorization hold or a provider re-issue
 * cannot be settled from what we hold. So neither is done to them: the
 * authorization is NOT silently accepted (it would move $25 from May into
 * April's closed totals), and it is NOT silently discarded. The resolution is
 * marked **CONTRADICTORY**, falls back to the posting date, and carries the
 * reason so a surface can show the disagreement instead of hiding it.
 *
 * Negative lag — an authorization dated AFTER its posting — is also
 * CONTRADICTORY. Zero rows today; the guard exists because "zero today" is not
 * an invariant.
 *
 * ── REVIEW-3 B-6: FIRST RESOLUTION WINS (event ↔ row reconciliation) ────────
 *
 * Where an observation history exists (the L8 event tables), the economic date
 * is decided ONCE, at the first observation, and never moves afterwards:
 * `firstPendingDate` — the economic date resolved when the row was FIRST seen
 * PENDING — outranks a later authorization attestation, which outranks posting.
 *
 * Why first-pending outranks authorization: an `authorizedAt` can APPEAR at
 * posting time (null while pending, stamped when posted), so an auth-first
 * precedence would let the posting DELIVERY move an already-published economic
 * date — precisely the movement this module exists to forbid ("a closed period
 * is closed"). The first-pending value is itself a resolution of THIS module
 * (authorization-aware at pending time), so nothing is lost: when the pending
 * row carried an authorization, that authorization IS the pinned value.
 *
 * The credibility bound applies to the pin too: a first-pending date more than
 * ECONOMIC_DATE_MAX_LAG_DAYS before (or after) the posting is refused and falls
 * through to the row's own evidence — an event pin is evidence, not an oracle.
 *
 * This is the SAME derivation `projectEvent` (event-identity.ts) uses for
 * `TransactionEvent.economicDate`, and `reprojectEvent` (event-write.ts)
 * materializes the event's answer into `Transaction.economicDate` — so the
 * event and its current row agree BY CONSTRUCTION. One resolver, one rule.
 * Pinned by lib/transactions/event-economic-date-rule.test.ts.
 */

/** Which evidence produced the economic date. */
export type EconomicDateBasis =
  /** The provider's own attestation of when the event occurred (`authorizedAt`). */
  | "AUTHORIZATION"
  /** The date first observed while the row was PENDING — pending dates are
   *  authorization-shaped. Only available where an observation history exists. */
  | "FIRST_PENDING_OBSERVATION"
  /** The posting date, when no earlier evidence exists. */
  | "POSTING"
  /** A date the user or an import supplied. */
  | "USER_SUPPLIED";

export type EconomicDateState =
  /** The chosen date is supported by the evidence. */
  | "OK"
  /** Evidence exists but is not credible (out of bounds, or inverted). The
   *  posting date is used and the disagreement is reported. */
  | "CONTRADICTORY";

/**
 * Maximum credible days between authorization and posting. See the header for
 * how the corpus drew this line.
 */
export const ECONOMIC_DATE_MAX_LAG_DAYS = 14;

export interface EconomicDateEvidence {
  /** Transaction.date — the POSTING date. Never rewritten. */
  postingDate: Date | string;
  /** Transaction.authorizedAt — the provider's attestation, or null. */
  authorizedAt?: Date | string | null;
  /**
   * The economic date resolved when this row's EVENT was first observed
   * PENDING, where an observation history exists (L8). Supplied by the event
   * projection (`projectEvent` / `reprojectEvent`); a row with no event — or an
   * event never seen pending — has none. When credible, it WINS: first
   * resolution is final (see the header).
   */
  firstPendingDate?: Date | string | null;
  /** True when the date came from a user/import rather than a provider. */
  userSupplied?: boolean;
}

export interface EconomicDateResolution {
  /** YYYY-MM-DD. The date the activity occurred. */
  economicDate: string;
  /** YYYY-MM-DD. Transaction.date, passed through unchanged. */
  postingDate: string;
  basis: EconomicDateBasis;
  state: EconomicDateState;
  /** postingDate − economicDate in whole days. 0 when they coincide. */
  lagDays: number;
  /** Present only when state is CONTRADICTORY. */
  reason?: string;
}

const DAY_MS = 86_400_000;

function toUTCDate(v: Date | string): Date {
  const d = v instanceof Date ? v : new Date(v);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const dayDiff = (a: Date, b: Date): number => Math.round((a.getTime() - b.getTime()) / DAY_MS);

/**
 * Resolve the economic date. Priority (B-6 — first resolution wins):
 * credible first-pending observation → credible bounded authorization →
 * posting date → user-supplied.
 *
 * The resolution is a pure function of the evidence, which is what makes it
 * IMMUTABLE across lifecycle transitions: posting changes `pending`,
 * `settlementState` and the row's identity, but a first-pending resolution —
 * once one exists — outranks everything posting can deliver (including a
 * late-arriving `authorizedAt`), so the answer cannot move. Where no
 * observation history exists, `authorizedAt` outranks `Transaction.date` for
 * the same reason: posting rewrites `date`, never `authorizedAt`.
 */
export function resolveEconomicDate(e: EconomicDateEvidence): EconomicDateResolution {
  const posting = toUTCDate(e.postingDate);
  const postingISO = iso(posting);

  // ── 1. First resolution wins (B-6). A credible pin is final; a non-credible
  //       one is NOT silently honoured — it falls through to the row's own
  //       evidence, and if that evidence cannot answer either, the posting date
  //       is used with the disagreement reported.
  const firstPending = e.firstPendingDate != null ? toUTCDate(e.firstPendingDate) : null;
  if (firstPending !== null) {
    const lag = dayDiff(posting, firstPending);
    if (lag >= 0 && lag <= ECONOMIC_DATE_MAX_LAG_DAYS) {
      return {
        economicDate: iso(firstPending), postingDate: postingISO,
        basis: "FIRST_PENDING_OBSERVATION", state: "OK", lagDays: lag,
      };
    }
  }

  // ── 2. The provider's authorization attestation, bounded. ─────────────────
  const auth = e.authorizedAt != null ? toUTCDate(e.authorizedAt) : null;
  if (auth !== null) {
    const lag = dayDiff(posting, auth);
    if (lag < 0) {
      return {
        economicDate: postingISO, postingDate: postingISO,
        basis: "POSTING", state: "CONTRADICTORY", lagDays: 0,
        reason: "The provider dated the authorization after the posting; the two cannot both be right, so the posting date is used.",
      };
    }
    if (lag > ECONOMIC_DATE_MAX_LAG_DAYS) {
      return {
        economicDate: postingISO, postingDate: postingISO,
        basis: "POSTING", state: "CONTRADICTORY", lagDays: 0,
        reason: `The provider's authorization date is ${lag} days before the posting, beyond the ${ECONOMIC_DATE_MAX_LAG_DAYS}-day bound the observed data supports; the posting date is used and the disagreement is reported.`,
      };
    }
    return {
      economicDate: iso(auth), postingDate: postingISO,
      basis: "AUTHORIZATION", state: "OK", lagDays: lag,
    };
  }

  // ── 3. A pin existed but was not credible, and nothing else answers. ──────
  if (firstPending !== null) {
    return {
      economicDate: postingISO, postingDate: postingISO,
      basis: "POSTING", state: "CONTRADICTORY", lagDays: 0,
      reason: "The first pending observation is not within a credible distance of the posting; the posting date is used.",
    };
  }

  return {
    economicDate: postingISO, postingDate: postingISO,
    basis: e.userSupplied ? "USER_SUPPLIED" : "POSTING",
    state: "OK", lagDays: 0,
  };
}

/**
 * The YYYY-MM period an event belongs to. This is the closed-period guarantee in
 * one line: a period's membership is a function of the ECONOMIC date, so posting
 * later can never move an event out of the month it happened in.
 */
export function economicPeriod(r: EconomicDateResolution): string {
  return r.economicDate.slice(0, 7);
}

/** True when posting moved the row into a different month than it occurred in —
 *  precisely the population a closed-period report must not silently absorb. */
export function crossesPeriodBoundary(r: EconomicDateResolution): boolean {
  return r.economicDate.slice(0, 7) !== r.postingDate.slice(0, 7);
}
