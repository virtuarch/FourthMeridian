/**
 * lib/investments/opening-position.ts
 *
 * A7-2 — manual opening-position assertion (the plan's Track C1). Lets a user
 * state "I held Q units of instrument X on date D, (optionally) with aggregate
 * cost basis B" and records it as the canonical composite evidence pair
 * (investigation §6.1), atomically:
 *
 *   1. InvestmentEvent { type: OPENING_BALANCE, date: D, quantity: +Q,
 *        source: "user", createdByUserId } — the row the reconstruction walk
 *        consumes. OPENING_BALANCE routes as a signed quantity event, so the
 *        backward walk subtracts Q at D and the unexplained opening shrinks by Q
 *        (no reconstruction-core change — §6.1). Provider/raw fields stay null;
 *        importedRaw stays null (this is NOT a file import).
 *   2. PositionObservation { origin: USER_ASSERTED, source: "user", date: D,
 *        quantity: Q, costBasis: B? } — the read-path anchor `resolvePositionAsOf`
 *        answers "what did I hold on D" from directly (tier observed, attributed),
 *        independent of whether reconstruction has run. importBatchId / deletedAt
 *        null (A7-1 columns; a manual assertion has no batch).
 *
 * Re-assertion is append + supersede, never edit-in-place, for the event log
 * (the reconstruction substrate): the new OPENING_BALANCE event is created and
 * every prior LIVE user OPENING_BALANCE event for the (account, instrument) has
 * its supersededById pointed at it. The observation obeys its own unique key
 * [account, instrument, date, origin, source] — same-date re-assertion upserts
 * (the "user's latest statement wins" rule, §6.2), and any prior live user
 * anchor at a DIFFERENT date is superseded by the new one. Net invariant: exactly
 * one live user OPENING_BALANCE event and one live USER_ASSERTED observation per
 * (account, instrument).
 *
 * Kill switch: INVESTMENT_IMPORTS_ENABLED absent ⇒ status "disabled", zero
 * writes. After the write, bounded reconstruction repair fires for the affected
 * (account, [instrument]); repair failure is non-fatal (the ingest hook posture).
 */

