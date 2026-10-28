/**
 * lib/crypto/btc-history-backfill.store.ts
 *
 * The database half of the resumable Bitcoin backfill (btc-history-backfill.ts):
 * the checkpoint on `Connection.historyCheckpoint`, the page's Transaction rows,
 * the DERIVED rows and the coverage licence — written together in one
 * transaction with a compare-and-swap on the checkpoint — and the entry point
 * `refreshWalletHistory` calls for BTC.
 */

import { PositionOrigin, ProviderType, type PrismaClient } from "@prisma/client";
import { BTC_ASSET, resolveCryptoInstrumentId } from "@/lib/investments/crypto-instrument";
import { BTC_NATIVE } from "./native-asset";
import { isExtendedKey } from "./btc-address-derivation";
import { readDiscoveryCursor } from "./btc-discovery-core";
import { persistPositionCoverage, loadPositionCoverage, licensedInterval } from "./position-coverage";
import { BTC_RECONSTRUCTION_SOURCE, reconstructBtcHistory, type BtcHistoryResult } from "./btc-history-sync";
import { persistBtcRawTxs } from "./btc-sync";
import { btcHistoryLink, readHistoryCheckpoint, casHistoryCheckpoint } from "./btc-history-checkpoint";
import {
  BTC_CHAIN_SUMMED_BASIS, BTC_RECONSTRUCTION_VERSION, BTC_CHAIN_STATS_SOURCE, type BtcBackfillFailureCode,
} from "./btc-history-backfill.core";
import {
  runBtcHistoryBackfill, CheckpointConflictError,
  type BtcBackfillStore, type BtcBackfillDeps, type BtcBackfillOutcome,
} from "./btc-history-backfill";

