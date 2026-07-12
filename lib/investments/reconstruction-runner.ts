/**
 * lib/investments/reconstruction-runner.ts
 *
 * A4-2 — the DB binding for position reconstruction. Gathers OBSERVED anchors +
 * canonical InvestmentEvents for an account, runs the pure core
 * (reconstruction-core.ts), and persists the result:
 *   - DERIVED PositionObservation rows (origin: DERIVED, source: "reconstruction")
 *     at each event date — regenerable, versioned, never mixed with observed rows;
 *   - one PositionReconstruction summary per (account, instrument).
 *
 * Dark and best-effort: gated behind INVESTMENT_RECONSTRUCTION_ENABLED (absent ⇒
 * ZERO writes); callers wrap it non-fatal (the A1 try/catch contract). Idempotent:
 * a rerun deletes only this job's own DERIVED rows (origin: DERIVED AND
 * source "reconstruction") for the reconstructed instruments and rewrites them —
 * OBSERVED / IMPORTED / USER_ASSERTED rows and the brokerage-cash DERIVED rows
 * (a different source) are structurally untouchable. The reconstruction runner
 * NEVER mints a completeness value off the A5-S1 canon — every written tier is
 * asserted against COMPLETENESS_TIERS first (A4 cannot invent trust vocabulary).
 *
 * Reads/writes only A4-owned data. No reader/UI changes, no valuation, no prices.
 */

