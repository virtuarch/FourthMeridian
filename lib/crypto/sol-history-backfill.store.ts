/**
 * lib/crypto/sol-history-backfill.store.ts
 *
 * The database half of the resumable Solana backfill (sol-history-backfill.ts):
 * the checkpoint on `Connection.cursor`, the DERIVED rows and the coverage
 * licence, written together in one transaction with a compare-and-swap on the
 * cursor — and the entry point `refreshWalletHistory` calls for SOL.
 */

import { PositionOrigin, type PrismaClient } from "@prisma/client";
import { SOL_ASSET, resolveCryptoInstrumentId } from "@/lib/investments/crypto-instrument";
import { SOL_NATIVE } from "./native-asset";
import { persistPositionCoverage, loadPositionCoverage, licensedInterval } from "./position-coverage";
import { SOL_RECONSTRUCTION_SOURCE } from "./sol-history-sync";
import { SOL_CHAIN_STATED_BASIS, SOL_RECONSTRUCTION_VERSION, SOL_CONTINUITY_SOURCE, parseCheckpoint, type SolBackfillFailureCode } from "./sol-history-backfill.core";
import {
  runSolHistoryBackfill, CheckpointConflictError, buildRpcCall, syncRunBudgetMs, SolTransportError,
  type SolBackfillStore, type SolBackfillDeps, type SolBackfillOutcome,
} from "./sol-history-backfill";
import { normalizeSolAddress } from "./sol-rpc";
import { parseSplState } from "./spl-history.core";
import { runSplTokenHistory, createSplDiscoveryCollector, annotateWithDiscoveries, type SplRunOutcome } from "./spl-history";
import { prismaSplHistoryStore, splHistoryEnabled } from "./spl-history.store";

/** The production store: Connection.cursor + PositionObservation + PositionCoverage. */
/** The client is the CALLER's authority (never a module default — audit-db-authority). */
export async function prismaSolBackfillStore(accountId: string, db: PrismaClient): Promise<{ store: SolBackfillStore; address: string; connectionId: string } | null> {
  const account = await db.financialAccount.findUnique({
    where: { id: accountId },
    select: { walletChain: true, walletAddress: true, deletedAt: true,
      connections: { where: { connectionId: { not: null }, deletedAt: null }, select: { connectionId: true },
        // Stable: the same link every run, or the checkpoint would flip between cursors.
        orderBy: [{ isCanonical: "desc" }, { createdAt: "asc" }], take: 1 } },
  });
  const connectionId = account?.connections[0]?.connectionId ?? null;
  if (!account || account.deletedAt || account.walletChain !== SOL_NATIVE.chain || !account.walletAddress || !connectionId) return null;
  const instrumentId = await resolveCryptoInstrumentId(SOL_ASSET, { client: db });
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
      // The quantity is stored as a float, so its lamport value carries up to a
      // few units of representation error above ~4.5M SOL. That error is the
      // tolerance — never more.
      const lamports = BigInt(Math.round(row.quantity * Number(lamportsPerSol)));
      const toleranceLamports = BigInt(Math.max(1, Math.ceil(Math.abs(Number(lamports)) * Number.EPSILON * 4)));
      return { dateISO: row.date.toISOString().slice(0, 10), lamports, toleranceLamports };
    },
    async legacy() {
      // The previous importer's LICENCE (never this importer's own), and its rows.
      const cov = (await loadPositionCoverage(db, [accountId])).get(accountId);
      if (!cov || cov.source === SOL_CONTINUITY_SOURCE) return null;
      const interval = licensedInterval(cov);
      if (!interval) return null;
      const rows = await db.positionObservation.findMany({
        where: { financialAccountId: accountId, instrumentId, origin: PositionOrigin.DERIVED, source: SOL_RECONSTRUCTION_SOURCE,
          // Legacy rows carry no version (NULL) — `NOT { = 2 }` would drop them in SQL.
          deletedAt: null, OR: [{ reconstructionVersion: null }, { reconstructionVersion: { not: SOL_RECONSTRUCTION_VERSION } }] },
        select: { date: true, quantity: true },
      });
      return { ...interval, rows: new Map(rows.map((r) => [r.date.toISOString().slice(0, 10), r.quantity])) };
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

export type SolResumableRefusal = "NOT_A_SOL_WALLET" | "HISTORY_GAP" | "BACKFILL_PAUSED" | "DEFERRED_TO_WORKER" | SolBackfillFailureCode | "CHECKPOINT_CONFLICT";

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
  /** SPL token history's step this run (null: disabled, skipped before it ran, or no budget left). */
  tokens?: SplRunOutcome | null;
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
  args: { accountId: string; client: PrismaClient; windowFromISO?: string; windowToISO?: string; resume?: boolean; deps?: SolBackfillDeps },
): Promise<SolResumableResult> {
  const bound = await prismaSolBackfillStore(args.accountId, args.client);
  if (!bound) {
    return { accountId: args.accountId, ok: false, refusal: "NOT_A_SOL_WALLET", reason: "not a SOL wallet with an address and a connection",
      derivedRowsWritten: 0, mode: "NO_CHANGE", impactedFromISO: null, backfill: null };
  }
  // SPL TOKEN HISTORY — discovery rides on the native fetch (its transaction
  // hook), folded into each native commit. A wallet whose native checkpoint is
  // fresh gets discovery for free (NATIVE); one imported before this existed
  // is re-walked by the token step itself (WALK).
  const splOn = splHistoryEnabled();
  const owner = normalizeSolAddress(bound.address);
  const deps0: SolBackfillDeps = { ...(args.deps ?? {}) };
  const meter = deps0.meter ?? {};
  deps0.meter = meter;
  const now = deps0.now ?? Date.now;
  const startMs = now();
  const sent = () => Object.values(meter).reduce((a, b) => a + b, 0);
  const sentAtStart = sent();
  let collector: ReturnType<typeof createSplDiscoveryCollector> | null = null;
  let freshSource: "NATIVE" | "WALK" = "WALK";
  if (splOn) {
    const before = parseCheckpoint(await bound.store.readCursor(), args.accountId, owner);
    freshSource = !before || (before.top === null && parseSplState(before.tokens) === null) ? "NATIVE" : "WALK";
    collector = createSplDiscoveryCollector(owner);
    const c = collector;
    deps0.observeTransaction = c.observe;
    deps0.annotateCheckpoint = (cp) => annotateWithDiscoveries(cp, c.all(), freshSource);
  }
  const o = await runSolHistoryBackfill({ accountId: args.accountId, address: bound.address, store: bound.store, resume: args.resume }, deps0);
  const native = nativeResult(args, o);
  if (!collector || o.stoppedBecause === "CONFLICT") return native;

  // The token step gets what is LEFT of the same run: wall clock and request allowance.
  const budgetMs = deps0.budgetMs ?? (Number(process.env.SOL_HISTORY_RUN_BUDGET_MS) > 0 ? Number(process.env.SOL_HISTORY_RUN_BUDGET_MS) : syncRunBudgetMs());
  const deadlineMs = startMs + budgetMs;
  const requestBudget = deps0.requestBudget !== undefined ? deps0.requestBudget - (sent() - sentAtStart) : undefined;
  if (deadlineMs - now() < 2_000 || (requestBudget !== undefined && requestBudget <= 0)) return native;
  let call;
  try { call = buildRpcCall({ ...deps0, observeTransaction: undefined, annotateCheckpoint: undefined }, deadlineMs); }
  catch (e) { if (e instanceof SolTransportError) return native; throw e; }
  let tokens: SplRunOutcome;
  try {
    tokens = await runSplTokenHistory(
      { owner, store: prismaSplHistoryStore(args.accountId, bound.connectionId, args.client), headOnly: deps0.headOnly, discovered: collector.all(), freshSource },
      { call, deadlineMs, now, sent, requestBudget, concurrency: deps0.concurrency },
    );
  } catch (e) {
    // Token history must never take the native result down with it.
    console.warn("[sol-history] SPL token history step failed (non-fatal):", e instanceof Error ? e.message : String(e));
    return native;
  }
  if (tokens.rowsWritten === 0 && tokens.impactedFromISO === null) return { ...native, tokens };
  const impactedFromISO = [native.impactedFromISO, tokens.impactedFromISO].filter((d): d is string => d !== null).sort()[0] ?? null;
  const merged: SolResumableResult = { ...native, tokens, impactedFromISO, derivedRowsWritten: native.derivedRowsWritten + Math.max(tokens.rowsWritten, 1), mode: "INCREMENTAL" };
  // A head-only sync deferred native history but proved token days: that IS a refresh.
  if (!native.ok && native.refusal === "DEFERRED_TO_WORKER") return { ...merged, ok: true, refusal: undefined, reason: undefined };
  return merged;
}

