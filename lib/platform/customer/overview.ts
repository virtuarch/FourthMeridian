/**
 * lib/platform/customer/overview.ts  (Platform Spaces 2.0 — Customer Success: THE READER)
 *
 * Reads on fm_system (`systemDb`). Ids are selected ONLY as join keys for the
 * attention union and the funnel; no email, name, institution or detail leaves
 * this file (the core emits counts). Read-only.
 *
 * PB-4 — the attention facts come from attention.ts, the SAME read the
 * Customers list's per-row reasons and `attention=` filter use.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { getConnectionHealth } from "@/lib/connections/health";
import { getIncidentsDailySeries } from "./incidents-daily";
import { loadAttention } from "./attention";
import { buildCsOverview } from "./overview-core";
import type { CsOverviewResponse } from "./overview-types";

export { ACTIVE_INCIDENT_SCAN } from "./attention";

export async function getCsOverview(windowDays: 30 | 90, now: Date = new Date()): Promise<CsOverviewResponse> {
  const client = systemDb;
  const [attention, deactivated, health, daily] = await Promise.all([
    loadAttention(now, client),
    client.user.count({ where: { role: "USER", deactivatedAt: { not: null } } }),
    getConnectionHealth(0),
    getIncidentsDailySeries(now, windowDays),
  ]);

  const byKind = new Map<string, number>();
  for (const i of attention.activePage.incidents) byKind.set(String(i.kind), (byKind.get(String(i.kind)) ?? 0) + 1);

  return buildCsOverview({
    ...attention.facts,
    deactivatedCustomers: deactivated,
    connections: { total: health.total, counts: health.counts, retired: health.retired },
    incidentDays: daily.days,
    incidentsFloor: daily.floor,
    openByKind: [...byKind.entries()].map(([kind, count]) => ({ kind, count })),
    openFloor: attention.activePage.scanTruncated,
  }, now, windowDays);
}
