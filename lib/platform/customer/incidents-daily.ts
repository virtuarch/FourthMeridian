/**
 * lib/platform/customer/incidents-daily.ts  (Platform visual pass V2 — CUSTOMER_SUCCESS day series)
 *
 * Sync incidents OPENED and RESOLVED per UTC day over a short window, for the
 * Customer Success card's trend on the Platform Overview. COUNTS ONLY: this
 * file receives ids, states and instants from the incident projection and
 * emits day counts — no account, item, subject, kind or `detail` (which can
 * carry financial facts) leaves it.
 *
 * PB-1 Phase 3 — MODULE VERDICTS ONLY. The series reads the incident-intelligence
 * module's `window` accessor (open incidents whatever their age, plus closed ones
 * that touched the window — D5 / D6), at the identity-free Ops tier (the route's
 * CS token is downgraded here: a count needs no customer), and folds the verdicts
 * in incident-trend-core.ts. Evidence, superseded, removed-subject and folded
 * duplicate rows are not episodes and are not counted.
 *
 * "Opened" is the episode's first occurrence (`firstOccurredAt`, else
 * `createdAt`); "resolved" is a resolved episode's `resolvedAt`. Resolved
 * episodes are retained 90 d after resolution (jobs/data-retention.ts), so a
 * 14-day window is complete unless the row cap is reached (then `floor`).
 */

import "server-only";
import { incidentAccessors, atOpsTier, type CsToken, type OpsToken } from "@/lib/platform/incidents/intelligence";
import { incidentTrendInstants } from "./incident-trend-core";
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
  "Sync-incident episodes per UTC day, from the incident-intelligence module (evidence, superseded, removed-connection and duplicate rows excluded): opened = first occurrence (else created); resolved = the resolution's resolvedAt.";

export async function getIncidentsDailySeries(
  /** The token the ROUTE minted from its own guard result; downgraded to the identity-free tier here. */
  incidentToken: CsToken | OpsToken,
  now: Date = new Date(), days = INCIDENTS_DAILY_WINDOW_DAYS,
): Promise<IncidentsDailySeries> {
  const since = windowStart(now, days);
  const page = await incidentAccessors.window(atOpsTier(incidentToken)!, { from: since, to: now }, { limit: INCIDENTS_DAILY_ROW_CAP, now });
  const scanTruncated = page.truncated;
  const episodes = incidentTrendInstants(page.items);
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
