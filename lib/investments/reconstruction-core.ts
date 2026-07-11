/**
 * lib/investments/reconstruction-core.ts
 *
 * A4-1 — PURE one-time position reconstruction. No Prisma, no I/O, no
 * `Date.now()`, no env — every input (anchors, events, dates) is passed in, so
 * this fixture-tests without a database (the backfill-core / lens-core
 * convention). The DB gathering + persistence is the runner's job
 * (reconstruction-runner.ts); this file owns only the deterministic math.
 *
 * Contract (plan §7.1), per (account, instrument), computed BACKWARD from the
 * observed current quantity:
 *
 *     walkQty(today)  = observed current quantity            (anchor, OBSERVED)
 *     walkQty(d⁻)     = walkQty(d) − Σ signedQuantity(events on d)
 *     openingQuantity = walkQty(E_start⁻)
 *     unexplainedOpeningQuantity = openingQuantity           // NEVER forced to 0
 *
 * Determinism rules enforced here:
 *   - events sorted by (date, source, externalEventId, id) — A3 §8 guarantee 2;
 *   - CANCEL rows negate an equal-and-opposite non-cancel on the same walk;
 *     an unmatched cancel is retained and the instrument flagged `conflicted`,
 *     never guessed (A3 §8 guarantee 5);
 *   - a SPLIT with a known ratio divides backward; a SPLIT without a ratio, a
 *     MERGER, a SPIN_OFF, or a quantity-bearing UNKNOWN STOPS the walk at that
 *     date with a failure reason — reconstruction never walks through a
 *     corporate action it cannot invert (A3 §8 guarantees 6, 7);
 *   - cash-only events (no instrumentId) route to the per-currency cash
 *     instrument's walk, by `amount`, never onto a security's quantity
 *     (A3 §8 guarantee 4);
 *   - closed positions (in the events, absent from holdings) anchor at 0;
 *   - the opening residual is persisted, never zeroed.
 *
 * The only perspective-engine coupling is a TYPE import of the A5-S1 canonical
 * CompletenessTier (never an edit) — the runner asserts membership at write time.
 */

import { InvestmentEventType } from "@prisma/client";
import type { CompletenessTier } from "@/lib/perspective-engine/types";

/** Bumped when the reconstruction math or semantics change (classifierVersion pattern). */
export const RECONSTRUCTION_VERSION = 1;

/** Fractional-share comparison tolerance (RelationshipResolver monetary-epsilon precedent). */
export const QUANTITY_EPSILON = 1e-6;

/** Failure reasons for a stopped/partial reconstruction (never free text elsewhere). */
export const RECON_FAILURE = {
  UNSUPPORTED_CORPORATE_ACTION: "UNSUPPORTED_CORPORATE_ACTION",
  UNKNOWN_EVENT: "UNKNOWN_EVENT",
} as const;

// ── Inputs ────────────────────────────────────────────────────────────────────

/** A canonical InvestmentEvent, reduced to what the walk needs. Serialisable. */
export interface ReconEventInput {
  id:              string;
  source:          string;
  externalEventId: string | null;
  date:            string;             // YYYY-MM-DD (Plaid @db.Date)
  type:            InvestmentEventType;
  /** null ⇒ cash-only movement (routes to the per-currency cash instrument). */
  instrumentId:    string | null;
  /** Security units, signed +in/−out. null on cash-only rows. */
  quantity:        number | null;
  /** Cash leg, FM sign +in/−out. Used for cash-only routing and CANCEL matching. */
  amount:          number | null;
  currency:        string | null;
  /** Split ratio when known (imports/manual); Plaid never supplies it. */
  ratio:           number | null;
}

/** Observed current quantity for one (account, instrument) — the walk anchor. */
export interface ReconAnchorInput {
  instrumentId:   string;
  quantity:       number;              // 0 for a closed/disposed position
  isCash:         boolean;
  date:           string;              // YYYY-MM-DD of the anchoring observation
  observationId?: string | null;
}

export interface ReconstructParams {
  anchors: ReconAnchorInput[];
  events:  ReconEventInput[];
  /** currency → cash Instrument id, for routing cash-only events. */
  cashInstrumentByCurrency?: Record<string, string>;
  /** YYYY-MM-DD reconstruction run date — the anchor date for closed positions. */
  runDate: string;
}

// ── Outputs ───────────────────────────────────────────────────────────────────

export type ReconStatus = "COMPLETE" | "PARTIAL" | "FAILED";

/** A derived position quantity as-of one event date (a DERIVED PositionObservation row). */
export interface DerivedQuantityPoint {
  date:                string;         // event date (YYYY-MM-DD)
  quantity:            number;         // reconstructed quantity as-of end of that date
  eventIds:            string[];       // InvestmentEvent ids supporting this point
  completeness:        CompletenessTier; // "derived" normally; "incomplete" at the boundary
  unexplainedQuantity: number | null; // residual attributed at this point (boundary only)
}

