/**
 * lib/forecast/stream-activity.ts
 *
 * FORECAST-2 — MAY WE ASSUME IT CONTINUES?
 *
 * Pure: no DB, no model, no clock of its own, no persistence. Substrate only.
 *
 * ── The two facts that are not one fact ─────────────────────────────────────
 * FORECAST-1 answers WHEN a stream would occur if it continues. It is a
 * calendar, and a calendar cannot know the job ended. Asked for September 2026,
 * it will happily produce the 10th and the 25th for a payroll whose last
 * payment was in December.
 *
 *   Abacus payroll · 35 observations · SEMIMONTHLY on the 10th and 25th
 *   last settlement 2025-12-24 · nothing since · the job ended
 *
 * The strength of that historical cadence is an argument for the SHAPE of the
 * schedule and no argument at all for its CONTINUATION. This module owns the
 * second question, and owns it separately, so that no future forecast can turn
 * a schedule into expected cash just because dates came out of a generator.
 *
 * ── The load-bearing precondition: silence must be observable ───────────────
 * Absence of payments has two completely different causes:
 *
 *   the stream stopped                    ← evidence about the income
 *   we stopped seeing the account         ← evidence about the feed
 *
 * Reading the second as the first is how a working paycheck becomes "ended".
 * So silence counts ONLY inside the ledger's observed reach, and an occurrence
 * the ledger has not yet arrived at is not missed — it is unobserved. This is
 * the same distinction `lib/freshness/observation.ts` draws when it refuses to
 * call ledger coverage "staleness".
 *
 * Measured on the real Space, this precondition is satisfied for the motivating
 * case and satisfied decisively: the very account that stopped paying Abacus
 * carries 180 further transactions and a ledger reaching 2026-08-25. The feed
 * was looking. The silence is about the job.
 *
 * ── What this module does NOT decide ────────────────────────────────────────
 * Not the amount, not the basis, not whether the stream is payroll rather than
 * interest. "Periodic" and "operating income" are different concepts and this
 * authority deliberately answers only the first — a monthly interest posting is
 * projection-eligible as a SCHEDULE, which is not a claim that it is salary.
 */

import { addDays, daysBetween } from './_time';
import {
  CadenceProvenance, isCadence, occurrencesBetween,
  type Cadence, type CadenceResult, type CadenceProvenanceKind,
} from './cadence';

/**
 * Whether the evidence licenses assuming this stream continues.
 *
 * The smallest machine the evidence supports. Four states, and the middle two
 * are the point:
 *
 *   CURRENT   every occurrence the ledger could have seen was paid.
 *   SILENT    the ledger covered occurrences and none were paid. The cadence is
 *             intact; what is missing is a reason to project it forward.
 *   ENDED     something positively established termination.
 *   UNKNOWN   the evidence cannot decide — usually because silence was never
 *             observable in the first place.
 *
 * ⚠️ SILENT IS NOT ENDED. Payments stopping is not proof a stream stopped: a
 * payroll can skip, a feed can lag, an employer can pay late. SILENT withholds
 * the projection and asserts nothing about employment, and it recovers on its
 * own the moment a payment lands. Only positive evidence reaches ENDED, and
 * today the only positive evidence that exists is the user saying so.
 *
 * One SILENT state carries both "missed one" and "missed fifteen" because the
 * consequence is identical — neither may project — and the count travels on the
 * result for anyone who needs to say which. A second state would be vocabulary
 * without a decision behind it.
 */
