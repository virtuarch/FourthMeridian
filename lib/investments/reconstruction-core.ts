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
 *   - V26-S1-CASH — an event is routed by its EFFECT, not by the absence of an
 *     instrument: its share leg (if any) walks the security by `quantity`, and
 *     its cash leg (if any) walks the per-currency cash instrument by `amount`.
 *     One event may therefore feed two walks — a sale moves shares out and cash
 *     in — and a cash amount never lands on a security's quantity
 *     (A3 §8 guarantee 4). Only a SHARE leg can be uninvertible; a cash leg
 *     always inverts by subtraction (see WalkLeg);
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
  /** Corporate-action counterparty (acquirer/child) when the import states it. */
  relatedInstrumentId?: string | null;
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
  /**
   * V26-A4-OPENING — the account's demonstrated provider-data floor
   * (MIN earliestReturnedDate over COMPLETE, reconciled coverage). An OPENING
   * ANCHOR is never emitted before it: the day before the first event may fall
   * outside anything the provider ever supplied, and a position row there would
   * manufacture evidence in UNKNOWN prehistory.
   *
   * Optional and null-safe. When absent, no floor constraint is applied — the
   * caller is stating it has no floor to enforce, not that the floor is
   * unbounded, so callers that CAN supply one should.
   */
  providerFloorISO?: string | null;
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
  evidenceRefs:               { anchorObservationId: string | null; eventIds: string[]; checkpointConflicts?: CheckpointConflict[] };
}

// ── Statement checkpoints (A7-7) ────────────────────────────────────────────────

/** A live IMPORTED PositionObservation anchor to reconcile against the walk. */
export interface ImportedCheckpoint {
  instrumentId:  string;
  date:          string;   // YYYY-MM-DD
  quantity:      number;   // the statement's stated held quantity
  observationId: string;
}

/** A checkpoint whose stated quantity disagrees with the reconstructed walk. */
export interface CheckpointConflict {
  instrumentId:    string;
  date:            string;
  observationId:   string;
  walkQuantity:    number;
  anchorQuantity:  number;
}

// ── Routing ───────────────────────────────────────────────────────────────────

/**
 * Which LEG of an event a routed entry represents.
 *
 * V26-S1-CASH — the distinction is load-bearing, not cosmetic. A corporate
 * action can be uninvertible in SHARES (we may not know a split's ratio) while
 * its CASH effect is a plain signed amount that inverts by subtraction like any
 * other. Before this existed, `stopReasonFor` and the divide-by-ratio branch ran
 * against whatever landed in a walk, so a ratio-less TQQQ split would have
 * stopped the ACCOUNT'S CASH WALK at the split date — halting cash history for
 * a reason that has nothing to do with cash.
 *
 * The rule, stated once: **a share leg can be uninvertible; a cash leg never
 * is.** Everything below follows from it.
 */
export type WalkLeg = "SECURITY" | "CASH";

/** A routed event: the walk it belongs to, which leg, + the signed delta. */
interface RoutedEvent {
  event: ReconEventInput;
  delta: number;   // security units (SECURITY leg) or cash amount (CASH leg)
  leg:   WalkLeg;
}

export interface RoutingResult {
  /** instrumentId → routed events (security walks + resolvable cash walks). */
  byInstrument: Map<string, RoutedEvent[]>;
  /** Events stating a cash effect whose currency has no known cash instrument. */
  unroutableCashEvents: ReconEventInput[];
}

/** Does this row state a material movement of money? */
function hasMaterialAmount(e: ReconEventInput): boolean {
  return e.amount != null && Number.isFinite(e.amount) && Math.abs(e.amount) > QUANTITY_EPSILON;
}

