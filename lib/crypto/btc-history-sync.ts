/**
 * lib/crypto/btc-history-sync.ts
 *
 * W6c — BITCOIN'S HISTORY, DERIVED RATHER THAN CARRIED.
 *
 * ── The debt this closes ────────────────────────────────────────────────────
 * Every other chain earns its historical quantity: movements are replayed
 * against a defensible anchor, an explicit coverage licence says which dates
 * that quantity may represent, and a dated close turns it into money. Bitcoin
 * did not. Its historical value came from `FinancialAccount.nativeBalance` — a
 * single sync-time figure — carried backward across any interval in which no
 * quantity-changing transaction happened to be found.
 *
 * That carry was licensed (V26-CRYPTO-QTY-1) and it was still the wrong shape:
 * absence of a recorded movement is only evidence of absence where something
 * guarantees a movement would have been recorded. The licence checked whether we
 * had seen a movement, not whether we would have.
 *
 * ── This is a BINDING, not an engine ────────────────────────────────────────
 * Nothing here reconstructs anything. The Bitcoin ledger already sits in
 * `Transaction` rows carrying native signed amounts, a stable
 * `externalTransactionId` and a settlement state, so this module's whole job is
 * to hand those rows to machinery that already exists:
 *
 *   Transaction (BTC, POSTED) → ChainMovement → NormalizedQuantityEvent
 *     → replayQuantityTimeline  (THE engine — same one Solana uses)
 *     → licenseCoverageByReconciliation  (THE licence upgrade)
 *     → PositionObservation(DERIVED) + PositionCoverage
 *
 * If Bitcoin ever needs a second reconstruction engine, the canonical one is
 * wrong rather than Bitcoin being special.
 *
 * ── What Bitcoin can and cannot prove ───────────────────────────────────────
 * An xpub wallet is scanned by DERIVING addresses until a gap limit is reached.
 * That is the same class of hazard as Solana's address-index gap: the scan can
 * only report transactions touching addresses it thought to ask about, and a
 * wallet that used an address beyond the gap would be silently short. So the
 * acquisition claims PARTIAL with `ADDRESS_INDEX_INCOMPLETE`, never COMPLETE
 * because pagination happened to reach an apparent beginning.
 *
 * The upgrade to COMPLETE is earned the same way Solana earns it and by the same
 * function: if the POSTED movements sum EXACTLY to an independently observed
 * balance, then no unseen movement can exist inside the scanned window without
 * breaking that arithmetic. Bounded scan plus closed residual is a proof; either
 * alone is not.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { PositionOrigin, SettlementState } from "@prisma/client";
import { db } from "@/lib/db";
import {
  reconcileMovementsAgainstBalance, licenseCoverageByReconciliation, toEventStreamCompleteness,
  movementsToQuantityEvents,
  type ChainMovement, type ChainCoverage,
} from "./chain-movement";
import { persistPositionCoverage } from "./position-coverage";
import { derivedRowsFromTimeline } from "./wallet-reconstruction";
import { BTC_NATIVE } from "./native-asset";
import {
  replayQuantityTimeline, PERMITTED_ANCHOR_ORIGINS,
  type QuantityAnchor, type QuantityTimeline,
} from "@/lib/investments/quantity-replay.core";

type Client = PrismaClient | Prisma.TransactionClient;

/** Source string stamped on every row this reconstruction owns. */
export const BTC_RECONSTRUCTION_SOURCE = "btc-reconstruction";

/** Satoshis per whole bitcoin — the asset's own base unit, never a magic number. */
const SATS_PER_BTC = BigInt(10) ** BigInt(BTC_NATIVE.decimals);

export type BtcHistoryRefusal =
  /** No POSTED native movements at all — nothing to replay. */
  | "NO_MOVEMENT_LEDGER"
  /** No OBSERVED position to anchor against. */
  | "NO_OBSERVED_ANCHOR"
  /**
   * The wallet holds UNCONFIRMED movements while its current balance comes from
   * a provider whose confirmed/unconfirmed basis is undocumented. The two cannot
   * be reconciled without assuming the basis, and assuming it is exactly the
   * step that would make the anchor indefensible. See the xpub note below.
   */
  | "BALANCE_BASIS_AMBIGUOUS"
  /** Movements do not sum to the observed balance. */
  | "LEDGER_DOES_NOT_RECONCILE";

export interface BtcHistoryResult {
  accountId: string;
  ok: boolean;
  refusal?: BtcHistoryRefusal;
  reason?: string;
  coverage?: ChainCoverage;
  timeline?: QuantityTimeline;
  derivedRowsWritten?: number;
  reconciliation?: { reconciles: boolean; residualSats: string; movementCount: number };
}

