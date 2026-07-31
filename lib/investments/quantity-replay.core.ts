/**
 * lib/investments/quantity-replay.core.ts
 *
 * V26-QUANTITY-1C / 1C.1 — the PURE quantity replay core. No Prisma, no
 * network, no clock. Consumes the QUANTITY-1B contract
 * (`NormalizedQuantityEvent`) exactly; it defines no competing event model.
 *
 * ── The two claims this module is careful never to make ─────────────────────
 *
 * 1. A delta without an opening quantity establishes MOVEMENT, not HOLDINGS. A
 *    first `BUY 3` does not mean three shares were held — it means three more
 *    were held than before, and "before" may be unrecorded. A first `SELL 1`
 *    certainly does not mean −1.
 *
 *    So unknown quantity is STRUCTURALLY NON-NUMERIC: a RELATIVE segment has no
 *    `quantity` field to fabricate, and an UNRESOLVED segment has neither.
 *    `{ quantity: 0, basis: "UNKNOWN" }` is unwritable by construction rather
 *    than merely discouraged.
 *
 * 2. An observation proves a quantity ON ITS DATE. It does not prove the same
 *    quantity for the days that follow. Extending a point across an interval is
 *    a claim about the days in between — that nothing happened — and the ONLY
 *    evidence for that is a declared-complete event stream. Absence of events
 *    is not evidence of absence of movement: BTC holds 25 recorded inflows, no
 *    outflows in three years, and 8.43% of its observed balance unexplained.
 *
 *    So interval width is licensed by `EventStreamCompleteness`, which the
 *    caller must state and this module never infers. With an UNKNOWN stream
 *    every absolute fact is a POINT, and the days between points are reported
 *    as UNCOVERED — never as zero, and never silently omitted.
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
const minISO = (a: string, b: string) => (a < b ? a : b);
const maxISO = (a: string, b: string) => (a > b ? a : b);

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

/** May this observation be used at all? */
export type AnchorAdmissibility = "PERMITTED" | "REJECTED_ORIGIN" | "OUTSIDE_WINDOW";

/** What part did it play in choosing where absolute replay begins? */
export type AnchorOpeningRole = "OPENING" | "RESUME" | "AMBIGUOUS_SAME_DAY" | "NONE";

/** How does it appear in the timeline? */
export type AnchorRepresentation =
  /** It opened or resumed an interval that replay carried forward. */
  | "INTERVAL"
  /** It states an absolute fact on its own date and nothing beyond it. */
  | "POINT"
  /** A licensed interval already covers its date; it confirms (see `residue`). */
  | "COVERED_BY_INTERVAL"
  /** Rejected, or outside the requested window — it appears in no segment. */
  | "NOT_REPRESENTED";

/**
 * Every candidate anchor's full fate. Identity and evidence travel with it so a
 * consumer never has to re-read the observation to interpret the timeline.
 */
export interface AnchorOutcome {
  observationId:  string;
  dateISO:        string;
  quantity:       number;
  origin:         string;
  completeness:   string;
  admissibility:  AnchorAdmissibility;
  openingRole:    AnchorOpeningRole;
  representation: AnchorRepresentation;
  /** observed − replayed where a licensed interval covers this date, else null. */
  residue:        number | null;
  detail:         string | null;
}

// ── Event-stream completeness (input, never inferred) ────────────────────────

/**
 * Whether the event stream is known to contain EVERY movement over an interval.
 *
 * This is a fact about the INGESTION — the provider's history window, the
 * cursor's reach, whether the initial import completed — and it is therefore
 * unknowable from the events themselves. A stream with no events looks
 * identical whether nothing happened or nothing was imported. The caller must
 * say which; this module refuses to guess.
 *
 * The DB binding that determines this is later work. Until it exists, callers
 * pass `UNKNOWN_EVENT_STREAM`, and every absolute fact stays a point.
 */
export type EventStreamCompleteness =
  | { kind: "COMPLETE"; fromISO: string; toISO: string; source: string }
  | { kind: "PARTIAL"; coveredFromISO: string | null; coveredToISO: string | null; reason: string }
  | { kind: "UNKNOWN"; reason: string };

