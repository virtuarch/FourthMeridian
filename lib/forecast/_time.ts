/**
 * lib/forecast/_time.ts
 *
 * V26-REASONING Slice 0 — ONE DAY, ONE DIRECTION.
 *
 * `DAY_MS` had seven private copies across `lib/forecast/**` and
 * `lib/ai/forecast/**`, which was harmless duplication. `daysBetween` had three,
 * and that was not:
 *
 *   engine.ts:73          (fromISO, toISO) => to − from
 *   projection.ts:78      (a, b)           => max(0, b − a)
 *   stream-activity.ts:180 (a, b)          => a − b            ← REVERSED
 *
 * Three functions, one name, two directions and one silent clamp. Every call
 * site happened to be safe — stream-activity's only use is wrapped in
 * `Math.abs`, so its inversion cancels, and projection's only use passes a
 * horizon whose `toISO` is validated to follow its `fromISO`, so its clamp never
 * fired. That is luck, not design: the next caller reads the name, not the
 * three bodies.
 *
 * The unified signature is the engine's, because it is the one whose parameter
 * names already said which way round it went. Nothing here clamps — a negative
 * gap is a real answer about two dates in the wrong order, and a caller that
 * needs zero says `Math.max(0, …)` where a reader can see it.
 *
 * ⚠️ NO CALENDAR ARITHMETIC LIVES HERE, for the reason `engine.ts` gives: month
 * arithmetic already has an owner in `lib/perspectives/time-range.ts`, and a
 * second copy would be a second opinion. These are whole-UTC-day helpers over
 * `YYYY-MM-DD` strings and nothing more.
 */

export const DAY_MS = 86_400_000;

/** Midnight UTC of an ISO date, as epoch ms. */
export const atUTC = (iso: string): number => Date.parse(`${iso}T00:00:00.000Z`);

/** Whole days from `fromISO` to `toISO`. Negative when `toISO` precedes it. */
export const daysBetween = (fromISO: string, toISO: string): number =>
  Math.round((atUTC(toISO) - atUTC(fromISO)) / DAY_MS);

/** `iso` shifted by `n` whole days, as `YYYY-MM-DD`. */
export const addDays = (iso: string, n: number): string =>
  new Date(atUTC(iso) + n * DAY_MS).toISOString().slice(0, 10);
