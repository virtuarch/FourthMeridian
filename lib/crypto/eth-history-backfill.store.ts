/**
 * lib/crypto/eth-history-backfill.store.ts
 *
 * The database half of the Ethereum history worker (eth-history-backfill.ts):
 * the checkpoint on `Connection.historyCheckpoint` (Bitcoin's column, the same
 * history link and compare-and-swap — btc-history-checkpoint.ts), the
 * completing write through the inline rebuild's own persistence, and the entry
 * point `refreshWalletHistory` calls for ETH.
 *
 * The client is always the CALLER's authority (audit-db-authority).
 */

import type { PrismaClient } from "@prisma/client";
import { ETH_ASSET, resolveCryptoInstrumentId } from "@/lib/investments/crypto-instrument";
import { ETH_NATIVE } from "./native-asset";
import { btcHistoryLink as historyLink, readHistoryCheckpoint, casHistoryCheckpoint } from "./btc-history-checkpoint";
import { reconstructEthHistory, persistEthFullHistory, type EthHistoryResult } from "./eth-history-sync";
import type { EthHistoryDeps } from "./eth-history";
import { parseCheckpoint, queuedCheckpoint, serializeCheckpoint, backfillStatus, type EthBackfillState } from "./eth-history-backfill.core";
import { runEthHistoryBackfill, EthCheckpointConflictError, type EthBackfillStore, type EthBackfillDeps, type EthBackfillOutcome } from "./eth-history-backfill";

/**
 * Hand an account's FULL rebuild to the worker (QUEUED, reason = the
 * incremental fallback). Idempotent: a queued / importing / failed checkpoint
 * is never replaced; a COMPLETE one starts a new generation (the incremental
 * path fell back again). A value that is not this account's ETH checkpoint is
 * never overwritten.
 */
export async function enqueueEthHistoryBackfill(client: PrismaClient, accountId: string, reason: string, now: Date = new Date()): Promise<boolean> {
  const link = await historyLink(client, accountId);
  if (!link) return false;
  const raw = await readHistoryCheckpoint(client, link.connectionId);
  const existing = parseCheckpoint(raw, accountId);
  if (raw !== null && !existing?.completedAtISO) return false;
  const next = { ...queuedCheckpoint(accountId, reason, now.toISOString()), snapshotPendingFromISO: existing?.snapshotPendingFromISO ?? null };
  return casHistoryCheckpoint(client, link.connectionId, raw, serializeCheckpoint(next));
}

/** The worker's state for this account's rebuild, while one is owed (null: none, or COMPLETE). */
export async function ethHistoryPending(client: PrismaClient, accountId: string): Promise<EthBackfillState | null> {
  const link = await historyLink(client, accountId);
  if (!link) return null;
  const cp = parseCheckpoint(await readHistoryCheckpoint(client, link.connectionId), accountId);
  return cp && !cp.completedAtISO ? backfillStatus(cp).state : null;
}

/**
 * An INLINE full rebuild succeeded (the worker is off, or was turned off with
 * a rebuild still queued): the worker's checkpoint no longer describes the
 * wallet. Mark it COMPLETE with the licence the rebuild wrote, so no surface
 * reports "importing" for a finished history and a re-enabled worker does
 * not redo it. Only a non-complete ETH checkpoint of this account is touched.
 */
export async function settleEthHistoryCheckpoint(client: PrismaClient, accountId: string, result: EthHistoryResult, now: Date = new Date()): Promise<boolean> {
  const link = await historyLink(client, accountId);
  if (!link) return false;
  const raw = await readHistoryCheckpoint(client, link.connectionId);
  const cp = parseCheckpoint(raw, accountId);
  if (!cp || cp.completedAtISO) return false;
  const cov = result.coverage?.kind === "COMPLETE" ? result.coverage : null;
  const nowISO = now.toISOString();
  return casHistoryCheckpoint(client, link.connectionId, raw, serializeCheckpoint({
    ...cp, movements: [], forward: null, movementsFound: result.reconciliation?.movementCount ?? cp.movements.length,
    completedAtISO: nowISO, lastProgressAtISO: nowISO, licensedFromISO: cov?.fromISO ?? null, licensedToISO: cov?.toISO ?? null,
    failures: 0, lastFailure: null, recovery: null,
  }));
}

export interface EthSyncImpl {
  reconstruct: typeof reconstructEthHistory;
  pending: typeof ethHistoryPending;
  enqueue: typeof enqueueEthHistoryBackfill;
  settle: typeof settleEthHistoryCheckpoint;
}
const PRODUCTION_IMPL: EthSyncImpl = {
  reconstruct: reconstructEthHistory, pending: ethHistoryPending, enqueue: enqueueEthHistoryBackfill, settle: settleEthHistoryCheckpoint,
};

