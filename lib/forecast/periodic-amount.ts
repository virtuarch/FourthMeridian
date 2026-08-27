/**
 * lib/forecast/periodic-amount.ts
 *
 * FORECAST-5 — WHAT THE CURRENT REGIME SUPPORTS.
 *
 * Pure: no DB, no model, no clock of its own, no persistence. Substrate only.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 * FORECAST-3 measured the real payroll and declined to name an amount, because
 * every naive answer is wrong in a different way:
 *
 *   all-history mean     $5,108   averages a superseded regime into the answer
 *   all-history median   $5,306   right by luck, on a series that contains
 *                                 $923.50 and $6,275.07
 *   latest observation   $5,306   one payment away from being anything
 *
 * The series is not one amount with noise. It is ~$5,950 through February,
 * ~$5,290 from late March, plus a partial first period, a supplemental
 * payment, and a high outlier. Averaging that is not a measurement.
 *
 * The question this module answers is "what does the CURRENT regime support",
 * and its most important answer is UNKNOWN.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 * It does not decide basis. A settled deposit proves an amount was received;
 * it says nothing about whether a FUTURE payment is gross or net, so nothing
 * here reaches for NET — that stays FORECAST-3's authority, and a derived
 * amount carries UNKNOWN basis.
 *
 * It does not decide whether the stream is alive. Abacus has a derivable
 * amount and a job that ended; amount and activity are orthogonal, and a good
 * historical figure never makes a dead stream projectable.
 *
 * It does not explain WHY an amount changed. The code sees a step. Whether
 * that was a raise, a cut, a benefits change or a job move is not visible here
 * and must not be narrated.
 */

import { occurrencesBetween, type Cadence } from './cadence';
import { occurrenceSatisfiedBy } from './stream-activity';
import {
  AmountBasis, EventProvenance, cadenceDerivedEvents,
  type EventProvenanceKind, type FlowRoleKind, type FutureCashEvent,
} from './future-cash-event';
import type { StreamActivity } from './stream-activity';

// ── Observations ────────────────────────────────────────────────────────────

/** One settled payment on the stream. Canonical rows only — one source, one account. */
export interface AmountObservation {
  dateISO: string;
  value: number;
  currency: string;
}

/** Why an observation did not contribute to the current amount. */
export const ExclusionReason = {
  /** Older than the current regime — the amount level changed after it. */
  OUTSIDE_REGIME: 'OUTSIDE_REGIME',
  /** Inside the regime window, but too far from its level to represent it. */
  OUTLIER: 'OUTLIER',
  /**
   * Its cadence slot carries more than one payment, so no single figure on that
   * slot represents the periodic amount.
   *
   * ⚠️ This is how a supplemental payment is detected — by the SCHEDULE, not by
   * being small or large. The real stream pays $5,276.89 on 2026-03-13 and
   * $923.50 on 2026-03-14; both satisfy the same occurrence, and which one is
   * "the paycheck" is not determinable. Classifying by magnitude would have
   * guessed, and guessed differently on a supplemental bonus.
   */
  SLOT_CONTESTED: 'SLOT_CONTESTED',
  /** Not aligned to any scheduled occurrence at all. */
  OFF_CADENCE: 'OFF_CADENCE',
} as const;

export type ExclusionReasonKind = typeof ExclusionReason[keyof typeof ExclusionReason];

/** One observation's fate, so nothing is ever silently dropped. */
export interface ObservationVerdict {
  dateISO: string;
  value: number;
  /** The scheduled occurrence it satisfied, or null. */
  slotISO: string | null;
  included: boolean;
  excludedBecause: ExclusionReasonKind | null;
}

// ── Result ──────────────────────────────────────────────────────────────────

