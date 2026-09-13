/**
 * lib/crypto/eth-history-incremental.ts
 *
 * INCREMENTAL ETHEREUM HISTORY — reuse what is already proven, prove only what is new.
 *
 * A full reconstruction re-proves every block since Byzantium on every refresh:
 * measured on a real wallet, ~150 s, ~551 HTTP requests and a delete-and-recreate
 * of 3,255 rows, twice in a row, to find the same 16 movements. This module
 * reuses the stored history — but only after verifying it against the chain.
 *
 *   eligible      COMPLETE coverage from this adapter, every DERIVED row on the
 *                 current reconstruction version, no gap before the boundary
 *   boundary      the covered-to date; its checkpoint is the stored row for the
 *                 day before
 *   resume block  the last block before 00:00 UTC on the boundary date, found by
 *                 bisection between a post-Merge floor and the finalized head
 *   checkpoint    the chain's balance at the resume block must equal the stored
 *                 checkpoint quantity — or the stored history is not trusted
 *   acquire       the SAME emptiness-proof acquisition, over [resume, finalized]
 *   reconcile     opening + Σ(new movements) = anchor, exactly, in wei
 *   write         only rows whose quantity actually changed, from the boundary
 *                 forward, in one transaction with the coverage licence
 *
 * ⚠️ ANY FAILED INVARIANT FALLS BACK TO THE FULL REBUILD. This is an optimisation
 * guarded by proof, not a second authority. A PROVIDER failure is different: it
 * is a refusal, it writes nothing, and the old proven history stays exactly
 * where it was — retrying the full rebuild against a failing provider would only
 * fail slower.
 *
 * ⚠️ NATIVE ETH ONLY. See eth-history-rows.ts. BNB, AVAX and ERC-20 history are
 * not reconstructed here, and this module claims nothing about them.
 */

import { PositionOrigin, type PrismaClient } from "@prisma/client";
import { baseUnitsToWhole, reconcileMovementsAgainstOpening, type ChainCoverage } from "./chain-movement";
import {
  acquireEthHistory, blockAtOrBefore, finalizedHead, postMergeSearchFloor, readAccountStateAt,
  EARLIEST_PROVABLE_BLOCK, ETH_HISTORY_SOURCE, type EthHistoryDeps,
} from "./eth-history";
import {
  ETH_RECONSTRUCTION_SOURCE, ETH_RECONSTRUCTION_VERSION, replayEthHistory, sameQuantity,
  type EthDerivedRow,
} from "./eth-history-rows";
import { ETH_NATIVE } from "./native-asset";
import { persistPositionCoverage } from "./position-coverage";
import type { EthHistoryRefusal, EthHistoryResult } from "./eth-history-sync";

/** Why the incremental path handed over to the full rebuild. */
export type EthIncrementalFallback =
  | "NO_COVERAGE"
  | "COVERAGE_INCOMPLETE"
  | "COVERAGE_SOURCE"
  | "NO_CHECKPOINT_ROW"
  | "HISTORY_GAP"
  | "VERSION_MISMATCH"
  | "BOUNDARY_UNRESOLVED"
  | "CHECKPOINT_MISMATCH"
  | "RECONCILIATION_MISMATCH"
  | "EXPLICIT_FULL";

export type EthIncrementalOutcome =
  | { kind: "FALLBACK"; reason: EthIncrementalFallback; detail?: string }
  | { kind: "REFUSED"; refusal: EthHistoryRefusal; reason: string }
  | { kind: "DONE"; result: EthHistoryResult };

export interface StoredDerivedRow { dateISO: string; quantity: number; completeness: string | null; version: number | null }

/** What the incremental path reads and writes. Injectable, so every invariant is testable without a database. */
export interface EthHistoryStore {
  coverage(accountId: string, instrumentId: string): Promise<{
    kind: string; coveredFromISO: string | null; coveredToISO: string | null; source: string;
  } | null>;
  /** Rows in [fromISO, toISO]: how many, and how many are not on the current version. */
  derivedStats(accountId: string, instrumentId: string, fromISO: string, toISO: string): Promise<{ count: number; notCurrentVersion: number }>;
  derivedRow(accountId: string, instrumentId: string, dateISO: string): Promise<StoredDerivedRow | null>;
  derivedRowsFrom(accountId: string, instrumentId: string, fromISO: string): Promise<StoredDerivedRow[]>;
  anchor(accountId: string, instrumentId: string): Promise<{ id: string; date: Date; origin: string; completeness: string | null } | null>;
  /** ONE transaction: delete these dates' rows, insert these rows, persist the coverage. */
  applySuffix(args: {
    accountId: string; instrumentId: string; deleteDatesISO: string[]; insert: EthDerivedRow[]; coverage: ChainCoverage;
  }): Promise<void>;
}

