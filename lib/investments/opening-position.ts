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

import { InvestmentEventType, PositionOrigin, type Prisma } from "@prisma/client";
import type { SyncIssueInput } from "@/lib/plaid/syncIssues";
import { assertEveryObservedRowWasWritten } from "@/lib/db/conditional-write";
import { repairReconstructionForAccount } from "@/lib/investments/reconstruction-runner";
import { resolveInstrumentForImport, type ImportInstrumentIdentity } from "@/lib/investments/instrument-resolver-import";

// ── RLS-PREP-2 — THE TWO AUTHORITIES OF AN INVESTMENT IMPORT ─────────────────
//
// The A7 writers (this one and investment-import-commit.ts) ran as the
// migration principal for one reason: they wrote operator telemetry through the
// same client as the money, and `SyncIssue` is revoked from fm_app. The answer
// is NOT to grant the tenant role that table, and NOT to run the money as
// fm_system. It is that the writer holds no database client at all:
//
//   tenant        every financial statement — batch, events, observations,
//                 supersession, reconstruction repair, and the instrument
//                 identity work (global reference data fm_app may already
//                 mint) — runs inside phases the CALLER opens as the tenant
//                 role. RLS decides what each one may touch.
//   recordIssue   a function that accepts ONE typed incident and returns
//                 nothing. In production it is `recordSyncIssue` on its
//                 fm_system default. It is not a client: there is no statement
//                 a writer could issue through it, so the system authority
//                 cannot become a way to perform the mutation outside RLS.
//
// ORDER IS THE BOUNDARY. `recordIssue` is only ever called after a tenant phase
// has ALREADY proved the account is visible to the caller under RLS (here an
// explicit read; in the commit writer the ImportBatch INSERT's WITH CHECK), and
// only after the phase it reports on has ended — committed or rolled back. A
// telemetry failure therefore cannot abort a financial transaction
// (OPS-2D-TX-1), and an unauthorized caller cannot reach telemetry.
//
// WHAT WAS NOT LOST. Telemetry was never atomic with the mutation: the old
// writer ran on an autocommit root client and recorded incidents as separate
// statements. Both incident kinds also describe something that wrote nothing —
// a refused identity, or a repair that rolled back — so there is no financial
// row for them to be atomic WITH.
export type InvestmentTenantPhase = <T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts?: { timeout?: number },
) => Promise<T>;
export type InvestmentIssueRecorder = (issue: SyncIssueInput) => Promise<void>;

/**
 * Reconstruction repair walks an account's whole event log in one phase;
 * Prisma's 5 s interactive default is sized for a single statement group.
 */
export const REPAIR_PHASE_TIMEOUT_MS = 30_000;

/**
 * The caller's tenant phase could not see the account it was asked to write to.
 * Routes authorize before calling, so this is a programming error or a race
 * with a revocation — never a normal outcome, and never a reason to continue.
 */
export class InvestmentAccountNotVisibleError extends Error {
  constructor() {
    super("The account is not visible to the acting user under the tenant role; refusing to write investment evidence or record telemetry for it.");
    this.name = "InvestmentAccountNotVisibleError";
  }
}

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
  /** Opens a phase as the acting user on the tenant role. See the module note. */
  tenant:      InvestmentTenantPhase;
  /** Records one operator incident AFTER a phase has ended. Never a client. */
  recordIssue: InvestmentIssueRecorder;
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

  const { tenant, recordIssue } = params;
  const now = params.now ?? new Date();
  const date = toDate(params.date);
  const { financialAccountId, quantity, userId } = params;
  const costBasis = params.costBasis ?? null;

  // ── ONE tenant phase: visibility → identity → the composite write ──────────
  // Atomic end to end, which it was not before: the instrument a manual
  // assertion mints now rolls back with the assertion that needed it instead of
  // surviving as an orphan when the composite write fails.
  const outcome = await tenant(async (tx) => {
    // The boundary every later step stands behind — including telemetry, which
    // names this account id to an operator.
    const visible = await tx.financialAccount.findUnique({ where: { id: financialAccountId }, select: { id: true } });
    if (!visible) throw new InvestmentAccountNotVisibleError();

    let instrumentId: string;
    let instrumentCreated = false;
    if ("instrumentId" in params.instrument) {
      instrumentId = params.instrument.instrumentId;
    } else {
      const resolved = await resolveInstrumentForImport(params.instrument, { client: tx, financialAccountId });
      if (resolved.conflict) return { conflict: true as const, issue: resolved.issue };
      instrumentId = resolved.instrumentId;
      instrumentCreated = resolved.created;
    }

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
      // A count-returning write: under RLS a refused row is a smaller count,
      // not an error. Every row this phase just SAW must have been written.
      const r = await tx.investmentEvent.updateMany({
        where: { id: { in: priorEvents.map((e) => e.id) } },
        data:  { supersededById: event.id },
      });
      assertEveryObservedRowWasWritten(
        { table: "InvestmentEvent", operation: "update", scope: `${priorEvents.length} prior user opening(s) of one position` },
        priorEvents.length, r.count,
      );
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
      const r = await tx.positionObservation.updateMany({
        where: { id: { in: priorObs.map((o) => o.id) } },
        data:  { supersededById: observation.id },
      });
      assertEveryObservedRowWasWritten(
        { table: "PositionObservation", operation: "update", scope: `${priorObs.length} prior user anchor(s) of one position` },
        priorObs.length, r.count,
      );
    }

    return {
      conflict: false as const,
      instrumentId, instrumentCreated,
      written: {
        eventId: event.id,
        observationId: observation.id,
        supersededEventIds: priorEvents.map((e) => e.id),
        supersededObservationIds: priorObs.map((o) => o.id),
      },
    };
  });

  if (outcome.conflict) {
    // The phase has ended and wrote nothing. Only now does telemetry run.
    if (outcome.issue) await recordIssue(outcome.issue);
    return { status: "conflict" };
  }
  const { instrumentId, instrumentCreated, written } = outcome;

  // ── Bounded reconstruction repair (non-fatal) ──────────────────────────────
  // Its own tenant phase, so a failed repair rolls back alone and leaves the
  // committed assertion standing. The best-effort handling sits OUTSIDE the
  // phase (lib/db/write-phase.ts): catching inside it would hand the next
  // statement an aborted transaction.
  let repair: AssertOpeningPositionResult["repair"];
  try {
    const m = await tenant((tx) => repairReconstructionForAccount(tx, {
      financialAccountId, affectedInstrumentIds: [instrumentId], affectedCash: false, now,
    }), { timeout: REPAIR_PHASE_TIMEOUT_MS });
    repair = { status: m.status, repairedInstrumentIds: m.repairedInstrumentIds };
  } catch (err) {
    console.warn(`[opening-position] reconstruction repair for account ${financialAccountId} failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    await recordIssue({ kind: "INVESTMENT_DATA_PERSISTENCE_FAILED", financialAccountId, detail: { stage: "opening-position-repair", error: err instanceof Error ? err.message : String(err) } });
  }

  return { status: "ok", instrumentId, instrumentCreated, ...written, repair };
}
