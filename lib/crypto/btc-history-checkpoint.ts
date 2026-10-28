/**
 * lib/crypto/btc-history-checkpoint.ts
 *
 * `Connection.historyCheckpoint` — where the resumable Bitcoin history
 * (btc-history-backfill.ts) keeps its checkpoint, and the ONE place that reads
 * and compare-and-swaps it.
 *
 * WHY A COLUMN OF ITS OWN (migration 20261028120000_connection_history_checkpoint)
 * and not `Connection.cursor`, where Solana keeps its checkpoint:
 *   - for an xpub wallet `cursor` already holds address DISCOVERY's checkpoint
 *     (btc-discovery-core.ts), which discovery rewrites wholesale and without a
 *     compare-and-swap — a nested history envelope would be clobbered by it, or
 *     would make every discovery step race the history CAS;
 *   - every Connections reader treats "has a cursor" as "discovery in
 *     progress" (space-data*, wallet-connections, sync/status), so a history
 *     checkpoint there would relabel a single-address wallet as importing
 *     addresses.
 * Nullable, no backfill: NULL means the wallet's history is still the wholesale
 * path's (btc-history-sync.ts). The column inherits Connection's row policies
 * (fm_app by userId; fm_system all) and table grants — no policy change.
 *
 * Read and written with parameterised raw SQL so this module does not depend on
 * a regenerated Prisma client; the column is in schema.prisma all the same.
 * The client is always the CALLER's authority (audit-db-authority).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { emptyCheckpoint, serializeCheckpoint } from "./btc-history-backfill.core";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * The wallet's history link: the SAME connection every run (canonical first,
 * then oldest), or the checkpoint would flip between rows — the ordering the
 * Solana store and the worker use.
 */
export async function btcHistoryLink(client: Client, accountId: string): Promise<{ connectionId: string; credential: string | null; discoveryCursor: string | null } | null> {
  const link = await client.accountConnection.findFirst({
    where: { financialAccountId: accountId, connectionId: { not: null }, deletedAt: null },
    orderBy: [{ isCanonical: "desc" }, { createdAt: "asc" }],
    select: { connectionId: true, connection: { select: { credential: true, cursor: true } } },
  });
  if (!link?.connectionId) return null;
  return { connectionId: link.connectionId, credential: link.connection?.credential ?? null, discoveryCursor: link.connection?.cursor ?? null };
}

export async function readHistoryCheckpoint(client: Client, connectionId: string): Promise<string | null> {
  const rows = await client.$queryRaw<Array<{ historyCheckpoint: string | null }>>`
    SELECT "historyCheckpoint" FROM "Connection" WHERE "id" = ${connectionId}`;
  return rows[0]?.historyCheckpoint ?? null;
}

/** Compare-and-swap: true when the stored value was `expected` (NULL-safe) and is now `next`. */
export async function casHistoryCheckpoint(client: Client, connectionId: string, expected: string | null, next: string): Promise<boolean> {
  const n = await client.$executeRaw`
    UPDATE "Connection" SET "historyCheckpoint" = ${next}
    WHERE "id" = ${connectionId} AND "historyCheckpoint" IS NOT DISTINCT FROM ${expected}::text`;
  return n === 1;
}

/** Does this account's history belong to the resumable backfill? */
export async function hasBtcHistoryCheckpoint(client: Client, accountId: string): Promise<boolean> {
  const link = await btcHistoryLink(client, accountId);
  return link !== null && (await readHistoryCheckpoint(client, link.connectionId)) !== null;
}

/**
 * Hand an account's history to the resumable backfill (QUEUED). Idempotent: a
 * checkpoint already there is never replaced. Called by the sync when the
 * inline import STOPPED AT ITS PAGE BUDGET — the 1,000-transaction ceiling no
 * longer truncates silently, it continues resumably.
 */
export async function enqueueBtcHistoryBackfill(client: Client, accountId: string, now: Date = new Date()): Promise<boolean> {
  const link = await btcHistoryLink(client, accountId);
  if (!link) return false;
  return casHistoryCheckpoint(client, link.connectionId, null, serializeCheckpoint(emptyCheckpoint(accountId, now.toISOString())));
}
