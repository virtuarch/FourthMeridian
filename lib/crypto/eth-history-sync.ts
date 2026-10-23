/**
 * lib/crypto/eth-history-sync.ts
 *
 * ETH-H2 — the persistence half of Ethereum's reconstruction.
 *
 * ETH-H1 established the acquisition and stopped deliberately: writing a third
 * reconstruction with no production caller would have repeated the mistake W6f
 * had just finished correcting. W6f wired the other two into the sync lifecycle,
 * so this one is written to be called by that same path from the start.
 *
 * ── What ETH-H1 established, and why it is not re-litigated here ────────────
 * Ethereum has no address-history RPC, and on this tier every `trace_*` and
 * `debug_*` method is refused. The answer was to stop needing an index:
 *
 *     code(a) == "0x" ∧ nonce(a) == nonce(b) ∧ balance(a) == balance(b)
 *       ⟹ no balance change occurred anywhere in (a, b]
 *
 * An EOA cannot be debited by anyone but itself; every debit needs a transaction
 * it originated (nonce++), code executing in its context (it has none, and
 * installing a 7702 delegation increments the authority nonce), or a CREATE at
 * the address (nonce ≥ 1). Credits — inbound transfers, withdrawals, rewards,
 * SELFDESTRUCT proceeds — move the balance, so balance equality excludes them
 * too. This module consumes that proof; it does not restate it.
 *
 * ── Where it refuses ────────────────────────────────────────────────────────
 * The proof's premise is that the account is a plain EOA. A contract wallet
 * (Safe, ERC-4337) or an EOA carrying a live EIP-7702 delegation can be debited
 * without originating anything, so no interval can be proven empty and no amount
 * of arithmetic rescues it. Those refuse with `PROOF_PREMISES_UNMET` and write
 * nothing — never a partial history that looks complete.
 *
 * ── Wei stays wei ───────────────────────────────────────────────────────────
 * `PositionObservation.quantity` is a Float, and wei→ETH→wei does NOT round-trip
 * at 18 decimals. Bitcoin's `BigInt(Math.round(q * 10^decimals))` anchor pattern
 * is safe at 8 decimals across the whole supply and is deliberately NOT copied:
 * here it would manufacture a wei anchor differing from the chain's, and a missed
 * movement equal to that error would reconcile spuriously. The anchor is read
 * from the chain in wei, reconciliation is integer, and the only conversion is
 * the one that writes the canonical row.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { PositionOrigin } from "@prisma/client";
import { db } from "@/lib/db";
import { reconcileMovementsAgainstBalance, type ChainCoverage } from "./chain-movement";
import { persistPositionCoverage } from "./position-coverage";
import { ETH_NATIVE } from "./native-asset";
import {
  ETH_RECONSTRUCTION_SOURCE, ETH_RECONSTRUCTION_VERSION, earliestRowDifference, replayEthHistory,
  type EthHistoryMode,
} from "./eth-history-rows";
import {
  prismaEthHistoryStore, runIncrementalEthHistory, type EthIncrementalFallback,
} from "./eth-history-incremental";
import {
  acquireEthHistory, finalizedBlockNumber, EARLIEST_PROVABLE_BLOCK, type EthHistoryDeps,
} from "./eth-history";
import { resolveCryptoInstrumentId, ETH_ASSET } from "@/lib/investments/crypto-instrument";
import {
  PERMITTED_ANCHOR_ORIGINS, type QuantityAnchor, type QuantityTimeline,
} from "@/lib/investments/quantity-replay.core";

type Client = PrismaClient | Prisma.TransactionClient;

export { ETH_RECONSTRUCTION_SOURCE, ETH_RECONSTRUCTION_VERSION };
export type { EthHistoryMode, EthIncrementalFallback };

export type EthHistoryRefusal =
  /** Not an ETH wallet, or no address to read. */
  | "NOT_AN_ETH_WALLET"
  /** Contract account, or an EOA with a live 7702 delegation. The proof's
   *  premises do not hold, so no interval can be proven empty. */
  | "PROOF_PREMISES_UNMET"
  /** The acquisition licensed no interval — provider refused, throttled, or the
   *  probe budget ran out before the window closed. */
  | "COVERAGE_UNLICENSED"
  /** Movements do not sum to the observed balance. */
  | "LEDGER_DOES_NOT_RECONCILE"
  /** No OBSERVED position to anchor the replay's identity against. */
  | "NO_OBSERVED_ANCHOR";