export interface AssertablePeriodicAmount {
  assertable: true;
  value: number;
  currency: string;
  provenance: EventProvenanceKind;
  /** The first occurrence of the current regime. Older payments are a different level. */
  regimeStartISO: string;
  /** How many observations licensed the figure. */
  observationCount: number;
  /** Widest relative deviation inside the regime, 0..1. Disclosed, never hidden. */
  spread: number;
  verdicts: ObservationVerdict[];
  reason: string;
}

export interface UnknownPeriodicAmount {
  assertable: false;
  reason: string;
  verdicts: ObservationVerdict[];
}

export type PeriodicAmount = AssertablePeriodicAmount | UnknownPeriodicAmount;

// ── Thresholds, measured ────────────────────────────────────────────────────

export const REGIME = {
  /**
   * How far an observation may sit from the regime's level and still belong.
   *
   * MEASURED, and it sits in a wide gap rather than on a tuned edge. On the one
   * real stream with a clean regime, within-regime variation is 0.37% (the four
   * most recent payments span $5,286.40–$5,306.12) and the step between regimes
   * is 12.5% ($5,950 → $5,290). Any band between roughly 1% and 12% separates
   * those two facts identically; 5% sits in the middle of that plateau.
   *
   * ⚠️ This band was NOT widened to make a second stream pass. Abacus payroll
   * drifts continuously — its recent payments span $4,702.93 to $5,544.00 with
   * no gap anywhere — so no band separates noise from level there, and it
   * resolves UNKNOWN. That is the correct answer, not a threshold problem.
   */
  BAND: 0.05,
  /**
   * Consecutive out-of-band observations that end the regime.
   *
   * One deviation is an outlier; two in a row is a new level. This is what lets
   * a strong regime survive a single supplemental payment — measured need: the
   * real payroll's $6,275.07 sits in the middle of ten otherwise-flat payments,
   * and a stricter rule truncates a 10-observation regime to 4.
   */
  BREAK_RUN: 2,
  /**
   * Observations required to license a current amount.
   *
   * Two cannot distinguish which of them is the outlier — a median of two is
   * their midpoint, and both look equally deviant from it. Three is the
   * smallest window where one point can be wrong and the level still visible.
   */
  MIN_OBSERVATIONS: 3,
  /**
   * Excluded outliers may not outnumber this share of the regime. Above it the
   * window is not a level with noise, it is noise.
   */
  MAX_OUTLIER_SHARE: 1 / 3,
} as const;

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * The amount the current regime supports, or UNKNOWN.
 *
 * Three problems are kept apart deliberately, because one generic
 * "exclude weird points" rule cannot tell them apart:
 *
 *   REGIME CHANGE      the level moved. Ends the window; older points are a
 *                      different fact, not bad data.
 *   OUTLIER            inside the window, far from the level. Survivable.
 *   SLOT CONTENTION    two payments on one occurrence. Detected from the
 *                      SCHEDULE, never from the amount.
 *
 * A partial first period is deliberately NOT a category. The $2,306.42 opening
 * payment is almost certainly a part-period, and this module cannot PROVE that
 * — nothing records when employment started, and a small payment is equally
 * consistent with a correction or a separate deposit. It falls outside the
 * current regime for the ordinary reason that it is historical, which is all
 * the current amount needs, so no claim is made about what it was.
 *
 * The walk runs BACKWARD from the newest observation. That is the whole point:
 * a forward or whole-series method gives a superseded regime equal weight, and
 * the question is what is true now.
 */
