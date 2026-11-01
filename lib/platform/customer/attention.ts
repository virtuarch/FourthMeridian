/**
 * lib/platform/customer/attention.ts  (PB-4 — Customer Success "who needs help": THE READER)
 *
 * Reads the facts attention-core.ts folds — once, for both the overview counts
 * and the Customers list's per-row reasons / filter. Fleet-wide by necessity
 * (a filtered list must know every customer's reasons before it pages), the
 * same reads the overview already made. Ids are selected ONLY as join keys;
 * no email, name, institution or detail is selected here. Read-only, on
 * fm_system (`systemDb`).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { assignableGroups } from "@/lib/entitlements/policy-groups";
import { loadPolicyGroupCatalogue } from "@/lib/platform/policies/policy-group-catalogue";
import { loadFunnelFacts } from "@/lib/platform/growth/product-analytics";
import { getActiveIncidentPage } from "@/lib/platform/incidents/projections";
import { foldAttention, type AttentionFacts, type AttentionFold } from "./attention-core";

const BROKEN = ["NEEDS_REAUTH", "ERROR"] as const;
/** Unresolved rows scanned for the active-incident projection; a full scan is reported as a floor. */
export const ACTIVE_INCIDENT_SCAN = 1000;
const NON_WALLET = ["PLAID", "MANUAL", "CSV"] as const;

export interface AttentionRead {
  facts: AttentionFacts;
  fold: AttentionFold;
  /** The canonical active-incident page the `incident` reason was read from (the overview's open-by-kind reuses it). */
  activePage: Awaited<ReturnType<typeof getActiveIncidentPage>>;
}

export async function loadAttention(now: Date = new Date(), client = systemDb): Promise<AttentionRead> {
  // PB-4 (owner, 2026-11-02) — "policy" = an assignment naming a group that is
  // not assignable now: unknown, invalid stored definition, or retired
  // (archived). An UNASSIGNED customer resolves to the catalogue default and is
  // never flagged here (under the fail-closed rollout switch the Platform Ops
  // policy-assignment alert owns that population).
  const live = assignableGroups(await loadPolicyGroupCatalogue()).map((g) => g.key);
  const [customers, funnel, plaidBroken, connBroken, activePage, invalid] = await Promise.all([
    client.user.findMany({ where: { role: "USER", deactivatedAt: null }, select: { id: true } }),
    loadFunnelFacts(client),
    client.plaidItem.findMany({ where: { status: { in: [...BROKEN] } }, select: { userId: true } }),
    client.connection.findMany({ where: { status: { in: [...BROKEN] }, provider: { notIn: [...NON_WALLET] } }, select: { userId: true } }),
    // The canonical ACTIVE incidents (derived state: orphaned, superseded and event rows excluded) —
    // the same read the Incidents workspace uses, so both say the same number.
    getActiveIncidentPage(ACTIVE_INCIDENT_SCAN),
    client.customerPolicyAssignment.findMany({ where: { policyGroup: { notIn: live } }, select: { userId: true } }),
  ]);

  const openIssues = activePage.incidents;
  // Sync-issue owners: through the Item, else through the account's owner / creator.
  const itemIds = [...new Set(openIssues.flatMap((i) => (i.plaidItemId ? [i.plaidItemId] : [])))];
  const accountIds = [...new Set(openIssues.flatMap((i) => (!i.plaidItemId && i.financialAccountId ? [i.financialAccountId] : [])))];
  const [items, accounts] = await Promise.all([
    itemIds.length ? client.plaidItem.findMany({ where: { id: { in: itemIds } }, select: { userId: true } }) : Promise.resolve([]),
    accountIds.length ? client.financialAccount.findMany({ where: { id: { in: accountIds } }, select: { ownerUserId: true, createdByUserId: true } }) : Promise.resolve([]),
  ]);

  const facts: AttentionFacts = {
    activeCustomerIds: new Set(customers.map((c) => c.id)),
    funnel,
    reconnectOwners: [...plaidBroken.map((p) => p.userId), ...connBroken.flatMap((c) => (c.userId ? [c.userId] : []))],
    incidentOwners: [...items.map((p) => p.userId), ...accounts.flatMap((a) => { const o = a.ownerUserId ?? a.createdByUserId; return o ? [o] : []; })],
    policyIssueOwners: invalid.map((a) => a.userId),
  };
  return { facts, fold: foldAttention(facts, now), activePage };
}