export interface EthHistoryResult {
  accountId: string;
  ok: boolean;
  refusal?: EthHistoryRefusal;
  reason?: string;
  coverage?: ChainCoverage;
  timeline?: QuantityTimeline;
  derivedRowsWritten?: number;
  /** EXACT wei. A string so no consumer can accidentally float it. */
  reconciliation?: { reconciles: boolean; residualWei: string; movementCount: number };
  /** The instrument the rows were written against, for the price backfill. */
  instrumentId?: string;
  /** FULL rebuild, INCREMENTAL suffix, or NO_CHANGE (proven nothing moved). */
  mode?: EthHistoryMode;
  /** Why a FULL rebuild ran instead of the incremental path. */
  fallbackReason?: EthIncrementalFallback;
  /** The earliest date whose stored quantity this run changed (or a new movement's date). Null: no historical change. */
  impactedFromISO?: string | null;
  /** The last date the proven coverage reaches. */
  coveredThroughISO?: string;
  /** DERIVED rows deleted + inserted by this run. */
  rowsChanged?: number;
}

/**
 * Reconstruct an Ethereum wallet's historical native quantity.
 *
 * Never throws. Every refusal is coded and writes NOTHING — a wallet whose
 * history cannot be established keeps its current position and gains no history,
 * which is the honest outcome rather than a degraded one.
 */
