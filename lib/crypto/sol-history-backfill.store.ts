/**
 * lib/crypto/sol-history-backfill.store.ts
 *
 * The database half of the resumable Solana backfill (sol-history-backfill.ts):
 * the checkpoint on `Connection.cursor`, the DERIVED rows and the coverage
 * licence, written together in one transaction with a compare-and-swap on the
 * cursor — and the entry point `refreshWalletHistory` calls for SOL.
 */

import { PositionOrigin } from "@prisma/client";
import { db } from "@/lib/db";
import { SOL_ASSET, resolveCryptoInstrumentId } from "@/lib/investments/crypto-instrument";
import { SOL_NATIVE } from "./native-asset";
import { persistPositionCoverage } from "./position-coverage";
import { SOL_RECONSTRUCTION_SOURCE } from "./sol-history-sync";
import { SOL_CHAIN_STATED_BASIS, SOL_RECONSTRUCTION_VERSION, type SolBackfillFailureCode } from "./sol-history-backfill.core";
import {
  runSolHistoryBackfill, CheckpointConflictError,
  type SolBackfillStore, type SolBackfillDeps, type SolBackfillOutcome,
} from "./sol-history-backfill";

/** The production store: Connection.cursor + PositionObservation + PositionCoverage. */
export async function prismaSolBackfillStore(accountId: string): Promise<{ store: SolBackfillStore; address: string; connectionId: string } | null> {
  const account = await db.financialAccount.findUnique({
    where: { id: accountId },
    select: { walletChain: true, walletAddress: true, deletedAt: true,
      connections: { where: { connectionId: { not: null } }, select: { connectionId: true }, take: 1 } },
  });
  const connectionId = account?.connections[0]?.connectionId ?? null;
  if (!account || account.deletedAt || account.walletChain !== SOL_NATIVE.chain || !account.walletAddress || !connectionId) return null;
  const instrumentId = await resolveCryptoInstrumentId(SOL_ASSET);
  const lamportsPerSol = BigInt(10) ** BigInt(SOL_NATIVE.decimals);

  const store: SolBackfillStore = {
    async readCursor() {
      const c = await db.connection.findUnique({ where: { id: connectionId }, select: { cursor: true } });
      return c?.cursor ?? null;
    },
    async anchor() {
      const row = await db.positionObservation.findFirst({
        where: { financialAccountId: accountId, instrumentId, supersededById: null, deletedAt: null,
          origin: { in: [PositionOrigin.OBSERVED, PositionOrigin.IMPORTED] } },
        orderBy: { date: "desc" }, select: { date: true, quantity: true },
      });
      if (!row) return null;
      return { dateISO: row.date.toISOString().slice(0, 10), lamports: BigInt(Math.round(row.quantity * Number(lamportsPerSol))) };
    },
    async commit(c) {
      await db.$transaction(async (tx) => {
        const swapped = await tx.connection.updateMany({ where: { id: connectionId, cursor: c.expectedCursor }, data: { cursor: c.nextCursor } });
        if (swapped.count !== 1) throw new CheckpointConflictError();
        const scope = { financialAccountId: accountId, instrumentId, origin: PositionOrigin.DERIVED, source: SOL_RECONSTRUCTION_SOURCE };
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
              origin: PositionOrigin.DERIVED, source: SOL_RECONSTRUCTION_SOURCE,
              completeness: SOL_CHAIN_STATED_BASIS, reconstructionVersion: SOL_RECONSTRUCTION_VERSION, isCash: false,
            })),
            skipDuplicates: true,
          });
        }
        if (c.coverage) await persistPositionCoverage(tx, accountId, instrumentId, c.coverage);
      });
    },
  };
  return { store, address: account.walletAddress, connectionId };
}

// ── The refresh entry point ─────────────────────────────────────────────────

export type SolResumableRefusal = "NOT_A_SOL_WALLET" | "HISTORY_GAP" | "BACKFILL_PAUSED" | SolBackfillFailureCode | "CHECKPOINT_CONFLICT";

export interface SolResumableResult {
  accountId: string;
  ok: boolean;
  refusal?: SolResumableRefusal;
  reason?: string;
  derivedRowsWritten: number;
  /** INCREMENTAL when rows changed, NO_CHANGE when nothing moved — what the snapshot planner reads. */
  mode: "INCREMENTAL" | "NO_CHANGE";
  impactedFromISO: string | null;
  backfill: SolBackfillOutcome | null;
}

/**
 * What `refreshWalletHistory` calls for SOL. The window arguments are accepted
 * for the shared signature and deliberately unused: the proven interval comes
 * from the chain, never from a caller's floor (the collapse in the 2026-10-28 RCA).
 *
 * `ok` means the run did not fail: it finished, progressed within its budget,
 * or verified nothing changed. A gap or a paused (repeatedly failing) backfill
 * is a refusal — nothing beyond what is already proven is claimed.
 */
export async function reconstructSolHistoryResumable(
  args: { accountId: string; windowFromISO?: string; windowToISO?: string; resume?: boolean; deps?: SolBackfillDeps },
): Promise<SolResumableResult> {
  const bound = await prismaSolBackfillStore(args.accountId);
  if (!bound) {
    return { accountId: args.accountId, ok: false, refusal: "NOT_A_SOL_WALLET", reason: "not a SOL wallet with an address and a connection",
      derivedRowsWritten: 0, mode: "NO_CHANGE", impactedFromISO: null, backfill: null };
  }
  const o = await runSolHistoryBackfill({ accountId: args.accountId, address: bound.address, store: bound.store, resume: args.resume }, args.deps);
  const base = { accountId: args.accountId, derivedRowsWritten: o.rowsWritten, impactedFromISO: o.impactedFromISO,
    mode: (o.rowsWritten > 0 ? "INCREMENTAL" : "NO_CHANGE") as "INCREMENTAL" | "NO_CHANGE", backfill: o };
  if (o.stoppedBecause === "GAP") return { ...base, ok: false, refusal: "HISTORY_GAP", reason: "a transaction is missing from the address index; proven history is kept" };
  if (o.stoppedBecause === "SKIPPED") return { ...base, ok: false, refusal: o.status.state === "RECOVERY_REQUIRED" ? "HISTORY_GAP" : "BACKFILL_PAUSED", reason: `history backfill is ${o.status.state}` };
  if (o.failure) return { ...base, ok: false, refusal: o.failure.code, reason: o.failure.detail };
  return { ...base, ok: true };
}
