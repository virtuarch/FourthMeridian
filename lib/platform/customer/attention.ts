/**
 * lib/platform/customer/attention.ts  (PB-4 — Customer Success "who needs help": THE READER)
 *
 * Reads the facts attention-core.ts folds — once, for both the overview counts
 * and the Customers list's per-row reasons / filter. Fleet-wide by necessity
 * (a filtered list must know every customer's reasons before it pages), the
 * same reads the overview already made.
 *
 * BETA-SCALE ASSUMPTION (S2 ruling, 2026-11-02). Every list load and every
 * overview read scans the whole active-customer fleet: cheap while the fleet is
 * beta-sized (hundreds), not at thousands. Each read this file owns is capped at
 * ATTENTION_SCAN_CAP; a read that reaches it marks the fold `floor` and every
 * count is shown as "≥N" — the same pattern as the active-incident scan
 * (ACTIVE_INCIDENT_SCAN → `scanTruncated` → `openFloor`). Reaching it is the
 * signal to move this to SQL aggregation / a per-page read. (The funnel facts
 * are Growth's shared loader and are not capped here.) Ids are selected ONLY as join keys;
 * no email, name, institution or detail is selected here. Read-only, on
 * fm_system (`systemDb`).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { assignableGroups } from "@/lib/entitlements/policy-groups";
import { entitlementLoadOptions } from "@/lib/entitlements/consume";
import { UNASSIGNED_CUSTOMER_WHERE } from "@/lib/platform/policy-assignment-health";
import { loadPolicyGroupCatalogue } from "@/lib/platform/policies/policy-group-catalogue";
import { loadFunnelFacts } from "@/lib/platform/growth/product-analytics";
import { getActiveIncidentPage } from "@/lib/platform/incidents/projections";
import { foldAttention, type AttentionFacts, type AttentionFold } from "./attention-core";

const BROKEN = ["NEEDS_REAUTH", "ERROR"] as const;
/** Unresolved rows scanned for the active-incident projection; a full scan is reported as a floor. */
export const ACTIVE_INCIDENT_SCAN = 1000;
/** Rows each fleet read below may return; a read that reaches it makes every count a floor. */
export const ATTENTION_SCAN_CAP = 5000;
const NON_WALLET = ["PLAID", "MANUAL", "CSV"] as const;

export interface AttentionRead {
  facts: AttentionFacts;
  fold: AttentionFold;
  /** The canonical active-incident page the `incident` reason was read from (the overview's open-by-kind reuses it). */
  activePage: Awaited<ReturnType<typeof getActiveIncidentPage>>;
}

export async function loadAttention(
  now: Date = new Date(), client = systemDb,
  /** Test seam only; production reads the resolver's own mode (entitlementLoadOptions). */
  opts: { failClosed?: boolean; cap?: number } = {},
): Promise<AttentionRead> {
  const cap = opts.cap ?? ATTENTION_SCAN_CAP;
  // S2 ruling — the fail-closed mode exactly as the entitlements resolver receives it (no second env parse).
  const failClosed = opts.failClosed ?? entitlementLoadOptions().failClosed === true;
  // PB-4 (owner, 2026-11-02) — "policy" = an assignment naming a group that is
  // not assignable now: unknown, invalid stored definition, or retired
  // (archived). An UNASSIGNED customer resolves to the catalogue default and is
  // NOT a `policy` issue; it is its own `unassigned` reason, and only while the
  // fail-closed switch is enforced (below).
  const live = assignableGroups(await loadPolicyGroupCatalogue()).map((g) => g.key);
  const [customers, funnel, plaidBroken, connBroken, activePage, invalid, unassigned] = await Promise.all([
    client.user.findMany({ where: { role: "USER", deactivatedAt: null }, select: { id: true }, orderBy: { createdAt: "desc" }, take: cap }),
    loadFunnelFacts(client),
    client.plaidItem.findMany({ where: { status: { in: [...BROKEN] } }, select: { userId: true }, take: cap }),
    client.connection.findMany({ where: { status: { in: [...BROKEN] }, provider: { notIn: [...NON_WALLET] } }, select: { userId: true }, take: cap }),
    // The canonical ACTIVE incidents (derived state: orphaned, superseded and event rows excluded) —
    // the same read the Incidents workspace uses, so both say the same number.
    getActiveIncidentPage(ACTIVE_INCIDENT_SCAN),
    client.customerPolicyAssignment.findMany({ where: { policyGroup: { notIn: live } }, select: { userId: true }, take: cap }),
    // S2 ruling — unassigned customers are a reason only while fail-closed is ENFORCED;
    // the SAME predicate as the Platform Ops policy-assignment alert. Not read otherwise.
    failClosed
      ? client.user.findMany({ where: UNASSIGNED_CUSTOMER_WHERE, select: { id: true }, take: cap })
      : Promise.resolve([] as { id: string }[]),
  ]);
  const floor = [customers, plaidBroken, connBroken, invalid, unassigned].some((rows) => rows.length >= cap) || activePage.scanTruncated;

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
    unassignedOwners: unassigned.map((u) => u.id),
    policyFailClosed: failClosed,
    floor,
  };
  return { facts, fold: foldAttention(facts, now), activePage };
}