/**
 * Route each event to the walks it affects. ONE EVENT MAY AFFECT TWO WALKS.
 *
 * ── The bug this exists to prevent (V26-S1-CASH) ─────────────────────────────
 * This routed by the ABSENCE of an instrument: a row with an `instrumentId` was
 * a security event and its cash leg was discarded; only a row WITHOUT one
 * reached the cash walk. That predicate encodes an assumption about provider
 * data shape that the provider does not satisfy.
 *
 * Measured on the live corpus: 47 of 51 investment events carry an
 * `instrumentId`. Plaid attaches the PAYING security's id to a dividend, the
 * TRADED security's id to a buy or sell, and — for a transfer — a synthetic
 * instrument it invents for the transfer itself (rows literally named "Journal
 * to …764" and "Tfr JPMORGAN CHASE BAN…", classified EQUITY). So on one live
 * brokerage account, 36 events moved $3,480.08 of cash and NOT ONE reached the
 * cash walk: its reconstruction ran with `eventCount = 0` and reported the
 * account's entire present-day cash balance, $3,557.72, as an unexplained
 * opening held before history began. The account's own observations put its
 * cash at $11.65 five days earlier.
 *
 * The repair is to route by EFFECT rather than by absence:
 *
 *   SECURITY leg — every row with an instrumentId. delta = its signed quantity
 *                  (null ⇒ 0: a cash dividend attributed to a security moves no
 *                  shares). Unchanged from before.
 *   CASH leg     — every row stating a material `amount`, routed to the
 *                  per-currency cash instrument. delta = that amount, in the FM
 *                  sign convention already documented on the schema and already
 *                  verified against the corpus (+ cash in, − cash out).
 *
 * A row can therefore produce one entry, two, or none. A SELL contributes −N
 * shares to its security walk AND +$X to the cash walk — which is what a sale
 * is. A zero or absent amount produces no cash entry at all, so a split
 * (amount 0) adds nothing and cannot manufacture a cash row.
 *
 * SAME-WALK COLLISION: if a row's own `instrumentId` IS the cash instrument, the
 * security leg already owns that walk and the cash leg is DROPPED (reported as
 * unroutable). Applying two deltas from one row to one walk would double-count
 * it. No such row exists in the corpus; this is structural, not observed.
 *
 * A cash effect whose currency has no known cash instrument is unroutable and
 * reported — never silently applied to some other currency's walk.
 */
export function routeEvents(
  events: ReconEventInput[],
  cashInstrumentByCurrency: Record<string, string> = {},
): RoutingResult {
  const byInstrument = new Map<string, RoutedEvent[]>();
  const unroutableCashEvents: ReconEventInput[] = [];

  const push = (instrumentId: string, event: ReconEventInput, delta: number, leg: WalkLeg) => {
    const list = byInstrument.get(instrumentId) ?? [];
    list.push({ event, delta, leg });
    byInstrument.set(instrumentId, list);
  };

  for (const event of events) {
    // ── SECURITY leg ────────────────────────────────────────────────────────
    if (event.instrumentId != null) {
      push(event.instrumentId, event, event.quantity ?? 0, "SECURITY");
    }

    // ── CASH leg — independent of whether a security leg was emitted ────────
    if (!hasMaterialAmount(event)) continue;
    const cashInstrumentId = event.currency ? cashInstrumentByCurrency[event.currency] : undefined;
    if (!cashInstrumentId) { unroutableCashEvents.push(event); continue; }
    if (cashInstrumentId === event.instrumentId) { unroutableCashEvents.push(event); continue; }
    push(cashInstrumentId, event, event.amount!, "CASH");
  }
  return { byInstrument, unroutableCashEvents };
}

// ── Walk ──────────────────────────────────────────────────────────────────────

/**
 * The calendar day before an ISO date. Pure and clock-free — parses the date in
 * UTC, so it is stable regardless of where it runs and correct across month,
 * year and leap boundaries.
 */
