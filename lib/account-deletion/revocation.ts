/**
 * lib/account-deletion/revocation.ts
 *
 * PRE-BETA-OPS-CLOSE Phase 3 — the bounded provider-revocation policy for
 * account deletion. PURE: no DB, no Plaid, no clock beyond injected values.
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
 * Deletion called Plaid `itemRemove`, and on failure counted it, logged it,
 * marked the item REVOKED ANYWAY, and completed the purge — which cascaded the
 * encrypted access token away. Three consequences, compounding:
 *   1. the failure was downgraded to a number in an audit blob;
 *   2. marking REVOKED excluded the item from the deletion cron's own
 *      `status: ACTIVE` filter, so even the existing retry loop would skip it;
 *   3. with the token destroyed, revocation became permanently impossible.
 * Fourth Meridian did stop ingesting (token and row gone, webhook no-ops), so
 * this was never a continued-ingestion risk — the harm is an upstream Plaid
 * consent that stays live forever with no way to reconcile it.
 *
 * ── THE TWO INVARIANTS, WHICH PULL IN OPPOSITE DIRECTIONS ────────────────────
 *   1. Fourth Meridian must not silently discard its ability to retry upstream
 *      revocation after a transient failure.
 *   2. A Plaid outage must not block a user's deletion forever.
 * Fail-closed satisfies (1) and violates (2); fail-open does the reverse. The
 * resolution is a BOUNDED retry: hold deletion for up to three daily attempts
 * (~72h), then complete it and record honestly that upstream revocation was
 * never confirmed. Approved policy, not an invention of this module.
 *
 * ── WHY ATTEMPTS ARE COUNTED IN DISTINCT DAYS ────────────────────────────────
 * The policy is "3 DAILY attempts", and counting distinct calendar days rather
 * than audit rows makes it both truthful and concurrency-safe: two cron runs (or
 * a manual re-run) on the same day are ONE attempt-day, so a double execution
 * can never burn the budget early and dump a user into terminal deletion after
 * ~24h instead of ~72h. No lock is needed for a counter that cannot be
 * double-incremented within a day.
 */

/** Approved policy: three daily attempts, ≈72 hours. */
export const MAX_REVOCATION_ATTEMPT_DAYS = 3;

/**
 * How a failed `itemRemove` should be read.
 *
 * `already-gone` is the ONLY outcome treated as success-equivalent, and only for
 * `ITEM_NOT_FOUND`. Plaid invalidates the access token on a successful
 * `/item/remove`, so a subsequent call for the same item returns ITEM_NOT_FOUND
 * — the item is definitively absent upstream and there is nothing left to
 * revoke. Deliberately NOT included: `INVALID_ACCESS_TOKEN`, which can equally
 * mean a malformed or rotated token rather than a removed item. Guessing there
 * would let us claim a revocation we never made.
 */
export type RevocationFailureClass = "already-gone" | "retryable";

/** Plaid error codes that prove the item is already absent upstream. */
export const TERMINAL_ALREADY_GONE_CODES: readonly string[] = ["ITEM_NOT_FOUND"];

export function classifyRevocationFailure(plaidErrorCode: string | undefined): RevocationFailureClass {
  return plaidErrorCode && TERMINAL_ALREADY_GONE_CODES.includes(plaidErrorCode)
    ? "already-gone"
    : "retryable";
}

export type RevocationDecision =
  /** Nothing failed — proceed with the destructive purge as normal. */
  | { action: "proceed" }
  /** Failures remain and the budget is not spent — HOLD deletion, retry tomorrow. */
  | { action: "hold"; attemptDay: number; attemptsRemaining: number }
  /** Budget spent — complete deletion, but record it as unrevoked. */
  | { action: "proceed-unrevoked"; attemptDay: number };

/**
 * Decide what a purge run should do, given this run's failures and the distinct
 * days on which revocation has previously failed for this user.
 *
 * `priorFailureDays` must NOT include today; the caller supplies the historical
 * set and this function adds the current attempt.
 */
export function decideRevocation(args: {
  /** Items whose revocation failed retryably in THIS run. */
  retryableFailures: number;
  /** Count of DISTINCT prior calendar days on which revocation failed. */
  priorFailureDays: number;
}): RevocationDecision {
  if (args.retryableFailures === 0) return { action: "proceed" };

  const attemptDay = args.priorFailureDays + 1;
  if (attemptDay >= MAX_REVOCATION_ATTEMPT_DAYS) {
    return { action: "proceed-unrevoked", attemptDay };
  }
  return { action: "hold", attemptDay, attemptsRemaining: MAX_REVOCATION_ATTEMPT_DAYS - attemptDay };
}

/** UTC calendar day key — the unit the daily-attempt budget is counted in. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Distinct prior failure days from audit timestamps, excluding today. */
export function countPriorFailureDays(failureTimestamps: readonly Date[], now: Date): number {
  const today = dayKey(now);
  return new Set(failureTimestamps.map(dayKey).filter((k) => k !== today)).size;
}