/** One persisted BTC ledger row, as this binding needs it. */
export interface BtcLedgerRow {
  externalTransactionId: string | null;
  date:     Date;
  amount:   number;
  settlementState: SettlementState | null;
}

/**
 * Whole BTC → satoshis, exactly.
 *
 * `Transaction.amount` is a Float, so it carries a rounding error the chain
 * never had. Rounding to the nearest satoshi is the honest reading of a value
 * that was a satoshi count before it was stored, and it is what lets the
 * reconciliation below be an exact integer comparison rather than a tolerance.
 */
export function btcToSats(amountBtc: number): bigint {
  return BigInt(Math.round(amountBtc * Number(SATS_PER_BTC)));
}

/**
 * Persisted ledger rows → canonical chain movements.
 *
 * Deliberately NOT a re-acquisition: these rows were written by the BTC sync
 * from provider data and carry its identity. Re-deriving them here would create
 * a second acquisition path that could disagree with the one that owns them.
 */
export function ledgerToChainMovements(
  rows: readonly BtcLedgerRow[],
  ownedAddress: string,
): ChainMovement[] {
  return rows.map((r, i) => {
    const dateISO = r.date.toISOString().slice(0, 10);
    return {
      networkId:      "bip122:000000000019d6689c085ae165831e93",
      // The provider's transaction identity, so a movement keeps the same key
      // across re-runs. An unidentified row falls back to its index, which is
      // stable within a run and is only reachable for legacy rows.
      eventId:        r.externalTransactionId ?? `ledger-row:${dateISO}:${i}`,
      movementKey:    "principal",
      assetKey:       BTC_NATIVE.assetKey,
      ownedAddress,
      baseUnitsDelta: btcToSats(r.amount),
      // A wallet ledger row IS a value transfer in or out of the owned account.
      role:           "TRANSFER" as const,
      occurredAtISO:  r.date.toISOString(),
      dateISO,
      timeBasis:      "BLOCK_TIME" as const,
      failed:         false,
      counterparties: [],
      sequence:       i,
      source:         "btc-ledger",
    };
  });
}

/**
 * Reconstruct a Bitcoin wallet's historical native quantity.
 *
 * Never throws: every refusal is coded and writes NOTHING. A wallet whose
 * history cannot be established keeps its current observation and gains no
 * history — which is the honest outcome, not a degraded one.
 */
