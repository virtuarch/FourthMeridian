/**
 * lib/investments/quantity-replay.core.ts
 *
 * V26-QUANTITY-1C — the PURE quantity replay core. No Prisma, no network, no
 * clock. Consumes the QUANTITY-1B contract (`NormalizedQuantityEvent`) exactly;
 * it defines no competing event model.
 *
 * ── The claim this module is careful never to make ──────────────────────────
 * A delta without an opening quantity establishes MOVEMENT, not HOLDINGS. A
 * first `BUY 3` does not mean three shares were held — it means three more were
 * held than before, and "before" may be unrecorded. A first `SELL 1` certainly
 * does not mean −1.
 *
 * So the output is a discriminated union in which unknown quantity is
 * STRUCTURALLY NON-NUMERIC: a RELATIVE segment has no `quantity` field to
 * fabricate, and an UNRESOLVED segment has neither. `{ quantity: 0, basis:
 * "UNKNOWN" }` is unwritable by construction rather than merely discouraged.
 *
 * PRICE-5A's doctrine holds throughout: UNKNOWN ownership prehistory is never
 * valued. No segment of any kind exists before the first defensible evidence,
 * and a position is never "opened" at its first BUY merely because that is the
 * earliest row available.
 */

import type { NormalizedQuantityEvent } from "./quantity-event.core";