import { AssetClass, PositionOrigin, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { COMPLETENESS_TIERS, isCompletenessTier } from "@/lib/perspective-engine/completeness";
import type { CompletenessTier } from "@/lib/perspective-engine/types";
import {
  reconstructPositions,
  detectCheckpointConflicts,
  applyCheckpointConflicts,
  RECONSTRUCTION_VERSION,
  type ReconAnchorInput,
  type ReconEventInput,
  type InstrumentReconstruction,
  type ImportedCheckpoint,
} from "./reconstruction-core";

type Client = PrismaClient | Prisma.TransactionClient;

/** DERIVED PositionObservation.source for reconstruction rows (distinct from brokerage-cash). */
export const RECONSTRUCTION_SOURCE = "reconstruction";

/** Kill switch — independent of the observations/events flags. Absent ⇒ zero writes. */
export function investmentReconstructionEnabled(): boolean {
  return process.env.INVESTMENT_RECONSTRUCTION_ENABLED === "true";
}

/**
 * The single write-time guard: A4 may only persist a completeness value that is
 * a member of the A5-S1 canonical vocabulary. Throws otherwise, so a mapping bug
 * fails loudly rather than smuggling a fifth trust vocabulary into the reserved
 * String columns (parallelization investigation §11).
 */
export function assertCanonicalCompleteness(value: string): CompletenessTier {
  if (!isCompletenessTier(value)) {
    throw new Error(
      `[reconstruction] refusing to write non-canonical completeness "${value}" — allowed: ${COMPLETENESS_TIERS.join(", ")}`,
    );
  }
  return value;
}

// ── Date helpers (date-only UTC, matching @db.Date) ──────────────────────────

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function fromYmd(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
}

// ── Input gathering ──────────────────────────────────────────────────────────

export interface ReconstructionInputs {
  anchors: ReconAnchorInput[];
  events:  ReconEventInput[];
  cashInstrumentByCurrency: Record<string, string>;
  runDate: string;
}

/**
 * Gather the reconstruction inputs for one account: the latest OBSERVED position
 * per instrument (the anchors), every active canonical InvestmentEvent, and the
 * per-currency cash instrument map (from the OBSERVED cash anchors) used to route
 * cash-only events. Superseded / soft-deleted events are excluded — the walk
 * reads the current canonical log (A3 §8 guarantee 8).
 */
export async function gatherReconstructionInputs(
  client: Client,
  financialAccountId: string,
  now: Date,
): Promise<ReconstructionInputs> {
  // Latest OBSERVED observation per instrument = the anchor (plan §7, "anchored
  // at OBSERVED rows"). Newest-first, keep the first seen per instrument.
  const observed = await client.positionObservation.findMany({
    // A7-1 — exclude rolled-back imported anchors (deletedAt set); existing rows
    // have deletedAt null, so this is a no-op until an import is rolled back.
    where:   { financialAccountId, origin: PositionOrigin.OBSERVED, deletedAt: null },
    orderBy: { date: "desc" },
    select:  { instrumentId: true, date: true, quantity: true, isCash: true, currency: true, id: true },
  });
  const anchorById = new Map<string, ReconAnchorInput>();
  const cashInstrumentByCurrency: Record<string, string> = {};
  for (const o of observed) {
    if (anchorById.has(o.instrumentId)) continue; // already have the latest
    anchorById.set(o.instrumentId, {
      instrumentId: o.instrumentId,
      quantity: o.quantity,
      isCash: o.isCash,
      date: ymd(o.date),
      observationId: o.id,
    });
    if (o.isCash && o.currency && !(o.currency in cashInstrumentByCurrency)) {
      cashInstrumentByCurrency[o.currency] = o.instrumentId;
    }
  }

  const eventRows = await client.investmentEvent.findMany({
    where:  { financialAccountId, deletedAt: null, supersededById: null },
    select: {
      id: true, source: true, externalEventId: true, date: true, type: true,
      instrumentId: true, quantity: true, amount: true, currency: true, ratio: true,
      relatedInstrumentId: true,
    },
  });
  const events: ReconEventInput[] = eventRows.map((e) => ({
    id: e.id,
    source: e.source,
    externalEventId: e.externalEventId,
    date: ymd(e.date),
    type: e.type,
    instrumentId: e.instrumentId,
    quantity: e.quantity,
    amount: e.amount,
    currency: e.currency,
    ratio: e.ratio,
    relatedInstrumentId: e.relatedInstrumentId,
  }));

  return { anchors: [...anchorById.values()], events, cashInstrumentByCurrency, runDate: ymd(now) };
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Persist one instrument's reconstruction: regenerate its DERIVED reconstruction
 * rows and upsert its summary. Only this job's own rows are deleted (origin
 * DERIVED + source "reconstruction"); everything else is untouched.
 */
async function persistInstrument(
  client: Client,
  financialAccountId: string,
  r: InstrumentReconstruction,
): Promise<void> {
  await client.positionObservation.deleteMany({
    where: {
      financialAccountId,
      instrumentId: r.instrumentId,
      origin: PositionOrigin.DERIVED,
      source: RECONSTRUCTION_SOURCE,
    },
  });

  if (r.derivedRows.length > 0) {
    await client.positionObservation.createMany({
      data: r.derivedRows.map((p) => ({
        financialAccountId,
        instrumentId: r.instrumentId,
        date: fromYmd(p.date),
        quantity: p.quantity,
        origin: PositionOrigin.DERIVED,
        source: RECONSTRUCTION_SOURCE,
        reconstructionVersion: RECONSTRUCTION_VERSION,
        completeness: assertCanonicalCompleteness(p.completeness),
        unexplainedQuantity: p.unexplainedQuantity,
        evidenceRefs: { eventIds: p.eventIds } as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
  }

  const summary = {
    earliestDefensibleDate: fromYmd(r.earliestDefensibleDate),
    observedCurrentQuantity: r.observedCurrentQuantity,
    openingQuantity: r.openingQuantity,
    unexplainedOpeningQuantity: r.unexplainedOpeningQuantity,
    reconciliation: r.status,
    failureReason: r.failureReason,
    completeness: assertCanonicalCompleteness(r.completeness),
    conflicted: r.conflicted,
    reconstructionVersion: RECONSTRUCTION_VERSION,
    eventCount: r.eventCount,
    evidenceRefs: r.evidenceRefs as unknown as Prisma.InputJsonValue,
  };
  await client.positionReconstruction.upsert({
    where: { financialAccountId_instrumentId: { financialAccountId, instrumentId: r.instrumentId } },
    create: { financialAccountId, instrumentId: r.instrumentId, ...summary },
    update: summary,
  });
}

export interface ReconstructionMetrics {
  status: "ok" | "disabled";
  instruments: number;
  complete: number;
  partial: number;
  failed: number;
  conflicted: number;
  derivedRows: number;
}

export interface ReconstructAccountParams {
  financialAccountId: string;
  now: Date;
  client?: Client;
  /**
   * Bounded repair (A4-3): restrict the run to these instrument ids. Omitted ⇒
   * reconstruct every anchored/closed position for the account (the one-time run).
   */
  instrumentIds?: string[];
}

/**
 * Reconstruct one account's positions and persist the DERIVED rows + summaries.
 * Returns metrics (status "disabled" ⇒ the flag is off and nothing was written).
 * Best-effort by contract — callers wrap in try/catch; a persistence failure
 * must never fail a refresh or ingestion.
 */
export async function reconstructAccount(params: ReconstructAccountParams): Promise<ReconstructionMetrics> {
  if (!investmentReconstructionEnabled()) {
    return { status: "disabled", instruments: 0, complete: 0, partial: 0, failed: 0, conflicted: 0, derivedRows: 0 };
  }
  const client = params.client ?? db;
  const inputs = await gatherReconstructionInputs(client, params.financialAccountId, params.now);

  let results = reconstructPositions(inputs);
  if (params.instrumentIds && params.instrumentIds.length > 0) {
    const wanted = new Set(params.instrumentIds);
    results = results.filter((r) => wanted.has(r.instrumentId));
  }

  // A7-7 — reconcile live IMPORTED statement anchors against the walk. A stated
  // holding that disagrees with the reconstructed quantity beyond epsilon flags
  // the position `conflicted` (surfaced, never averaged, never re-anchored).
  const importedAnchors = await client.positionObservation.findMany({
    where:  { financialAccountId: params.financialAccountId, origin: PositionOrigin.IMPORTED, deletedAt: null, supersededById: null },
    select: { instrumentId: true, date: true, quantity: true, id: true },
  });
  if (importedAnchors.length > 0) {
    const checkpoints: ImportedCheckpoint[] = importedAnchors.map((o) => ({ instrumentId: o.instrumentId, date: ymd(o.date), quantity: o.quantity, observationId: o.id }));
    results = applyCheckpointConflicts(results, detectCheckpointConflicts(results, checkpoints));
  }

  const metrics: ReconstructionMetrics = {
    status: "ok", instruments: 0, complete: 0, partial: 0, failed: 0, conflicted: 0, derivedRows: 0,
  };

  const persistAll = async (tx: Client) => {
    for (const r of results) {
      await persistInstrument(tx, params.financialAccountId, r);
      metrics.instruments++;
      if (r.status === "COMPLETE") metrics.complete++;
      else if (r.status === "PARTIAL") metrics.partial++;
      else metrics.failed++;
      if (r.conflicted) metrics.conflicted++;
      metrics.derivedRows += r.derivedRows.length;
    }
  };

  if ("$transaction" in client) await (client as PrismaClient).$transaction((tx) => persistAll(tx));
  else await persistAll(client);

  return metrics;
}

// ── Bounded repair (A4-3) ─────────────────────────────────────────────────────

export interface RepairParams {
  financialAccountId: string;
  /** Non-null instrument ids touched by newly ingested/corrected events. */
  affectedInstrumentIds: string[];
  /** A cash-only event (instrumentId null) was ingested/corrected. */
  affectedCash: boolean;
  now: Date;
  client?: Client;
}

export interface RepairMetrics extends ReconstructionMetrics {
  repairedInstrumentIds: string[];
}

/**
 * Bounded, incremental repair: rerun reconstruction only for the positions that
 * (a) already have a reconstruction summary — i.e. sit inside an already-
 * reconstructed window — AND (b) were touched by newly ingested or corrected
 * events. Positions never reconstructed (no summary) are left to the one-time
 * run, not repaired here. A touched cash-only event repairs the account's
 * reconstructed cash instruments (resolved by AssetClass). No summaries / no
 * matching targets ⇒ a no-op. Flag-off ⇒ no reads and no writes.
 *
 * The walk itself is always full (anchored at the latest OBSERVED quantity), so
 * a late event dated before the window correctly re-widens or shrinks the
 * unexplained opening — the "min(affected dates) → next OBSERVED anchor" bound is
 * satisfied by scoping to the affected instruments, never the whole account.
 */
export async function repairReconstructionForAccount(params: RepairParams): Promise<RepairMetrics> {
  const empty: RepairMetrics = {
    status: "disabled", instruments: 0, complete: 0, partial: 0, failed: 0, conflicted: 0, derivedRows: 0, repairedInstrumentIds: [],
  };
  if (!investmentReconstructionEnabled()) return empty;
  const client = params.client ?? db;

  const summaries = await client.positionReconstruction.findMany({
    where:  { financialAccountId: params.financialAccountId },
    select: { instrumentId: true },
  });
  if (summaries.length === 0) return { ...empty, status: "ok" }; // nothing reconstructed yet
  const reconstructed = new Set(summaries.map((s) => s.instrumentId));

  const target = new Set(params.affectedInstrumentIds.filter((id) => reconstructed.has(id)));
  if (params.affectedCash) {
    const cashInstruments = await client.instrument.findMany({
      where:  { id: { in: [...reconstructed] }, assetClass: AssetClass.CASH },
      select: { id: true },
    });
    for (const c of cashInstruments) target.add(c.id);
  }
  if (target.size === 0) return { ...empty, status: "ok" };

  const m = await reconstructAccount({
    financialAccountId: params.financialAccountId,
    now: params.now,
    client,
    instrumentIds: [...target],
  });
  return { ...m, repairedInstrumentIds: [...target] };
}
