/**
 * lib/ai/brief/policy.ts
 *
 * EVERY DAILY BRIEF LIFECYCLE CONSTANT, IN ONE PLACE.
 *
 * ⚠️ POLICY, NOT TUNING KNOBS SCATTERED THROUGH CODE. Each number below is a
 * product decision with a stated reason; a test pins the relationships between
 * them (the lease must outlive the provider deadline).
 */

/**
 * How long a generation claim lasts before another caller may take it over.
 *
 * The structured-output deadline is 60 s (STRUCTURED_TIMEOUT_MS); package
 * assembly measured 0.1–0.5 s live and persistence is one row. 90 s outlives a
 * deadline-length call with room for a slow assembly, and is short enough that a
 * crashed process blocks a retry for a minute and a half, not for a day.
 */
export const GENERATION_LEASE_MS = 90_000;

/**
 * After a failed generation, how long before another may be attempted.
 *
 * A fixed cooldown from `lastFailedAt`, not a progressive backoff: the row records
 * one failure time and one reason, and a beta surface visited a few times a day
 * does not need a retry count. Three minutes stops a page left open, a refresh
 * loop or several tabs from spending a model call per visit against a provider
 * that is down, while a transient failure still heals within a coffee. An older
 * Brief stays visible throughout; a digest check (no model call) is never cooled.
 */
export const GENERATION_FAILURE_COOLDOWN_MS = 180_000;

/**
 * The oldest earlier Brief that may stand in, clearly dated, while today's generates.
 *
 * Two days covers "yesterday's" plus a missed day. Older than that, a Brief is a
 * record, not a fallback — it is returned as not usable, never presented as current.
 */
export const STALE_FALLBACK_MAX_DAYS = 2;

/**
 * Standing facts (relevance.ts): how far a concentration weight must move, in
 * percentage points, before an unchanged-looking concentration is news again.
 * Ten points is "60% → 70%", not a daily price wobble.
 */
export const CONCENTRATION_WEIGHT_STEP_PCT = 10;

/**
 * A previous Brief older than this does not suppress a standing fact: after a month
 * away, "your crypto is almost all BTC" is a fair re-introduction.
 */
export const RELEVANCE_PRIOR_MAX_DAYS = 30;

/**
 * The width of the clock component of the source watermark.
 *
 * Some package inputs change with time alone: per-account freshness bands (LIVE
 * under a day, RECENT under a week), the 30-day manual-account staleness, and the
 * wallet fresh/stale band that decides whether a canonical wallet value replaces a
 * balance. No row changes when those cross, so no data clock can see it. An hourly
 * bucket bounds how long such a change can go unnoticed; the cost of noticing is
 * one package assembly per visiting hour, never a model call on its own.
 */
export const WATERMARK_CLOCK_BUCKET_MS = 3_600_000;

/**
 * What counts as a material change, encoded as BUCKETS so no prior package has
 * to be stored to compare against.
 *
 * Money is bucketed linearly by ABSOLUTE_STEP below ABSOLUTE_STEP / RELATIVE_STEP
 * ($50,000) and geometrically by RELATIVE_STEP above it — "max($1,000, 2%)", the
 * investigation's rule, made stateless. Movements (d1/w1/m1) smaller than
 * ABSOLUTE_STEP are zero, so a sign flip on a $40 wobble is not news.
 *
 * A recent transaction is material when it is at least
 * max(LARGE_TRANSACTION_FLOOR, LARGE_TRANSACTION_SHARE × monthly expenses), or
 * when it is an income or debt-payment movement of at least the floor.
 */
export const MATERIALITY = {
  ABSOLUTE_STEP: 1_000,
  RELATIVE_STEP: 0.02,
  LARGE_TRANSACTION_FLOOR: 250,
  LARGE_TRANSACTION_SHARE: 0.25,
  SIGNAL_FLOWS: ['INCOME', 'DEBT_PAYMENT'] as readonly string[],
} as const;