/** The production store. The client is the CALLER's authority (never a module default — audit-db-authority). */
export async function prismaBtcBackfillStore(accountId: string, db: PrismaClient): Promise<{ store: BtcBackfillStore; connectionId: string } | null> {
  const account = await db.financialAccount.findUnique({
    where: { id: accountId },
    select: { walletChain: true, walletAddress: true, ownerUserId: true, deletedAt: true },
  });
  if (!account || account.deletedAt || account.walletChain !== BTC_NATIVE.chain || !account.walletAddress) return null;
  const link = await btcHistoryLink(db, accountId);
  if (!link) return null;
  const connectionId = link.connectionId;
  const descriptor = link.credential ?? account.walletAddress;
  const isXpub = isExtendedKey(descriptor);
  const instrumentId = await resolveCryptoInstrumentId(BTC_ASSET, { client: db });

  const readAddresses = async (): Promise<string[]> => {
    const rows = await db.providerAccountIdentity.findMany({
      where: { provider: ProviderType.WALLET, financialAccountId: accountId },
      select: { externalAccountId: true },
    });
    const real = rows.map((r) => r.externalAccountId).filter((a) => !isExtendedKey(a));
    // A pre-v1.5 single-address wallet with no identity row: its one address (as btc-sync).
    return real.length === 0 && !isXpub ? [account.walletAddress!] : real;
  };

  const store: BtcBackfillStore = {
    readCursor: () => readHistoryCheckpoint(db, connectionId),
    async addresses() {
      const addresses = await readAddresses();
      if (!isXpub) return { addresses, complete: true };
      // An xpub's set is final only once discovery has met its gap limit on
      // both branches — an undiscovered address would be an unlisted one.
      const c = await db.connection.findUnique({ where: { id: connectionId }, select: { cursor: true } });
      const d = readDiscoveryCursor(c?.cursor ?? null);
      return { addresses, complete: d.rDone && d.cDone };
    },
    async legacy() {
      // The wholesale path's LICENCE (never this path's own), and its rows.
      const cov = (await loadPositionCoverage(db, [accountId])).get(accountId);
      if (!cov || cov.source === BTC_CHAIN_STATS_SOURCE) return null;
      const interval = licensedInterval(cov);
      if (!interval) return null;
      const rows = await db.positionObservation.findMany({
        where: { financialAccountId: accountId, instrumentId, origin: PositionOrigin.DERIVED, source: BTC_RECONSTRUCTION_SOURCE,
          // Legacy rows carry no version (NULL) — `NOT { = 2 }` would drop them in SQL.
          deletedAt: null, OR: [{ reconstructionVersion: null }, { reconstructionVersion: { not: BTC_RECONSTRUCTION_VERSION } }] },
        select: { date: true, quantity: true },
      });
      return { ...interval, rows: new Map(rows.map((r) => [r.date.toISOString().slice(0, 10), r.quantity])) };
    },
    async commit(c) {
      // The address set is read OUTSIDE the transaction: it is the netting
      // context for the Transaction rows, not something this commit changes.
      const addresses = c.rawTxs.length > 0 ? await readAddresses() : [];
      await db.$transaction(async (tx) => {
        if (!(await casHistoryCheckpoint(tx, connectionId, c.expectedCursor, c.nextCursor))) throw new CheckpointConflictError();
        if (c.rawTxs.length > 0) {
          await persistBtcRawTxs(tx, { id: accountId, ownerUserId: account.ownerUserId, addresses }, c.rawTxs);
        }
        // DERIVED rows of this source only — an OBSERVED row is never touched.
        const scope = { financialAccountId: accountId, instrumentId, origin: PositionOrigin.DERIVED, source: BTC_RECONSTRUCTION_SOURCE };
        if (c.replaceAll) await tx.positionObservation.deleteMany({ where: scope });
        else if (c.deleteFromISO && c.deleteToISO) {
          await tx.positionObservation.deleteMany({ where: { ...scope,
            date: { gte: new Date(`${c.deleteFromISO}T00:00:00.000Z`), lte: new Date(`${c.deleteToISO}T00:00:00.000Z`) } } });
        }
        if (c.rows.length > 0) {
          await tx.positionObservation.createMany({
            data: c.rows.map((r) => ({
              financialAccountId: accountId, instrumentId,
              date: new Date(`${r.dateISO}T00:00:00.000Z`), quantity: r.quantity,
              origin: PositionOrigin.DERIVED, source: BTC_RECONSTRUCTION_SOURCE,
              completeness: BTC_CHAIN_SUMMED_BASIS, reconstructionVersion: BTC_RECONSTRUCTION_VERSION, isCash: false,
            })),
            skipDuplicates: true,
          });
        }
        if (c.coverage) await persistPositionCoverage(tx, accountId, instrumentId, c.coverage);
      }, { timeout: 30_000 });
    },
  };
  return { store, connectionId };
}

// ── The refresh entry point ─────────────────────────────────────────────────

export type BtcResumableRefusal =
  | "NOT_A_BTC_WALLET" | "HISTORY_RECOVERY_REQUIRED" | "BACKFILL_PAUSED" | "DEFERRED_TO_WORKER" | "HISTORY_UNVERIFIED"
  | BtcBackfillFailureCode | "CHECKPOINT_CONFLICT";

export interface BtcResumableResult {
  accountId: string;
  ok: boolean;
  refusal?: BtcResumableRefusal;
  reason?: string;
  derivedRowsWritten: number;
  /** INCREMENTAL when rows changed, NO_CHANGE when nothing moved — what the snapshot planner reads. */
  mode: "INCREMENTAL" | "NO_CHANGE";
  impactedFromISO: string | null;
  backfill: BtcBackfillOutcome | null;
}

/**
 * The resumable backfill for one BTC wallet. `ok` means the run did not fail:
 * it proved and wrote rows, verified nothing changed, or progressed its import
 * within its budget. A recovery, a paused backfill, or a run that imported
 * nothing provable is a refusal — nothing beyond what is proven is claimed.
 */
