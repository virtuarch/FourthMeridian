/**
 * lib/sync/wallet-connections.ts
 *
 * Server-only loader that turns the user's Connection(provider=WALLET) rows into
 * the SAME provider-agnostic SyncConnection contract the Connections page uses
 * for Plaid — plus the wallet accounts grouped by CONNECTION id (never the
 * institution string, which collides for multiple self-custodied wallets).
 *
 * One card per Connection(WALLET): single-address wallet = one Connection = one
 * card; xpub wallet = one Connection = one card (its aggregated account);
 * multiple wallets = multiple cards.
 *
 * Read-only, no schema. Uses Connection.status/lastSyncedAt/errorCode (the v1.5
 * provider-sync truth) for state, and AccountConnection.connectionId to attach
 * each wallet's own account(s).
 */

import { db } from "@/lib/db";
import { ProviderType, ConnectionStatus } from "@prisma/client";
import { buildWalletSyncStatus, type SyncConnection, type WalletConnectionStateInput } from "@/lib/sync/status";
import type { AccountLite } from "@/components/connections/ConnectionCard";

export interface WalletSyncData {
  connections: SyncConnection[];
  /** Wallet accounts keyed by Connection id (SyncConnection.id). */
  accountsByConnectionId: Record<string, AccountLite[]>;
}

export async function loadWalletSyncConnections(userId: string): Promise<WalletSyncData> {
  const rows = await db.connection.findMany({
    where: {
      userId,
      provider: ProviderType.WALLET,
      status:   { not: ConnectionStatus.REVOKED },
    },
    select: {
      id:           true,
      status:       true,
      lastSyncedAt: true,
      errorCode:    true,
      accountConnections: {
        where:  { deletedAt: null },
        select: { financialAccount: { select: { id: true, name: true, type: true, deletedAt: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const accountsByConnectionId: Record<string, AccountLite[]> = {};
  const inputs: WalletConnectionStateInput[] = [];

  for (const c of rows) {
    // The wallet's own active account(s), deduped by id.
    const seen = new Set<string>();
    const accounts: AccountLite[] = [];
    for (const ac of c.accountConnections) {
      const fa = ac.financialAccount;
      if (!fa || fa.deletedAt !== null || seen.has(fa.id)) continue;
      seen.add(fa.id);
      accounts.push({ id: fa.id, name: fa.name, type: fa.type });
    }
    if (accounts.length === 0) continue; // no active account → no card (e.g. removed wallet)

    accountsByConnectionId[c.id] = accounts;
    inputs.push({
      id:           c.id,
      displayName:  accounts[0].name,
      status:       c.status as WalletConnectionStateInput["status"],
      lastSyncedAt: c.lastSyncedAt,
      errorCode:    c.errorCode,
    });
  }

  return { connections: buildWalletSyncStatus(inputs), accountsByConnectionId };
}