export function deriveCurrentPeriodicAmount(
  observations: readonly AmountObservation[], cadence: Cadence,
): PeriodicAmount {
  if (observations.length === 0) {
    return { assertable: false, reason: 'no observations', verdicts: [] };
  }

  const currencies = [...new Set(observations.map((o) => o.currency))];
  if (currencies.length > 1) {
    // Amounts in different currencies are different facts, and no rate — past
    // or future — is applied here to pretend otherwise.
    return {
      assertable: false,
      reason: `observations span ${currencies.join(' and ')}; a regime must be a single currency`,
      verdicts: observations.map((o) => ({
        dateISO: o.dateISO, value: o.value, slotISO: null,
        included: false, excludedBecause: ExclusionReason.OFF_CADENCE,
      })),
    };
  }
  const currency = currencies[0];

  const sorted = [...observations].sort((a, b) => a.dateISO.localeCompare(b.dateISO));

  // 1. Align to the schedule. The cadence says WHEN; this asks which occurrence
  //    each payment answers.
  const aligned = sorted.map((o) => ({ ...o, slot: occurrenceSatisfiedBy(cadence, o.dateISO) }));
  const perSlot = new Map<string, number>();
  for (const a of aligned) if (a.slot) perSlot.set(a.slot, (perSlot.get(a.slot) ?? 0) + 1);

  const verdicts: ObservationVerdict[] = aligned.map((a) => ({
    dateISO: a.dateISO, value: a.value, slotISO: a.slot,
    included: false,
    excludedBecause: a.slot === null
      ? ExclusionReason.OFF_CADENCE
      : (perSlot.get(a.slot) ?? 0) > 1 ? ExclusionReason.SLOT_CONTESTED : null,
  }));

  const eligible = verdicts.filter((v) => v.excludedBecause === null);
  if (eligible.length < REGIME.MIN_OBSERVATIONS) {
    for (const v of verdicts) if (v.excludedBecause === null) v.excludedBecause = ExclusionReason.OUTSIDE_REGIME;
    return {
      assertable: false, verdicts,
      reason: `only ${eligible.length} observation(s) align cleanly to the schedule; `
        + `${REGIME.MIN_OBSERVATIONS} are required to establish a level`,
    };
  }

  // 2. Walk backward. Membership is tested against the median of what is
  //    already in the window, so one bad point cannot drag the level.
  const included: number[] = [];
  let regimeStartIndex = eligible.length;

  const deviatesFrom = (level: number, value: number) =>
    level !== 0 && Math.abs(value - level) / Math.abs(level) > REGIME.BAND;

  for (let i = eligible.length - 1; i >= 0; i--) {
    const v = eligible[i];
    const level = included.length ? median(included) : v.value;

    if (deviatesFrom(level, v.value)) {
      // One deviation is an outlier; a RUN of them is a different level. Look
      // ahead rather than taking the point and rolling back, so a point is
      // classified once and never reclassified.
      let run = 1;
      while (run < REGIME.BREAK_RUN && i - run >= 0
             && deviatesFrom(level, eligible[i - run].value)) run += 1;

      if (run >= REGIME.BREAK_RUN) break;   // regime boundary; stop here
      v.excludedBecause = ExclusionReason.OUTLIER;
      continue;
    }

    included.push(v.value);
    v.included = true;
    regimeStartIndex = i;
  }

  // Everything older than the regime start, and anything the walk never
  // classified, is simply a different level — not bad data.
  for (const v of eligible) {
    if (!v.included && v.excludedBecause === null) {
      v.excludedBecause = ExclusionReason.OUTSIDE_REGIME;
    }
  }

  if (included.length < REGIME.MIN_OBSERVATIONS) {
    return {
      assertable: false, verdicts,
      reason: `the most recent ${included.length} observation(s) form a stable level, `
        + `and ${REGIME.MIN_OBSERVATIONS} are required — the amount changed too recently to establish a current level`,
    };
  }
  for (const [i, v] of eligible.entries()) {
    if (i < regimeStartIndex && v.excludedBecause === ExclusionReason.OUTLIER) {
      v.excludedBecause = ExclusionReason.OUTSIDE_REGIME;
    }
  }
  const outlierCount = eligible.filter((v) => v.excludedBecause === ExclusionReason.OUTLIER).length;
  if (outlierCount > included.length * REGIME.MAX_OUTLIER_SHARE) {
    return {
      assertable: false, verdicts,
      reason: `${outlierCount} of ${included.length + outlierCount} observations in the recent window `
        + 'sit outside the band; this is variation, not a level',
    };
  }

  const value = median(included);
  const spread = Math.max(...included.map((v) => Math.abs(v - value) / Math.abs(value)));
  const regimeStartISO = eligible[regimeStartIndex].dateISO;

  return {
    assertable: true, value, currency,
    provenance: EventProvenance.DERIVED,
    regimeStartISO, observationCount: included.length, spread, verdicts,
    reason: `${included.length} observations since ${regimeStartISO} hold a level of ${value} ${currency} `
      + `within ${(spread * 100).toFixed(2)}%`
      + (outlierCount ? `, with ${outlierCount} excluded as outlier(s)` : '')
      + '. Older observations belong to a different level and were not averaged in.',
  };
}

