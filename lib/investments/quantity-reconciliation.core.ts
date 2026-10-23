/**
 * lib/investments/quantity-reconciliation.core.ts
 *
 * V26-QUANTITY-1D — reconciliation evidence and candidate explanations. PURE:
 * no Prisma, no network, no clock. Consumes a `QuantityTimeline` produced by
 * QUANTITY-1C/1C.1 and the QUANTITY-1B events that produced it. It replays
 * nothing and defines no competing engine.
 *
 * ── The distinction this module exists to hold ──────────────────────────────
 *
 * When replay reaches 15 and the observation says 99, there are two entirely
 * different things one can say about the difference:
 *
 *   OBSERVED FACT        "no opening anchor exists", "an unsupported transfer
 *                        lies in this interval", "the stream is not declared
 *                        complete". Read off the timeline. Not inferred.
 *
 *   CANDIDATE EXPLANATION  "84 happens to equal the magnitude of that transfer".
 *                        This is arithmetic coincidence. It may well be the
 *                        cause; it is not evidence that it is. A residue of 2.0
 *                        next to a transfer of 2.0 stays a coincidence until
 *                        something independent corroborates it.
 *
 * Every candidate therefore names the others it competes with, carries the ids
 * that support it, and is `WEAK` until a second independent signal exists. None
 * may become a quantity event, an anchor, or a correction: this module emits
 * readings of evidence, never evidence.
 *
 * UNEXPLAINED is the honest default and by far the most common outcome.
 */

import type { NormalizedQuantityEvent } from "./quantity-event.core";
import { licensedCoverage, type QuantityTimeline } from "./quantity-replay.core";

const DEFAULT_TOLERANCE = 1e-6;

// ── A. Observed facts ────────────────────────────────────────────────────────

/**
 * Things that are TRUE of the timeline, each readable without inference. Order
 * of declaration is the emission order — deterministic, and roughly "most
 * structural first".
 */
export const OBSERVED_FACT_KINDS = [
  "MISSING_OPENING_ANCHOR",
  "AMBIGUOUS_SAME_DAY_ANCHOR",
  "BLOCKED_INTERVAL",
  "UNSUPPORTED_TRANSFER_PRESENT",
  "INVALID_EVENT_PRESENT",
  "UNATTRIBUTABLE_EVENT_PRESENT",
  "ORDER_SENSITIVE_GROUP_PRESENT",
  "STREAM_COMPLETENESS_UNKNOWN",
  "STREAM_COMPLETENESS_PARTIAL",
  "UNCOVERED_INTERVAL_PRESENT",
  "ANCHOR_MISMATCH",
  "REJECTED_DERIVED_ANCHOR",
] as const;
export type ObservedFactKind = (typeof OBSERVED_FACT_KINDS)[number];

export interface ObservedFact {
  kind:        ObservedFactKind;
  /** Event ids, observation ids or ISO intervals — whatever evidences the fact. */
  evidenceIds: string[];
  detail:      string;
}

// ── B. Candidate explanations ────────────────────────────────────────────────

export const CANDIDATE_KINDS = [
  "MISSING_PREHISTORY_CONSISTENT",
  "MISSING_EVENTS_CONSISTENT",
  "TRANSFER_MAGNITUDE_MATCH",
  "SIGN_INVERSION_CONSISTENT",
  "SPLIT_RATIO_CONSISTENT",
] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export interface CandidateExplanation {
  kind:                     CandidateKind;
  supportingEventIds:       string[];
  supportingObservationIds: string[];
  /**
   * How the candidate was arrived at. There is exactly one value today, and
   * that is the point: nothing in the codebase yet supplies a second,
   * independent signal, so no candidate can currently claim more.
   */
  basis:                    "ARITHMETIC_COINCIDENCE" | "STRUCTURAL_ABSENCE";
  /**
   * WEAK until independently corroborated — a transfer whose counterpart
   * instrument and date both align, or a split confirmed by a corporate-action
   * source. Nothing supplies either yet, so nothing is CORROBORATED today.
   */
  confidence:               "WEAK" | "CORROBORATED";
  /** The other candidates offered for the same difference. */
  competingWith:            CandidateKind[];
  detail:                   string;
}

/** A difference between what replay says and what an observation says. */
export interface ResidueReading {
  observationId: string;
  dateISO:       string;
  /** What the licensed absolute interval claimed on that date. */
  expected:      number;
  /** What the observation states. */
  observed:      number;
  residue:       number;
  candidates:    CandidateExplanation[];
  verdict:       "UNEXPLAINED" | "CANDIDATES_AVAILABLE";
}

