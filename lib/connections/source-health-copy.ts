/**
 * lib/connections/source-health-copy.ts
 *
 * The words for a source's health state — one mapping, used by the Daily Brief's
 * data-health disclosure and the Connections cards, so the two pages cannot
 * describe the same state differently. States come from
 * space-data-health.core.ts; dates are formatted by the caller's own clock style.
 *
 * ⚠️ STATES, NOT REASONS. OUT_OF_DATE says nothing arrived since a date — never
 * "sync error". Only the provider's own verdicts are described as problems.
 */

import type { DataSourceState } from "./space-data-health.core";

export function sourceStatusText(
  state: DataSourceState,
  lastUpdatedAt: string | null,
  format: { date: (iso: string) => string; recent: (iso: string) => string },
): string {
  const since = lastUpdatedAt ? format.date(lastUpdatedAt) : null;
  switch (state) {
    case "CURRENT":          return lastUpdatedAt ? `Updated ${format.recent(lastUpdatedAt)}` : "Up to date";
    case "IMPORTING":        return "Still importing";
    case "OUT_OF_DATE":      return since ? `Hasn’t updated since ${since}` : "Hasn’t updated recently";
    case "NEEDS_RECONNECT":  return since ? `Needs to be reconnected · last updated ${since}` : "Needs to be reconnected";
    case "CONNECTION_ERROR": return since ? `Connection error · last updated ${since}` : "Connection error";
    case "SYNC_INCOMPLETE":  return since ? `Last update didn’t finish · data from ${since}` : "Last update didn’t finish";
    case "DISCONNECTED":     return since ? `Disconnected · last updated ${since}` : "Disconnected";
    case "NEVER_UPDATED":    return "Hasn’t updated yet";
  }
}
