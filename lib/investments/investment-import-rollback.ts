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
 *
 * ── RLS-C-S8 — EVERY COUNT THIS RETURNS IS NOW A MEASURED CLAIM ──────────────
 * All four writes here are `updateMany`, and all four counts are reported to the
 * USER: "rolled back N events", "cleared N supersession pointers". Under a tenant
 * role an UPDATE refused by a USING policy returns `{ count: 0 }` with no error
 * and no log, so a refused rollback used to render as a SUCCESSFUL one that
 * rolled nothing back — and a partial as an unqualified success, because 3-of-7
 * is a plausible number nobody compared to anything.
 *
 * `resolveConditionalWrite` (lib/db/conditional-write.ts) cannot express this and
 * must not be bent to: it asks "can I still see THE row", singular, keyed by a
 * primary key, and a statement keyed by `importBatchId` has no single row to
 * probe. A batch's honest question is different, and cheaper — DID I WRITE EVERY
 * ROW I HAD ALREADY SEEN AS ELIGIBLE, under this same authority, in this same
 * phase? That is the escape clause of the S6a rule used DELIBERATELY rather than
 * relied on by accident: a zero is determinate exactly when visibility was
 * established in the same phase.
 *
 * Two of the three observations are FREE. The pre-read of the batch's rows
 * already happened (steps 3 and 4 need the ids), so it only had to start
 * selecting `deletedAt` — which is also the thing that makes the comparison
 * correct rather than merely loud. The eligible set is the LIVE rows, not all of
 * them: a second rollback of an already-rolled-back batch legitimately writes
 * zero, and comparing against the whole batch would turn idempotence into an
 * incident. The two un-supersede observations cost one indexed `count` each, on
 * the rarest and most destructive path in the import feature.
 *
 * ⚠️ THE ORDER OF THE UN-SUPERSEDE COUNT IS LOAD-BEARING. It is taken AFTER the
 * soft-deletes, immediately before its own statement, with the identical `where`.
 * A batch row may itself be superseded by another batch row; counted before the
 * soft-delete it is eligible, counted after it is not — so an observation taken
 * at the wrong moment manufactures a shortfall that never happened.
 */

import type { Prisma } from "@prisma/client";

import { assertEveryObservedRowWasWritten } from "@/lib/db/conditional-write";

type Tx = Prisma.TransactionClient;

/** Named so the shortfall site is identifiable in a log without carrying any row contents. */
const BATCH_SCOPE = "one import batch's live rows";

export interface InvestmentRollbackResult {
  eventsDeleted:            number;
  observationsDeleted:      number;
  pointersCleared:          number;
  affectedInstrumentIds:    string[];
  affectedCash:             boolean;
}

export async function rollbackInvestmentBatchRows(tx: Tx, batchId: string, now: Date): Promise<InvestmentRollbackResult> {
  // The batch's rows (live or already-deleted) — for instrument scope, the
  // un-supersede pointer set, AND the eligible-row observation the counts below
  // are asserted against. Reading before the soft-delete keeps ids stable.
  const events = await tx.investmentEvent.findMany({ where: { importBatchId: batchId }, select: { id: true, instrumentId: true, deletedAt: true } });
  const observations = await tx.positionObservation.findMany({ where: { importBatchId: batchId }, select: { id: true, instrumentId: true, deletedAt: true } });

  const liveEvents = events.filter((e) => e.deletedAt == null).length;
  const liveObservations = observations.filter((o) => o.deletedAt == null).length;

  const eventsDeleted = (await tx.investmentEvent.updateMany({ where: { importBatchId: batchId, deletedAt: null }, data: { deletedAt: now } })).count;
  assertEveryObservedRowWasWritten({ table: "InvestmentEvent", operation: "update", scope: BATCH_SCOPE }, liveEvents, eventsDeleted);

  const observationsDeleted = (await tx.positionObservation.updateMany({ where: { importBatchId: batchId, deletedAt: null }, data: { deletedAt: now } })).count;
  assertEveryObservedRowWasWritten({ table: "PositionObservation", operation: "update", scope: BATCH_SCOPE }, liveObservations, observationsDeleted);

  const batchRowIds = [...events.map((e) => e.id), ...observations.map((o) => o.id)];
  let pointersCleared = 0;
  if (batchRowIds.length > 0) {
    // See the header: observe, then write, with the identical `where`, in that
    // order. The observation IS the guard — an edit that deletes it because "the
    // updateMany's where clause already says that" removes the only thing that
    // can tell a complete un-supersession from a partial one.
    const eventPointerWhere = { supersededById: { in: batchRowIds }, deletedAt: null };
    const eventPointers = await tx.investmentEvent.count({ where: eventPointerWhere });
    const eventPointersCleared = (await tx.investmentEvent.updateMany({ where: eventPointerWhere, data: { supersededById: null } })).count;
    assertEveryObservedRowWasWritten({ table: "InvestmentEvent", operation: "update", scope: "the rows this batch had superseded" }, eventPointers, eventPointersCleared);

    const obsPointerWhere = { supersededById: { in: batchRowIds }, deletedAt: null };
    const obsPointers = await tx.positionObservation.count({ where: obsPointerWhere });
    const obsPointersCleared = (await tx.positionObservation.updateMany({ where: obsPointerWhere, data: { supersededById: null } })).count;
    assertEveryObservedRowWasWritten({ table: "PositionObservation", operation: "update", scope: "the rows this batch had superseded" }, obsPointers, obsPointersCleared);

    pointersCleared = eventPointersCleared + obsPointersCleared;
  }

  const affectedInstrumentIds = [...new Set([...events, ...observations].map((r) => r.instrumentId).filter((id): id is string => !!id))];
  const affectedCash = events.some((e) => e.instrumentId == null);

  return { eventsDeleted, observationsDeleted, pointersCleared, affectedInstrumentIds, affectedCash };
}