export const UNKNOWN_EVENT_STREAM: EventStreamCompleteness = {
  kind: "UNKNOWN",
  reason: "no ingestion-coverage evidence supplied by the caller",
};

/**
 * The interval over which movement is known to be fully recorded, or null when
 * no such interval is established. A PARTIAL stream with an open boundary
 * licenses nothing: "covered from some unknown date" cannot bound a claim.
 */
export function licensedCoverage(
  c: EventStreamCompleteness,
): { fromISO: string; toISO: string } | null {
  if (c.kind === "COMPLETE") return { fromISO: c.fromISO, toISO: c.toISO };
  if (c.kind === "PARTIAL" && c.coveredFromISO !== null && c.coveredToISO !== null) {
    return { fromISO: c.coveredFromISO, toISO: c.coveredToISO };
  }
  return null;
}

// ── Segments ─────────────────────────────────────────────────────────────────

export type SegmentOrderCertainty = "KNOWN" | "TIE_BROKEN";

/**
 * `fromISO === toISO` is a POINT: the claim holds on that date and says nothing
 * about the next. A wider segment is an INTERVAL claim, and only a licensed
 * event stream can widen one.
 */
export type QuantityTimelineSegment =
  | {
      kind:           "ABSOLUTE";
      fromISO:        string;
      toISO:          string;
      quantity:       number;
      basis:          "OBSERVED_ANCHOR" | "REPLAYED";
      derivedFrom:    string[];
      orderCertainty: SegmentOrderCertainty;
    }
  | {
      kind:            "RELATIVE";
      fromISO:         string;
      toISO:           string;
      /** Movement since the first event. Deliberately NOT named `quantity`. */
      cumulativeDelta: number;
      reason:          "MISSING_OPENING_ANCHOR";
      derivedFrom:     string[];
      orderCertainty:  SegmentOrderCertainty;
    }
  | {
      kind:             "UNRESOLVED";
      fromISO:          string;
      toISO:            string;
      reason:           "ORDER_SENSITIVE_UNRESOLVED" | "UNSUPPORTED_EVENT" | "INVALID_EVENT";
      blockingEventIds: string[];
    };

/**
 * Time inside the requested window about which the timeline says NOTHING.
 *
 * This exists so that omitted time is inspectable rather than inferable. A
 * consumer must never have to compare the first and last segment against the
 * window to discover that the middle is missing, and uncovered time must never
 * be mistaken for a quantity of zero.
 */
export type UncoveredReason =
  | "BEFORE_FIRST_DEFENSIBLE_ANCHOR"
  | "BETWEEN_INDEPENDENT_ANCHORS"
  | "AFTER_LAST_DEFENSIBLE_EVIDENCE"
  | "EVENT_STREAM_COMPLETENESS_UNKNOWN";

export interface UncoveredInterval {
  fromISO: string;
  toISO:   string;
  reason:  UncoveredReason;
}

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
  /** Last date any absolute claim reaches. Null ⇒ none was ever made. */
  absoluteResolvedThroughISO: string | null;
  /** observationIds that let absolute replay resume after a blocking date. */
  resumedFromAnchors:         string[];
  /** Every anchor's fate — exactly one entry per input anchor. */
  anchorOutcomes:             AnchorOutcome[];
  /** Confirming anchors whose quantity disagreed with replay, beyond tolerance. */
  reconciliationResidues:     Array<{ observationId: string; dateISO: string; expected: number; observed: number; residue: number }>;
  /** Echoed so a consumer can see what licensed (or refused to license) intervals. */
  eventStream:                EventStreamCompleteness;
  /** Days inside the window that no segment widened to cover. */
  intervalClaimsWithheld:     number;
}

/**
 * A TRUTHFUL one-word summary, derived from INTERVAL COVERAGE and not merely
 * from which segment kinds are present.
 *
 * `ABSOLUTE_COMPLETE` is the strongest claim in the vocabulary and it means
 * exactly one thing: every date in the requested window is covered by a
 * defensible absolute segment. One late absolute point in a month-long window
 * is not complete, however absolute that point may be.
 */
export type TimelineSummary =
  | "ABSOLUTE_COMPLETE"
  | "ABSOLUTE_WITH_GAPS"
  | "RELATIVE_ONLY"
  | "UNREPLAYABLE";

