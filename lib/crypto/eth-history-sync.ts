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
import {
  reconcileMovementsAgainstBalance, toEventStreamCompleteness, movementsToQuantityEvents,
  type ChainCoverage,
} from "./chain-movement";
import { persistPositionCoverage } from "./position-coverage";
import { derivedRowsFromTimeline } from "./wallet-reconstruction";
import { ETH_NATIVE } from "./native-asset";
import {
  acquireEthHistory, finalizedBlockNumber, EARLIEST_PROVABLE_BLOCK, type EthHistoryDeps,
} from "./eth-history";
import { resolveCryptoInstrumentId, ETH_ASSET } from "@/lib/investments/crypto-instrument";
import {
  replayQuantityTimeline, PERMITTED_ANCHOR_ORIGINS,
  type QuantityAnchor, type QuantityTimeline,
} from "@/lib/investments/quantity-replay.core";

type Client = PrismaClient | Prisma.TransactionClient;

/** Source stamped on every row this reconstruction owns. */
export const ETH_RECONSTRUCTION_SOURCE = "eth-reconstruction";

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

  // ── 5. REPLAY — THE engine, the one Bitcoin and Solana use.
  const events = movementsToQuantityEvents(movements, {
    accountId, instrumentId, decimals: ETH_NATIVE.decimals,
  });
  const timeline = replayQuantityTimeline({
    instrumentId, accountId, anchors, events,
    windowFromISO: args.windowFromISO,
    windowToISO:   args.windowToISO,
    eventStream:   toEventStreamCompleteness(coverage),
    // One wei is below float resolution at this magnitude, so the tolerance is
    // the smallest value that is meaningful rather than the smallest unit.
    // Reconciliation above is where exactness is enforced; this only guards the
    // replay's own arithmetic.
    tolerance:     1e-12,
  });

  const derived = derivedRowsFromTimeline(timeline);
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