export async function reconstructBtcHistory(args: {
  accountId: string;
  windowFromISO: string;
  windowToISO: string;
  client?: Client;
  dryRun?: boolean;
}): Promise<BtcHistoryResult> {
  const client = args.client ?? db;
  const { accountId } = args;

  const account = await client.financialAccount.findUnique({
    where:  { id: accountId },
    select: { id: true, walletChain: true, walletAddress: true },
  });
  if (!account || account.walletChain?.trim().toUpperCase() !== BTC_NATIVE.chain) {
    return { accountId, ok: false, refusal: "NO_MOVEMENT_LEDGER",
      reason: `not a syncable ${BTC_NATIVE.chain} wallet` };
  }

  // ── 1. THE LEDGER. Native-denominated rows only: a wallet whose Transaction
  //    rows are fiat-denominated (a seeded brokerage-shaped row, say) has no
  //    quantity ledger at all, and must not be mistaken for one that does.
  const rows = await client.transaction.findMany({
    where:  { financialAccountId: accountId, deletedAt: null, currency: BTC_NATIVE.symbol },
    select: { externalTransactionId: true, date: true, amount: true, settlementState: true },
    orderBy: { date: "asc" },
  });
  const posted = rows.filter((r) => r.settlementState === SettlementState.POSTED);
  if (posted.length === 0) {
    return { accountId, ok: false, refusal: "NO_MOVEMENT_LEDGER",
      reason: "no POSTED native movements — nothing to replay" };
  }

  // ── 2. THE XPUB BALANCE-BASIS QUESTION, ANSWERED RATHER THAN ASSUMED.
  //
  //    A single-address balance is computed from confirmed outputs; an xpub
  //    balance is the provider's `final_balance`, whose confirmed/unconfirmed
  //    basis is undocumented. Anchoring on a figure whose basis is unknown is
  //    exactly the move this slice exists to stop.
  //
  //    It is answered, not lowered: reconciliation below compares POSTED
  //    movements against the observed balance in EXACT satoshis. If they agree,
  //    the confirmed movements alone account for the whole balance, so whatever
  //    the provider's basis is it contained nothing else — the quantity is
  //    established by arithmetic and the anchor is corroborated rather than
  //    trusted. If UNCONFIRMED movements exist, that argument is unavailable:
  //    the sums could agree because both include the same unconfirmed value, and
  //    we refuse rather than guess which.
  const unconfirmed = rows.length - posted.length;
  if (unconfirmed > 0) {
    return { accountId, ok: false, refusal: "BALANCE_BASIS_AMBIGUOUS",
      reason: `${unconfirmed} unconfirmed movement(s) present and the wallet's `
        + "balance basis is not attested — the reconciliation that would license "
        + "this anchor cannot distinguish a confirmed match from an unconfirmed one" };
  }

  // ── 3. THE ANCHOR — an OBSERVED position, never the legacy column.
  const anchorRow = await client.positionObservation.findFirst({
    where:  {
      financialAccountId: accountId, supersededById: null, deletedAt: null,
      origin: { in: [...PERMITTED_ANCHOR_ORIGINS] as PositionOrigin[] },
    },
    orderBy: { date: "desc" },
    select:  { id: true, date: true, quantity: true, origin: true, instrumentId: true, completeness: true },
  });
  if (!anchorRow) {
    return { accountId, ok: false, refusal: "NO_OBSERVED_ANCHOR",
      reason: "no OBSERVED position to anchor the replay against" };
  }
  const instrumentId = anchorRow.instrumentId;
  const anchorDateISO = anchorRow.date.toISOString().slice(0, 10);

  // ── 4. RECONCILE, IN EXACT SATOSHIS. Integers in, integers out, no tolerance.
  const movements = ledgerToChainMovements(posted, account.walletAddress ?? "");
  const recon = reconcileMovementsAgainstBalance(movements, btcToSats(anchorRow.quantity));
  if (!recon.reconciles) {
    return { accountId, ok: false, refusal: "LEDGER_DOES_NOT_RECONCILE",
      reason: `movements do not explain the observed balance — residual ${recon.residual} sat`,
      reconciliation: { reconciles: false, residualSats: recon.residual.toString(), movementCount: recon.movementCount } };
  }

  // ── 5. COVERAGE. What the scan can actually claim, then what the arithmetic
  //    upgrades it to. An xpub scan bounded by a gap limit is PARTIAL with the
  //    address-index caveat; a closed residual licenses the scanned window the
  //    same way it does for Solana, through the SAME function.
  const earliestISO = movements[0].dateISO;
  const scanned: ChainCoverage = {
    kind: "PARTIAL",
    coveredFromISO: earliestISO,
    coveredToISO:   movements[movements.length - 1].dateISO,
    caveats: ["ADDRESS_INDEX_INCOMPLETE"],
    source:  "btc-ledger",
  };
  const licensed = licenseCoverageByReconciliation(scanned, recon, anchorDateISO);

  // ── 6. REPLAY — THE engine, unchanged.
  const events = movementsToQuantityEvents(movements, {
    accountId, instrumentId, decimals: BTC_NATIVE.decimals,
  });
  const anchors: QuantityAnchor[] = [{
    observationId:        anchorRow.id,
    dateISO:              anchorDateISO,
    effectiveDateTimeISO: anchorRow.date.toISOString(),
    quantity:             anchorRow.quantity,
    origin:               anchorRow.origin,
    completeness:         anchorRow.completeness ?? "observed",
  }];
  const timeline = replayQuantityTimeline({
    instrumentId, accountId, anchors, events,
    windowFromISO: args.windowFromISO,
    windowToISO:   args.windowToISO,
    eventStream:   toEventStreamCompleteness(licensed),
    tolerance:     1 / Number(SATS_PER_BTC),
  });

  // ── 7. PERSIST result + licence, together. Only ABSOLUTE segments state a
  //    quantity; uncovered time writes nothing, which is what keeps the period
  //    before the first defensible anchor ABSENT rather than zero.
  const derived = derivedRowsFromTimeline(timeline);
  if (!args.dryRun) {
    await db.$transaction(async (tx) => {
      await tx.positionObservation.deleteMany({
        where: {
          financialAccountId: accountId, instrumentId,
          origin: PositionOrigin.DERIVED, source: BTC_RECONSTRUCTION_SOURCE,
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
            source:   BTC_RECONSTRUCTION_SOURCE,
            completeness: r.basis,
            isCash:   false,
          })),
          skipDuplicates: true,
        });
      }
      await persistPositionCoverage(tx, accountId, instrumentId, licensed);
    });
  }

  return {
    accountId, ok: true, coverage: licensed, timeline,
    derivedRowsWritten: derived.length,
    reconciliation: { reconciles: true, residualSats: recon.residual.toString(), movementCount: recon.movementCount },
  };
}