/** One (account, instrument) reconstruction outcome — the summary + derived rows. */
export interface InstrumentReconstruction {
  instrumentId:               string;
  isCash:                     boolean;
  observedCurrentQuantity:    number;
  openingQuantity:            number;
  unexplainedOpeningQuantity: number;
  earliestDefensibleDate:     string;
  status:                     ReconStatus;
  failureReason:              string | null;
  /** Canonical A5-S1 tier: "derived" when COMPLETE, "incomplete" otherwise. */
  completeness:               CompletenessTier;
  conflicted:                 boolean;
  eventCount:                 number;
  derivedRows:                DerivedQuantityPoint[];
  evidenceRefs:               { anchorObservationId: string | null; eventIds: string[] };
}

// ── Routing ───────────────────────────────────────────────────────────────────

/** A routed event: the walk it belongs to + the signed delta it applies there. */
interface RoutedEvent {
  event: ReconEventInput;
  delta: number;   // security units (security walk) or cash amount (cash walk)
}

export interface RoutingResult {
  /** instrumentId → routed events (security walks + resolvable cash walks). */
  byInstrument: Map<string, RoutedEvent[]>;
  /** Cash-only events whose currency has no known cash instrument — unroutable. */
  unroutableCashEvents: ReconEventInput[];
}

/**
 * Route each event to exactly one instrument walk. A row with an instrumentId is
 * a SECURITY event (delta = its quantity; a null quantity, e.g. a cash dividend
 * attributed to a security, contributes 0 — it changes no share count). A row
 * without an instrumentId is a CASH-ONLY event routed to the per-currency cash
 * instrument (delta = its cash amount). A cash-only event whose currency has no
 * known cash instrument is unroutable and reported, never silently applied.
 */
export function routeEvents(
  events: ReconEventInput[],
  cashInstrumentByCurrency: Record<string, string> = {},
): RoutingResult {
  const byInstrument = new Map<string, RoutedEvent[]>();
  const unroutableCashEvents: ReconEventInput[] = [];

  const push = (instrumentId: string, event: ReconEventInput, delta: number) => {
    const list = byInstrument.get(instrumentId) ?? [];
    list.push({ event, delta });
    byInstrument.set(instrumentId, list);
  };

  for (const event of events) {
    if (event.instrumentId != null) {
      push(event.instrumentId, event, event.quantity ?? 0);
      continue;
    }
    const cashInstrumentId = event.currency ? cashInstrumentByCurrency[event.currency] : undefined;
    if (cashInstrumentId) push(cashInstrumentId, event, event.amount ?? 0);
    else unroutableCashEvents.push(event);
  }
  return { byInstrument, unroutableCashEvents };
}

// ── Walk ──────────────────────────────────────────────────────────────────────

function stopReasonFor(e: ReconEventInput): string | null {
  const T = InvestmentEventType;
  if (e.type === T.SPLIT && e.ratio == null) return RECON_FAILURE.UNSUPPORTED_CORPORATE_ACTION;
  if (e.type === T.MERGER || e.type === T.SPIN_OFF) return RECON_FAILURE.UNSUPPORTED_CORPORATE_ACTION;
  if (e.type === T.UNKNOWN && e.quantity != null && Math.abs(e.quantity) > QUANTITY_EPSILON) {
    return RECON_FAILURE.UNKNOWN_EVENT;
  }
  return null;
}

/** Deterministic total order for the walk: (date, source, externalEventId, id). */
function compareRouted(a: RoutedEvent, b: RoutedEvent): number {
  return (
    a.event.date.localeCompare(b.event.date) ||
    a.event.source.localeCompare(b.event.source) ||
    (a.event.externalEventId ?? "").localeCompare(b.event.externalEventId ?? "") ||
    a.event.id.localeCompare(b.event.id)
  );
}

/**
 * Match CANCEL rows to an equal-and-opposite non-cancel on the same walk. Matched
 * pairs net to zero and drop out; an unmatched cancel is retained (its delta
 * still applies) and the walk is flagged `conflicted`. Deterministic: cancels
 * and candidates are consumed in sorted order.
 */
function resolveCancels(sorted: RoutedEvent[]): { active: RoutedEvent[]; conflicted: boolean } {
  const cancels: RoutedEvent[] = [];
  const others: RoutedEvent[] = [];
  for (const r of sorted) {
    if (r.event.type === InvestmentEventType.CANCEL) cancels.push(r);
    else others.push(r);
  }
  if (cancels.length === 0) return { active: sorted, conflicted: false };

  const consumed = new Set<RoutedEvent>();
  let conflicted = false;
  for (const cancel of cancels) {
    const match = others.find(
      (o) => !consumed.has(o) && Math.abs(o.delta + cancel.delta) <= QUANTITY_EPSILON,
    );
    if (match) {
      consumed.add(match);
      consumed.add(cancel);
    } else {
      conflicted = true; // unmatched cancel — retained below, never guessed away
    }
  }
  const active = sorted.filter((r) => !consumed.has(r));
  return { active, conflicted };
}