export interface QuantityTimeline {
  instrumentId:   string;
  accountId:      string;
  windowFromISO:  string;
  windowToISO:    string;
  summary:        TimelineSummary;
  segments:       QuantityTimelineSegment[];
  /** Requested time no segment speaks for. Empty ⇒ the window is fully spoken for. */
  uncovered:      UncoveredInterval[];
  diagnostics:    ReplayDiagnostics;
}

export interface ReplayInput {
  instrumentId: string;
  accountId:    string;
  /** Every candidate anchor. Order irrelevant — sorted internally. */
  anchors:      readonly QuantityAnchor[];
  /** QUANTITY-1B output for this (account, instrument). */
  events:       readonly NormalizedQuantityEvent[];
  /**
   * The REQUESTED interval. Both ends are caller decisions and neither is
   * inferred here: not from the first event, the first anchor, account
   * creation, the current date, or the earliest emitted segment. Those are
   * evidence facts, and a window derived from evidence can never reveal that
   * evidence is missing.
   */
  windowFromISO: string;
  windowToISO:   string;
  /** Required — see `EventStreamCompleteness`. Pass `UNKNOWN_EVENT_STREAM` if unknown. */
  eventStream:   EventStreamCompleteness;
  /** Asset-aware comparison tolerance for confirming anchors. */
  tolerance?:    number;
}

const DEFAULT_TOLERANCE = 1e-6;

/**
 * Derived from interval coverage across the whole requested window — never from
 * the strongest segment present. Letting ABSOLUTE → UNRESOLVED → ABSOLUTE
 * report as complete, or letting a single late point stand for a month, are the
 * two most misleading things this module could do.
 */
