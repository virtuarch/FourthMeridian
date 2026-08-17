/**
 * lib/time/clock.ts   (REVIEW-3 B-6 — THE chronology clock seam)
 *
 * THE one implementation of "what day is it". Pure and ZERO-IMPORT — no Prisma,
 * no React, no other lib module — so ANY layer (fx, prices, history, platform,
 * client components, tsx scripts) can reach it without acquiring a dependency.
 * That zero-import property is what lets lib/fx and lib/prices both delegate
 * here without coupling to each other (their no-coupling doctrine is about
 * subsystem dependencies, not about sharing a dependency-free primitive).
 *
 * ── Before this module ──────────────────────────────────────────────────────
 *
 * The repo had THREE "now" implementations answering the same question:
 *
 *     todayIso()                          lib/investments/current-positions.ts
 *                                         lib/ai/assemblers/holdings.ts
 *     yesterdayUTCISO()                   lib/fx/config.ts AND lib/prices/config.ts
 *                                         (byte-identical clones)
 *     isoDate(truncDateUTC(new Date()))   lib/history/account-series.ts
 *                                         lib/history/holding-series.ts
 *
 * All three agreed today and none was obligated to keep agreeing. A chronology
 * with three clocks cannot say which day a fact belongs to; this module is the
 * B-6 answer: one clock, injectable for tests, delegated to by everyone.
 * `lib/time/clock-authority.test.ts` scans the source tree and fails the build
 * on any re-implementation.
 *
 * ── The calendar convention ─────────────────────────────────────────────────
 *
 * Every calendar day in Fourth Meridian is a UTC calendar day, "YYYY-MM-DD".
 * Snapshot dates, archive dates, economic dates, as-of cutoffs — all UTC days.
 * There is no timezone parameter on purpose: a per-user timezone is a
 * PRESENTATION concern, and introducing it at the fact layer would let the same
 * fact belong to two days depending on who asks.
 *
 * ⚠️ These are CALENDAR functions, not timestamps. A genuinely-instant record
 * ("when did this write happen") stays `new Date()` at its call site — that is
 * a timestamp, not a day, and forcing it through here would be a category error.
 */

/** An injectable source of "now". Defaults to the system clock everywhere. */
export type Clock = () => Date;

/** The production clock. Tests inject their own instead of mocking Date. */
export const systemClock: Clock = () => new Date();

/** The UTC calendar date of an instant, as "YYYY-MM-DD". Pure formatter. */
export function toISODateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Today's UTC calendar date — THE "current day" basis (see lib/time/basis.ts).
 * Accepts an explicit `now` so a test (or a caller holding one instant for a
 * whole computation) can pin the day.
 */
export function todayUTCISO(now: Date = new Date()): string {
  return toISODateUTC(now);
}

/**
 * Yesterday's UTC calendar date — THE "newest closed day" basis: the newest
 * date the append-only FX and price archives accept (their plan D4/D8 doctrine,
 * now stated once instead of twice). Today is not closed until it is over.
 */
export function yesterdayUTCISO(now: Date = new Date()): string {
  return toISODateUTC(new Date(now.getTime() - 86_400_000));
}
