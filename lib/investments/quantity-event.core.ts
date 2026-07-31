/**
 * lib/investments/quantity-event.core.ts
 *
 * V26-QUANTITY-1B — the PURE normalized quantity-event contract. No Prisma, no
 * network, no clock. This slice produces the vocabulary and the normalizer;
 * QUANTITY-1C replays it.
 *
 * ── What this module refuses to do ──────────────────────────────────────────
 * It does not guess. Every active source row produces either a normalized event
 * or an explicit exclusion carrying a coded reason — nothing is silently
 * dropped, and nothing ambiguous is quietly turned into a no-op. Two rules
 * enforce that:
 *
 *   1. A field named `quantity` never overrides contradictory event semantics.
 *   2. Ordering that is merely deterministic is never presented as observed.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 * InvestmentEvent.date is @db.Date — DAY precision. Same-day order is therefore
 * usually unknowable. `certainty: "KNOWN"` is claimed ONLY when a real datetime
 * exists; otherwise the sort is stable and reproducible but explicitly
 * `TIE_BROKEN`, so QUANTITY-1C can detect same-day uncertainty rather than
 * replaying a guess it mistook for fact. externalEventId / type / id stabilise
 * the sort; they never imply chronology.
 *
 * No corporate-action-first ordering is invented here — the local corpus has one
 * SPLIT and no evidence to justify a priority rule.
 */

import type { InvestmentEventType } from "@prisma/client";

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Whether the position of an event in the sequence is a fact or a convention. */
export type EventOrderingCertainty = "KNOWN" | "TIE_BROKEN";

/**
 * What replay may do with an event. Identity failure is deliberately distinct
 * from unsupported semantics: one is fixable by resolving an instrument, the
 * other by implementing a conversion rule. Collapsing them would hide which.
 */
export type QuantityReplayStatus =
  /** A signed delta (or a ratio) that replay may apply. */
  | "REPLAYABLE"
  /** Provably does not change quantity — e.g. a cash dividend. */
  | "NEUTRAL"
  /** Cannot be attributed to an instrument. */
  | "UNATTRIBUTABLE"
  /** The event kind, or its sign convention, is not resolvable from evidence. */
  | "UNSUPPORTED_SEMANTICS"
  /** Structurally broken — non-finite quantity, missing required ratio. */
  | "INVALID";

/** Stable, greppable reasons. Declaration order is emission order. */
export const QUANTITY_EVENT_REASONS = [
  "CASH_DIVIDEND",
  "NO_INSTRUMENT",
  "NON_FINITE_QUANTITY",
  "MISSING_QUANTITY",
  "MISSING_RATIO",
  "SIGN_CONVENTION_UNRESOLVED",
  "CONVERSION_NOT_IMPLEMENTED",
  "UNKNOWN_EVENT_TYPE",
] as const;
export type QuantityEventReason = (typeof QUANTITY_EVENT_REASONS)[number];

export interface QuantityEventOrder {
  /** The provider's real instant, when one exists. Null ⇒ day precision only. */
  effectiveDateTimeISO: string | null;
  /** Stable sort key. Reproducible, but NOT a claim about chronology. */
  deterministicKey:     string;
  certainty:            EventOrderingCertainty;
}

/** The source row this module reads. A projection, not the Prisma model. */
export interface QuantityEventSource {
  id:                  string;
  financialAccountId:  string;
  instrumentId:        string | null;
  type:                InvestmentEventType | string;
  dateISO:             string;
  datetimeISO:         string | null;
  quantity:            number | null;
  ratio:               number | null;
  source:              string;
  externalEventId:     string | null;
  relatedInstrumentId: string | null;
}

export interface NormalizedQuantityEvent {
  eventId:            string;
  accountId:          string;
  instrumentId:       string | null;
  sourceType:         string;
  /** The provider's value, VERBATIM — preserved for reconciliation and debugging. */
  sourceQuantity:     number | null;
  /** Signed effect on holdings. Null unless REPLAYABLE with a delta. */
  normalizedDelta:    number | null;
  /** Split/reverse-split ratio. Null unless a ratio event. */
  ratio:              number | null;
  dateISO:            string;
  order:              QuantityEventOrder;
  status:             QuantityReplayStatus;
  /** Null only when status is REPLAYABLE. */
  reason:             QuantityEventReason | null;
  provenance:         string;
  externalEventId:    string | null;
}