export const ActivityState = {
  CURRENT: 'CURRENT',
  SILENT:  'SILENT',
  ENDED:   'ENDED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ActivityStateName = typeof ActivityState[keyof typeof ActivityState];

/**
 * What the user said about this stream, in this interaction.
 *
 * NEVER PERSISTED. No safe authority for storing per-stream employment state
 * exists — `User.employmentStatus` is a registration-time profile field with no
 * stream identity at all (measured: every user in the corpus reads EMPLOYED,
 * including the one whose payroll ended) — so this travels as an argument and
 * dies with the call. Inventing a table for it would be persisting speculative
 * employment state, which is precisely what this slice must not do.
 */
export interface UserAssertion {
  /** CONTINUES: "I still work there." ENDED: "I left that job." */
  kind: 'CONTINUES' | 'ENDED';
  /** When the user said it. An assertion is itself an observation with a date. */
  assertedOnISO: string;
}

/** Everything the resolver is allowed to look at. */
export interface ActivityEvidence {
  cadence: CadenceResult;
  /** Observed settlement dates for THIS stream — one account, one source. */
  settlements: readonly string[];
  /**
   * The newest transaction of ANY kind on the account: how far the ledger
   * reaches. Null when nobody looked, which makes silence unreadable.
   */
  observedThroughISO: string | null;
  asOfISO: string;
  assertion?: UserAssertion;
}

/** The deterministic answer. */
export interface StreamActivity {
  state: ActivityStateName;
  /**
   * ⚠️ THE CONTRACT. Future-cash generation must consult this and nothing else.
   * `occurrencesBetween` producing dates is not, and must never become, a
   * statement that those dates are expected income.
   */
  mayGenerateExpectedOccurrences: boolean;
  provenance: CadenceProvenanceKind;
  reason: string;
  /** Scheduled occurrences the ledger covered and no settlement satisfied. */
  missedOccurrences: number | null;
  /**
   * The schedule slot the newest settlement satisfied — NOT the settlement.
   * A payment on the 24th satisfies the 25th; it does not move the schedule.
   */
  lastSatisfiedOccurrenceISO: string | null;
  /** The newest observed settlement itself, carried separately on purpose. */
  lastObservedSettlementISO: string | null;
  /** How far silence was readable. Beyond this, absence proves nothing. */
  observedThroughISO: string | null;
  sourceKey?: string;
}

// ── Thresholds, measured rather than chosen ─────────────────────────────────

export const ACTIVITY = {
  /**
   * How far a settlement may land from its scheduled day and still satisfy it.
   *
   * MEASURED, not picked: across all five cadences in the live ledger — 99
   * scheduled slots — the largest deviation between a scheduled day and the
   * settlement that satisfied it is exactly 3 days (mid-month interest posting
   * forward onto a business day). Observed range −2..+3.
   *
   * A shift longer than this reads as a miss, which withholds a projection
   * rather than inventing one — so the error this tolerance can cause runs in
   * the safe direction. That is also why no holiday calendar is built here: the
   * evidence does not require one, and being wrong costs a withheld projection.
   */
  SETTLEMENT_TOLERANCE_DAYS: 3,
  /**
   * How many observed misses a stream may have and still project.
   *
   * MEASURED: across those same 99 slots on five real streams, the number of
   * scheduled occurrences that were skipped is ZERO. Healthy streams in this
   * corpus do not miss. A stream that misses an occurrence the ledger fully
   * covered is therefore behaving unlike anything observed, and the honest
   * response is to stop projecting rather than to average over it.
   *
   * ⚠️ This is a threshold for PROJECTING, never for concluding termination.
   * One miss and fifteen misses are both non-projectable; neither is ENDED.
   */
  MAX_MISSED_FOR_PROJECTION: 0,
} as const;

// ── Dates ───────────────────────────────────────────────────────────────────
// V26-REASONING Slice 0 — these were local copies, and the local `daysBetween`
// ran (a, b) => a − b, the OPPOSITE direction from the two other functions of
// that name. Its single use below is wrapped in `Math.abs`, so the inversion
// cancelled and nothing was ever wrong; the name was.

const shift = addDays;

// ── Schedule versus settlement ──────────────────────────────────────────────

/**
 * The scheduled occurrence a settlement satisfies, or null if it satisfies none.
 *
 * ⚠️ These are two facts and conflating them is a real, measured error. Abacus
 * is scheduled on the 10th and the 25th; its last payment settled 2025-12-24.
 * Treating that settlement as the schedule makes 2025-12-25 look like a MISSED
 * occurrence when it is in fact the very payment observed — and FORECAST-1's
 * `missedSinceAnchor`, which counts from the settlement, reports exactly that
 * phantom. A business-day shift is evidence FOR the occurrence, never a
 * mutation of the schedule.
 */
export function occurrenceSatisfiedBy(cadence: Cadence, settlementISO: string): string | null {
  const tol = ACTIVITY.SETTLEMENT_TOLERANCE_DAYS;
  const near = occurrencesBetween(cadence, shift(settlementISO, -tol), shift(settlementISO, tol));
  let best: string | null = null, bestDist = Infinity;
  for (const slot of near) {
    const d = Math.abs(daysBetween(settlementISO, slot));
    if (d < bestDist) { bestDist = d; best = slot; }
  }
  return best;
}

/**
 * Scheduled occurrences after `afterOccurrenceISO` that the ledger fully
 * covered and that no settlement satisfied.
 *
 * "Fully covered" means the ledger reaches past the point where a shifted
 * payment could still have landed — slot + tolerance. An occurrence scheduled
 * for the 28th is not missing on the 25th; nobody has looked yet.
 *
 * ⚠️ This is the observation-relative measure the activity decision runs on.
 * FORECAST-1's `missedSinceAnchor` is NOT sufficient for it: that counts from
 * the settlement rather than the satisfied slot, and it counts occurrences the
 * ledger has not reached. On Abacus at 2026-08-27 it reports 17; the observable
 * truth is 15. Both of its errors overstate silence, so its verdict happened to
 * be right for the wrong reasons — which is not a property to build on.
 */
export function missedOccurrencesSince(
  cadence: Cadence, afterOccurrenceISO: string, observedThroughISO: string,
): string[] {
  const horizon = shift(observedThroughISO, -ACTIVITY.SETTLEMENT_TOLERANCE_DAYS);
  const from = shift(afterOccurrenceISO, 1);
  if (from > horizon) return [];
  return occurrencesBetween(cadence, from, horizon);
}

// ── The decision ────────────────────────────────────────────────────────────

const unknown = (
  reason: string, sourceKey?: string, partial: Partial<StreamActivity> = {},
): StreamActivity => ({
  state: ActivityState.UNKNOWN,
  mayGenerateExpectedOccurrences: false,
  provenance: CadenceProvenance.DERIVED,
  reason, missedOccurrences: null,
  lastSatisfiedOccurrenceISO: null, lastObservedSettlementISO: null,
  observedThroughISO: null, sourceKey, ...partial,
});

/**
 * Resolve whether a stream may be projected forward.
 *
 * Evidence hierarchy, strongest first:
 *
 *   1. an explicit user assertion — the only positive evidence of continuation
 *      or termination that exists anywhere in this system;
 *   2. observed silence, but ONLY within the ledger's reach;
 *   3. nothing else. There is no employer feed, no provider-attested future
 *      income, and no termination signal in the schema.
 */
export function resolveStreamActivity(evidence: ActivityEvidence): StreamActivity {
  const { cadence, settlements, observedThroughISO, asOfISO, assertion } = evidence;
  const sourceKey = cadence.sourceKey;

  // A termination assertion is decisive and needs no cadence to be true.
  if (assertion?.kind === 'ENDED') {
    return {
      ...unknown('', sourceKey),
      state: ActivityState.ENDED,
      mayGenerateExpectedOccurrences: false,
      provenance: CadenceProvenance.USER_ASSERTED,
      reason: `the user stated on ${assertion.assertedOnISO} that this income ended`,
      lastObservedSettlementISO: settlements.length ? [...settlements].sort().at(-1)! : null,
      observedThroughISO,
    };
  }

  // No schedule, nothing to project. An assertion cannot manufacture one:
  // "I still work there" is a fact about employment, not about pay dates.
  if (!isCadence(cadence)) {
    return unknown(
      'no cadence could be established, so there is no schedule to project'
      + (assertion?.kind === 'CONTINUES'
        ? '. The user states the income continues, which establishes that it exists but not when it arrives'
        : ''),
      sourceKey,
      { provenance: assertion ? CadenceProvenance.USER_ASSERTED : CadenceProvenance.DERIVED,
        observedThroughISO },
    );
  }

  const sorted = [...new Set(settlements)].sort();
  const lastSettlement = sorted.at(-1) ?? null;
  if (!lastSettlement) {
    return unknown('no settlements were observed for this stream', sourceKey, { observedThroughISO });
  }

  const satisfied = occurrenceSatisfiedBy(cadence, lastSettlement);
  const lastSatisfied = satisfied ?? lastSettlement;

  // A continuation assertion outranks historical silence for this interaction.
  // It does not erase the silence — the reason still names it.
  if (assertion?.kind === 'CONTINUES') {
    const covered = observedThroughISO && observedThroughISO >= lastSatisfied
      ? missedOccurrencesSince(cadence, lastSatisfied, observedThroughISO).length
      : null;
    return {
      state: ActivityState.CURRENT,
      mayGenerateExpectedOccurrences: true,
      provenance: CadenceProvenance.USER_ASSERTED,
      reason: `the user stated on ${assertion.assertedOnISO} that this income continues`
        + (covered ? `, which outranks ${covered} unpaid scheduled occurrence(s) in the ledger` : ''),
      missedOccurrences: covered,
      lastSatisfiedOccurrenceISO: satisfied, lastObservedSettlementISO: lastSettlement,
      observedThroughISO, sourceKey,
    };
  }

  // Silence has to be observable before it can mean anything.
  if (!observedThroughISO) {
    return unknown(
      'the ledger\'s reach is unknown, so absence of payments cannot be distinguished from absence of observation',
      sourceKey,
      { lastSatisfiedOccurrenceISO: satisfied, lastObservedSettlementISO: lastSettlement },
    );
  }
  if (observedThroughISO < lastSettlement) {
    return unknown(
      `the ledger reaches only ${observedThroughISO}, before the newest observed settlement — silence is not readable`,
      sourceKey,
      { lastSatisfiedOccurrenceISO: satisfied, lastObservedSettlementISO: lastSettlement, observedThroughISO },
    );
  }

  const missed = missedOccurrencesSince(cadence, lastSatisfied, observedThroughISO);
  // Occurrences that have come due by the as-of date but that the LEDGER cannot
  // see, because the feed stops short of them.
  //
  // ⚠️ This is the blind spot, and it is not the same as silence. Silence is
  // "we looked and nothing came"; this is "nobody looked". Measured need: a
  // monthly stream on the 10th whose account last reported on 2026-07-31 has an
  // August payment that may or may not exist — and without this check it
  // resolves CURRENT and projects forward, licensing future cash on a feed that
  // stopped talking. Contrary evidence still wins: a stream with an observed
  // miss is SILENT even if later occurrences are also unobserved.
  const unobservedDue = occurrencesBetween(
    cadence, shift(lastSatisfied, 1), shift(asOfISO, -ACTIVITY.SETTLEMENT_TOLERANCE_DAYS),
  ).filter((iso) => iso > shift(observedThroughISO, -ACTIVITY.SETTLEMENT_TOLERANCE_DAYS));

  const base = {
    provenance: CadenceProvenance.DERIVED,
    missedOccurrences: missed.length,
    lastSatisfiedOccurrenceISO: satisfied,
    lastObservedSettlementISO: lastSettlement,
    observedThroughISO, sourceKey,
  };

  if (missed.length > ACTIVITY.MAX_MISSED_FOR_PROJECTION) {
    return {
      ...base,
      state: ActivityState.SILENT,
      mayGenerateExpectedOccurrences: false,
      reason: `${missed.length} scheduled occurrence(s) between ${missed[0]} and ${missed.at(-1)} `
        + `were covered by the ledger (which reaches ${observedThroughISO}) and none were paid. `
        + 'The schedule is intact; continuation is not established. This is not evidence the income ended.',
    };
  }

  if (unobservedDue.length > 0) {
    return {
      ...base,
      state: ActivityState.UNKNOWN,
      mayGenerateExpectedOccurrences: false,
      reason: `${unobservedDue.length} scheduled occurrence(s) from ${unobservedDue[0]} have come due, `
        + `but the ledger reaches only ${observedThroughISO} and cannot see them. `
        + 'Nobody looked; this is not silence, and continuation is unestablished.',
    };
  }

  return {
    ...base,
    state: ActivityState.CURRENT,
    mayGenerateExpectedOccurrences: true,
    reason: `every scheduled occurrence through ${observedThroughISO} was paid; `
      + `the newest settled ${lastSettlement}`
      + (satisfied && satisfied !== lastSettlement ? ` against the ${satisfied} occurrence` : '')
      + `. Nothing further was due within the ledger's reach as at ${asOfISO}.`,
  };
}

// ── The licensed generator ──────────────────────────────────────────────────

/**
 * Occurrences that may be treated as EXPECTED FUTURE CASH.
 *
 * ⚠️ THE STRUCTURAL BOUNDARY OF THIS SLICE. `occurrencesBetween` in
 * FORECAST-1 is mechanical schedule generation: it answers "when would this
 * land", takes only a cadence, and knows nothing about whether the stream still
 * exists. THIS function is the licensed path, and it cannot be called without
 * an activity decision — a caller holding only a cadence physically cannot
 * produce expected cash.
 *
 * Returns empty whenever the stream is not eligible. Empty is the correct
 * answer, not a failure: false future income is worse than a missing forecast.
 *
 * FORECAST-3's FutureCashEvent generation must enter through here.
 */
export function expectedOccurrencesBetween(
  activity: StreamActivity, cadence: CadenceResult, fromISO: string, toISO: string,
): string[] {
  if (!activity.mayGenerateExpectedOccurrences) return [];
  if (!isCadence(cadence)) return [];
  // ⚠️ FM-AUDIT-008 — AN OCCURRENCE THE LEDGER ALREADY SETTLED IS NOT FUTURE CASH.
  // `lastSatisfiedOccurrenceISO` is the schedule slot the newest observed
  // settlement paid. That money is already in today's balance, so the slot — and
  // every slot before it — must not be generated again. Without this, a paycheque
  // that landed TODAY (slot = asOf) or EARLY (paid the 24th for the 25th, asOf on
  // the 24th) was both in the opening balance and projected as income on the
  // projection's first day: one extra paycheque in every projection, crossing,
  // goal seek and floor sweep run on a payday.
  //
  // What stays deliberately OUT: an unsatisfied slot dated before `fromISO` (a
  // late payment still inside the settlement tolerance). Cash is never claimed
  // before it is either observed or scheduled forward; the next scheduled slot is
  // the first expected one, and the late deposit appears as observed cash when it
  // settles.
  const settled = activity.lastSatisfiedOccurrenceISO;
  return occurrencesBetween(cadence, fromISO, toISO).filter((d) => settled === null || d > settled);
}

/** A compact statement of activity. Not wired into chat retrieval. */
export function describeActivity(a: StreamActivity): string[] {
  const lines = [
    `Income stream activity: ${a.state} — ${a.mayGenerateExpectedOccurrences
      ? 'MAY be projected forward' : 'may NOT be projected forward'}. Basis: ${a.provenance}.`,
    `  ${a.reason}`,
  ];
  if (a.lastObservedSettlementISO) {
    lines.push(`  Newest settlement: ${a.lastObservedSettlementISO}`
      + (a.lastSatisfiedOccurrenceISO && a.lastSatisfiedOccurrenceISO !== a.lastObservedSettlementISO
        ? ` (satisfying the ${a.lastSatisfiedOccurrenceISO} scheduled occurrence)` : '')
      + `. Ledger observed through: ${a.observedThroughISO ?? 'unknown'}.`);
  }
  if (!a.mayGenerateExpectedOccurrences && a.state !== ActivityState.ENDED) {
    lines.push('  No future amount may be stated for this stream. Absence of payment is not '
      + 'evidence that the income ended — only that continuation is unestablished.');
  }
  return lines;
}
