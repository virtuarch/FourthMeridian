/**
 * lib/platform/trends/daily-core.ts  (Platform visual pass V2 — day series for the Overview)
 *
 * PURE. Buckets timestamps into a contiguous window of UTC days. Used by the
 * Security and Customer Success day projections (lib/platform/security/daily.ts,
 * lib/platform/customer/incidents-daily.ts), which read COMPLETE ledgers for the
 * window — so a day with no rows is an observed ZERO, not a gap. When a read
 * hits its row cap the series is a FLOOR and says so (`floor: true`).
 */

const DAY_MS = 86_400_000;

/** YYYY-MM-DD (UTC) of an instant. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The `days` UTC day keys ending today (inclusive), ascending. */
export function windowDayKeys(now: Date, days: number): string[] {
  const today = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, i) => utcDay(new Date(today - (days - 1 - i) * DAY_MS)));
}

/** 00:00Z of the window's first day — the lower bound a reader queries from. */
export function windowStart(now: Date, days: number): Date {
  return new Date(`${windowDayKeys(now, days)[0]}T00:00:00.000Z`);
}

/** Count instants per day key (instants outside the window are ignored). */
export function countByDay(keys: readonly string[], instants: readonly (Date | null | undefined)[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const at of instants) {
    if (!at) continue;
    const k = utcDay(at);
    if (k in out) out[k]++;
  }
  return out;
}
