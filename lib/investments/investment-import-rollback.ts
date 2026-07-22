/**
 * lib/investments/investment-import-rollback.ts
 *
 * A7-5 — the investment half of batch rollback, finally keeping the A3 schema
 * comment's promise ("rollback soft-deletes them"). Runs inside the rollback
 * route's already-claimed transaction for INVESTMENT_HISTORY batches only; the
 * banking (TRANSACTIONS) path never calls it, so banking rollback stays
 * byte-identical.
 *
 * Inside the transaction it:
 *   1. soft-deletes the batch's live InvestmentEvent rows;
 *   2. soft-deletes the batch's live PositionObservation rows;
 *   3. un-supersedes: any LIVE row whose supersededById points at a row in this
 *      batch has that pointer cleared — the USER_ASSERTED opening the import had
 *      outranked honestly returns (its evidence class was never erased);
 *   4. reports per-table counts + the affected instruments for bounded repair.
 *
 * Residuals re-widen with zero reconstruction-core changes: gatherReconstruction-
 * Inputs already filters deletedAt/supersededById, so repairing the affected
 * (account, instruments) after the transaction recomputes without this batch's
 * evidence. Repair is the caller's responsibility (non-fatal, post-transaction).
 */

import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export interface InvestmentRollbackResult {
  eventsDeleted:            number;
  observationsDeleted:      number;
  pointersCleared:          number;
  affectedInstrumentIds:    string[];
  affectedCash:             boolean;
}

export async function rollbackInvestmentBatchRows(tx: Tx, batchId: string, now: Date): Promise<InvestmentRollbackResult> {
  // The batch's rows (live or already-deleted) — for instrument scope + the
  // un-supersede pointer set. Reading before the soft-delete keeps ids stable.
  const events = await tx.investmentEvent.findMany({ where: { importBatchId: batchId }, select: { id: true, instrumentId: true } });
  const observations = await tx.positionObservation.findMany({ where: { importBatchId: batchId }, select: { id: true, instrumentId: true } });

  const eventsDeleted = (await tx.investmentEvent.updateMany({ where: { importBatchId: batchId, deletedAt: null }, data: { deletedAt: now } })).count;
  const observationsDeleted = (await tx.positionObservation.updateMany({ where: { importBatchId: batchId, deletedAt: null }, data: { deletedAt: now } })).count;

  const batchRowIds = [...events.map((e) => e.id), ...observations.map((o) => o.id)];
  let pointersCleared = 0;
  if (batchRowIds.length > 0) {
    pointersCleared += (await tx.investmentEvent.updateMany({ where: { supersededById: { in: batchRowIds }, deletedAt: null }, data: { supersededById: null } })).count;
    pointersCleared += (await tx.positionObservation.updateMany({ where: { supersededById: { in: batchRowIds }, deletedAt: null }, data: { supersededById: null } })).count;
  }

  const affectedInstrumentIds = [...new Set([...events, ...observations].map((r) => r.instrumentId).filter((id): id is string => !!id))];
  const affectedCash = events.some((e) => e.instrumentId == null);

  return { eventsDeleted, observationsDeleted, pointersCleared, affectedInstrumentIds, affectedCash };
}