/**
 * An absolute observation set against the movement actually recorded before it.
 *
 * Deliberately NOT called an opening quantity. When the stream is not declared
 * complete, the difference has at least two incompatible readings — holdings
 * that predate recorded history, or movements never imported — and nothing in
 * the timeline distinguishes them. Naming it "opening" would pick one.
 */
export interface UnattributedDifference {
  observationId:   string;
  dateISO:         string;
  observedQuantity: number;
  /** Σ of replayable deltas strictly before the observation's date. */
  recordedMovement: number;
  difference:      number;
  candidates:      CandidateExplanation[];
  verdict:         "UNEXPLAINED" | "CANDIDATES_AVAILABLE";
}

// ── C. Back-solved opening quantity ──────────────────────────────────────────

export const BACK_SOLVE_REFUSALS = [
  "NO_PERMITTED_LATER_ANCHOR",
  "NO_RECORDED_MOVEMENT",
  "STREAM_NOT_COMPLETE",
  "STREAM_DOES_NOT_SPAN_INTERVAL",
  "BLOCKED_INTERVAL",
  "ORDER_SENSITIVE_INTERVAL",
  "NON_FINITE_ARITHMETIC",
] as const;
export type BackSolveRefusal = (typeof BACK_SOLVE_REFUSALS)[number];

/**
 * `anchorQuantity − cumulativeDelta`, emitted only when every gate passes.
 *
 * A derived implication, never evidence. The literal types make that
 * structural: `origin` can only be "DERIVED", which
 * `PERMITTED_ANCHOR_ORIGINS` rejects, so this value cannot be fed back into
 * replay as an anchor even by accident. It licenses no valuation before the
 * first event and upgrades no UNKNOWN prehistory to KNOWN.
 */
export interface BackSolvedOpening {
  quantity:                 number;
  /** The date the implied opening applies to — the first recorded movement. */
  asOfISO:                  string;
  basis:                    "BACK_SOLVED";
  origin:                   "DERIVED";
  completeness:             "derived";
  derivedFromObservationId: string;
  derivedFromEventIds:      string[];
}

// ── Report ───────────────────────────────────────────────────────────────────

export type ReconciliationSummary =
  /** Nothing to say: no facts, no residues, no unattributed difference. */
  | "CLEAN"
  /** Structural facts only — no numeric disagreement anywhere. */
  | "FACTS_ONLY"
  /** At least one residue or unattributed difference exists. */
  | "DIFFERENCES_PRESENT";

export interface ReconciliationReport {
  instrumentId:            string;
  accountId:               string;
  windowFromISO:           string;
  windowToISO:             string;
  facts:                   ObservedFact[];
  residues:                ResidueReading[];
  unattributedDifferences: UnattributedDifference[];
  backSolved:              BackSolvedOpening | null;
  backSolveRefusals:       BackSolveRefusal[];
  summary:                 ReconciliationSummary;
}

export interface ReconcileInput {
  timeline:   QuantityTimeline;
  /** The same QUANTITY-1B events the timeline was built from. */
  events:     readonly NormalizedQuantityEvent[];
  tolerance?: number;
}

// ── Candidate matching (structural tests, never magnitude thresholds) ─────────

/**
 * Ratios a corporate action plausibly takes. Bounded and explicit: an open
 * search over rationals would "explain" any difference at all, which is the
 * opposite of evidence.
 */
const PLAUSIBLE_SPLIT_RATIOS: ReadonlyArray<{ ratio: number; label: string }> = [
  { ratio: 2,    label: "2:1" },
  { ratio: 3,    label: "3:1" },
  { ratio: 4,    label: "4:1" },
  { ratio: 5,    label: "5:1" },
  { ratio: 10,   label: "10:1" },
  { ratio: 20,   label: "20:1" },
  { ratio: 1 / 2,  label: "1:2 reverse" },
  { ratio: 1 / 3,  label: "1:3 reverse" },
  { ratio: 1 / 4,  label: "1:4 reverse" },
  { ratio: 1 / 5,  label: "1:5 reverse" },
  { ratio: 1 / 10, label: "1:10 reverse" },
  { ratio: 1 / 20, label: "1:20 reverse" },
  { ratio: 3 / 2,  label: "3:2" },
];

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/**
 * Offer every reading the arithmetic permits, then let each name the others.
 *
 * The competing list is what keeps this honest: a lone plausible explanation
 * reads as a diagnosis, whereas three explanations that all fit read as what
 * they are — an unresolved question with several possible answers.
 */
