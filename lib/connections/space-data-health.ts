/**
 * lib/connections/space-data-health.ts
 *
 * The read behind space-data-health.core.ts — the Space's sources, as one viewer
 * may see them.
 *
 * ⚠️ THE CANONICAL SPACE TRAVERSAL. SpaceAccountLink(ACTIVE) → FinancialAccount
 * (live) → AccountConnection(live, canonical) → PlaidItem / Connection — the same
 * path lib/spaces/sync-completeness.ts uses, so a source appears here exactly when
 * its accounts appear in the Space.
 *
 * ⚠️ READ-ONLY, AND NEVER A PROVIDER CALL. Nothing here refreshes, syncs or asks a
 * provider anything; it reports what Fourth Meridian last recorded. No token,
 * credential, cursor value or external id is selected.
 */

import 'server-only';
import type { PrismaClient, VisibilityLevel } from '@prisma/client';
import { grantsAccountDetail } from '@/lib/ai/visibility';
import { accountDisplayName, ACCOUNT_NAME_SELECT } from '@/lib/accounts/display-identity';
import { deriveSpaceDataHealth, type DataHealthAccountInput, type SpaceDataHealth } from './space-data-health.core';
import { loadRefreshPolicies } from '@/lib/platform/refresh-policy';

type Client = Pick<PrismaClient, 'spaceAccountLink' | 'platformSetting'>;

export async function loadSpaceDataHealth(
  client: Client, args: { spaceId: string; viewerUserId: string; now: Date },
): Promise<SpaceDataHealth> {
  const [links, policies] = await Promise.all([client.spaceAccountLink.findMany({
    where: { spaceId: args.spaceId, status: 'ACTIVE', financialAccount: { deletedAt: null } },
    select: {
      visibilityLevel: true,
      financialAccount: {
        select: {
          ...ACCOUNT_NAME_SELECT, ownerUserId: true, lastUpdated: true, syncStatus: true,
          connections: {
            where: { deletedAt: null },
            orderBy: [{ isCanonical: 'desc' }, { createdAt: 'asc' }],
            select: {
              plaidItem: { select: { id: true, userId: true, institutionName: true, status: true,
                lastSyncedAt: true, syncIncompleteAt: true, historyBuildStartedAt: true } },
              connection: { select: { id: true, userId: true, provider: true, status: true,
                errorCode: true, lastSyncedAt: true, cursor: true } },
            },
          },
        },
      },
    },
  }), loadRefreshPolicies(client)]);

  const rows: DataHealthAccountInput[] = links.map((l) => {
    const fa = l.financialAccount;
    const plaidConn = fa.connections.find((c) => c.plaidItem)?.plaidItem ?? null;
    const walletConn = plaidConn ? null
      : fa.connections.map((c) => c.connection).find((c) => c && c.provider !== 'PLAID' && c.provider !== 'MANUAL' && c.provider !== 'CSV') ?? null;
    return {
      detailVisible: grantsAccountDetail(l.visibilityLevel as VisibilityLevel) || fa.ownerUserId === args.viewerUserId,
      accountName: accountDisplayName(fa),
      lastUpdated: fa.lastUpdated,
      syncStatus: fa.syncStatus,
      plaid: plaidConn ? {
        key: plaidConn.id, ownerUserId: plaidConn.userId, institutionName: plaidConn.institutionName,
        status: plaidConn.status, lastSyncedAt: plaidConn.lastSyncedAt,
        syncIncompleteAt: plaidConn.syncIncompleteAt, historyBuildStartedAt: plaidConn.historyBuildStartedAt,
      } : null,
      wallet: walletConn ? {
        key: walletConn.id, ownerUserId: walletConn.userId, status: walletConn.status,
        errorCode: walletConn.errorCode, lastSyncedAt: walletConn.lastSyncedAt, discoveryCursor: !!walletConn.cursor,
      } : null,
    };
  });

  return deriveSpaceDataHealth(rows, args.viewerUserId, args.now, policies);
}
