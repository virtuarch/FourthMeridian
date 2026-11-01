/**
 * lib/platform/connections/removed-connections.ts  (PB-5)
 *
 * THE READER for the Removed connections list. Bounded reads of facts that
 * already exist, folded by removed-connections.core.ts (pure, tested there).
 *
 * AUTHORITY — `systemDb` (fm_system), never `db`: one operator reading across
 * every tenant with no user identity to bind, exactly the shape
 * lib/platform/plaid/provider-cleanup.ts documents (and the db-authority
 * ratchet enforces). The route gates PLATFORM_OPS READ before this runs.
 *
 * SELECTS — ids, statuses, institution labels, timestamps, account ids for a
 * count, audit actions/metadata (operational keys only), and the acting
 * operators' username / name. NO email, NO token, NO address, NO balances.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { PlaidItemStatus, ConnectionStatus, ProviderType } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { operatorDisplayName } from "@/lib/platform/customer/identity-label";
import { readCleanupMarkers } from "@/lib/platform/plaid/provider-cleanup";
import {
  foldRemovedConnections,
  queryRemovedConnections,
  type AuditFact,
  type RemovedConnectionRow,
  type RemovedConnectionsPage,
  type RemovedConnectionsQuery,
} from "./removed-connections.core";

/** Upper bound on each population read. Removals are rare by construction; this is a safety cap, not a page. */
export const REMOVED_READ_CAP = 2000;
/** Upper bound on the customer / transition evidence rows read. */
const EVIDENCE_CAP = 5000;

const LINK_SELECT = {
  select: { financialAccountId: true, deletedAt: true, financialAccount: { select: { deletedAt: true } } },
} as const;

type LinkRow = { financialAccountId: string; deletedAt: Date | null; financialAccount: { deletedAt: Date | null } | null };
const toLinks = (rows: LinkRow[]) =>
  rows.map((l) => ({ financialAccountId: l.financialAccountId, deletedAt: l.deletedAt, accountDeletedAt: l.financialAccount?.deletedAt ?? null }));

/** Every removed connection, folded (unfiltered). */
export async function loadRemovedConnections(client = systemDb): Promise<RemovedConnectionRow[]> {
  const markers = await readCleanupMarkers(client);
  const markerItemIds = [...new Set(markers
    .map((m) => (m.metadata as { plaidItemId?: unknown } | null)?.plaidItemId)
    .filter((v): v is string => typeof v === "string" && v.length > 0))];

  const [plaidItems, walletRows] = await Promise.all([
    client.plaidItem.findMany({
      // A READ filter, spelled `equals` so it is not mistaken for a status write
      // (lib/plaid/disconnect-revocation.test.ts classifies every REVOKED writer).
      where:   { OR: [{ status: { equals: PlaidItemStatus.REVOKED } }, { id: { in: markerItemIds } }] },
      select:  { id: true, userId: true, institutionName: true, status: true, connections: LINK_SELECT },
      orderBy: { createdAt: "desc" },
      take:    REMOVED_READ_CAP,
    }),
    // Candidate wallets: REVOKED, or holding at least one soft-deleted link. The
    // fold applies the hub's exact rule (accounts, none live) to these.
    client.connection.findMany({
      where:   {
        provider: ProviderType.WALLET,
        OR: [
          { status: ConnectionStatus.REVOKED },
          { accountConnections: { some: { OR: [{ deletedAt: { not: null } }, { financialAccount: { deletedAt: { not: null } } }] } } },
        ],
      },
      select:  { id: true, userId: true, externalConnectionId: true, status: true, accountConnections: LINK_SELECT },
      orderBy: { createdAt: "desc" },
      take:    REMOVED_READ_CAP,
    }),
  ]);

  const ownerIds = [...new Set([...plaidItems.map((p) => p.userId), ...walletRows.map((w) => w.userId)])];
  const plaidIds = plaidItems.map((p) => p.id);

  const [revokedTransitions, customerActs, operatorActs] = await Promise.all([
    plaidIds.length === 0 ? Promise.resolve([] as AuditFact[]) : client.auditLog.findMany({
      where:   { action: AuditAction.PLAID_ITEM_STATUS_CHANGED, userId: { in: ownerIds }, metadata: { path: ["to"], equals: "REVOKED" } },
      select:  { action: true, userId: true, createdAt: true, metadata: true },
      orderBy: { createdAt: "desc" },
      take:    EVIDENCE_CAP,
    }),
    ownerIds.length === 0 ? Promise.resolve([] as AuditFact[]) : client.auditLog.findMany({
      where:   { action: { in: [AuditAction.CONNECTION_DISCONNECTED, AuditAction.ACCOUNT_REMOVE] }, userId: { in: ownerIds } },
      select:  { action: true, userId: true, createdAt: true, metadata: true },
      orderBy: { createdAt: "desc" },
      take:    EVIDENCE_CAP,
    }),
    client.auditLog.findMany({
      where:   { action: AuditAction.CONNECTION_REMOVED_BY_OPERATOR },
      select:  { action: true, userId: true, createdAt: true, performedByAdminId: true, metadata: true },
      orderBy: { createdAt: "desc" },
      take:    EVIDENCE_CAP,
    }),
  ]);

  const operatorIds = [...new Set(operatorActs.map((r) => r.performedByAdminId).filter((v): v is string => !!v))];
  const operators = operatorIds.length === 0 ? [] : await client.user.findMany({
    where:  { id: { in: operatorIds } },
    select: { id: true, username: true, name: true },
  });
  const label = new Map(operators.map((u) => [u.id, operatorDisplayName(u)] as const));

  return foldRemovedConnections({
    plaidItems: plaidItems.map((p) => ({ id: p.id, userId: p.userId, institutionName: p.institutionName, status: p.status, links: toLinks(p.connections) })),
    wallets: walletRows.map((w) => ({ id: w.id, userId: w.userId, externalConnectionId: w.externalConnectionId, status: w.status, links: toLinks(w.accountConnections) })),
    markers,
    revokedTransitions,
    customerActs,
    operatorActs,
    operatorLabel: (id) => label.get(id) ?? null,
  });
}

/** One filtered page plus whole-population totals. */
export async function getRemovedConnectionsPage(query: RemovedConnectionsQuery, client = systemDb): Promise<RemovedConnectionsPage> {
  return queryRemovedConnections(await loadRemovedConnections(client), query);
}