export async function reconstructEthHistory(args: {
  accountId: string;
  /** Ignored for block selection — the chain's own numbering bounds the scan —
   *  but carried so the replay window matches the caller's request. */
  windowFromISO: string;
  windowToISO: string;
  client?: Client;
  deps?: EthHistoryDeps;
  dryRun?: boolean;
  /** Skip the incremental path: an explicit repair / full rebuild. */
  full?: boolean;
}): Promise<EthHistoryResult> {
  const client = args.client ?? db;
  const { accountId } = args;

  const account = await client.financialAccount.findUnique({
    where:  { id: accountId },
    select: { id: true, walletChain: true, walletAddress: true },
  });
  if (
    !account
    || account.walletChain?.trim().toUpperCase() !== ETH_NATIVE.chain
    || !account.walletAddress
  ) {
    return { accountId, ok: false, refusal: "NOT_AN_ETH_WALLET",
      reason: `not a syncable ${ETH_NATIVE.chain} wallet` };
  }

  // ── 0. INCREMENTAL, WHEN THE STORED HISTORY CAN BE VERIFIED ─────────────────
  //    eth-history-incremental.ts reuses proven rows only after checking them
  //    against the chain; any failed invariant hands back here for the full
  //    rebuild below, and a provider failure is a refusal that writes nothing.
  let fallbackReason: EthIncrementalFallback = "EXPLICIT_FULL";
  if (!args.full) {
    const incremental = await runIncrementalEthHistory({
      accountId, walletAddress: account.walletAddress, instrumentId: await resolveCryptoInstrumentId(ETH_ASSET),
      todayISO: args.windowToISO, store: prismaEthHistoryStore(db), deps: args.deps, dryRun: args.dryRun,
    });
    if (incremental.kind === "DONE") return incremental.result;
    if (incremental.kind === "REFUSED") {
      return { accountId, ok: false, refusal: incremental.refusal, reason: incremental.reason, mode: "INCREMENTAL" };
    }
    fallbackReason = incremental.reason;
    console.log(`[eth-history] full rebuild for ${accountId}: ${incremental.reason}${incremental.detail ? ` — ${incremental.detail}` : ""}`);
  }

  // ── 1. ACQUIRE. Every judgement about what the chain proves lives in
  //    `acquireEthHistory`: the EOA premise, the bisection, the block evidence
  //    and the coverage it licenses. Nothing is re-decided here.
  let acquisition;
  try {
    // The upper bound is the FINALIZED head, never `latest`: a reorg-able block
    // is not evidence, and the anchor the reconciliation closes against must not
    // be able to change underneath the coverage it licenses.
    const toBlock = await finalizedBlockNumber(args.deps);
    acquisition = await acquireEthHistory(
      { ownerAddress: account.walletAddress, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock },
      args.deps ?? {},
    );
  } catch (e) {
    return { accountId, ok: false, refusal: "COVERAGE_UNLICENSED",
      reason: `acquisition failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const { movements, coverage, anchorBalanceWei } = acquisition;

  // ── 2. THE PREMISE. `PROOF_PREMISES_UNMET` is the caveat the acquisition
  //    raises for a contract or delegated account: the provider answered
  //    correctly and the data was fine — this account is simply not the kind of
  //    thing the argument is about, and retrying will keep succeeding.
  if (coverage.kind !== "COMPLETE") {
    const premisesUnmet =
      coverage.kind === "UNKNOWN" && coverage.caveats.includes("PROOF_PREMISES_UNMET");
    return {
      accountId, ok: false,
      refusal: premisesUnmet ? "PROOF_PREMISES_UNMET" : "COVERAGE_UNLICENSED",
      reason: premisesUnmet
        ? "this account is not a plain EOA (contract wallet, or a live EIP-7702 "
          + "delegation), so no interval can be proven empty"
        : `acquisition licensed no interval (${coverage.kind})`,
      coverage,
    };
  }

  // ── 3. RECONCILE, IN EXACT WEI. The acquisition's own anchor balance, read
  //    from the chain — never a whole-unit figure scaled back up.
  if (anchorBalanceWei === null) {
    return { accountId, ok: false, refusal: "COVERAGE_UNLICENSED", coverage,
      reason: "no anchor balance was read, so there is nothing to reconcile against" };
  }
  const recon = reconcileMovementsAgainstBalance(movements, anchorBalanceWei);
  if (!recon.reconciles) {
    return {
      accountId, ok: false, refusal: "LEDGER_DOES_NOT_RECONCILE",
      reason: `movements do not explain the observed balance — residual ${recon.residual} wei`,
      coverage,
      reconciliation: { reconciles: false, residualWei: recon.residual.toString(), movementCount: recon.movementCount },
    };
  }

  // ── 4. IDENTITY + ANCHOR. The anchor's QUANTITY comes from the chain in wei;
  //    the OBSERVED row supplies only the identity and date the replay needs.
  const instrumentId = await resolveCryptoInstrumentId(ETH_ASSET);
  const anchorRow = await client.positionObservation.findFirst({
    where: {
      financialAccountId: accountId, instrumentId, supersededById: null, deletedAt: null,
      origin: { in: [...PERMITTED_ANCHOR_ORIGINS] as PositionOrigin[] },
    },
    orderBy: { date: "desc" },
    select:  { id: true, date: true, origin: true, completeness: true },
  });
  if (!anchorRow) {
    return { accountId, ok: false, refusal: "NO_OBSERVED_ANCHOR", coverage,
      reason: "no OBSERVED position to anchor the replay against — sync the current balance first" };
  }

  const anchors: QuantityAnchor[] = [{
    observationId:        anchorRow.id,
    dateISO:              anchorRow.date.toISOString().slice(0, 10),
    effectiveDateTimeISO: anchorRow.date.toISOString(),
    // THE ONE CONVERSION, at the canonical boundary and nowhere earlier.
    quantity:             weiToEthExact(anchorBalanceWei),
    origin:               anchorRow.origin,
    completeness:         anchorRow.completeness ?? "observed",
  }];

  // ── 5. REPLAY — THE engine, the one Bitcoin and Solana use, through the
  //    derivation the incremental path shares (eth-history-rows.ts).
  // ETH-H2 — THE LICENCE WIDENS THE WINDOW; THE CALLER'S FLOOR MUST NOT NARROW IT.
  //
  // Bitcoin and Solana are handed a window derived from evidence ALREADY in the
  // database — their movements are imported before any reconstruction runs — so
  // the caller's floor is naturally wide. Ethereum discovers its own range from
  // the chain during acquisition, and a wallet added today has exactly one row
  // in the database, so that floor collapses to a single day.
  //
  // Measured on the real wallet: the caller's window was 2026-08-27..2026-08-27
  // while the coverage licensed 2017-10-16..2026-08-27 — 3238 provable days
  // replayed as one. The replay window is therefore the UNION: the licence
  // decides how far back the evidence reaches, and the caller only says how far
  // forward it wants to go.
  const replayFromISO =
    coverage.fromISO < args.windowFromISO ? coverage.fromISO : args.windowFromISO;

  const { timeline, rows: derived } = replayEthHistory({
    accountId, instrumentId, anchor: anchors[0], movements, coverage,
    windowFromISO: replayFromISO, windowToISO: args.windowToISO,
  });

  // The IMPACT: the earliest date whose stored quantity this rebuild changes.
  // A version-bump rebuild over identical evidence changes nothing downstream.
  const existingRows = await client.positionObservation.findMany({
    where:  { financialAccountId: accountId, instrumentId, origin: PositionOrigin.DERIVED, source: ETH_RECONSTRUCTION_SOURCE },
    select: { date: true, quantity: true },
  });
  const impactedFromISO = earliestRowDifference(
    existingRows.map((r) => ({ dateISO: r.date.toISOString().slice(0, 10), quantity: r.quantity })), derived);
  if (!args.dryRun) {
    await db.$transaction(async (tx) => {
      await tx.positionObservation.deleteMany({
        where: {
          financialAccountId: accountId, instrumentId,
          origin: PositionOrigin.DERIVED, source: ETH_RECONSTRUCTION_SOURCE,
        },
      });
      if (derived.length > 0) {
        await tx.positionObservation.createMany({
          data: derived.map((r) => ({
            financialAccountId: accountId,
            instrumentId,
            date:     new Date(`${r.dateISO}T00:00:00.000Z`),
            quantity: r.quantity,
            origin:   PositionOrigin.DERIVED,
            source:   ETH_RECONSTRUCTION_SOURCE,
            completeness: r.basis,
            isCash:   false,
            reconstructionVersion: ETH_RECONSTRUCTION_VERSION,
          })),
          skipDuplicates: true,
        });
      }
      // Rows and the licence that lets them speak for a date, together.
      await persistPositionCoverage(tx, accountId, instrumentId, coverage);
    });
  }

  return {
    accountId, ok: true, coverage, timeline, instrumentId,
    derivedRowsWritten: derived.length,
    reconciliation: { reconciles: true, residualWei: recon.residual.toString(), movementCount: recon.movementCount },
    mode: "FULL", fallbackReason, impactedFromISO,
    coveredThroughISO: coverage.toISO,
    rowsChanged: existingRows.length + derived.length,
  };
}

/**
 * Wei → whole ETH for the canonical row.
 *
 * The ONLY conversion in this module, and it is one-way on purpose: nothing here
 * ever converts back. `Number(wei) / 1e18` loses precision above ~9e15 wei
 * (0.009 ETH), so the division is done on the exact integer split into whole and
 * fractional parts, which keeps every digit a float64 can represent and discards
 * only those it never could.
 */
export function weiToEthExact(wei: bigint): number {
  const unit = BigInt(10) ** BigInt(ETH_NATIVE.decimals);
  const whole = wei / unit;
  const frac  = wei - whole * unit;
  return Number(whole) + Number(frac) / Number(unit);
}