/**
 * What the user said the amount is now.
 *
 * ⚠️ An assertion OVERRIDES the derived figure and does NOT rewrite the
 * evidence: the derived verdicts travel unchanged on the result, so a consumer
 * can still see what the ledger shows and that the user disagreed with it.
 */
export function assertedPeriodicAmount(
  value: number, currency: string, asOfISO: string, derived?: PeriodicAmount,
): AssertablePeriodicAmount {
  return {
    assertable: true, value, currency,
    provenance: EventProvenance.USER_ASSERTED,
    regimeStartISO: asOfISO,
    observationCount: 0,
    spread: 0,
    verdicts: derived?.verdicts ?? [],
    reason: `the user stated the current amount is ${value} ${currency} as at ${asOfISO}`
      + (derived?.assertable ? `; the ledger shows a level of ${derived.value}` : ''),
  };
}

/** Diagnostic counts, so exclusions are always inspectable. */
export function exclusionSummary(a: PeriodicAmount): Record<string, number> {
  const out: Record<string, number> = { included: 0 };
  for (const v of a.verdicts) {
    if (v.included) out.included += 1;
    else out[v.excludedBecause ?? 'UNRESOLVED'] = (out[v.excludedBecause ?? 'UNRESOLVED'] ?? 0) + 1;
  }
  return out;
}

/**
 * Occurrences a cadence would place in a window — used only by diagnostics and
 * tests to show alignment. Not a licensing path; see FORECAST-2/3 for that.
 */
export function scheduleSlots(cadence: Cadence, fromISO: string, toISO: string): string[] {
  return occurrencesBetween(cadence, fromISO, toISO);
}

// ── Composition seam ────────────────────────────────────────────────────────

/**
 * The full chain: cadence → activity licence → current amount → dated events.
 *
 * ⚠️ BASIS STAYS UNKNOWN. A derived amount is a NOMINAL periodic figure. That
 * historical payments landed as cash in a checking account proves those
 * payments were cash; it establishes nothing about whether a FUTURE payment is
 * quoted gross or net, and promoting to NET here would smuggle a tax
 * conclusion out of an arithmetic one. Basis remains FORECAST-3's authority and
 * requires someone to establish it.
 *
 * ⚠️ THE ACTIVITY LICENCE IS ABSOLUTE. Amount quality cannot substitute for it:
 * Abacus has a clean four-observation regime at $5,015.68 and a job that ended,
 * and it produces zero events. A good number about a dead stream is still a
 * number about a dead stream.
 *
 * When the amount is UNKNOWN the dates still stand — FORECAST-3 permits an
 * event with `amount: null`, and that is a better answer than a filled-in
 * average.
 */
export function periodicCashEvents(
  activity: StreamActivity,
  cadence: Cadence,
  amount: PeriodicAmount,
  fromISO: string,
  toISO: string,
  role: FlowRoleKind,
): FutureCashEvent[] {
  return cadenceDerivedEvents(
    activity, cadence, fromISO, toISO, role,
    amount.assertable
      ? {
        value: amount.value,
        currency: amount.currency,
        basis: AmountBasis.UNKNOWN,
        provenance: amount.provenance,
      }
      : undefined,
  );
}