/**
 * What `refreshWalletHistory` calls for ETH.
 *
 * `deferFull` false (the worker does not carry Ethereum): EXACTLY the call
 * made before — the incremental path, falling back to the inline FULL rebuild.
 * Only after a SUCCESSFUL inline FULL rebuild is a leftover worker checkpoint
 * settled (settleEthHistoryCheckpoint); every other outcome touches nothing.
 *
 * `deferFull` true: a rebuild already owed to the worker is not attempted here
 * (it would only fall back again); otherwise the incremental path runs, and a
 * fallback records the QUEUED checkpoint and returns FULL_REBUILD_DEFERRED,
 * having written nothing.
 */
export async function reconstructEthHistoryForSync(
  args: { accountId: string; windowFromISO: string; windowToISO: string; client: PrismaClient; deferFull: boolean; deps?: EthHistoryDeps },
  impl: EthSyncImpl = PRODUCTION_IMPL,
): Promise<EthHistoryResult> {
  const { accountId, windowFromISO, windowToISO, deps } = args;
  if (!args.deferFull) {
    const r = await impl.reconstruct({ accountId, windowFromISO, windowToISO, deps });
    if (r.ok && r.mode === "FULL") {
      try { await impl.settle(args.client, accountId, r); }
      catch (e) { console.warn(`[eth-history] could not settle the worker checkpoint for ${accountId} (non-fatal):`, e instanceof Error ? e.message : String(e)); }
    }
    return r;
  }

  let pending: EthBackfillState | null = null;
  try { pending = await impl.pending(args.client, accountId); }
  catch (e) {
    // A transient read failure: the incremental path still runs, and a fallback still defers.
    console.warn(`[eth-history] checkpoint read failed for ${accountId} (non-fatal):`, e instanceof Error ? e.message : String(e));
  }
  if (pending) {
    return { accountId, ok: false, refusal: "FULL_REBUILD_DEFERRED",
      reason: `history is carried by the background worker (${pending.toLowerCase()})` };
  }
  const r = await impl.reconstruct({ accountId, windowFromISO, windowToISO, deps, deferFull: true });
  if (r.refusal === "FULL_REBUILD_DEFERRED") {
    try { await impl.enqueue(args.client, accountId, r.fallbackReason ?? "UNKNOWN"); }
    catch (e) {
      // Nothing was written; the next sync falls back and enqueues again.
      console.warn(`[eth-history] could not queue the full rebuild for ${accountId} (non-fatal):`, e instanceof Error ? e.message : String(e));
    }
  }
  return r;
}

/** The production store for one ETH wallet account. */
export async function prismaEthBackfillStore(accountId: string, db: PrismaClient): Promise<{ store: EthBackfillStore; connectionId: string } | null> {
  const account = await db.financialAccount.findUnique({
    where: { id: accountId }, select: { walletChain: true, walletAddress: true, deletedAt: true },
  });
  if (!account || account.deletedAt || account.walletChain?.trim().toUpperCase() !== ETH_NATIVE.chain || !account.walletAddress) return null;
  const link = await historyLink(db, accountId);
  if (!link) return null;
  const connectionId = link.connectionId;
  const store: EthBackfillStore = {
    walletAddress: account.walletAddress,
    readCursor: () => readHistoryCheckpoint(db, connectionId),
    casCursor: (expected, next) => casHistoryCheckpoint(db, connectionId, expected, next),
    async complete(c) {
      return persistEthFullHistory({
        accountId, client: db, writer: db, movements: c.movements, coverage: c.coverage, anchorBalanceWei: c.anchorBalanceWei,
        // The licence starts at the provable floor, before any stored evidence.
        windowFromISO: c.coverage.fromISO, windowToISO: c.windowToISO, fallbackReason: c.fallbackReason,
        instrumentId: await resolveCryptoInstrumentId(ETH_ASSET, { client: db }),
        txTimeoutMs: 30_000,
        inTransaction: async (tx) => {
          if (!(await casHistoryCheckpoint(tx, connectionId, c.expectedCursor, c.nextCursor))) throw new EthCheckpointConflictError();
        },
      });
    },
  };
  return { store, connectionId };
}

/** One worker step for one ETH wallet. */
export async function reconstructEthHistoryResumable(args: { accountId: string; client: PrismaClient; todayISO: string; deps: EthBackfillDeps }): Promise<EthBackfillOutcome> {
  const bound = await prismaEthBackfillStore(args.accountId, args.client);
  if (!bound) return { stoppedBecause: "NOT_QUEUED", status: null, rowsWritten: 0, impactedFromISO: null, failure: null, requests: 0 };
  return runEthHistoryBackfill({ accountId: args.accountId, store: bound.store, todayISO: args.todayISO }, args.deps);
}
