/**
 * lib/ai/conversation/tools/shared/values.ts
 *
 * Pure value helpers shared by the tools: rounding, calendar-day arithmetic,
 * the information ceiling, and the read bounds.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

export const round2 = (n: number) => Math.round(n * 100) / 100;
/** A Date back to the calendar day it represents. UTC, like every date in this layer. */
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** The same calendar day, N years on. Clamps 29 February the way a calendar does. */
export const addYearsISO = (iso: string, years: number): string => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate()));
  return target.getUTCMonth() === d.getUTCMonth() ? target.toISOString().slice(0, 10)
    : new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth() + 1, 0))
      .toISOString().slice(0, 10);
};
/** The bound `lib/history/exploration` uses. Enough for all-time on this corpus. */
export const SNAPSHOT_READ_ROWS = 1100;
/** Ceiling on a DAILY series, so one call cannot return a year of rows by accident. */
export const MAX_DAILY_POINTS = 200;
/**
 * An information ceiling, applied.
 *
 * ⚠️ A CEILING IS NOT A DEFAULT — it OVERRIDES a later explicit bound. "Act as if
 * you know nothing after Jan 1" must hold even when the same call also asks for a
 * window ending in September, because a model that resolves the window first and
 * the cutoff second leaks the future without ever noticing.
 */
export const clampToCeiling = (date: string, ceiling: string) => (date > ceiling ? ceiling : date);

export const daysAgoISO = (asOf: string, n: number) =>
  new Date(Date.parse(`${asOf}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