export function previousDayISO(dateISO: string): string {
  return new Date(Date.parse(`${dateISO}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** Does an event state a material share effect on THIS instrument's leg? */
function hasMaterialQuantity(e: ReconEventInput): boolean {
  return e.quantity != null && Math.abs(e.quantity) > QUANTITY_EPSILON;
}

/**
 * A7-7 — is an imported MERGER / SPIN_OFF invertible? Only when its TERMS are
 * known (investigation §7), never guessed:
 *   - stock action: ratio AND relatedInstrumentId stated (the counterparty leg),
 *   - cash merger:  a material cash amount (ratio-less by nature; position → 0),
 * AND the row states the share effect (a material quantity) so the walk can apply
 * it as a signed delta on this leg. Brokers list each leg separately, so no
 * cross-instrument coupling is needed. Anything less ⇒ stop (never guess terms).
 */
function corporateActionInvertible(e: ReconEventInput): boolean {
  if (!hasMaterialQuantity(e)) return false;
  const stockTermsKnown = e.ratio != null && e.relatedInstrumentId != null;
  const cashMerger = e.type === InvestmentEventType.MERGER && e.amount != null && Math.abs(e.amount) > QUANTITY_EPSILON;
  return stockTermsKnown || cashMerger;
}

function stopReasonFor(e: ReconEventInput): string | null {
  const T = InvestmentEventType;
  if (e.type === T.SPLIT && e.ratio == null) return RECON_FAILURE.UNSUPPORTED_CORPORATE_ACTION;
  if ((e.type === T.MERGER || e.type === T.SPIN_OFF) && !corporateActionInvertible(e)) {
    return RECON_FAILURE.UNSUPPORTED_CORPORATE_ACTION;
  }
  if (e.type === T.UNKNOWN && hasMaterialQuantity(e)) {
    return RECON_FAILURE.UNKNOWN_EVENT;
  }
  return null;
}

/**
 * The stop reason for a ROUTED entry.
 *
 * V26-S1-CASH — only a SHARE leg can be uninvertible. `stopReasonFor` asks
 * whether a corporate action's effect on a SHARE COUNT can be reversed; a cash
 * amount has no ratio, no counterparty leg and no terms to be missing, so it
 * inverts by subtraction like every other signed amount. Applying the share test
 * to a cash entry would let a ratio-less split halt an account's cash history —
 * a refusal about shares, silently spent on cash.
 */
function stopReasonForRouted(r: RoutedEvent): string | null {
  return r.leg === "SECURITY" ? stopReasonFor(r.event) : null;
}

/** Deterministic total order for the walk: (date, source, externalEventId, id, leg). */
function compareRouted(a: RoutedEvent, b: RoutedEvent): number {
  return (
    a.event.date.localeCompare(b.event.date) ||
    a.event.source.localeCompare(b.event.source) ||
    (a.event.externalEventId ?? "").localeCompare(b.event.externalEventId ?? "") ||
    a.event.id.localeCompare(b.event.id) ||
    // One event can now produce two entries; the leg is the final tie-break so
    // the total order stays total (A3 §8 guarantee 2). Legs never share a walk
    // in practice — routing drops the collision — so this only ever settles a
    // theoretical tie, deterministically.
    a.leg.localeCompare(b.leg)
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
    // V26-S1-CASH — a cancel may only annul an entry on the SAME LEG. A share
    // cancel that happened to be numerically equal-and-opposite to some cash
    // amount would otherwise net the two to zero and delete both.
    const match = others.find(
      (o) => !consumed.has(o) && o.leg === cancel.leg &&
        Math.abs(o.delta + cancel.delta) <= QUANTITY_EPSILON,
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
  providerFloorISO: string | null,
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

    const stopEv = evs.find((r) => stopReasonForRouted(r));
    if (stopEv) {
      stopped = true;
      failureReason = stopReasonForRouted(stopEv);
      earliest = date; // cannot reverse a corporate action we can't invert
      break;
    }

    // Reverse this date's events to reach the quantity that held just before it.
    // The ratio branch is SHARE arithmetic and applies to the security leg only:
    // dividing a cash balance by a split ratio is not a statement about money.
    for (const r of evs) {
      if (
        r.leg === "SECURITY" &&
        r.event.type === InvestmentEventType.SPLIT &&
        r.event.ratio != null && r.event.ratio !== 0
      ) {
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

  // ── V26-A4-OPENING — THE OPENING ANCHOR ───────────────────────────────────
  //
  // Every derived row above states the quantity as-of the END of an event date,
  // so the earliest of them is the quantity AFTER the first event. Nothing
  // represented the interval BEFORE it, even though `opening` states it exactly.
  //
  // The consequence was a silent over-count: with no row covering those dates,
  // `resolvePositionAsOf` returns null and `holdConstantBeforeEarliest` carries
  // the earliest row backward — the POST-event quantity. Locally that valued
  // INTC as 5 shares for the 91 days before the BUY that took it 4 → 5, and
  // NVDA as 2.0002 before the fractional buy that took it 2.0001 → 2.0002. The
  // walk knew 4 and 2.0001 the whole time; it simply never said so where a
  // reader could see it.
  //
  // So the residual is emitted as its own DERIVED row, dated the day before the
  // first supported event. It is the SAME fact already stored as
  // `openingQuantity` — published at the boundary rather than only summarised —
  // which is why this belongs in the walk's output and not in a valuation-layer
  // fallback.
  //
  // Refused, deliberately, when:
  //   - the walk STOPPED (FAILED): everything before the stop is exactly what
  //     could not be reconstructed. TQQQ keeps its pre-split history unlicensed.
  //   - sources CONFLICT: an unusable opening must not be published as a fact.
  //   - the opening is non-finite.
  //   - the opening is ZERO. Introducing a zero row here would create a KNOWN
  //     ABSENCE that valuation treats as a closed position, which is new zero
  //     semantics this slice has not earned. Group A (opening 0) therefore emits
  //     nothing and its ownership start is untouched.
  //   - there are no events at all: `earliest` is the anchor date and there is
  //     no "before the first event" to describe.
  //   - the anchor date would fall before the account's provider floor.
  //
  // A genuinely negative opening KEEPS ITS SIGN. This publishes the walk's
  // answer; it does not judge it. Valuation's residue guard independently
  // refuses a DERIVED negative from a non-COMPLETE reconstruction, which is the
  // right place for that judgement.
  //
  // Provenance is preserved, never upgraded: origin stays DERIVED (the writer's
  // concern), completeness is "incomplete" and `unexplainedQuantity` carries the
  // residual, because the entire quantity of this row is unexplained. It has no
  // supporting events — `eventIds` is empty — as it IS the residual.
  const openingAnchorDate = previousDayISO(earliest);
  const emitOpeningAnchor =
    !stopped &&
    !conflicted &&
    Number.isFinite(opening) &&
    Math.abs(opening) > QUANTITY_EPSILON &&
    rows.length > 0 &&
    openingAnchorDate < earliest &&
    !rows.some((r) => r.date === openingAnchorDate) &&
    (providerFloorISO == null || openingAnchorDate >= providerFloorISO);

  if (emitOpeningAnchor) {
    rows.unshift({
      date: openingAnchorDate,
      quantity: opening,
      eventIds: [],
      completeness: "incomplete",
      unexplainedQuantity: opening,
    });
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
        params.providerFloorISO ?? null,
      ),
    );
  }

  results.sort((a, b) => a.instrumentId.localeCompare(b.instrumentId));
  return results;
}

// ── Statement-checkpoint reconciliation (A7-7) ──────────────────────────────────

/** The reconstructed quantity as-of a date from a walk's derived rows, or null
 *  when the date is beyond the walk's defensible coverage. */
function walkQuantityAsOf(r: InstrumentReconstruction, date: string): number | null {
  if (date < r.earliestDefensibleDate) return null; // beyond coverage — cannot answer
  let best: DerivedQuantityPoint | null = null;
  for (const row of r.derivedRows) {
    if (row.date <= date && (best === null || row.date > best.date)) best = row;
  }
  // No event on/before the date within coverage ⇒ the quantity held flat at the
  // anchor back to the earliest defensible date.
  return best ? best.quantity : r.observedCurrentQuantity;
}

// ── Cash reconciliation against provider observations (V26-S1-CASH) ───────────

/** Default monetary tolerance for cash reconciliation, in account-currency units. */
export const CASH_RECONCILIATION_TOLERANCE = 0.01;

/** One date where the walk could be compared against an independent observation. */
export interface WalkCheckpointResidual {
  date:          string;
  walkQuantity:  number;
  observed:      number;
  residual:      number;   // observed − walk
  reconciled:    boolean;
}

/** How well a walk agrees with the observations it passes over. */
export interface WalkReconciliation {
  checkpoints:   number;
  reconciled:    number;
  maxResidual:   number;
  tolerance:     number;
  residuals:     WalkCheckpointResidual[];
}

/**
 * Compare a walk against every independent OBSERVATION that falls inside its
 * coverage, and report how well it agrees.
 *
 * ── Why this is EVIDENCE and not a conflict ──────────────────────────────────
 * `detectCheckpointConflicts` above exists for IMPORTED statement anchors, where
 * a disagreement is a genuine dispute between two sources and must block trust.
 * This is a different question with a different consequence.
 *
 * A cash walk is anchored at the latest OBSERVED balance and passes over earlier
 * OBSERVED balances on its way back. Those are free, independent checks — and
 * they are exactly what makes cash reconstruction verifiable in a way share
 * reconstruction is not (a share walk usually has only one anchor: today).
 *
 * But a disagreement here is NOT a dispute, because on any date carrying an
 * observation, origin precedence (OBSERVED > DERIVED, resolvePositionAsOf)
 * means the OBSERVATION is what every consumer reads. The derived row for that
 * date is unreachable. A mismatch on an unreachable row tells us how good the
 * model is; it does not put a displayed number in doubt. Where no observation
 * exists — the dates that actually matter — there is nothing to disagree with.
 *
 * So this records rather than escalates. Measured on the live corpus, that is
 * precisely the right severity: the walk reproduces the observed cash balance
 * EXACTLY on 6 of 8 dates, and misses 2 by $1.50 — one dividend dated
 * 2026-07-31 that posted to cash on 2026-08-03. That is settlement lag, a real
 * property of brokerage cash, and it belongs in the evidence record rather than
 * behind a "sources disagree, needs review" banner.
 *
 * Pure and deterministic. Observations outside the walk's coverage are skipped:
 * a walk makes no claim there, so there is nothing to compare.
 */
export function reconcileWalkAgainstObservations(
  r: InstrumentReconstruction,
  observations: readonly { date: string; quantity: number }[],
  tolerance: number = CASH_RECONCILIATION_TOLERANCE,
): WalkReconciliation {
  const residuals: WalkCheckpointResidual[] = [];
  for (const o of observations) {
    const walk = walkQuantityAsOf(r, o.date);
    if (walk === null) continue; // outside coverage — no claim, nothing to check
    const residual = o.quantity - walk;
    residuals.push({
      date: o.date, walkQuantity: walk, observed: o.quantity, residual,
      reconciled: Math.abs(residual) <= tolerance,
    });
  }
  residuals.sort((a, b) => a.date.localeCompare(b.date));
  return {
    checkpoints: residuals.length,
    reconciled:  residuals.filter((x) => x.reconciled).length,
    maxResidual: residuals.reduce((m, x) => Math.max(m, Math.abs(x.residual)), 0),
    tolerance,
    residuals,
  };
}

/**
 * Reconcile each imported statement anchor inside a walk's window against the
 * reconstructed quantity at that date. Disagreement beyond QUANTITY_EPSILON is a
 * conflict — surfaced, NEVER averaged and NEVER used to re-anchor the walk
 * (multi-anchor segmented walks are a core rewrite the data hasn't earned).
 * Pure and deterministic.
 */
export function detectCheckpointConflicts(
  reconstructions: InstrumentReconstruction[],
  checkpoints: ImportedCheckpoint[],
): CheckpointConflict[] {
  const byId = new Map(reconstructions.map((r) => [r.instrumentId, r]));
  const conflicts: CheckpointConflict[] = [];
  for (const cp of checkpoints) {
    const r = byId.get(cp.instrumentId);
    if (!r) continue;
    const wq = walkQuantityAsOf(r, cp.date);
    if (wq === null) continue; // outside coverage — no claim, no conflict
    if (Math.abs(wq - cp.quantity) > QUANTITY_EPSILON) {
      conflicts.push({ instrumentId: cp.instrumentId, date: cp.date, observationId: cp.observationId, walkQuantity: wq, anchorQuantity: cp.quantity });
    }
  }
  conflicts.sort((a, b) => a.instrumentId.localeCompare(b.instrumentId) || a.date.localeCompare(b.date));
  return conflicts;
}

/**
 * Mark every reconstruction with a checkpoint conflict as `conflicted` and record
 * the conflicting checkpoints in its evidenceRefs. Returns new objects (pure);
 * quantities/status are untouched — a conflict blocks trust, it never rewrites the
 * number.
 */
export function applyCheckpointConflicts(
  reconstructions: InstrumentReconstruction[],
  conflicts: CheckpointConflict[],
): InstrumentReconstruction[] {
  if (conflicts.length === 0) return reconstructions;
  const byInstrument = new Map<string, CheckpointConflict[]>();
  for (const c of conflicts) {
    const list = byInstrument.get(c.instrumentId) ?? [];
    list.push(c);
    byInstrument.set(c.instrumentId, list);
  }
  return reconstructions.map((r) => {
    const cs = byInstrument.get(r.instrumentId);
    if (!cs) return r;
    return { ...r, conflicted: true, evidenceRefs: { ...r.evidenceRefs, checkpointConflicts: cs } };
  });
}
