/**
 * lib/platform/customer/overview.ts  (Platform Spaces 2.0 — Customer Success: THE READER)
 *
 * Reads on fm_system (`systemDb`). Ids are selected ONLY as join keys for the
 * attention union and the funnel; no email, name, institution or detail leaves
 * this file (the core emits counts). Read-only.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { getConnectionHealth } from "@/lib/connections/health";
import { resolvableGroupKeys } from "@/lib/entitlements/policy-groups";
import { loadPolicyGroupCatalogue } from "@/lib/platform/policies/policy-group-catalogue";
import { loadFunnelFacts } from "@/lib/platform/growth/product-analytics";
import { getIncidentsDailySeries } from "./incidents-daily";
import { getActiveIncidentPage } from "@/lib/platform/incidents/projections";
import { buildCsOverview } from "./overview-core";
import type { CsOverviewResponse } from "./overview-types";

const BROKEN = ["NEEDS_REAUTH", "ERROR"] as const;
/** Unresolved rows scanned for the active-incident projection; a full scan is reported as a floor. */
export const ACTIVE_INCIDENT_SCAN = 1000;
const NON_WALLET = ["PLAID", "MANUAL", "CSV"] as const;

export async function getCsOverview(windowDays: 30 | 90, now: Date = new Date()): Promise<CsOverviewResponse> {
  const client = systemDb;
  const known = resolvableGroupKeys(await loadPolicyGroupCatalogue());
  const [customers, deactivated, funnel, plaidBroken, connBroken, activePage, unassigned, invalid, health, daily] = await Promise.all([
    client.user.findMany({ where: { role: "USER", deactivatedAt: null }, select: { id: true } }),
    client.user.count({ where: { role: "USER", deactivatedAt: { not: null } } }),
    loadFunnelFacts(client),
    client.plaidItem.findMany({ where: { status: { in: [...BROKEN] } }, select: { userId: true } }),
    client.connection.findMany({ where: { status: { in: [...BROKEN] }, provider: { notIn: [...NON_WALLET] } }, select: { userId: true } }),
    // The canonical ACTIVE incidents (derived state: orphaned, superseded and event rows excluded) —
    // the same read the Incidents workspace uses, so both say the same number.
    getActiveIncidentPage(ACTIVE_INCIDENT_SCAN),
    client.user.findMany({ where: { role: "USER", deactivatedAt: null, policyAssignment: { is: null } }, select: { id: true } }),
    client.customerPolicyAssignment.findMany({ where: { policyGroup: { notIn: known } }, select: { userId: true } }),
    getConnectionHealth(0),
    getIncidentsDailySeries(now, windowDays),
  ]);

  const openIssues = activePage.incidents;
  // Sync-issue owners: through the Item, else through the account's owner / creator.
  const itemIds = [...new Set(openIssues.flatMap((i) => (i.plaidItemId ? [i.plaidItemId] : [])))];
  const accountIds = [...new Set(openIssues.flatMap((i) => (!i.plaidItemId && i.financialAccountId ? [i.financialAccountId] : [])))];
  const [items, accounts] = await Promise.all([
    itemIds.length ? client.plaidItem.findMany({ where: { id: { in: itemIds } }, select: { userId: true } }) : Promise.resolve([]),
    accountIds.length ? client.financialAccount.findMany({ where: { id: { in: accountIds } }, select: { ownerUserId: true, createdByUserId: true } }) : Promise.resolve([]),
  ]);

  const byKind = new Map<string, number>();
  for (const i of openIssues) byKind.set(String(i.kind), (byKind.get(String(i.kind)) ?? 0) + 1);

  return buildCsOverview({
    activeCustomerIds: new Set(customers.map((c) => c.id)),
    deactivatedCustomers: deactivated,
    funnel,
    reconnectOwners: [...plaidBroken.map((p) => p.userId), ...connBroken.flatMap((c) => (c.userId ? [c.userId] : []))],
    incidentOwners: [...items.map((p) => p.userId), ...accounts.flatMap((a) => { const o = a.ownerUserId ?? a.createdByUserId; return o ? [o] : []; })],
    policyIssueOwners: [...unassigned.map((u) => u.id), ...invalid.map((a) => a.userId)],
    connections: { total: health.total, counts: health.counts, retired: health.retired },
    incidentDays: daily.days,
    incidentsFloor: daily.floor,
    openByKind: [...byKind.entries()].map(([kind, count]) => ({ kind, count })),
    openFloor: activePage.scanTruncated,
  }, now, windowDays);
}
