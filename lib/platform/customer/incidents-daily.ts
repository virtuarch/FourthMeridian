/**
 * lib/platform/customer/incidents-daily.ts  (Platform visual pass V2 — CUSTOMER_SUCCESS day series)
 *
 * Sync incidents OPENED and RESOLVED per UTC day over a short window, for the
 * Customer Success card's trend on the Platform Overview. COUNTS ONLY: this
 * file receives ids, states and instants from the incident projection and
 * emits day counts — no account, item, subject, kind or `detail` (which can
 * carry financial facts) leaves it.
 *
 * PB-4 — CANONICAL EPISODES ONLY. The series reads through
 * getIncidentEpisodeTimeline (lib/platform/incidents/projections.ts), which
 * derives each row's state with the SAME call the active-incident projection
 * uses (episodes-core.ts). Event rows (REMOVED_TOMBSTONE et al. — stored
 * resolved with no resolvedAt), superseded and orphaned rows are not incidents
 * and are not counted; an episode still open is exactly an active incident.
 *
 * "Opened" is the episode's first occurrence (`firstOccurredAt`, else
 * `createdAt`); "resolved" is a recovered episode's `resolvedAt`. Resolved
 * episodes are retained 90 d after resolution (jobs/data-retention.ts), so a
 * 14-day window is complete unless the row cap is reached (then `floor`).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { getIncidentEpisodeTimeline } from "@/lib/platform/incidents/projections";
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
  "Canonical sync-incident episodes per UTC day (event, superseded and orphaned rows excluded): opened = first occurrence (else created); resolved = the recovery's resolvedAt.";

export async function getIncidentsDailySeries(now: Date = new Date(), days = INCIDENTS_DAILY_WINDOW_DAYS): Promise<IncidentsDailySeries> {
  const since = windowStart(now, days);
  const { episodes, scanTruncated } = await getIncidentEpisodeTimeline(since, INCIDENTS_DAILY_ROW_CAP, systemDb);
  const keys = windowDayKeys(now, days);
  const opened = countByDay(keys, episodes.map((e) => e.openedAt));
  const resolved = countByDay(keys, episodes.map((e) => e.resolvedAt));
  return {
    days: keys.map((day) => ({ day, opened: opened[day], resolved: resolved[day] })),
    windowDays: days,
    floor: scanTruncated,
    basis: INCIDENTS_DAILY_BASIS,
    checkedAt: now.toISOString(),
  };
}