function groupByDate(events: RoutedEvent[]): Map<string, RoutedEvent[]> {
  const byDate = new Map<string, RoutedEvent[]>();
  for (const r of events) {
    const list = byDate.get(r.event.date) ?? [];
    list.push(r);
    byDate.set(r.event.date, list);
  }
  return byDate;
}

function walkInstrument(
  instrumentId: string,
  isCash: boolean,
  anchorQuantity: number,
  anchorDate: string,
  anchorObservationId: string | null,
  routed: RoutedEvent[],
): InstrumentReconstruction {
  // Only events on or before the anchor (today) inform the backward walk.
  const inWindow = routed.filter((r) => r.event.date <= anchorDate);
  const sorted = [...inWindow].sort(compareRouted);
  const { active, conflicted } = resolveCancels(sorted);

  const byDate = groupByDate(active);
  const datesDesc = [...byDate.keys()].sort((a, b) => b.localeCompare(a));

  let q = anchorQuantity;
  let stopped = false;
  let failureReason: string | null = null;
  let earliest = anchorDate;
  const rowsDesc: DerivedQuantityPoint[] = [];

  for (const date of datesDesc) {
    const evs = byDate.get(date)!;
    // Quantity as-of end of this event date, before reversing it.
    rowsDesc.push({
      date,
      quantity: q,
      eventIds: evs.map((r) => r.event.id),
      completeness: "derived",
      unexplainedQuantity: null,
    });

    const stopEv = evs.find((r) => stopReasonFor(r.event));
    if (stopEv) {
      stopped = true;
      failureReason = stopReasonFor(stopEv.event);
      earliest = date; // cannot reverse a corporate action we can't invert
      break;
    }

    // Reverse this date's events to reach the quantity that held just before it.
    for (const r of evs) {
      if (r.event.type === InvestmentEventType.SPLIT && r.event.ratio != null && r.event.ratio !== 0) {
        q = q / r.event.ratio;
      } else {
        q = q - r.delta;
      }
    }
    earliest = date;
  }

  const opening = q; // quantity before the earliest defensible date (the residual)
  const status: ReconStatus = stopped
    ? "FAILED"
    : conflicted
      ? "PARTIAL"
      : Math.abs(opening) <= QUANTITY_EPSILON
        ? "COMPLETE"
        : "PARTIAL";
  const completeness: CompletenessTier = status === "COMPLETE" ? "derived" : "incomplete";

  // Stamp the boundary row honestly: when the opening isn't fully explained, the
  // earliest derived row carries the residual and reads "incomplete" (plan §4).
  const rows = rowsDesc.slice().reverse(); // ascending by date for output
  if (status !== "COMPLETE" && rows.length > 0) {
    const boundary = rows.find((r) => r.date === earliest);
    if (boundary) {
      boundary.completeness = "incomplete";
      boundary.unexplainedQuantity = opening;
    }
  }

  return {
    instrumentId,
    isCash,
    observedCurrentQuantity: anchorQuantity,
    openingQuantity: opening,
    unexplainedOpeningQuantity: opening, // persisted, never forced to 0
    earliestDefensibleDate: earliest,
    status,
    failureReason,
    completeness,
    conflicted,
    eventCount: routed.length,
    derivedRows: rows,
    evidenceRefs: { anchorObservationId, eventIds: active.map((r) => r.event.id) },
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Reconstruct every (account, instrument) position from anchors + events.
 * Instruments are the union of the anchors and every routed target — so a closed
 * position (in the events, absent from holdings) is reconstructed with a
 * quantity-0 anchor. Deterministic and pure: identical inputs → identical output
 * (results sorted by instrumentId).
 */
export function reconstructPositions(params: ReconstructParams): InstrumentReconstruction[] {
  const { byInstrument } = routeEvents(params.events, params.cashInstrumentByCurrency ?? {});

  const anchorById = new Map<string, ReconAnchorInput>();
  for (const a of params.anchors) anchorById.set(a.instrumentId, a);

  const instrumentIds = new Set<string>([...anchorById.keys(), ...byInstrument.keys()]);

  const results: InstrumentReconstruction[] = [];
  for (const instrumentId of instrumentIds) {
    const anchor = anchorById.get(instrumentId);
    const routed = byInstrument.get(instrumentId) ?? [];
    results.push(
      walkInstrument(
        instrumentId,
        anchor?.isCash ?? false,
        anchor?.quantity ?? 0, // closed position: no anchor ⇒ anchored at 0
        anchor?.date ?? params.runDate,
        anchor?.observationId ?? null,
        routed,
      ),
    );
  }

  results.sort((a, b) => a.instrumentId.localeCompare(b.instrumentId));
  return results;
}