// ── Dates (pure, UTC, no clock) ──────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertISO(s: string, label: string): void {
  if (!ISO_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new Error(`[quantity-replay] invalid ${label}: "${s}"`);
  }
}
function shiftISO(dateISO: string, days: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

// ── Anchors ──────────────────────────────────────────────────────────────────

/**
 * An ABSOLUTE statement of holdings at a moment. Evidence origin is explicit
 * because not every observation may anchor a replay.
 */
export interface QuantityAnchor {
  observationId:        string;
  dateISO:              string;
  /**
   * Instant-level evidence, when it exists. PositionObservation.date is
   * @db.Date, so this is normally null — which is exactly why a same-day anchor
   * is ambiguous rather than usable. NEVER synthesise this from createdAt or a
   * row id: neither is evidence of when the holding was true.
   */
  effectiveDateTimeISO: string | null;
  quantity:             number;
  origin:               string;  // PositionOrigin as data — the core imports no Prisma
  completeness:         string;
}

/**
 * Origins permitted to anchor a replay.
 *
 * Mirrors `reconstruction-read.ts:tierForRow`, which already treats these three
 * as observed-tier evidence. DERIVED is excluded for two independent reasons:
 * it is reconstruction OUTPUT, so anchoring on it would let a replay anchor on a
 * previous replay and compound its own error invisibly; and DERIVED rows are
 * rewritten by a sync that records nothing in either observability ledger, so a
 * timeline anchored on one is not reproducible.
 */
export const PERMITTED_ANCHOR_ORIGINS: ReadonlySet<string> = new Set([
  "OBSERVED", "IMPORTED", "USER_ASSERTED",
]);

export type AnchorDisposition =
  | "USED_OPENING"
  | "USED_RESUME"
  | "CONFIRMING"
  | "REJECTED_ORIGIN"
  | "AMBIGUOUS_SAME_DAY"
  | "UNUSED";

export interface AnchorOutcome {
  observationId: string;
  dateISO:       string;
  disposition:   AnchorDisposition;
  /** Residue on a CONFIRMING anchor; the rejected origin; etc. */
  detail:        string | null;
}

// ── Segments ─────────────────────────────────────────────────────────────────

export type SegmentOrderCertainty = "KNOWN" | "TIE_BROKEN";

export type QuantityTimelineSegment =
  | {
      kind:           "ABSOLUTE";
      fromISO:        string;
      toISO:          string | null;
      quantity:       number;
      basis:          "OBSERVED_ANCHOR" | "REPLAYED";
      derivedFrom:    string[];
      orderCertainty: SegmentOrderCertainty;
    }
  | {
      kind:            "RELATIVE";
      fromISO:         string;
      toISO:           string | null;
      /** Movement since the first event. Deliberately NOT named `quantity`. */
      cumulativeDelta: number;
      reason:          "MISSING_OPENING_ANCHOR";
      derivedFrom:     string[];
      orderCertainty:  SegmentOrderCertainty;
    }
  | {
      kind:             "UNRESOLVED";
      fromISO:          string;
      toISO:            string | null;
      reason:           "ORDER_SENSITIVE_UNRESOLVED" | "UNSUPPORTED_EVENT" | "INVALID_EVENT";
      blockingEventIds: string[];
    };

// ── Same-day classification ──────────────────────────────────────────────────

export type SameDayClassification = "ORDERED" | "COMMUTATIVE" | "ORDER_SENSITIVE_UNRESOLVED";

/**
 * Classify a same-day group by OPERATOR ALGEBRA, not by hope.
 *
 *   ORDERED    every event carries a real datetime — chronology is evidenced.
 *   COMMUTATIVE all deltas (addition commutes) or all ratios (multiplication
 *               commutes), so the closing quantity is provably independent of
 *               the tie-break.
 *   ORDER_SENSITIVE_UNRESOLVED  the group mixes ≥1 ratio with ≥1 delta, where
 *               (q+d)·r ≠ q·r+d. A deterministic sort would pick one of two
 *               different real answers and present it as fact.
 */
export function classifySameDayGroup(
  events: readonly NormalizedQuantityEvent[],
): SameDayClassification {
  if (events.length <= 1) return events.every((e) => e.order.certainty === "KNOWN") ? "ORDERED" : "COMMUTATIVE";
  if (events.every((e) => e.order.certainty === "KNOWN")) return "ORDERED";
  const hasDelta = events.some((e) => e.normalizedDelta !== null);
  const hasRatio = events.some((e) => e.ratio !== null);
  return hasDelta && hasRatio ? "ORDER_SENSITIVE_UNRESOLVED" : "COMMUTATIVE";
}

// ── Result ───────────────────────────────────────────────────────────────────

export interface ReplayDiagnostics {
  unsupportedEventIds:        string[];
  unattributableEventIds:     string[];
  invalidEventIds:            string[];
  /**
   * Events that legitimately move no quantity — a cash dividend is the whole
   * population today. They are listed rather than passed over so that every
   * input event is accounted for somewhere: "changed nothing" and "was dropped"
   * must not look identical from the outside.
   */
  neutralEventIds:            string[];
  unresolvedTransferEventIds: string[];
  orderSensitiveGroups:       Array<{ dateISO: string; eventIds: string[]; classification: SameDayClassification }>;
  missingOpeningAnchor:       boolean;
  anchorRejectedReason:       string | null;
  /** Last date absolute replay is defensible. Null ⇒ it never was. */
  absoluteResolvedThroughISO: string | null;
  /** observationIds that let absolute replay resume after a blocking date. */
  resumedFromAnchors:         string[];
  /** Every anchor's fate — used, rejected, ambiguous or simply unused. */
  anchorOutcomes:             AnchorOutcome[];
  /** Confirming anchors whose quantity disagreed with replay, beyond tolerance. */
  reconciliationResidues:     Array<{ observationId: string; dateISO: string; expected: number; observed: number; residue: number }>;
}

/**
 * A TRUTHFUL one-word summary. Deliberately NOT "the strongest claim anywhere":
 * that would let ABSOLUTE → UNRESOLVED → ABSOLUTE report as ABSOLUTE_COMPLETE
 * and hide the interval in the middle, which is the single most misleading thing
 * this module could do. Segments remain authoritative; the summary only ever
 * narrows the claim.
 */
export type TimelineSummary =
  | "ABSOLUTE_COMPLETE"
  | "ABSOLUTE_WITH_GAPS"
  | "RELATIVE_ONLY"
  | "UNREPLAYABLE";

export interface QuantityTimeline {
  instrumentId: string;
  accountId:    string;
  windowToISO:  string;
  summary:      TimelineSummary;
  segments:     QuantityTimelineSegment[];
  diagnostics:  ReplayDiagnostics;
}

export interface ReplayInput {
  instrumentId: string;
  accountId:    string;
  /** Every candidate anchor. Order irrelevant — sorted internally. */
  anchors:      readonly QuantityAnchor[];
  /** QUANTITY-1B output for this (account, instrument). */
  events:       readonly NormalizedQuantityEvent[];
  windowToISO:  string;
  /** Asset-aware comparison tolerance for confirming anchors. */
  tolerance?:   number;
}

const DEFAULT_TOLERANCE = 1e-6;

/** Derived from ALL segments — never from the best one. */
export function summarise(segments: readonly QuantityTimelineSegment[]): TimelineSummary {
  const hasAbsolute   = segments.some((s) => s.kind === "ABSOLUTE");
  const hasRelative   = segments.some((s) => s.kind === "RELATIVE");
  const hasUnresolved = segments.some((s) => s.kind === "UNRESOLVED");
  if (hasAbsolute) return hasUnresolved ? "ABSOLUTE_WITH_GAPS" : "ABSOLUTE_COMPLETE";
  if (hasRelative) return "RELATIVE_ONLY";
  return "UNREPLAYABLE";
}

// ── Replay ───────────────────────────────────────────────────────────────────

interface DayGroup {
  dateISO:        string;
  replayable:     NormalizedQuantityEvent[];
  blocking:       NormalizedQuantityEvent[];
  classification: SameDayClassification;
}

/** Sort key inside an ORDERED group: real datetime, then the 1B key. */
function orderedKey(e: NormalizedQuantityEvent): string {
  return `${e.order.effectiveDateTimeISO ?? ""}|${e.order.deterministicKey}`;
}

/**
 * Can `anchor` open a run that begins with events on `firstEventDateISO`?
 *
 * Strictly-before always qualifies. Same-day qualifies ONLY when timestamps
 * prove precedence — the anchor and EVERY same-day event must carry one, and
 * the anchor's must be earlier. With day-only precision (the normal case) a
 * same-day anchor is AMBIGUOUS, never an opening: an observation dated on the
 * event day is an end-of-day state that already reflects the event, and using it
 * double-counts (a same-day buy of 3 against an observation of 3 "reconciles"
 * to 6).
 */
function anchorPrecedes(
  anchor: QuantityAnchor, firstEventDateISO: string, sameDayEvents: readonly NormalizedQuantityEvent[],
): { ok: boolean; ambiguous: boolean } {
  if (anchor.dateISO < firstEventDateISO) return { ok: true, ambiguous: false };
  if (anchor.dateISO > firstEventDateISO) return { ok: false, ambiguous: false };
  if (!anchor.effectiveDateTimeISO) return { ok: false, ambiguous: true };
  const times = sameDayEvents.map((e) => e.order.effectiveDateTimeISO);
  if (times.some((t) => t === null)) return { ok: false, ambiguous: true };
  return { ok: times.every((t) => anchor.effectiveDateTimeISO! < t!), ambiguous: false };
}

/**
 * Replay one (account, instrument) timeline.
 *
 * Deterministic and total: identical input yields byte-identical output, every
 * input event ends up in a segment or a diagnostic, and no unsupported event is
 * stepped over while an apparently exact timeline continues past it.
 */
export function replayQuantityTimeline(input: ReplayInput): QuantityTimeline {
  const { instrumentId, accountId, windowToISO } = input;
  assertISO(windowToISO, "windowToISO");
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;

  const diagnostics: ReplayDiagnostics = {
    unsupportedEventIds: [], unattributableEventIds: [], invalidEventIds: [],
    neutralEventIds: [], unresolvedTransferEventIds: [], orderSensitiveGroups: [],
    missingOpeningAnchor: false, anchorRejectedReason: null,
    absoluteResolvedThroughISO: null, resumedFromAnchors: [],
    anchorOutcomes: [], reconciliationResidues: [],
  };

  // ── Classify every input event ──────────────────────────────────────────
  for (const e of input.events) {
    if (e.status === "UNSUPPORTED_SEMANTICS") {
      diagnostics.unsupportedEventIds.push(e.eventId);
      if (e.sourceType.startsWith("TRANSFER_")) diagnostics.unresolvedTransferEventIds.push(e.eventId);
    } else if (e.status === "UNATTRIBUTABLE") diagnostics.unattributableEventIds.push(e.eventId);
    else if (e.status === "INVALID") diagnostics.invalidEventIds.push(e.eventId);
    else if (e.status === "NEUTRAL") diagnostics.neutralEventIds.push(e.eventId);
  }
  diagnostics.neutralEventIds.sort();
  diagnostics.unsupportedEventIds.sort();
  diagnostics.unattributableEventIds.sort();
  diagnostics.invalidEventIds.sort();
  diagnostics.unresolvedTransferEventIds.sort();

  // ── Anchors: permitted vs rejected ──────────────────────────────────────
  const outcome = new Map<string, AnchorOutcome>();
  const permitted: QuantityAnchor[] = [];
  for (const a of [...input.anchors].sort((x, y) =>
    x.dateISO < y.dateISO ? -1 : x.dateISO > y.dateISO ? 1 : x.observationId.localeCompare(y.observationId))) {
    assertISO(a.dateISO, "anchor.dateISO");
    if (!PERMITTED_ANCHOR_ORIGINS.has(a.origin)) {
      outcome.set(a.observationId, {
        observationId: a.observationId, dateISO: a.dateISO,
        disposition: "REJECTED_ORIGIN", detail: `origin ${a.origin} may not anchor a replay`,
      });
      continue;
    }
    permitted.push(a);
    outcome.set(a.observationId, {
      observationId: a.observationId, dateISO: a.dateISO, disposition: "UNUSED", detail: null,
    });
  }
  if (permitted.length === 0 && input.anchors.length > 0) {
    diagnostics.anchorRejectedReason = "no candidate anchor has a permitted origin";
  }

  // ── Group replayable + blocking events by date ──────────────────────────
  const dates = new Set<string>();
  for (const e of input.events) dates.add(e.dateISO);
  const groups: DayGroup[] = [...dates].sort().map((dateISO) => {
    const onDay = input.events.filter((e) => e.dateISO === dateISO);
    const replayable = onDay.filter((e) => e.status === "REPLAYABLE");
    const blocking = onDay.filter((e) => e.status === "UNSUPPORTED_SEMANTICS" || e.status === "INVALID");
    const classification = classifySameDayGroup(replayable);
    if (classification === "ORDER_SENSITIVE_UNRESOLVED") {
      diagnostics.orderSensitiveGroups.push({
        dateISO, eventIds: replayable.map((e) => e.eventId).sort(), classification,
      });
    }
    return { dateISO, replayable, blocking, classification };
  });

  const applicable = groups.filter((g) => g.replayable.length > 0 || g.blocking.length > 0);
  const segments: QuantityTimelineSegment[] = [];
  const groupByDate = new Map(applicable.map((g) => [g.dateISO, g]));

  if (applicable.length === 0) {
    // No events at all: an anchor alone still states a holding.
    if (permitted.length > 0) {
      const a = permitted[permitted.length - 1];
      outcome.get(a.observationId)!.disposition = "USED_OPENING";
      segments.push({
        kind: "ABSOLUTE", fromISO: a.dateISO, toISO: windowToISO, quantity: a.quantity,
        basis: "OBSERVED_ANCHOR", derivedFrom: [a.observationId], orderCertainty: "KNOWN",
      });
      diagnostics.absoluteResolvedThroughISO = windowToISO;
    }
    diagnostics.anchorOutcomes = [...outcome.values()].sort((x, y) => x.observationId.localeCompare(y.observationId));
    return { instrumentId, accountId, windowToISO, summary: summarise(segments), segments, diagnostics };
  }

  // ── Choose an opening anchor ────────────────────────────────────────────
  const firstDate = applicable[0].dateISO;
  const firstDayEvents = applicable[0].replayable;
  let opening: QuantityAnchor | null = null;
  for (const a of permitted) {
    const p = anchorPrecedes(a, firstDate, firstDayEvents);
    if (p.ambiguous) outcome.get(a.observationId)!.disposition = "AMBIGUOUS_SAME_DAY";
    if (p.ok) opening = a; // latest qualifying wins (permitted is date-ascending)
  }
  if (opening) outcome.get(opening.observationId)!.disposition = "USED_OPENING";
  else diagnostics.missingOpeningAnchor = true;

  // ── Walk the days ───────────────────────────────────────────────────────
  let absolute = opening !== null;
  let quantity = opening ? opening.quantity : 0;
  let cumulative = 0;
  /**
   * The date the CURRENT absolute run was anchored. An anchor earlier than this
   * has been superseded (a later qualifying anchor won the opening, or replay
   * resumed after a gap), so it is not evidence about the current run and must
   * not be reconciled against it.
   */
  let absoluteSinceISO: string | null = opening ? opening.dateISO : null;
  let runFrom: string | null = opening ? opening.dateISO : null;
  let runBasis: "OBSERVED_ANCHOR" | "REPLAYED" = "OBSERVED_ANCHOR";
  let runDerived: string[] = opening ? [opening.observationId] : [];
  let runCertainty: SegmentOrderCertainty = "KNOWN";

  const closeRun = (toISO: string | null): void => {
    if (runFrom === null) return;
    // A run whose end precedes its own start covers no time: it arises whenever
    // a run is superseded on the very day it opened (a second event the same
    // day, or an anchor timestamped earlier that morning). Emitting it would
    // produce an inverted, empty segment claiming nothing over no interval.
    if (toISO !== null && toISO < runFrom) { runFrom = null; return; }
    if (absolute) {
      segments.push({
        kind: "ABSOLUTE", fromISO: runFrom, toISO, quantity,
        basis: runBasis, derivedFrom: [...runDerived], orderCertainty: runCertainty,
      });
    } else {
      segments.push({
        kind: "RELATIVE", fromISO: runFrom, toISO, cumulativeDelta: cumulative,
        reason: "MISSING_OPENING_ANCHOR", derivedFrom: [...runDerived], orderCertainty: runCertainty,
      });
    }
    runFrom = null;
  };

  // Walk EVERY date that carries evidence — event dates and anchor dates alike.
  // An anchor on a date with no events is still a statement about holdings on
  // that date, and must be reconciled rather than silently ignored.
  const walkDates = [...new Set([
    ...applicable.map((g) => g.dateISO),
    ...permitted.map((a) => a.dateISO).filter((d) => d <= windowToISO),
  ])].sort();

  const EMPTY_DAY: Omit<DayGroup, "dateISO"> = {
    replayable: [], blocking: [], classification: "COMMUTATIVE",
  };

  for (const dateISO of walkDates) {
    const g: DayGroup = groupByDate.get(dateISO) ?? { dateISO, ...EMPTY_DAY };
    const blocked = g.blocking.length > 0 || g.classification === "ORDER_SENSITIVE_UNRESOLVED";

    if (blocked) {
      // Close whatever run is open at the day BEFORE the blockage, then record
      // the blocked day. Absolute replay may not step over unknown movement.
      closeRun(shiftISO(g.dateISO, -1));
      if (absolute && diagnostics.absoluteResolvedThroughISO === null) {
        diagnostics.absoluteResolvedThroughISO = shiftISO(g.dateISO, -1);
      }
      segments.push({
        kind: "UNRESOLVED", fromISO: g.dateISO, toISO: null,
        reason: g.classification === "ORDER_SENSITIVE_UNRESOLVED" ? "ORDER_SENSITIVE_UNRESOLVED"
              : g.blocking.some((e) => e.status === "INVALID") ? "INVALID_EVENT" : "UNSUPPORTED_EVENT",
        blockingEventIds: [...g.blocking.map((e) => e.eventId),
                           ...(g.classification === "ORDER_SENSITIVE_UNRESOLVED" ? g.replayable.map((e) => e.eventId) : [])].sort(),
      });
      absolute = false;
      cumulative = 0;

      // ── Resume from the earliest permitted anchor strictly after this day ──
      const resume = permitted.find((a) => a.dateISO > g.dateISO);
      if (resume) {
        outcome.get(resume.observationId)!.disposition = "USED_RESUME";
        diagnostics.resumedFromAnchors.push(resume.observationId);
        absolute = true;
        quantity = resume.quantity;
        absoluteSinceISO = resume.dateISO;
        runFrom = resume.dateISO;
        runBasis = "OBSERVED_ANCHOR";
        runDerived = [resume.observationId];
        runCertainty = "KNOWN";
        // Close the UNRESOLVED gap the day before the resume anchor.
        const gap = segments[segments.length - 1];
        if (gap.kind === "UNRESOLVED") gap.toISO = shiftISO(resume.dateISO, -1);
      }
      continue;
    }

    // Apply the day's events. ORDERED replays in evidenced order; COMMUTATIVE
    // is order-independent by construction, so the deterministic key is safe.
    const ordered = g.classification === "ORDERED"
      ? [...g.replayable].sort((a, b) => (orderedKey(a) < orderedKey(b) ? -1 : 1))
      : [...g.replayable].sort((a, b) => (a.order.deterministicKey < b.order.deterministicKey ? -1 : 1));

    for (const e of ordered) {
      closeRun(shiftISO(g.dateISO, -1));
      if (e.ratio !== null) quantity *= e.ratio;
      else {
        quantity += e.normalizedDelta ?? 0;
        cumulative += e.normalizedDelta ?? 0;
      }
      runFrom = g.dateISO;
      runBasis = "REPLAYED";
      runDerived = [e.eventId];
      runCertainty = e.order.certainty === "KNOWN" ? "KNOWN" : "TIE_BROKEN";
    }

    // ── Confirming anchors on this date ────────────────────────────────────
    // Compared AFTER the day's events are applied: an observation dated on an
    // event day is an end-of-day state, so end-of-day replay is what it is
    // evidence about.
    if (absolute && absoluteSinceISO !== null) {
      for (const a of permitted.filter((x) => x.dateISO === g.dateISO && x.dateISO >= absoluteSinceISO!)) {
        const o = outcome.get(a.observationId)!;
        if (o.disposition === "USED_OPENING" || o.disposition === "USED_RESUME") continue;
        if (o.disposition === "UNUSED") o.disposition = "CONFIRMING";
        const residue = a.quantity - quantity;
        if (Math.abs(residue) > tolerance) {
          diagnostics.reconciliationResidues.push({
            observationId: a.observationId, dateISO: a.dateISO,
            expected: quantity, observed: a.quantity, residue,
          });
          o.detail = `replay ${quantity} vs observed ${a.quantity} (residue ${residue})`;
        }
      }
    }
  }
  closeRun(windowToISO);

  if (absolute && diagnostics.absoluteResolvedThroughISO === null) {
    diagnostics.absoluteResolvedThroughISO = windowToISO;
  }

  diagnostics.anchorOutcomes = [...outcome.values()].sort((x, y) => x.observationId.localeCompare(y.observationId));
  diagnostics.resumedFromAnchors.sort();
  return { instrumentId, accountId, windowToISO, summary: summarise(segments), segments, diagnostics };
}
