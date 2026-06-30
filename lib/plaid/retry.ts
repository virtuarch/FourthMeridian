/**
 * lib/plaid/retry.ts
 *
 * D2 Step 7D — bounded retry/backoff around a single transient Plaid API
 * call. Wraps one SDK call (accountsGet, investmentsHoldingsGet,
 * transactionsSync) at its call site — never a whole-item pipeline
 * (lib/plaid/refresh.ts's refreshPlaidItem, lib/plaid/syncTransactions.ts's
 * syncTransactionsForItem). Those already have their own idempotent/
 * resumable designs (see those files' headers), so retrying a single failed
 * call is strictly smaller-blast-radius than re-running an entire item from
 * the top.
 *
 * Retryability is decided entirely by lib/plaid/errors.ts's
 * isRetryablePlaidError() — this file owns only the retry mechanism
 * (attempt count, delay, logging), never error-code knowledge. A
 * non-retryable error (NEEDS_REAUTH, config errors, unrecognized codes,
 * non-Plaid exceptions) throws on the first failure, identical to today's
 * behavior — callers' existing catch blocks (D2-7A health classification,
 * D2-7B cooldown marking) are unaffected either way.
 *
 * Constants are local, not provider-configurable — same pattern as
 * lib/plaid/refreshCooldown.ts's MANUAL_REFRESH_COOLDOWN_MS. No
 * ProviderCatalog/config layer exists yet.
 */

import { isRetryablePlaidError } from "@/lib/plaid/errors";

/** Total attempts (1 original + retries). Kept low — see D2_STEP7D_RETRY_BACKOFF_CHECKLIST.md §4. */
const MAX_PLAID_RETRY_ATTEMPTS = 2;

/** Flat delay between attempts. No exponential growth at this attempt count. */
const PLAID_RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls `fn()`, retrying up to MAX_PLAID_RETRY_ATTEMPTS total attempts when
 * the thrown error is transient (per isRetryablePlaidError). Re-throws the
 * original error unchanged once attempts are exhausted, or immediately if
 * the error isn't retryable.
 *
 * @param label  Short identifier for the wrapped call, used only in the
 *               retry warning log (e.g. "accountsGet", "transactionsSync").
 */
export async function withPlaidRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      const attemptsRemaining = MAX_PLAID_RETRY_ATTEMPTS - attempt;
      if (attemptsRemaining <= 0 || !isRetryablePlaidError(err)) {
        throw err;
      }
      console.warn(
        `[plaid][retry] ${label} failed on attempt ${attempt}/${MAX_PLAID_RETRY_ATTEMPTS} — retrying in ${PLAID_RETRY_DELAY_MS}ms`,
        err
      );
      await sleep(PLAID_RETRY_DELAY_MS);
    }
  }
}