const DAY_MS = 86_400_000;
const shiftISO = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysInclusive = (fromISO: string, toISO: string) => Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / DAY_MS) + 1;
const toWholeEth = (wei: bigint) => baseUnitsToWhole(wei, ETH_NATIVE.decimals);

export async function runIncrementalEthHistory(args: {
  accountId: string;
  walletAddress: string;
  instrumentId: string;
  todayISO: string;
  store: EthHistoryStore;
  deps?: EthHistoryDeps;
  dryRun?: boolean;
}): Promise<EthIncrementalOutcome> {
  const { accountId, instrumentId, store } = args;
  const deps = args.deps ?? {};
  const fallback = (reason: EthIncrementalFallback, detail?: string): EthIncrementalOutcome => ({ kind: "FALLBACK", reason, detail });

  // ── Eligibility: only history this adapter proved, on this algorithm, without holes ──
  const cov = await store.coverage(accountId, instrumentId);
  if (!cov) return fallback("NO_COVERAGE");
  if (cov.kind !== "COMPLETE" || !cov.coveredFromISO || !cov.coveredToISO) return fallback("COVERAGE_INCOMPLETE");
  if (cov.source !== ETH_HISTORY_SOURCE) return fallback("COVERAGE_SOURCE", cov.source);
  const fromISO = cov.coveredFromISO;
  const boundaryISO = cov.coveredToISO;
  const checkpointISO = shiftISO(boundaryISO, -1);
  if (checkpointISO < fromISO) return fallback("NO_CHECKPOINT_ROW");
  if (boundaryISO > args.todayISO) return fallback("BOUNDARY_UNRESOLVED", `covered to ${boundaryISO}, after today ${args.todayISO}`);

  const stats = await store.derivedStats(accountId, instrumentId, fromISO, args.todayISO);
  if (stats.notCurrentVersion > 0) return fallback("VERSION_MISMATCH", `${stats.notCurrentVersion} row(s) not on version ${ETH_RECONSTRUCTION_VERSION}`);
  const before = await store.derivedStats(accountId, instrumentId, fromISO, checkpointISO);
  if (before.count !== daysInclusive(fromISO, checkpointISO)) {
    return fallback("HISTORY_GAP", `${before.count} of ${daysInclusive(fromISO, checkpointISO)} days stored before the boundary`);
  }
  const checkpoint = await store.derivedRow(accountId, instrumentId, checkpointISO);
  if (!checkpoint) return fallback("NO_CHECKPOINT_ROW");

  const anchorRow = await store.anchor(accountId, instrumentId);
  if (!anchorRow) {
    return { kind: "REFUSED", refusal: "NO_OBSERVED_ANCHOR",
      reason: "no OBSERVED position to anchor the replay against — sync the current balance first" };
  }

  // ── Resume block + checkpoint, against the chain ──────────────────────────
  let head: { number: number; timestampSec: bigint };
  let resumeBlock: number;
  let openingWei: bigint;
  try {
    head = await finalizedHead(deps);
    // The last second of the checkpoint day: the resume block's state is that day's closing state.
    const instantSec = Date.parse(`${boundaryISO}T00:00:00Z`) / 1000 - 1;
    if (instantSec >= Number(head.timestampSec)) return fallback("BOUNDARY_UNRESOLVED", "boundary is not yet finalized");
    resumeBlock = await blockAtOrBefore(instantSec, { lo: postMergeSearchFloor(head, instantSec), hi: head.number }, deps);
    if (resumeBlock < EARLIEST_PROVABLE_BLOCK) return fallback("BOUNDARY_UNRESOLVED", `resume block ${resumeBlock} precedes the provable floor`);
    openingWei = (await readAccountStateAt(args.walletAddress, resumeBlock, deps)).balance;
  } catch (e) {
    return { kind: "REFUSED", refusal: "COVERAGE_UNLICENSED",
      reason: `incremental boundary read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!sameQuantity(toWholeEth(openingWei), checkpoint.quantity)) {
    return fallback("CHECKPOINT_MISMATCH",
      `stored ${checkpoint.quantity} on ${checkpointISO} vs chain ${toWholeEth(openingWei)} at block ${resumeBlock}`);
  }

  // ── Acquire only the suffix, with the same proof ──────────────────────────
  let acquisition;
  try {
    acquisition = await acquireEthHistory({ ownerAddress: args.walletAddress, fromBlock: resumeBlock, toBlock: head.number }, deps);
  } catch (e) {
    return { kind: "REFUSED", refusal: "COVERAGE_UNLICENSED",
      reason: `incremental acquisition failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const { coverage: suffixCoverage, cursor, movements } = acquisition;
  if (suffixCoverage.kind !== "COMPLETE") {
    const premisesUnmet = suffixCoverage.kind === "UNKNOWN" && suffixCoverage.caveats.includes("PROOF_PREMISES_UNMET");
    return { kind: "REFUSED", refusal: premisesUnmet ? "PROOF_PREMISES_UNMET" : "COVERAGE_UNLICENSED",
      reason: premisesUnmet ? "this account is no longer a plain EOA, so no interval can be proven empty"
        : `incremental acquisition licensed no interval (${suffixCoverage.kind})` };
  }
  if (!cursor.reachedWindowStart || cursor.provenFromBlock !== resumeBlock) {
    return { kind: "REFUSED", refusal: "COVERAGE_UNLICENSED",
      reason: `incremental acquisition stopped at ${cursor.provenFromBlock} (${cursor.stoppedBecause ?? "?"}) before the resume block` };
  }
  const recon = reconcileMovementsAgainstOpening(movements, acquisition.openingBalanceWei, acquisition.anchorBalanceWei);
  if (!recon.reconciles || acquisition.openingBalanceWei !== openingWei) {
    return fallback("RECONCILIATION_MISMATCH", recon.reason);
  }
  const anchorWei = acquisition.anchorBalanceWei!;

  // ── The suffix's rows ─────────────────────────────────────────────────────
  let rows: EthDerivedRow[];
  let timeline: EthHistoryResult["timeline"];
  if (movements.length === 0) {
    // Provably nothing moved since the checkpoint day closed: every day from the
    // boundary to today holds the checkpoint's quantity, on the checkpoint's basis.
    rows = [];
    for (let d = boundaryISO; d <= args.todayISO; d = shiftISO(d, 1)) {
      rows.push({ dateISO: d, quantity: checkpoint.quantity, basis: checkpoint.completeness ?? "REPLAYED_BACKWARD" });
    }
  } else {
    const replayed = replayEthHistory({
      accountId, instrumentId,
      anchor: {
        observationId: anchorRow.id,
        dateISO: anchorRow.date.toISOString().slice(0, 10),
        effectiveDateTimeISO: anchorRow.date.toISOString(),
        quantity: toWholeEth(anchorWei),
        origin: anchorRow.origin,
        completeness: anchorRow.completeness ?? "observed",
      },
      movements, coverage: suffixCoverage,
      windowFromISO: boundaryISO, windowToISO: args.todayISO,
    });
    // Days before the first new movement CONTINUE the checkpoint's segment: the
    // quantity is the checkpoint's (proven by the reconciliation) and so is the
    // basis a full rebuild would give them. The replay, starting at the boundary,
    // can only label them back-solved.
    const firstMovementISO = movements.map((m) => m.dateISO).sort()[0];
    rows = replayed.rows.map((r) => (r.dateISO < firstMovementISO
      ? { ...r, basis: checkpoint.completeness ?? r.basis }
      : r));
    timeline = replayed.timeline;
  }

  // ── Write only what changed ───────────────────────────────────────────────
  const existing = await store.derivedRowsFrom(accountId, instrumentId, boundaryISO);
  const desired = new Map(rows.map((r) => [r.dateISO, r]));
  const deleteDatesISO: string[] = [];
  const keep = new Set<string>();
  let earliestChangedExisting: string | null = null;
  for (const e of existing) {
    const want = desired.get(e.dateISO);
    const same = want && sameQuantity(want.quantity, e.quantity) && want.basis === (e.completeness ?? "")
      && e.version === ETH_RECONSTRUCTION_VERSION;
    if (same) { keep.add(e.dateISO); continue; }
    deleteDatesISO.push(e.dateISO);
    if (!want || !sameQuantity(want.quantity, e.quantity)) {
      if (earliestChangedExisting === null || e.dateISO < earliestChangedExisting) earliestChangedExisting = e.dateISO;
    }
  }
  const insert = rows.filter((r) => !keep.has(r.dateISO));
  const earliestMovement = movements.length ? movements.map((m) => m.dateISO).sort()[0] : null;
  const impactedFromISO = [earliestChangedExisting, earliestMovement].filter((d): d is string => d !== null).sort()[0] ?? null;

  const coverage: ChainCoverage = { kind: "COMPLETE", fromISO, toISO: suffixCoverage.toISO, source: ETH_HISTORY_SOURCE };
  const coverageMoved = suffixCoverage.toISO !== boundaryISO;
  const rowsChanged = deleteDatesISO.length + insert.length;
  if (!args.dryRun && (rowsChanged > 0 || coverageMoved)) {
    await store.applySuffix({ accountId, instrumentId, deleteDatesISO, insert, coverage });
  }

  return {
    kind: "DONE",
    result: {
      accountId, ok: true, coverage, timeline, instrumentId,
      derivedRowsWritten: insert.length,
      reconciliation: { reconciles: true, residualWei: recon.residual.toString(), movementCount: recon.movementCount },
      mode: movements.length === 0 && earliestChangedExisting === null ? "NO_CHANGE" : "INCREMENTAL",
      impactedFromISO,
      coveredThroughISO: suffixCoverage.toISO,
      rowsChanged,
    },
  };
}

// ── The database binding ─────────────────────────────────────────────────────

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const isoOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function prismaEthHistoryStore(client: PrismaClient): EthHistoryStore {
  const base = (accountId: string, instrumentId: string) => ({
    financialAccountId: accountId, instrumentId,
    origin: PositionOrigin.DERIVED, source: ETH_RECONSTRUCTION_SOURCE, deletedAt: null,
  });
  const toRow = (r: { date: Date; quantity: number; completeness: string | null; reconstructionVersion: number | null }): StoredDerivedRow =>
    ({ dateISO: isoOf(r.date)!, quantity: r.quantity, completeness: r.completeness, version: r.reconstructionVersion });
  const select = { date: true, quantity: true, completeness: true, reconstructionVersion: true } as const;
  return {
    async coverage(accountId, instrumentId) {
      const c = await client.positionCoverage.findUnique({
        where: { financialAccountId_instrumentId: { financialAccountId: accountId, instrumentId } },
        select: { kind: true, coveredFromDate: true, coveredToDate: true, source: true },
      });
      return c ? { kind: c.kind, coveredFromISO: isoOf(c.coveredFromDate), coveredToISO: isoOf(c.coveredToDate), source: c.source } : null;
    },
    async derivedStats(accountId, instrumentId, fromISO, toISO) {
      const where = { ...base(accountId, instrumentId), date: { gte: day(fromISO), lte: day(toISO) } };
      const [count, notCurrentVersion] = await Promise.all([
        client.positionObservation.count({ where }),
        // Explicit null arm: `not: N` alone would silently drop unversioned rows.
        client.positionObservation.count({ where: { ...where, OR: [
          { reconstructionVersion: null }, { reconstructionVersion: { not: ETH_RECONSTRUCTION_VERSION } },
        ] } }),
      ]);
      return { count, notCurrentVersion };
    },
    async derivedRow(accountId, instrumentId, dateISO) {
      const r = await client.positionObservation.findFirst({ where: { ...base(accountId, instrumentId), date: day(dateISO) }, select });
      return r ? toRow(r) : null;
    },
    async derivedRowsFrom(accountId, instrumentId, fromISO) {
      const rows = await client.positionObservation.findMany({
        where: { ...base(accountId, instrumentId), date: { gte: day(fromISO) } }, select, orderBy: { date: "asc" },
      });
      return rows.map(toRow);
    },
    async anchor(accountId, instrumentId) {
      return client.positionObservation.findFirst({
        where: {
          financialAccountId: accountId, instrumentId, supersededById: null, deletedAt: null,
          origin: { in: [PositionOrigin.OBSERVED, PositionOrigin.IMPORTED, PositionOrigin.USER_ASSERTED] },
        },
        orderBy: { date: "desc" },
        select: { id: true, date: true, origin: true, completeness: true },
      });
    },
    async applySuffix({ accountId, instrumentId, deleteDatesISO, insert, coverage }) {
      await client.$transaction(async (tx) => {
        if (deleteDatesISO.length > 0) {
          await tx.positionObservation.deleteMany({ where: { ...base(accountId, instrumentId), date: { in: deleteDatesISO.map(day) } } });
        }
        if (insert.length > 0) {
          await tx.positionObservation.createMany({
            data: insert.map((r) => ({
              financialAccountId: accountId, instrumentId, date: day(r.dateISO), quantity: r.quantity,
              origin: PositionOrigin.DERIVED, source: ETH_RECONSTRUCTION_SOURCE, completeness: r.basis,
              isCash: false, reconstructionVersion: ETH_RECONSTRUCTION_VERSION,
            })),
            skipDuplicates: true,
          });
        }
        // Rows and the licence that lets them speak for a date, together.
        await persistPositionCoverage(tx, accountId, instrumentId, coverage);
      });
    },
  };
}