export interface NormalizationAudit {
  events:          NormalizedQuantityEvent[];
  totalInput:      number;
  byStatus:        Record<QuantityReplayStatus, number>;
  /** Rows dropped BEFORE normalization (deleted / superseded), counted not hidden. */
  excludedInactive: number;
  /** Rows dropped as exact duplicates of an already-seen identity. */
  excludedDuplicate: number;
  /** Events sharing (instrument, date) with at least one other — replay must care. */
  sameDayCollisions: number;
  /** Distinct (instrument, date) groups holding more than one event. */
  collisionGroups: number;
  /** Collision groups where EVERY member carries a real datetime. */
  collisionGroupsWithKnownOrder: number;
  /** Events violating the replay-operator XOR. MUST be 0. */
  operatorInvariantViolations: number;
}

// ── Mapping, derived from an audit of the real corpus ────────────────────────

/**
 * SIGN CONVENTION, measured over the 50 active local events — NOT assumed from
 * the schema comment, which claims "+ units in / − units out" and does not match
 * what the data does:
 *
 *   BUY          12/12 quantity POSITIVE, amount negative  → magnitude; type gives direction
 *   SELL         10/10 quantity POSITIVE, amount positive  → magnitude; type gives direction
 *   TRANSFER_IN   2/2  quantity NEGATIVE, amount positive  → CONTRADICTS its own type
 *   TRANSFER_OUT  1/1  quantity NEGATIVE, amount negative  → matches the schema doc,
 *                                                            but not the BUY/SELL rule
 *
 * BUY and SELL are internally consistent across 22 rows: the field is a
 * magnitude and the TYPE supplies direction. Confident.
 *
 * The transfer family is not. Under the BUY/SELL rule TRANSFER_IN would become
 * negative (wrong way); under the schema rule SELL would become positive (also
 * wrong way). Two conventions coexist in one table and three rows cannot settle
 * which governs transfers. Rather than guess — and a guess here silently moves
 * shares between accounts — transfers are UNSUPPORTED_SEMANTICS with
 * SIGN_CONVENTION_UNRESOLVED. Resolving it belongs to the provider-adapter
 * audit (QUANTITY-1F), where the Plaid mapping can be read directly.
 */
const MAGNITUDE_WITH_TYPE_DIRECTION: Record<string, 1 | -1> = {
  BUY:  1,
  SELL: -1,
};

/** Event kinds that change quantity but whose conversion is not implemented. */
const CONVERSION_KINDS = new Set(["MERGER", "SPIN_OFF", "SYMBOL_CHANGE", "REINVESTMENT"]);

/** Event kinds that never touch security units. */
const CASH_ONLY_KINDS = new Set([
  "CONTRIBUTION", "WITHDRAWAL", "INTEREST", "CAPITAL_GAIN", "FEE", "TAX",
]);

/** Transfers — real quantity effects whose sign convention is unresolved. */
const TRANSFER_KINDS = new Set(["TRANSFER_IN", "TRANSFER_OUT"]);

/**
 * REPLAY-OPERATOR XOR. A replayable event carries EXACTLY ONE operator: a signed
 * delta, or a ratio. Never both, never neither.
 *
 * Both would let replay apply a movement twice under two different rules; neither
 * would let a REPLAYABLE event silently do nothing — the quietest way for a
 * corporate action to vanish. The two private constructors below make the invalid
 * combinations unconstructible rather than merely tested for, and
 * hasSingleReplayOperator is exported so the audit can assert it over real data.
 */
export function hasSingleReplayOperator(e: NormalizedQuantityEvent): boolean {
  const hasDelta = e.normalizedDelta !== null;
  const hasRatio = e.ratio !== null;
  return e.status === "REPLAYABLE" ? (hasDelta !== hasRatio) : (!hasDelta && !hasRatio);
}

/** Normalize -0 to 0. `Object.is(-0, 0)` is false, so -0 would break byte-equality. */
function noNegativeZero(n: number): number {
  return n === 0 ? 0 : n;
}

function replayableDelta(src: QuantityEventSource, delta: number): NormalizedQuantityEvent {
  return {
    eventId: src.id, accountId: src.financialAccountId, instrumentId: src.instrumentId,
    sourceType: String(src.type), sourceQuantity: src.quantity,
    normalizedDelta: noNegativeZero(delta), ratio: null,
    dateISO: src.dateISO, order: orderOf(src), status: "REPLAYABLE", reason: null,
    provenance: src.source, externalEventId: src.externalEventId,
  };
}

