/**
 * lib/ai/rate-limit-retry.ts
 *
 * ABSORB A PROVIDER RATE LIMIT — bounded, 429 only, honouring the provider's wait.
 *
 * ⚠️ THE CANONICAL RULE, MADE REACHABLE. The rule was written once, privately, in
 * lib/ai/conversation/turn.ts (`callWithRateLimitRetry`): only a rate limit is
 * retried, the provider's own "try again in Ns" is honoured with a small margin,
 * the fallback is a capped linear backoff, and the attempts are bounded. The
 * Daily Brief could not reach it and therefore had none: one 429 produced a
 * refused Brief and a three-minute cooldown (measured: 23 of 23 "refusals" in a
 * concurrent run were 429s). This module is that same rule as a function anyone
 * can call — same predicate, same wait formula, same default bound — so a second
 * surface does not grow a second policy. `rate-limit-retry.test.ts` pins the
 * constants against turn.ts's source so the two cannot drift silently while
 * turn.ts still holds its private copy.
 *
 * ⚠️ QUOTA, NOT BEHAVIOUR. Every other provider error (a timeout, a refusal, a
 * 5xx, malformed output) is rethrown immediately. Retrying those would be asking
 * the model again until the answer looks right.
 *
 * ⚠️ A DEADLINE, BECAUSE SOME CALLERS HOLD A LEASE. The chat turn has no clock to
 * respect; the Brief generates inside a 90-second claim. With `deadlineAt`, a
 * wait is taken only if an attempt of at least `minAttemptMs` still fits after it
 * — otherwise the rate-limit error is rethrown and the caller fails NOW, inside
 * its lease, rather than sleeping through it.
 *
 * Pure apart from the injected clock and sleep.
 */

/** turn.ts `MAX_RATE_LIMIT_RETRIES`. */
export const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5;
/** Added to the provider's suggested wait. */
export const SUGGESTED_WAIT_MARGIN_MS = 1_500;
/** Backoff when the provider suggests nothing: `min(MAX, STEP × attempt)`. */
export const BACKOFF_STEP_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;

export interface RateLimitRetryRecord {
  attempt:  number;
  waitedMs: number;
  reason:   string;
}

export interface RateLimitRetryOptions {
  /** How many waits may be taken. Default 5. */
  maxRetries?: number;
  /** Epoch ms by which the LAST attempt must be able to finish. Omitted ⇒ no deadline. */
  deadlineAt?: number;
  /** The shortest attempt worth waiting for. Only read with `deadlineAt`. */
  minAttemptMs?: number;
  onRetry?: (r: RateLimitRetryRecord) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A provider rate limit — by status when the SDK supplies one, else by message (turn.ts's predicate). */
export function isRateLimitError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 429) return true;
  return /rate limit|429/i.test(messageOf(err));
}

/** How long to wait before attempt `attempt + 1`. The provider's own figure wins. */
export function rateLimitWaitMs(err: unknown, attempt: number): number {
  const suggested = /try again in ([\d.]+)s/i.exec(messageOf(err));
  return suggested
    ? Math.ceil(Number(suggested[1]) * 1000) + SUGGESTED_WAIT_MARGIN_MS
    : Math.min(BACKOFF_MAX_MS, BACKOFF_STEP_MS * attempt);
}

export async function callWithRateLimitRetry<T>(
  call: (attempt: number) => Promise<T>, options: RateLimitRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await call(attempt);
    } catch (err) {
      if (!isRateLimitError(err) || attempt > maxRetries) throw err;
      const waitedMs = rateLimitWaitMs(err, attempt);
      if (options.deadlineAt !== undefined
        && now() + waitedMs + (options.minAttemptMs ?? 0) > options.deadlineAt) throw err;
      options.onRetry?.({ attempt, waitedMs, reason: messageOf(err).slice(0, 160) });
      await sleep(waitedMs);
    }
  }
}