export async function reconstructBtcHistoryResumable(
  args: { accountId: string; client: PrismaClient; resume?: boolean; deps?: BtcBackfillDeps },
): Promise<BtcResumableResult> {
  const bound = await prismaBtcBackfillStore(args.accountId, args.client);
  if (!bound) {
    return { accountId: args.accountId, ok: false, refusal: "NOT_A_BTC_WALLET", reason: "not a BTC wallet with an address and a connection",
      derivedRowsWritten: 0, mode: "NO_CHANGE", impactedFromISO: null, backfill: null };
  }
  const o = await runBtcHistoryBackfill({ accountId: args.accountId, store: bound.store, resume: args.resume }, args.deps);
  const base = { accountId: args.accountId, derivedRowsWritten: o.rowsWritten, impactedFromISO: o.impactedFromISO,
    mode: (o.impactedFromISO !== null ? "INCREMENTAL" : "NO_CHANGE") as "INCREMENTAL" | "NO_CHANGE", backfill: o };
  if (o.stoppedBecause === "SKIPPED") {
    return { ...base, ok: false, refusal: o.status.state === "RECOVERY_REQUIRED" ? "HISTORY_RECOVERY_REQUIRED" : "BACKFILL_PAUSED", reason: `history backfill is ${o.status.state}` };
  }
  // Rows changed (proof or withdrawal) — a refresh the snapshot window must hear about, whatever followed.
  if (o.impactedFromISO !== null) {
    return { ...base, ok: true, ...(o.failure ? { refusal: o.failure.code, reason: o.failure.detail } : {}) };
  }
  if (o.stoppedBecause === "RECOVERY") return { ...base, ok: false, refusal: "HISTORY_RECOVERY_REQUIRED", reason: o.status.recovery?.detail ?? "history needs recovery" };
  if (o.failure) return { ...base, ok: false, refusal: o.failure.code, reason: o.failure.detail };
  if (o.verified === true) return { ...base, ok: true };
  if (o.verified === false) return { ...base, ok: false, refusal: "HISTORY_UNVERIFIED", reason: "the listing does not yet reconcile with the explorer's chain_stats" };
  // Import progressed (or nothing to do yet) but nothing is provable yet: no
  // rows changed, so the "history rebuilt" clock must not move.
  return { ...base, ok: false, refusal: "DEFERRED_TO_WORKER",
    reason: args.deps?.headOnly ? "history is carried by the background worker" : `history import ${o.status.state.toLowerCase()} — ${o.status.txsProcessed} transactions so far` };
}

/**
 * What `refreshWalletHistory` calls for BTC. A wallet the resumable backfill
 * owns (a checkpoint on its link — handed over by the sync when the inline
 * import stopped at its page budget) runs it; every other wallet keeps the
 * wholesale reconstruction exactly as before. Never both: the wholesale path
 * replaces every DERIVED row of the source, which would clobber proven rows.
 */
export async function reconstructBtcHistoryOrResumable(args: {
  accountId: string; windowFromISO: string; windowToISO: string; client: PrismaClient; headOnly: boolean;
}): Promise<BtcHistoryResult | BtcResumableResult> {
  let owned = false;
  try {
    const link = await btcHistoryLink(args.client, args.accountId);
    owned = link !== null && (await readHistoryCheckpoint(args.client, link.connectionId)) !== null;
  } catch (e) {
    // Unreadable (e.g. the column's migration not applied yet): the wholesale
    // path, exactly as before — and it refuses by itself where the resumable
    // licence is already in force (RESUMABLE_HISTORY_IN_FORCE).
    console.warn(`[btc-history] checkpoint read failed for ${args.accountId} (non-fatal — wholesale path):`, e instanceof Error ? e.message : String(e));
  }
  if (owned) return reconstructBtcHistoryResumable({ accountId: args.accountId, client: args.client, deps: { headOnly: args.headOnly } });
  return reconstructBtcHistory({ accountId: args.accountId, windowFromISO: args.windowFromISO, windowToISO: args.windowToISO, client: args.client });
}