import { InvestmentEventType, PositionOrigin, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { recordSyncIssue } from "@/lib/plaid/syncIssues";
import { repairReconstructionForAccount } from "@/lib/investments/reconstruction-runner";
import { resolveInstrumentForImport, type ImportInstrumentIdentity } from "@/lib/investments/instrument-resolver-import";

/** The canonical source string for manual (non-file) evidence. */
export const USER_SOURCE = "user";

/** Feature flag for the whole A7 import surface (routes + writers). */
export function investmentImportsEnabled(): boolean {
  return process.env.INVESTMENT_IMPORTS_ENABLED === "true";
}

export type AssertOpeningStatus = "ok" | "disabled" | "conflict";

export interface AssertOpeningPositionParams {
  financialAccountId: string;
  /** An existing instrument id (preferred) or an identity to resolve/create. */
  instrument: { instrumentId: string } | ImportInstrumentIdentity;
  /** YYYY-MM-DD as-of date the position was held. */
  date:     string;
  quantity: number;
  costBasis?: number | null;
  userId:   string;
  now?:     Date;
  /** Top-level client (needs $transaction); defaults to db. */
  client?:  PrismaClient;
}

export interface AssertOpeningPositionResult {
  status: AssertOpeningStatus;
  instrumentId?:            string;
  instrumentCreated?:       boolean;
  eventId?:                 string;
  observationId?:           string;
  supersededEventIds?:      string[];
  supersededObservationIds?: string[];
  repair?: { status: string; repairedInstrumentIds: string[] };
}

function toDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/**
 * Assert (or re-assert) a manual opening position. Deterministic given its
 * inputs and clock. Returns "conflict" (no writes) when the instrument identity
 * is ambiguous — the caller must resolve it (pick an existing instrument).
 */
export async function assertOpeningPosition(params: AssertOpeningPositionParams): Promise<AssertOpeningPositionResult> {
  if (!investmentImportsEnabled()) return { status: "disabled" };

  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const date = toDate(params.date);
  const { financialAccountId, quantity, userId } = params;
  const costBasis = params.costBasis ?? null;

  // ── Resolve the instrument (prefer an explicit id; else identity) ──────────
  let instrumentId: string;
  let instrumentCreated = false;
  if ("instrumentId" in params.instrument) {
    instrumentId = params.instrument.instrumentId;
  } else {
    const resolved = await resolveInstrumentForImport(params.instrument, { client, financialAccountId });
    if (resolved.conflict) return { status: "conflict" };
    instrumentId = resolved.instrumentId;
    instrumentCreated = resolved.created;
  }

  // ── Atomic composite write + supersession ──────────────────────────────────
  const written = await client.$transaction(async (tx: Prisma.TransactionClient) => {
    const event = await tx.investmentEvent.create({
      data: {
        financialAccountId, instrumentId,
        type: InvestmentEventType.OPENING_BALANCE,
        date, quantity,
        source: USER_SOURCE,
        createdByUserId: userId,
        // provider/raw fields, ratio, relatedInstrumentId, importBatchId,
        // importedRaw all null — a manual assertion, not a file import.
      },
      select: { id: true },
    });

    const priorEvents = await tx.investmentEvent.findMany({
      where: {
        financialAccountId, instrumentId,
        type: InvestmentEventType.OPENING_BALANCE, source: USER_SOURCE,
        deletedAt: null, supersededById: null, id: { not: event.id },
      },
      select: { id: true },
    });
    if (priorEvents.length > 0) {
      await tx.investmentEvent.updateMany({
        where: { id: { in: priorEvents.map((e) => e.id) } },
        data:  { supersededById: event.id },
      });
    }

    const observation = await tx.positionObservation.upsert({
      where: {
        financialAccountId_instrumentId_date_origin_source: {
          financialAccountId, instrumentId, date,
          origin: PositionOrigin.USER_ASSERTED, source: USER_SOURCE,
        },
      },
      create: {
        financialAccountId, instrumentId, date,
        origin: PositionOrigin.USER_ASSERTED, source: USER_SOURCE,
        quantity, costBasis,
      },
      // Same-date re-assertion: latest user statement wins; keep it live.
      update: { quantity, costBasis, supersededById: null, deletedAt: null },
      select: { id: true },
    });

    const priorObs = await tx.positionObservation.findMany({
      where: {
        financialAccountId, instrumentId,
        origin: PositionOrigin.USER_ASSERTED, source: USER_SOURCE,
        deletedAt: null, supersededById: null, id: { not: observation.id },
      },
      select: { id: true },
    });
    if (priorObs.length > 0) {
      await tx.positionObservation.updateMany({
        where: { id: { in: priorObs.map((o) => o.id) } },
        data:  { supersededById: observation.id },
      });
    }

    return {
      eventId: event.id,
      observationId: observation.id,
      supersededEventIds: priorEvents.map((e) => e.id),
      supersededObservationIds: priorObs.map((o) => o.id),
    };
  });

  // ── Bounded reconstruction repair (non-fatal) ──────────────────────────────
  let repair: AssertOpeningPositionResult["repair"];
  try {
    const m = await repairReconstructionForAccount({
      financialAccountId, affectedInstrumentIds: [instrumentId], affectedCash: false, now, client,
    });
    repair = { status: m.status, repairedInstrumentIds: m.repairedInstrumentIds };
  } catch (err) {
    console.warn(`[opening-position] reconstruction repair for account ${financialAccountId} failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    await recordSyncIssue({ kind: "UPSERT_ERROR", financialAccountId, detail: { stage: "opening-position-repair", error: err instanceof Error ? err.message : String(err) } });
  }

  return { status: "ok", instrumentId, instrumentCreated, ...written, repair };
}