export function summarise(
  segments: readonly QuantityTimelineSegment[],
  uncovered: readonly UncoveredInterval[],
): TimelineSummary {
  const hasAbsolute   = segments.some((s) => s.kind === "ABSOLUTE");
  const hasRelative   = segments.some((s) => s.kind === "RELATIVE");
  const hasUnresolved = segments.some((s) => s.kind === "UNRESOLVED");
  if (hasAbsolute) {
    return uncovered.length === 0 && !hasRelative && !hasUnresolved
      ? "ABSOLUTE_COMPLETE" : "ABSOLUTE_WITH_GAPS";
  }
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

/** A run before licensing clips it. `toISO` is what replay would like to claim. */
interface RawRun {
  kind:            "ABSOLUTE" | "RELATIVE";
  fromISO:         string;
  toISO:           string;
  quantity:        number;
  cumulativeDelta: number;
  basis:           "OBSERVED_ANCHOR" | "REPLAYED";
  derivedFrom:     string[];
  orderCertainty:  SegmentOrderCertainty;
}

/** Sort key inside an ORDERED group: real datetime, then the 1B key. */
function orderedKey(e: NormalizedQuantityEvent): string {
  return `${e.order.effectiveDateTimeISO ?? ""}|${e.order.deterministicKey}`;
}

/**
 * How far may a claim that begins on `fromISO` extend?
 *
 * Only as far as the event stream is declared to record every movement. Outside
 * that, the claim collapses to the single date it was proven on. This is the
 * one place interval width is decided, so there is exactly one place where
 * "nothing was recorded" could be mistaken for "nothing happened".
 */
function licensedThrough(
  fromISO: string, desiredToISO: string, stream: EventStreamCompleteness,
): string {
  if (desiredToISO <= fromISO) return fromISO;
  const cover = licensedCoverage(stream);
  if (cover === null) return fromISO;
  if (fromISO < cover.fromISO || fromISO > cover.toISO) return fromISO;
  return minISO(desiredToISO, cover.toISO);
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
 * input event ends up in a segment or a diagnostic, every anchor gets exactly
 * one outcome, every day of the requested window is either covered by a segment
 * or listed as uncovered, and no unsupported event is stepped over while an
 * apparently exact timeline continues past it.
 */
export function replayQuantityTimeline(input: ReplayInput): QuantityTimeline {
  const { instrumentId, accountId, windowFromISO, windowToISO, eventStream } = input;
  assertISO(windowFromISO, "windowFromISO");
  assertISO(windowToISO, "windowToISO");
  if (windowToISO < windowFromISO) {
    throw new Error(`[quantity-replay] windowToISO ${windowToISO} precedes windowFromISO ${windowFromISO}`);
  }
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;

  const diagnostics: ReplayDiagnostics = {
    unsupportedEventIds: [], unattributableEventIds: [], invalidEventIds: [],
    neutralEventIds: [], unresolvedTransferEventIds: [], orderSensitiveGroups: [],
    missingOpeningAnchor: false, anchorRejectedReason: null,
    absoluteResolvedThroughISO: null, resumedFromAnchors: [],
    anchorOutcomes: [], reconciliationResidues: [],
    eventStream, intervalClaimsWithheld: 0,
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

  // ── Anchors: admissibility ──────────────────────────────────────────────
  const outcome = new Map<string, AnchorOutcome>();
  const permitted: QuantityAnchor[] = [];
  const sortedAnchors = [...input.anchors].sort((x, y) =>
    x.dateISO < y.dateISO ? -1 : x.dateISO > y.dateISO ? 1 : x.observationId.localeCompare(y.observationId));

  for (const a of sortedAnchors) {
    assertISO(a.dateISO, "anchor.dateISO");
    const base = {
      observationId: a.observationId, dateISO: a.dateISO, quantity: a.quantity,
      origin: a.origin, completeness: a.completeness,
      openingRole: "NONE" as AnchorOpeningRole,
      representation: "NOT_REPRESENTED" as AnchorRepresentation,
      residue: null as number | null, detail: null as string | null,
    };
    if (!PERMITTED_ANCHOR_ORIGINS.has(a.origin)) {
      outcome.set(a.observationId, { ...base, admissibility: "REJECTED_ORIGIN",
        detail: `origin ${a.origin} may not anchor a replay` });
      continue;
    }
    if (a.dateISO > windowToISO) {
      outcome.set(a.observationId, { ...base, admissibility: "OUTSIDE_WINDOW",
        detail: `dated after windowToISO ${windowToISO}` });
      continue;
    }
    permitted.push(a);
    outcome.set(a.observationId, { ...base, admissibility: "PERMITTED" });
  }
  if (permitted.length === 0 && input.anchors.length > 0) {
    diagnostics.anchorRejectedReason = "no candidate anchor is both permitted in origin and inside the window";
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
  const groupByDate = new Map(applicable.map((g) => [g.dateISO, g]));
  const rawRuns: RawRun[] = [];
  const unresolvedSegments: Extract<QuantityTimelineSegment, { kind: "UNRESOLVED" }>[] = [];

  // ── Choose an opening anchor ────────────────────────────────────────────
  let opening: QuantityAnchor | null = null;
  if (applicable.length > 0) {
    const firstDate = applicable[0].dateISO;
    const firstDayEvents = applicable[0].replayable;
    for (const a of permitted) {
      const p = anchorPrecedes(a, firstDate, firstDayEvents);
      if (p.ambiguous) outcome.get(a.observationId)!.openingRole = "AMBIGUOUS_SAME_DAY";
      if (p.ok) opening = a; // latest qualifying wins (permitted is date-ascending)
    }
    if (opening) outcome.get(opening.observationId)!.openingRole = "OPENING";
    else diagnostics.missingOpeningAnchor = true;
  }

  // ── Walk the days, producing RAW (unlicensed) runs ──────────────────────
  let absolute = opening !== null;
  let quantity = opening ? opening.quantity : 0;
  let cumulative = 0;
  let runFrom: string | null = opening ? opening.dateISO : null;
  let runBasis: "OBSERVED_ANCHOR" | "REPLAYED" = "OBSERVED_ANCHOR";
  let runDerived: string[] = opening ? [opening.observationId] : [];
  let runCertainty: SegmentOrderCertainty = "KNOWN";

  const closeRun = (toISO: string): void => {
    if (runFrom === null) return;
    // A run whose end precedes its own start covers no time: it arises whenever
    // a run is superseded on the very day it opened (a second event the same
    // day, or an anchor timestamped earlier that morning). Emitting it would
    // produce an inverted, empty segment claiming nothing over no interval.
    if (toISO < runFrom) { runFrom = null; return; }
    rawRuns.push({
      kind: absolute ? "ABSOLUTE" : "RELATIVE", fromISO: runFrom, toISO,
      quantity, cumulativeDelta: cumulative, basis: runBasis,
      derivedFrom: [...runDerived], orderCertainty: runCertainty,
    });
    runFrom = null;
  };

  // Walk EVERY date that carries evidence — event dates and anchor dates alike.
  // An anchor on a date with no events is still a statement about holdings on
  // that date, and must be reconciled rather than silently ignored.
  const walkDates = [...new Set([
    ...applicable.map((g) => g.dateISO),
    ...permitted.map((a) => a.dateISO),
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
      unresolvedSegments.push({
        kind: "UNRESOLVED", fromISO: g.dateISO, toISO: windowToISO,
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
        const ro = outcome.get(resume.observationId)!;
        ro.openingRole = "RESUME";
        diagnostics.resumedFromAnchors.push(resume.observationId);
        absolute = true;
        quantity = resume.quantity;
        runFrom = resume.dateISO;
        runBasis = "OBSERVED_ANCHOR";
        runDerived = [resume.observationId];
        runCertainty = "KNOWN";
        // Close the UNRESOLVED gap the day before the resume anchor.
        unresolvedSegments[unresolvedSegments.length - 1].toISO = shiftISO(resume.dateISO, -1);
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
  }
  closeRun(windowToISO);

  // ── License interval width ──────────────────────────────────────────────
  // A run's desired reach is what replay computed; its LICENSED reach is how
  // far the event stream is known to record every movement. Unlicensed tail is
  // not emitted as a claim — it falls through to `uncovered` below.
  const segments: QuantityTimelineSegment[] = [];
  for (const r of rawRuns) {
    if (r.toISO < windowFromISO || r.fromISO > windowToISO) continue;   // wholly outside the window
    const from = maxISO(r.fromISO, windowFromISO);
    const desired = minISO(r.toISO, windowToISO);
    const to = licensedThrough(from, desired, eventStream);
    if (to < desired) diagnostics.intervalClaimsWithheld++;
    if (r.kind === "ABSOLUTE") {
      segments.push({ kind: "ABSOLUTE", fromISO: from, toISO: to, quantity: r.quantity,
        basis: r.basis, derivedFrom: r.derivedFrom, orderCertainty: r.orderCertainty });
    } else {
      segments.push({ kind: "RELATIVE", fromISO: from, toISO: to, cumulativeDelta: r.cumulativeDelta,
        reason: "MISSING_OPENING_ANCHOR", derivedFrom: r.derivedFrom, orderCertainty: r.orderCertainty });
    }
  }
  for (const u of unresolvedSegments) {
    if (u.toISO < windowFromISO || u.fromISO > windowToISO) continue;
    segments.push({ ...u, fromISO: maxISO(u.fromISO, windowFromISO), toISO: minISO(u.toISO, windowToISO) });
  }

  // ── Every permitted anchor is an absolute fact at its own date ───────────
  // A later anchor winning the opening does not make an earlier one untrue. An
  // anchor already inside a licensed absolute interval CONFIRMS it (and may
  // disagree); one that is not becomes a POINT — proof on its own date, and
  // deliberately not one day more.
  for (const a of permitted) {
    const o = outcome.get(a.observationId)!;
    if (a.dateISO < windowFromISO) {
      o.detail = o.detail ?? `dated before windowFromISO ${windowFromISO}`;
      if (o.openingRole === "OPENING" || o.openingRole === "RESUME") o.representation = "INTERVAL";
      continue;
    }
    const covering = segments.find((s) => s.kind === "ABSOLUTE" && s.fromISO <= a.dateISO && s.toISO >= a.dateISO);
    if (covering && covering.kind === "ABSOLUTE") {
      const opened = o.openingRole === "OPENING" || o.openingRole === "RESUME";
      const isOwnRun = covering.derivedFrom.includes(a.observationId);
      o.representation = opened && isOwnRun ? "INTERVAL" : "COVERED_BY_INTERVAL";
      // Reconcile against any licensed interval this anchor did not itself
      // open: both state a quantity on the same date, so they are directly
      // comparable and a disagreement is a fact worth surfacing.
      if (!(opened && isOwnRun)) {
        const residue = a.quantity - covering.quantity;
        o.residue = residue;
        if (Math.abs(residue) > tolerance) {
          diagnostics.reconciliationResidues.push({
            observationId: a.observationId, dateISO: a.dateISO,
            expected: covering.quantity, observed: a.quantity, residue,
          });
          o.detail = `replay ${covering.quantity} vs observed ${a.quantity} (residue ${residue})`;
        }
      }
      continue;
    }
    // An isolated anchor reaches exactly as far as the event stream licenses:
    // to the next piece of evidence when movement in between is known to be
    // fully recorded, and otherwise not one day past the date it proves.
    const nextBoundary = [
      ...segments.map((s) => s.fromISO),
      ...permitted.map((x) => x.dateISO),
    ].filter((d) => d > a.dateISO).sort()[0];
    const desired = nextBoundary ? shiftISO(nextBoundary, -1) : windowToISO;
    const to = licensedThrough(a.dateISO, desired, eventStream);
    if (to < desired) diagnostics.intervalClaimsWithheld++;
    segments.push({
      kind: "ABSOLUTE", fromISO: a.dateISO, toISO: to, quantity: a.quantity,
      basis: "OBSERVED_ANCHOR", derivedFrom: [a.observationId], orderCertainty: "KNOWN",
    });
    o.representation = to > a.dateISO ? "INTERVAL" : "POINT";
  }

  // ── Order, then find the time nothing speaks for ─────────────────────────
  // Segments of the same kind never overlap. An ABSOLUTE point MAY sit inside a
  // RELATIVE run — that is the APLD shape, where an end-of-day observation
  // states the level on one date while the events around it state only
  // movement. Both are true of that day, and suppressing either would discard
  // evidence rather than resolve a contradiction.
  segments.sort((x, y) =>
    x.fromISO < y.fromISO ? -1 : x.fromISO > y.fromISO ? 1
      : x.toISO < y.toISO ? -1 : x.toISO > y.toISO ? 1
      : x.kind.localeCompare(y.kind));

  const cover = licensedCoverage(eventStream);
  const firstSpoken = segments.length ? segments[0].fromISO : null;
  const lastSpoken = segments.reduce<string | null>((m, s) => (m === null || s.toISO > m ? s.toISO : m), null);

  const uncovered: UncoveredInterval[] = [];
  let cursor = windowFromISO;
  for (const s of segments) {
    if (s.fromISO > cursor) {
      const gapTo = shiftISO(s.fromISO, -1);
      const interior = firstSpoken !== null && cursor > firstSpoken;
      const streamCovers = cover !== null && cover.fromISO <= cursor && cover.toISO >= gapTo;
      uncovered.push({
        fromISO: cursor, toISO: gapTo,
        reason: !interior ? "BEFORE_FIRST_DEFENSIBLE_ANCHOR"
              : streamCovers ? "BETWEEN_INDEPENDENT_ANCHORS"
              : "EVENT_STREAM_COMPLETENESS_UNKNOWN",
      });
    }
    if (s.toISO >= cursor) cursor = shiftISO(s.toISO, 1);
  }
  if (cursor <= windowToISO) {
    uncovered.push({
      fromISO: cursor, toISO: windowToISO,
      reason: lastSpoken === null ? "BEFORE_FIRST_DEFENSIBLE_ANCHOR" : "AFTER_LAST_DEFENSIBLE_EVIDENCE",
    });
  }

  diagnostics.absoluteResolvedThroughISO = segments.reduce<string | null>(
    (m, s) => (s.kind === "ABSOLUTE" && (m === null || s.toISO > m) ? s.toISO : m), null);
  diagnostics.anchorOutcomes = [...outcome.values()].sort((x, y) => x.observationId.localeCompare(y.observationId));
  diagnostics.resumedFromAnchors.sort();

  return {
    instrumentId, accountId, windowFromISO, windowToISO,
    summary: summarise(segments, uncovered), segments, uncovered, diagnostics,
  };
}
