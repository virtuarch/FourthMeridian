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
 * The whole model phase of one generation — every attempt and every wait between
 * them — must end within this many milliseconds of starting.
 *
 * ⚠️ A RATE LIMIT IS QUOTA, NOT A FAILED BRIEF. One provider 429 used to yield a
 * refused Brief and the three-minute cooldown below (measured: 23 of 23
 * "refusals" in a concurrent run were 429s). Generation now absorbs a rate limit
 * through the canonical bounded retry (lib/ai/rate-limit-retry.ts) — but it holds
 * a CLAIM while it does, so the retry is budgeted against the lease: 75 s leaves
 * 15 s of the 90 s lease for package assembly (0.1–0.5 s measured) and one-row
 * persistence. A wait is taken only if a useful attempt still fits after it;
 * otherwise the 429 fails the generation immediately, inside the lease, and the
 * cooldown applies as before. lifecycle.test.ts pins budget < lease.
 */
export const GENERATION_CALL_BUDGET_MS = 75_000;

/** The shortest attempt worth waiting for: live Brief calls measured 5–20 s. */
export const GENERATION_MIN_ATTEMPT_MS = 20_000;

/** Waits one generation may take. The budget usually binds first; this bounds a provider that suggests tiny waits. */
export const GENERATION_MAX_RATE_LIMIT_RETRIES = 3;

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
 * THE BRIEF'S GENERATION CONTRACT — bumped BY HAND when what a generated Brief may
 * say, or which of its sentences code keeps, changes meaningfully: the
 * instruction, the output schema, or a deterministic acceptance rule
 * (SHOWN_ON_PAGE, relevance, the figure licence). A stored Brief written under
 * another version is rewritten once, lazily, on its next visit, from the same
 * financial evidence — never by a background sweep.
 *
 * ⚠️ INTENTIONAL, NOT AUTOMATIC. Not a git SHA, build id, package version or boot
 * time: a deploy that changes nothing about the Brief must not cost a model call
 * per Space. lifecycle.test.ts pins the prompt/schema hash, so editing the prompt
 * forces the question "does this need a bump?" at review time.
 *
 * History — 2: Slice 4.1 (freshness belongs to the page: no connection talk in
 * headline or cards, stale sources named only where they matter, NEW is not a change).
 * 3: claim-scoped evidence (a classification ships with its scope and reason, the
 * debt RATE is no longer a debt verdict, freshness is per claim, a movement is tied
 * to a balance only by the class of account it posted on — UNCONNECTED_MOVEMENT —
 * and a percentage over a base smaller than the movement is withheld). Every
 * stored Brief is rewritten once, lazily, under reason `version`.
 */
export const BRIEF_GENERATION_VERSION = 'brief-generation-3';

/**
 * The generation version a stored `promptVersion` was written under. Stored as
 * `<version>+prompt-<hash>`; rows from before versioning (`brief-prompt-<hash>`)
 * parse as their whole value, which no current version equals.
 */
export const generationVersionOf = (stored: string | null): string | null => (stored ? stored.split('+')[0] : null);

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
