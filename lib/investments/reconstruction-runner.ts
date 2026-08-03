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

import { AssetClass, InvestmentCoverageOutcome, InvestmentEventType, PositionOrigin, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { COMPLETENESS_TIERS, isCompletenessTier } from "@/lib/perspective-engine/completeness";
import type { CompletenessTier } from "@/lib/perspective-engine/types";
// V26-A4-SIGN — the canonical type→direction mapping (BUY +, SELL −), reused
// here rather than restated. See the mapping site below.
import { signedShareDelta } from "@/lib/investments/quantity-event.core";
import { loadCorporateActionTerms, actionKey } from "./corporate-actions";
import {
  reconstructPositions,
  detectCheckpointConflicts,
  applyCheckpointConflicts,
  reconcileWalkAgainstObservations,
  RECONSTRUCTION_VERSION,
  type ReconAnchorInput,
  type ReconEventInput,
  type InstrumentReconstruction,
  type ImportedCheckpoint,
  type WalkReconciliation,
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
  /**
   * V26-A4-OPENING — the account's demonstrated provider-data floor. Bounds the
   * opening anchor the walk may emit; null when this account has no COMPLETE,
   * pagination-reconciled coverage (a wallet or manual account).
   */
  providerFloorISO: string | null;
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
  // V26-A4-SIGN — THE ONE PLACE DIRECTION IS APPLIED.
  //
  // `ReconEventInput.quantity` is contractually "Security units, signed
  // +in/−out" and `reconstruction-core` walks backward with `q = q − delta`.
  // The provider stores an unsigned MAGNITUDE with direction in `type`, and this
  // mapping passed it through raw: BUY happened to work, every SELL was inverted
  // (it subtracted where it had to add), and the walk landed at −Σ|quantity| —
  // the fake negative openings the residue guard has been refusing.
  //
  // `signedShareDelta` is the canonical mapping that already lived in
  // quantity-event.core.ts; this is its second consumer, not a second table.
  //
  // A row it does not ratify (transfers, corporate actions, unknown types, or a
  // pre-signed negative) is passed through UNCHANGED — never zeroed. A4's own
  // `stopReasonFor` / `corporateActionInvertible` still need the real magnitude
  // to stop or degrade the walk, and zeroing would let a corporate action vanish
  // into a silent no-op. This slice applies direction where it is ratified and
  // changes nothing else.
  // V26-S1-CA — A RATIO THE PROVIDER NEVER STATED, FROM A SOURCE THAT DID.
  //
  // Plaid emits the corporate action and never its terms: every SPLIT in the
  // live corpus carries `ratio` NULL, so `stopReasonFor` halts the walk and the
  // position keeps UNSUPPORTED_CORPORATE_ACTION. TQQQ's history stopped at
  // 2025-11-20 for exactly this reason.
  //
  // The terms authority holds what an INDEPENDENT source stated — today the
  // `splitFactor` Tiingo has been returning on the price rows we already fetch.
  // It is consulted ONLY where the event itself states nothing: a ratio the user
  // or an imported statement supplied always wins, because it is first-party
  // evidence about that account and this is a vendor's view of the market.
  //
  // This is deliberately the ONLY change S1-CA makes to reconstruction. The core
  // already handles `ratio != null` correctly on both paths — `stopReasonFor`
  // stops refusing and `walkInstrument` divides — so the terms belong at the one
  // place ReconEventInput is constructed, exactly like V26-A4-SIGN's direction
  // mapping. The walk's math is untouched.
  const corporateActionTerms = await loadCorporateActionTerms(
    eventRows.map((e) => e.instrumentId).filter((id): id is string => id != null),
    client,
  );
  const termsRatioFor = (e: { instrumentId: string | null; date: Date; type: InvestmentEventType }): number | null => {
    if (e.instrumentId == null) return null;
    if (e.type !== InvestmentEventType.SPLIT) return null; // only splits carry terms today
    return corporateActionTerms.get(actionKey(e.instrumentId, ymd(e.date), "SPLIT"))?.ratio ?? null;
  };

  const events: ReconEventInput[] = eventRows.map((e) => ({
    id: e.id,
    source: e.source,
    externalEventId: e.externalEventId,
    date: ymd(e.date),
    type: e.type,
    instrumentId: e.instrumentId,
    quantity: signedShareDelta(e) ?? e.quantity,
    amount: e.amount,
    currency: e.currency,
    ratio: e.ratio ?? termsRatioFor(e),
    relatedInstrumentId: e.relatedInstrumentId,
  }));

  // V26-A4-OPENING — the account's demonstrated provider-data floor: the earliest
  // date any COMPLETE, pagination-reconciled coverage attempt actually returned,
  // restricted to the provider identity of the most recent attempt so a replaced
  // item cannot widen it. The walk never emits an opening anchor before this —
  // the day before a first event can fall outside anything the provider supplied.
  // Null when the account has no such coverage (a wallet, a manual account), in
  // which case no floor constraint applies.
  const latestAttempt = await client.investmentEventCoverage.findFirst({
    where:   { financialAccountId },
    orderBy: { attemptedAt: "desc" },
    select:  { plaidItemId: true },
  });
  let providerFloorISO: string | null = null;
  if (latestAttempt) {
    const floor = await client.investmentEventCoverage.aggregate({
      where: {
        financialAccountId,
        plaidItemId:          latestAttempt.plaidItemId,
        outcome:              InvestmentCoverageOutcome.COMPLETE,
        paginationReconciled: true,
        earliestReturnedDate: { not: null },
      },
      _min: { earliestReturnedDate: true },
    });
    if (floor._min.earliestReturnedDate) providerFloorISO = ymd(floor._min.earliestReturnedDate);
  }

  return { anchors: [...anchorById.values()], events, cashInstrumentByCurrency, runDate: ymd(now), providerFloorISO };
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
  /** V26-S1-CASH — the walk's agreement with independent observations, when measured. */
  cashReconciliation?: WalkReconciliation,
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
    evidenceRefs: (cashReconciliation
      ? { ...r.evidenceRefs, cashReconciliation }
      : r.evidenceRefs) as unknown as Prisma.InputJsonValue,
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

  // V26-S1-CASH — RECONCILE THE CASH WALK AGAINST THE PROVIDER'S OWN BALANCES.
  //
  // A cash walk is the one reconstruction in this system with frequent
  // independent checkpoints: the provider reports the account's cash balance on
  // many dates, and the walk passes over all of them on its way back from the
  // anchor. Comparing them costs one already-loaded row set and turns cash
  // reconstruction from an assertion into a measured claim.
  //
  // Recorded as evidence, never as a `conflicted` flag — see
  // reconcileWalkAgainstObservations for why a mismatch on a date that carries
  // an observation is diagnostic rather than a dispute.
  //
  // Scoped to CASH walks deliberately. Securities also carry OBSERVED history
  // and reconciling them would be valuable, but `conflicted`/status changes on
  // security positions propagate into valuation and the residue guard; that is a
  // larger decision than this slice, and mixing it in would hide which change
  // moved which number.
  const cashInstrumentIds = new Set(
    results.filter((r) => r.isCash).map((r) => r.instrumentId),
  );
  const cashReconciliationByInstrument = new Map<string, ReturnType<typeof reconcileWalkAgainstObservations>>();
  if (cashInstrumentIds.size > 0) {
    const observedCash = await client.positionObservation.findMany({
      where: {
        financialAccountId: params.financialAccountId,
        instrumentId: { in: [...cashInstrumentIds] },
        origin: PositionOrigin.OBSERVED,
        deletedAt: null,
        supersededById: null,
      },
      select: { instrumentId: true, date: true, quantity: true },
    });
    const byInstrument = new Map<string, { date: string; quantity: number }[]>();
    for (const o of observedCash) {
      const list = byInstrument.get(o.instrumentId) ?? [];
      list.push({ date: ymd(o.date), quantity: o.quantity });
      byInstrument.set(o.instrumentId, list);
    }
    for (const r of results) {
      if (!r.isCash) continue;
      const obs = byInstrument.get(r.instrumentId);
      if (!obs || obs.length === 0) continue;
      cashReconciliationByInstrument.set(r.instrumentId, reconcileWalkAgainstObservations(r, obs));
    }
  }

  const metrics: ReconstructionMetrics = {
    status: "ok", instruments: 0, complete: 0, partial: 0, failed: 0, conflicted: 0, derivedRows: 0,
  };

  const persistAll = async (tx: Client) => {
    for (const r of results) {
      await persistInstrument(tx, params.financialAccountId, r, cashReconciliationByInstrument.get(r.instrumentId));
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
  // V26-S1-CASH — AN EVENT THAT TOUCHES A SECURITY WALK CAN TOUCH THE CASH WALK.
  //
  // `affectedCash` is each producer's statement that a CASH-ONLY row moved, and
  // it stayed accurate for what it described. But routing now sends a cash leg
  // wherever a row states a material amount, and almost every such row also
  // carries an instrumentId — so a newly ingested SELL rebuilds its security
  // walk while leaving a stale, now-wrong cash walk published beside it.
  //
  // Repairing the cash walks whenever ANY walk is repaired is the structural
  // answer: it lives in one place, a new producer cannot forget it, and the cost
  // of over-repairing is nil (the walk is always full and the write is
  // idempotent) while the cost of under-repairing is a wrong number on screen.
  if (params.affectedCash || target.size > 0) {
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