function candidatesFor(
  difference: number,
  opts: {
    blockedTransfers: readonly NormalizedQuantityEvent[];
    missingOpeningAnchor: boolean;
    streamComplete: boolean;
    expected: number | null;
    observed: number | null;
    observationId: string | null;
    tolerance: number;
  },
): CandidateExplanation[] {
  const { tolerance: tol } = opts;
  const found: Array<Omit<CandidateExplanation, "competingWith">> = [];
  const obsIds = opts.observationId ? [opts.observationId] : [];

  if (near(difference, 0, tol)) return [];

  // ── structural absences ────────────────────────────────────────────────
  if (opts.missingOpeningAnchor) {
    found.push({
      kind: "MISSING_PREHISTORY_CONSISTENT",
      supportingEventIds: [], supportingObservationIds: obsIds,
      basis: "STRUCTURAL_ABSENCE", confidence: "WEAK",
      detail: "no permitted anchor precedes the first recorded movement, so the " +
        "difference is consistent with holdings that predate recorded history",
    });
  }
  if (!opts.streamComplete) {
    found.push({
      kind: "MISSING_EVENTS_CONSISTENT",
      supportingEventIds: [], supportingObservationIds: obsIds,
      basis: "STRUCTURAL_ABSENCE", confidence: "WEAK",
      detail: "the event stream is not declared complete over this interval, so the " +
        "difference is equally consistent with movements that were never imported",
    });
  }

  // ── arithmetic coincidences ────────────────────────────────────────────
  for (const t of opts.blockedTransfers) {
    const q = t.sourceQuantity;
    if (q === null || !Number.isFinite(q)) continue;
    if (near(Math.abs(difference), Math.abs(q), tol)) {
      found.push({
        kind: "TRANSFER_MAGNITUDE_MATCH",
        supportingEventIds: [t.eventId], supportingObservationIds: obsIds,
        basis: "ARITHMETIC_COINCIDENCE", confidence: "WEAK",
        detail: `|difference| ${Math.abs(difference)} equals the magnitude of unresolved ` +
          `${t.sourceType} ${t.eventId} (${q}) — a numeric match, not a demonstrated cause`,
      });
    }
    // A flipped sign shows up as twice the magnitude: the value was subtracted
    // where it should have been added, or the reverse.
    if (near(Math.abs(difference), Math.abs(2 * q), tol)) {
      found.push({
        kind: "SIGN_INVERSION_CONSISTENT",
        supportingEventIds: [t.eventId], supportingObservationIds: obsIds,
        basis: "ARITHMETIC_COINCIDENCE", confidence: "WEAK",
        detail: `|difference| ${Math.abs(difference)} is twice the magnitude of ` +
          `${t.sourceType} ${t.eventId} (${q}), consistent with an inverted sign — ` +
          "note InvestmentEvent stores two sign conventions (QUANTITY-1B)",
      });
    }
  }

  if (opts.expected !== null && opts.observed !== null &&
      Number.isFinite(opts.expected) && opts.expected !== 0) {
    const r = opts.observed / opts.expected;
    for (const p of PLAUSIBLE_SPLIT_RATIOS) {
      if (near(r, p.ratio, tol)) {
        found.push({
          kind: "SPLIT_RATIO_CONSISTENT",
          supportingEventIds: [], supportingObservationIds: obsIds,
          basis: "ARITHMETIC_COINCIDENCE", confidence: "WEAK",
          detail: `observed/replayed is ${r}, consistent with an unrecorded ${p.label} ` +
            "corporate action — no corporate-action source has confirmed it",
        });
        break;   // one ratio reading is enough; the list is ordered
      }
    }
  }

  const kinds = found.map((f) => f.kind);
  return found
    .map((f) => ({ ...f, competingWith: kinds.filter((k) => k !== f.kind) }))
    .sort((x, y) => CANDIDATE_KINDS.indexOf(x.kind) - CANDIDATE_KINDS.indexOf(y.kind));
}

// ── Reconcile ────────────────────────────────────────────────────────────────

/**
 * Read a timeline. Deterministic and total: identical input yields
 * byte-identical output, and every fact, residue and refusal is emitted in
 * declaration order.
 */