function replayableRatio(src: QuantityEventSource, ratio: number): NormalizedQuantityEvent {
  return {
    eventId: src.id, accountId: src.financialAccountId, instrumentId: src.instrumentId,
    sourceType: String(src.type), sourceQuantity: src.quantity,
    normalizedDelta: null, ratio,
    dateISO: src.dateISO, order: orderOf(src), status: "REPLAYABLE", reason: null,
    provenance: src.source, externalEventId: src.externalEventId,
  };
}

function excluded(
  src: QuantityEventSource, status: QuantityReplayStatus, reason: QuantityEventReason,
): NormalizedQuantityEvent {
  return {
    eventId: src.id, accountId: src.financialAccountId, instrumentId: src.instrumentId,
    sourceType: String(src.type), sourceQuantity: src.quantity,
    // A non-replayable event exposes NO operator. The provider's raw ratio stays
    // out of the normalized shape so replay cannot pick it up by accident;
    // sourceQuantity preserves the evidence that matters for diagnostics.
    normalizedDelta: null, ratio: null,
    dateISO: src.dateISO, order: orderOf(src),
    status, reason, provenance: src.source, externalEventId: src.externalEventId,
  };
}

function orderOf(src: QuantityEventSource): QuantityEventOrder {
  // The key is stable and reproducible. It is NOT chronology: only a real
  // datetime upgrades certainty to KNOWN.
  const deterministicKey = [
    src.dateISO,
    src.datetimeISO ?? "",
    String(src.type),
    src.source,
    src.externalEventId ?? "",
    src.id,
  ].join("|");
  return {
    effectiveDateTimeISO: src.datetimeISO,
    deterministicKey,
    certainty: src.datetimeISO ? "KNOWN" : "TIE_BROKEN",
  };
}

/**
 * Normalize ONE source row. Pure and total: every input yields an inspectable
 * outcome, never a silent drop.
 *
 * Order of checks is deliberate — identity before semantics before structure, so
 * an unattributable MERGER reports the identity problem (the thing that must be
 * fixed first) rather than the conversion gap.
 */
export function normalizeQuantityEvent(src: QuantityEventSource): NormalizedQuantityEvent {
  const type = String(src.type);

  if (src.instrumentId === null) return excluded(src, "UNATTRIBUTABLE", "NO_INSTRUMENT");

  if (src.quantity !== null && !Number.isFinite(src.quantity)) {
    return excluded(src, "INVALID", "NON_FINITE_QUANTITY");
  }
  if (src.ratio !== null && !Number.isFinite(src.ratio)) {
    return excluded(src, "INVALID", "MISSING_RATIO");
  }

  // A cash dividend is PROVEN not to create units: all 24 local DIVIDEND rows
  // are providerType "cash", subtype "dividend", with quantity 0 or null and a
  // positive cash amount. A reinvestment would carry real units and does not
  // occur here — so no reinvestment mapping is invented for a case with no
  // evidence. A DIVIDEND that ever arrives WITH units is ambiguous by
  // construction and is reported, not assumed.
  if (type === "DIVIDEND") {
    if (src.quantity === null || src.quantity === 0) {
      return excluded(src, "NEUTRAL", "CASH_DIVIDEND");
    }
    return excluded(src, "UNSUPPORTED_SEMANTICS", "SIGN_CONVENTION_UNRESOLVED");
  }

  if (CASH_ONLY_KINDS.has(type)) return excluded(src, "NEUTRAL", "CASH_DIVIDEND");

  if (TRANSFER_KINDS.has(type)) {
    return excluded(src, "UNSUPPORTED_SEMANTICS", "SIGN_CONVENTION_UNRESOLVED");
  }

  if (type === "SPLIT" || type === "REVERSE_SPLIT") {
    // The single local SPLIT has ratio NULL and quantity 10 — the ratio field
    // exists and is unpopulated, so whether 10 is the resulting share count or
    // the added shares is unknowable. A split replayed with the wrong reading
    // is off by the entire ratio, so this is INVALID until the ratio is present.
    if (src.ratio === null || src.ratio <= 0) return excluded(src, "INVALID", "MISSING_RATIO");
    return replayableRatio(src, src.ratio);
  }

  if (CONVERSION_KINDS.has(type)) {
    return excluded(src, "UNSUPPORTED_SEMANTICS", "CONVERSION_NOT_IMPLEMENTED");
  }

  const direction = MAGNITUDE_WITH_TYPE_DIRECTION[type];
  if (direction === undefined) {
    // OPENING_BALANCE, CANCEL, ADJUSTMENT, OTHER, UNKNOWN and any enum member
    // added later. Reported, never silently NEUTRAL — a new provider type that
    // moved shares must not vanish into a no-op.
    return excluded(src, "UNSUPPORTED_SEMANTICS", "UNKNOWN_EVENT_TYPE");
  }
  if (src.quantity === null) return excluded(src, "INVALID", "MISSING_QUANTITY");
  if (src.quantity === 0)    return excluded(src, "NEUTRAL", "CASH_DIVIDEND");

  // BUY/SELL carry a MAGNITUDE; the type supplies direction. A negative source
  // value contradicts that measured convention (0/22 locally), so it is
  // reported rather than double-negated into a plausible-looking number.
  if (src.quantity < 0) {
    return excluded(src, "UNSUPPORTED_SEMANTICS", "SIGN_CONVENTION_UNRESOLVED");
  }

  return replayableDelta(src, src.quantity * direction);
}

