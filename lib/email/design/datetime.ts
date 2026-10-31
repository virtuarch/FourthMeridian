/**
 * lib/email/design/datetime.ts
 *
 * Email date/time wording. Emails are read in an unknown time zone, so every
 * absolute time is rendered in UTC WITH an explicit zone label. (lib/format.ts
 * `formatDateTime` also formats in UTC but prints no label, so it is not reused
 * for email copy.)
 *
 * Pure: no imports, no I/O.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How close to a whole day a span must be to count as that whole day. */
export const WHOLE_DAY_TOLERANCE_MS = 60 * 1000;

/**
 * Whole days from `from` to `to`. A span within ±1 minute of a whole number of
 * 24-hour days IS that many days (so a 7-day TTL computed a few milliseconds
 * apart from its issue time still reads "7 days", never "6"); any other span is
 * floored to complete days (6.5 days → 6), so the email never promises time the
 * invite does not have. Epoch-millisecond arithmetic is UTC by construction, so
 * a local DST shift never gains or loses a day. Negative or invalid spans → 0.
 */
export function wholeDaysBetween(from: Date, to: Date): number {
  const span = to.getTime() - from.getTime();
  if (!Number.isFinite(span) || span <= 0) return 0;
  const nearest = Math.round(span / DAY_MS);
  if (nearest > 0 && Math.abs(span - nearest * DAY_MS) <= WHOLE_DAY_TOLERANCE_MS) return nearest;
  return Math.floor(span / DAY_MS);
}

/** "1 day" / "N days"; "less than a day" for 0. */
export function daysPhrase(days: number): string {
  if (days <= 0) return "less than a day";
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * "Saturday, November 7, 2026 at 3:04 PM UTC".
 * Assembled from formatToParts so ICU's date/time separator (", " vs " at ")
 * never changes the output.
 */
export function formatUtcDateTimeLabelled(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("email: invalid date");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday:  "long",
    month:    "long",
    day:      "numeric",
    year:     "numeric",
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true,
  }).formatToParts(date);
  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;
  return `${p.weekday}, ${p.month} ${p.day}, ${p.year} at ${p.hour}:${p.minute} ${p.dayPeriod} UTC`;
}
