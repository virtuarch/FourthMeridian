/**
 * lib/sync/deferred-ingestion.ts  (OPS-2D-4A follow-up)
 *
 * "Is this connection's ingestion currently held back by platform policy?"
 *
 * ONE authority, because the alternative is every surface guessing. The
 * Connections card, the accounts perspective, the operator diagnostics and the
 * post-Link screen all need the same answer, and the evidence it rests on is not
 * something a component can reasonably assemble.
 *
 * WHY `syncIncompleteAt` IS NOT THE ANSWER
 * ----------------------------------------
 * It is tempting — it is one field and it is already on the row. But it means
 * only "more ingestion work is pending", and at least four different situations
 * set it:
 *
 *   1. a first-run import genuinely in flight right now;
 *   2. an import interrupted mid-way and awaiting the recovery job;
 *   3. a stale candidate that has been failing for hours;
 *   4. an import that never started because admission denied it.
 *
 * Only the fourth is policy deferral. A surface that renders "Importing" for all
 * four tells the customer work is happening when, in case 4, nothing is running
 * and nothing will until an operator acts. That is the specific lie this module
 * exists to stop — so `syncIncompleteAt` is a PRECONDITION here, never the
 * evidence.
 *
 * THE EVIDENCE
 * ------------
 * The refresh ledger already records the decision: OPS-2D-3 writes a SKIPPED
 * RefreshExecution carrying a typed `admissionReason` whenever ingestion is
 * refused. That row is the fact. Deferral is therefore:
 *
 *   the item's most recent execution was SKIPPED for an admission reason
 *   AND nothing is running now (no lock held, no RUNNING execution)
 *
 * The second clause matters: if a newer run has since started, the deferral is
 * over regardless of what the older row says. "Most recent" is what keeps this
 * from latching.
 *
 * PURE, AND THAT IS STRUCTURAL. The ledger read lives in
 * lib/platform/refresh/deferral.ts, inside the DF-2 projection layer, because
 * the two-seam doctrine says consumers never touch those tables directly. This
 * module holds only the rule — which is also what makes the rule exhaustively
 * testable without a database.
 */

/** Everything the pure derivation needs about one connection. */
export interface IngestionDeferralInput {
  /** Non-null while a sync holds the per-item lock. */
  syncLockedAt: Date | null;
  /**
   * The item's MOST RECENT RefreshExecution, or null when it has never had one.
   * Only the newest matters — an older denial says nothing about now.
   */
  latestExecution: {
    overallStatus: string;
    /** Typed admission reason; non-null only on a policy-denied execution. */
    admissionReason: string | null;
  } | null;
}

/**
 * The resolved deferral, or null when ingestion is not policy-held.
 * Carries the typed reason so callers can resolve a label from the canonical
 * registry — it deliberately does NOT carry copy of its own.
 */
export interface IngestionDeferral {
  reason: string;
}

/**
 * Is ingestion currently deferred by platform policy?
 *
 * Pure. Returns null for every situation that is not policy deferral —
 * including active imports, interrupted imports and stale candidates, which are
 * indistinguishable from deferral if you look only at `syncIncompleteAt`.
 */
export function deriveIngestionDeferral(input: IngestionDeferralInput): IngestionDeferral | null {
  // Something is running right now. Whatever an earlier row says, this is not a
  // held connection — it is a working one.
  if (input.syncLockedAt !== null) return null;

  const latest = input.latestExecution;
  if (latest === null) return null;

  // A RUNNING execution is the same story from the ledger's side.
  if (latest.overallStatus === "RUNNING") return null;

  // The decision itself: skipped, for a policy reason. Both halves are
  // required — a SKIPPED execution with no admissionReason is ordinary lock
  // contention (IN_FLIGHT), which is not deferral and must not read as one.
  if (latest.overallStatus !== "SKIPPED") return null;
  if (latest.admissionReason === null) return null;

  return { reason: latest.admissionReason };
}

// ── Is anything actually running? ────────────────────────────────────────────
//
// Deferral answers case 4 above. The Connections surface needs the other three
// separated too, because "importing" with a spinner and "this keeps running in
// the background" is only true in case 1. Preview Sandbox, 2026-10-06: a fresh
// OAuth Item's import failed at page 2; the card said "Transaction history
// importing… 100 imported" with nothing running, and after recovery it said
// "Building your timeline — this finishes in the background" with nothing
// building it. Both were inferences from an ABSENT marker.
//
// The same ledger row is the evidence. RUNNING is POSITIVE evidence only:
//   - the per-item sync lock is held, or
//   - the newest execution is RUNNING,
// and only while fresh. A lock or RUNNING row older than the lock TTL belongs to
// a process that died (the lock is reclaimed after that age), so it is not work.

/**
 * Bound on positive evidence. Equal to lib/plaid/sync-lock.ts LOCK_TTL_MS (one
 * 300 s function budget plus headroom) — pinned by test; not imported, to keep
 * this module pure.
 */
export const INGESTION_ACTIVITY_STALE_MS = 360_000;

/**
 * - RUNNING   work is executing now.
 * - DEFERRED  held by platform policy (deriveIngestionDeferral).
 * - IDLE      the item has execution history and nothing is running now.
 * - UNKNOWN   the item has never had an execution (e.g. a Link exchange whose
 *             first execution row has not been written yet).
 */
export type IngestionActivity = "RUNNING" | "DEFERRED" | "IDLE" | "UNKNOWN";

export interface IngestionActivityInput {
  syncLockedAt: Date | null;
  latestExecution: {
    overallStatus: string;
    admissionReason: string | null;
    startedAt: Date;
  } | null;
}

export function deriveIngestionActivity(input: IngestionActivityInput, now: Date): IngestionActivity {
  const fresh = (t: Date) => now.getTime() - t.getTime() < INGESTION_ACTIVITY_STALE_MS;
  if (input.syncLockedAt !== null && fresh(input.syncLockedAt)) return "RUNNING";
  const latest = input.latestExecution;
  if (latest !== null && latest.overallStatus === "RUNNING" && fresh(latest.startedAt)) return "RUNNING";
  // A stale lock / stale RUNNING row is not work — judge the rest as if absent.
  if (deriveIngestionDeferral({
    syncLockedAt: null,
    latestExecution: latest && latest.overallStatus !== "RUNNING" ? latest : null,
  }) !== null) return "DEFERRED";
  return latest === null ? "UNKNOWN" : "IDLE";
}