export function reconcileQuantityTimeline(input: ReconcileInput): ReconciliationReport {
  const { timeline: t, events } = input;
  const tol = input.tolerance ?? DEFAULT_TOLERANCE;
  const d = t.diagnostics;

  // ── A. Observed facts, in declaration order ─────────────────────────────
  const facts: ObservedFact[] = [];
  const add = (kind: ObservedFactKind, evidenceIds: string[], detail: string) =>
    facts.push({ kind, evidenceIds: [...evidenceIds].sort(), detail });

  if (d.missingOpeningAnchor) {
    add("MISSING_OPENING_ANCHOR", [], "no permitted anchor precedes the first recorded movement");
  }
  const ambiguous = d.anchorOutcomes.filter((o) => o.openingRole === "AMBIGUOUS_SAME_DAY");
  if (ambiguous.length > 0) {
    add("AMBIGUOUS_SAME_DAY_ANCHOR", ambiguous.map((o) => o.observationId),
      "an observation shares its date with an event and neither carries a timestamp");
  }
  const blocked = t.segments.filter((s) => s.kind === "UNRESOLVED");
  if (blocked.length > 0) {
    add("BLOCKED_INTERVAL", blocked.map((s) => `${s.fromISO}→${s.toISO}`),
      `${blocked.length} interval(s) where exact replay is not possible`);
  }
  if (d.unresolvedTransferEventIds.length > 0) {
    add("UNSUPPORTED_TRANSFER_PRESENT", d.unresolvedTransferEventIds,
      "transfer semantics are unresolved — QUANTITY-1B declines to guess the sign");
  }
  if (d.invalidEventIds.length > 0) {
    add("INVALID_EVENT_PRESENT", d.invalidEventIds, "an event is structurally unusable");
  }
  if (d.unattributableEventIds.length > 0) {
    add("UNATTRIBUTABLE_EVENT_PRESENT", d.unattributableEventIds,
      "an event carries no instrument and cannot be attributed to a position");
  }
  if (d.orderSensitiveGroups.length > 0) {
    add("ORDER_SENSITIVE_GROUP_PRESENT", d.orderSensitiveGroups.map((g) => g.dateISO),
      "a same-day group mixes a ratio with a delta and its chronology is unevidenced");
  }
  if (d.eventStream.kind === "UNKNOWN") {
    add("STREAM_COMPLETENESS_UNKNOWN", [], d.eventStream.reason);
  } else if (d.eventStream.kind === "PARTIAL") {
    add("STREAM_COMPLETENESS_PARTIAL", [], d.eventStream.reason);
  }
  if (t.uncovered.length > 0) {
    add("UNCOVERED_INTERVAL_PRESENT", t.uncovered.map((u) => `${u.fromISO}→${u.toISO}`),
      `${t.uncovered.length} interval(s) of the requested window that no segment speaks for`);
  }
  if (d.reconciliationResidues.length > 0) {
    add("ANCHOR_MISMATCH", d.reconciliationResidues.map((r) => r.observationId),
      "an observation disagrees with the licensed interval covering its date");
  }
  const rejected = d.anchorOutcomes.filter((o) => o.admissibility === "REJECTED_ORIGIN");
  if (rejected.length > 0) {
    add("REJECTED_DERIVED_ANCHOR", rejected.map((o) => o.observationId),
      "reconstruction output may not anchor a replay of itself");
  }

  // ── shared inputs to candidate matching ────────────────────────────────
  const blockedTransfers = events
    .filter((e) => d.unresolvedTransferEventIds.includes(e.eventId))
    .sort((x, y) => x.eventId.localeCompare(y.eventId));
  const cover = licensedCoverage(d.eventStream);
  const streamComplete = d.eventStream.kind === "COMPLETE";

  // ── B1. Residues: replay vs an observation on the same date ────────────
  const residues: ResidueReading[] = [...d.reconciliationResidues]
    .sort((x, y) => (x.dateISO < y.dateISO ? -1 : x.dateISO > y.dateISO ? 1
      : x.observationId.localeCompare(y.observationId)))
    .map((r) => {
      const candidates = candidatesFor(r.residue, {
        blockedTransfers, missingOpeningAnchor: d.missingOpeningAnchor, streamComplete,
        expected: r.expected, observed: r.observed, observationId: r.observationId, tolerance: tol,
      });
      return { ...r, candidates,
        verdict: candidates.length > 0 ? "CANDIDATES_AVAILABLE" as const : "UNEXPLAINED" as const };
    });

  // ── B2. Unattributed differences: an observation vs recorded movement ──
  // The BTC shape. Computed for the EARLIEST permitted observation that has
  // recorded movement before it, because that is where prehistory would sit.
  const replayable = [...events].filter((e) => e.status === "REPLAYABLE")
    .sort((x, y) => (x.dateISO < y.dateISO ? -1 : x.dateISO > y.dateISO ? 1 : 0));
  const usableAnchors = d.anchorOutcomes
    .filter((o) => o.admissibility === "PERMITTED")
    .sort((x, y) => (x.dateISO < y.dateISO ? -1 : x.dateISO > y.dateISO ? 1
      : x.observationId.localeCompare(y.observationId)));

  const unattributedDifferences: UnattributedDifference[] = [];
  const firstAnchor = usableAnchors[0] ?? null;
  if (firstAnchor && d.missingOpeningAnchor) {
    const before = replayable.filter((e) => e.dateISO <= firstAnchor.dateISO);
    const recordedMovement = before.reduce((n, e) => n + (e.normalizedDelta ?? 0), 0);
    const difference = firstAnchor.quantity - recordedMovement;
    if (before.length > 0 && !near(difference, 0, tol) && Number.isFinite(difference)) {
      const candidates = candidatesFor(difference, {
        blockedTransfers, missingOpeningAnchor: true, streamComplete,
        expected: recordedMovement, observed: firstAnchor.quantity,
        observationId: firstAnchor.observationId, tolerance: tol,
      });
      unattributedDifferences.push({
        observationId: firstAnchor.observationId, dateISO: firstAnchor.dateISO,
        observedQuantity: firstAnchor.quantity, recordedMovement, difference, candidates,
        verdict: candidates.length > 0 ? "CANDIDATES_AVAILABLE" : "UNEXPLAINED",
      });
    }
  }

  // ── C. Back-solve, gated ───────────────────────────────────────────────
  const refusals: BackSolveRefusal[] = [];
  let backSolved: BackSolvedOpening | null = null;
  {
    const anchor = firstAnchor;
    const before = anchor ? replayable.filter((e) => e.dateISO <= anchor.dateISO) : [];
    const movement = before.reduce((n, e) => n + (e.normalizedDelta ?? 0), 0);
    const ratioInInterval = before.some((e) => e.ratio !== null);
    const gapBefore = anchor
      ? t.segments.some((s) => s.kind === "UNRESOLVED" && s.fromISO <= anchor.dateISO)
      : false;
    const orderSensitiveBefore = anchor
      ? d.orderSensitiveGroups.some((g) => g.dateISO <= anchor.dateISO)
      : false;
    const firstMovementISO = before[0]?.dateISO ?? null;

    if (!anchor) refusals.push("NO_PERMITTED_LATER_ANCHOR");
    if (before.length === 0) refusals.push("NO_RECORDED_MOVEMENT");
    if (!streamComplete) refusals.push("STREAM_NOT_COMPLETE");
    else if (anchor && firstMovementISO && (cover === null ||
             cover.fromISO > firstMovementISO || cover.toISO < anchor.dateISO)) {
      refusals.push("STREAM_DOES_NOT_SPAN_INTERVAL");
    }
    if (gapBefore) refusals.push("BLOCKED_INTERVAL");
    if (orderSensitiveBefore) refusals.push("ORDER_SENSITIVE_INTERVAL");
    // A ratio event before the anchor makes the subtraction invalid outright:
    // holdings were multiplied, so no single delta sum inverts to an opening.
    if (ratioInInterval) refusals.push("NON_FINITE_ARITHMETIC");
    else if (anchor && (!Number.isFinite(movement) || !Number.isFinite(anchor.quantity - movement))) {
      refusals.push("NON_FINITE_ARITHMETIC");
    }

    if (refusals.length === 0 && anchor && firstMovementISO) {
      backSolved = {
        quantity: anchor.quantity - movement,
        asOfISO: firstMovementISO,
        basis: "BACK_SOLVED", origin: "DERIVED", completeness: "derived",
        derivedFromObservationId: anchor.observationId,
        derivedFromEventIds: before.map((e) => e.eventId).sort(),
      };
    }
  }
  refusals.sort((x, y) => BACK_SOLVE_REFUSALS.indexOf(x) - BACK_SOLVE_REFUSALS.indexOf(y));

  const summary: ReconciliationSummary =
    residues.length > 0 || unattributedDifferences.length > 0 ? "DIFFERENCES_PRESENT"
    : facts.length > 0 ? "FACTS_ONLY" : "CLEAN";

  return {
    instrumentId: t.instrumentId, accountId: t.accountId,
    windowFromISO: t.windowFromISO, windowToISO: t.windowToISO,
    facts, residues, unattributedDifferences, backSolved,
    backSolveRefusals: refusals, summary,
  };
}