/** The native run's result, exactly as before token history existed. */
function nativeResult(
  args: { accountId: string; deps?: SolBackfillDeps },
  o: SolBackfillOutcome,
): SolResumableResult {
  const base = { accountId: args.accountId, derivedRowsWritten: o.rowsWritten, impactedFromISO: o.impactedFromISO,
    mode: (o.rowsWritten > 0 ? "INCREMENTAL" : "NO_CHANGE") as "INCREMENTAL" | "NO_CHANGE", backfill: o };
  // Committed progress is a refresh even when the run then stopped: those days
  // changed, and the snapshot window must hear about them.
  if (o.progressed) {
    const refusal = o.stoppedBecause === "GAP" ? { refusal: "HISTORY_GAP" as const, reason: "a transaction is missing from the address index; proven history is kept" }
      : o.failure ? { refusal: o.failure.code, reason: o.failure.detail } : {};
    return { ...base, ok: true, ...refusal };
  }
  if (o.stoppedBecause === "GAP") return { ...base, ok: false, refusal: "HISTORY_GAP", reason: "a transaction is missing from the address index; proven history is kept" };
  if (o.stoppedBecause === "SKIPPED") return { ...base, ok: false, refusal: o.status.state === "RECOVERY_REQUIRED" ? "HISTORY_GAP" : "BACKFILL_PAUSED", reason: `history backfill is ${o.status.state}` };
  if (o.failure) return { ...base, ok: false, refusal: o.failure.code, reason: o.failure.detail };
  // A head-only sync that proved nothing new built nothing: not a refresh (the
  // "history rebuilt" clock must not move), the worker carries the history.
  if (args.deps?.headOnly && !o.progressed && o.status.state !== "COMPLETE") {
    return { ...base, ok: false, refusal: "DEFERRED_TO_WORKER", reason: "history is carried by the background worker" };
  }
  return { ...base, ok: true };
}
