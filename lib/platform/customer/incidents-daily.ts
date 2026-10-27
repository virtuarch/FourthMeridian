/**
 * lib/platform/customer/incidents-daily.ts  (Platform visual pass V2 — CUSTOMER_SUCCESS day series)
 *
 * Sync incidents OPENED and RESOLVED per UTC day over a short window, for the
 * Customer Success card's trend on the Platform Overview. COUNTS ONLY: the read
 * selects three timestamps and nothing else — no account, item, subject, kind
 * or `detail` (which can carry financial facts) leaves the database.
 *
 * "Opened" is the episode's first occurrence (`firstOccurredAt`, else
 * `createdAt`); "resolved" is `resolvedAt`. Resolved episodes are retained 90 d
 * after resolution (jobs/data-retention.ts), so a 14-day window is complete
 * unless the row cap is reached (then `floor`).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { countByDay, windowDayKeys, windowStart } from "@/lib/platform/trends/daily-core";

export const INCIDENTS_DAILY_WINDOW_DAYS = 14;
export const INCIDENTS_DAILY_ROW_CAP = 20_000;

export interface IncidentDay {
  day: string;
  opened: number;
  resolved: number;
}

export interface IncidentsDailySeries {
  days: IncidentDay[];
  windowDays: number;
  floor: boolean;
  basis: string;
  checkedAt: string;
}

export const INCIDENTS_DAILY_BASIS =
  "SyncIssue episodes per UTC day: opened = first occurrence (else created); resolved = resolvedAt.";

export async function getIncidentsDailySeries(now: Date = new Date(), days = INCIDENTS_DAILY_WINDOW_DAYS): Promise<IncidentsDailySeries> {
  const since = windowStart(now, days);
  const rows = await systemDb.syncIssue.findMany({
    where: { OR: [{ createdAt: { gte: since } }, { firstOccurredAt: { gte: since } }, { resolvedAt: { gte: since } }] },
    select: { createdAt: true, firstOccurredAt: true, resolvedAt: true },
    take: INCIDENTS_DAILY_ROW_CAP,
  });
  const keys = windowDayKeys(now, days);
  const opened = countByDay(keys, rows.map((r) => r.firstOccurredAt ?? r.createdAt));
  const resolved = countByDay(keys, rows.map((r) => r.resolvedAt));
  return {
    days: keys.map((day) => ({ day, opened: opened[day], resolved: resolved[day] })),
    windowDays: days,
    floor: rows.length >= INCIDENTS_DAILY_ROW_CAP,
    basis: INCIDENTS_DAILY_BASIS,
    checkedAt: now.toISOString(),
  };
}