/**
 * Identity for de-duplication.
 *
 * `(source, externalEventId)` mirrors the database's own unique constraint and
 * is used ONLY when both are present. Otherwise the row id is the identity —
 * two distinct rows with null externalEventId are two distinct events, and
 * collapsing them would silently delete a real movement.
 */
export function quantityEventIdentity(src: QuantityEventSource): string {
  return src.externalEventId ? `x:${src.source}|${src.externalEventId}` : `id:${src.id}`;
}

/**
 * Normalize a batch: exclude inactive rows, de-duplicate by identity, sort
 * deterministically, and report what happened to everything.
 *
 * Deterministic: sorting is by `deterministicKey` alone, which is a total order
 * over distinct rows, so shuffled input yields byte-identical output.
 */
export function normalizeQuantityEvents(
  sources: readonly (QuantityEventSource & { deletedAt?: unknown; supersededById?: unknown })[],
): NormalizationAudit {
  const active = sources.filter((s) => s.deletedAt == null && s.supersededById == null);
  const excludedInactive = sources.length - active.length;

  const seen = new Set<string>();
  const kept: QuantityEventSource[] = [];
  let excludedDuplicate = 0;
  for (const s of active) {
    const identity = quantityEventIdentity(s);
    if (seen.has(identity)) { excludedDuplicate++; continue; }
    seen.add(identity);
    kept.push(s);
  }

  const events = kept
    .map(normalizeQuantityEvent)
    .sort((a, b) => (a.order.deterministicKey < b.order.deterministicKey ? -1
                   : a.order.deterministicKey > b.order.deterministicKey ? 1 : 0));

  const byStatus: Record<QuantityReplayStatus, number> = {
    REPLAYABLE: 0, NEUTRAL: 0, UNATTRIBUTABLE: 0, UNSUPPORTED_SEMANTICS: 0, INVALID: 0,
  };
  for (const e of events) byStatus[e.status]++;

  // Same-day collisions matter to replay: without a datetime their true order is
  // unknowable, and this count is what lets QUANTITY-1C notice.
  const perDay = new Map<string, number>();
  for (const e of events) {
    const k = `${e.instrumentId ?? "null"}|${e.dateISO}`;
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }
  const sameDayCollisions = events.filter(
    (e) => (perDay.get(`${e.instrumentId ?? "null"}|${e.dateISO}`) ?? 0) > 1,
  ).length;

  const groups = [...perDay.entries()].filter(([, n]) => n > 1);
  const knownOrderGroups = groups.filter(([k]) =>
    events.filter((e) => `${e.instrumentId ?? "null"}|${e.dateISO}` === k)
      .every((e) => e.order.certainty === "KNOWN")).length;

  return {
    events, totalInput: sources.length, byStatus, excludedInactive, excludedDuplicate,
    sameDayCollisions,
    collisionGroups: groups.length,
    collisionGroupsWithKnownOrder: knownOrderGroups,
    operatorInvariantViolations: events.filter((e) => !hasSingleReplayOperator(e)).length,
  };
}
