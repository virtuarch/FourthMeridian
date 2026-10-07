/**
 * lib/refresh/deps.ts  (P1 REFRESH ALL — the two authorities' dependency sets)
 *
 * The orchestrator imports no database client. These builders hand it the reads
 * and guard writes under the authority the CALLER holds:
 *
 *   tenantRefreshDeps(userId)   the customer's own Refresh All — every read and
 *                               guard write is one short `withTenantDb` phase
 *                               (fm_app may SELECT/UPDATE its own PlaidItem and
 *                               Connection rows under "userId" = me; the owner
 *                               arm of FinancialAccount serves the wallet list)
 *   clientRefreshDeps(client)   an operator acting for a customer — the caller
 *                               passes the explicit client it is entitled to
 *                               (fm_system from a Customer Success route)
 *
 * Provider work (the Plaid fan-out, the chain adapters) is never inside a
 * tenant phase: a phase is a security boundary holding a transaction, and must
 * not span a network round trip.
 */

import type { Prisma } from "@prisma/client";
import { withTenantDb } from "@/lib/db/tenant-context";
import { limitByUser } from "@/lib/rate-limit";
import { claimWalletSyncLock, markWalletManualRefreshed, releaseWalletSyncLock } from "./wallet-lock";
import type { PlaidAuthorityFact, RefreshAllDeps, WalletAuthorityFact } from "./refresh-all";

/** The slice of a Prisma client the deps need. A transaction client satisfies it. */
export type RefreshDepsClient = Pick<Prisma.TransactionClient, "plaidItem" | "financialAccount" | "connection">;

type Run = <T>(fn: (c: RefreshDepsClient) => Promise<T>) => Promise<T>;

function walletLabel(chain: string | null, accountId: string): string {
  return `${chain ?? "Wallet"} …${accountId.slice(-6)}`;
}

function buildDeps(run: Run): RefreshAllDeps {
  return {
    listPlaidItems: (userId): Promise<PlaidAuthorityFact[]> => run(async (c) => {
      const rows = await c.plaidItem.findMany({
        where: { userId },
        select: { id: true, institutionName: true, status: true, lastManualRefreshAt: true },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((r) => ({ id: r.id, institutionName: r.institutionName, status: r.status, lastManualRefreshAt: r.lastManualRefreshAt }));
    }),
    listWallets: (userId): Promise<WalletAuthorityFact[]> => run(async (c) => {
      const rows = await c.financialAccount.findMany({
        where: { ownerUserId: userId, deletedAt: null, walletChain: { not: null } },
        select: {
          id: true, walletChain: true,
          connections: {
            where: { deletedAt: null, connectionId: { not: null } },
            select: { connection: { select: { id: true, lastManualRefreshAt: true } } },
          },
        },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((r) => {
        const conn = r.connections.map((x) => x.connection).find((x): x is NonNullable<typeof x> => x !== null) ?? null;
        return { accountId: r.id, chain: r.walletChain, label: walletLabel(r.walletChain, r.id), connectionId: conn?.id ?? null, lastManualRefreshAt: conn?.lastManualRefreshAt ?? null };
      });
    }),
    markPlaidAttempts: (ids, at) => ids.length === 0 ? Promise.resolve() : run(async (c) => {
      await c.plaidItem.updateMany({ where: { id: { in: ids } }, data: { lastManualRefreshAt: at } });
    }),
    walletRateCheck: async (userId, limitPerHour) => {
      const limited = await limitByUser(userId, "wallet-resync", { limit: Math.max(0, Math.floor(limitPerHour)), windowSec: 3600 });
      if (!limited) return { allowed: true };
      const retry = Number(limited.headers.get("Retry-After"));
      return { allowed: false, ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}) };
    },
    claimWallet: (connectionId, at) => run((c) => claimWalletSyncLock(connectionId, c, at)),
    releaseWallet: (connectionId) => run((c) => releaseWalletSyncLock(connectionId, c)),
    markWalletAttempt: (connectionId, at) => run((c) => markWalletManualRefreshed(connectionId, c, at)),
  };
}

/** The customer's own authority: every read and guard write is a tenant phase. */
export function tenantRefreshDeps(userId: string): RefreshAllDeps {
  return buildDeps((fn) => withTenantDb(userId, (tx) => fn(tx)));
}

/** An explicit client the caller already holds (an operator route's fm_system). */
export function clientRefreshDeps(client: RefreshDepsClient): RefreshAllDeps {
  return buildDeps((fn) => fn(client));
}
