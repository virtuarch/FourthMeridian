/**
 * lib/forecast/cadence.ts
 *
 * FORECAST-1 — WHEN MONEY ARRIVES, DECIDED BY CODE.
 *
 * Pure: no DB, no model, no clock of its own. Substrate only — nothing here
 * forecasts anything, and no consumer is wired to it yet.
 *
 * ── The failures this closes ────────────────────────────────────────────────
 * Two measured live, both arithmetic a language model should never have been
 * asked to do:
 *
 *   "I get paid $5,250 biweekly, project 3 months"
 *     → the model INVENTED future pay dates, because none were derivable from
 *       anything in the prompt.
 *     → and treated biweekly as two cheques a month, understating monthly
 *       income by 7.7%: $10,500 against the true $11,375.
 *
 * A cadence with an anchor generates its occurrences by definition. 26/12 is a
 * property of the KIND, not a fact to be recalled correctly under pressure.
 *
 * ── Why BIWEEKLY and SEMIMONTHLY cannot be one thing ────────────────────────
 * They look alike from an interval and are not the same schedule:
 *
 *   BIWEEKLY      every 14 days · 26/year · drifts across the whole month
 *   SEMIMONTHLY   twice a month · 24/year · pinned to two days of the month
 *
 * Measured on the real ledger, the discriminator is NOT the gap — both sit
 * around 14–15 days — it is day-of-month spread. One employer's payroll lands
 * on sixteen distinct days over nineteen payments; the other's lands on six
 * distinct days over thirty-five. That is the signature, and it is what
 * `deriveCadence` reads.
 *
 * Collapsing them costs 8.3% of annual income, which is the kind of error that
 * looks like a rounding difference and is not.
 *
 * ── What a cadence is NOT ───────────────────────────────────────────────────
 * It answers WHEN. It carries no amount, and establishing one does NOT mean the
 * current paycheck is known, that payroll is still active, that every future
 * occurrence is guaranteed, or that anything is known about tax treatment.
 * Those are later authorities (FORECAST-2 onward) and must not be inferred from
 * a schedule.
 */

import { DAY_MS } from './_time';
import { median } from './_num';

/** How often money arrives. */
export const CadenceKind = {
  /** Every 7 days. 52 a year. */
  WEEKLY:      'WEEKLY',
  /** Every 14 days. 26 a year — NOT 24, and not "twice a month". */
  BIWEEKLY:    'BIWEEKLY',
  /** Twice a month on two days of the month. 24 a year. */
  SEMIMONTHLY: 'SEMIMONTHLY',
  /** Once a month. 12 a year. */
  MONTHLY:     'MONTHLY',
} as const;

export type CadenceKindName = typeof CadenceKind[keyof typeof CadenceKind];

/**
 * How a cadence came to be known.
 *
 * Mirrors the vocabulary already used on the position spine (`PositionOrigin`)
 * and in CF-2's evidence states rather than minting a parallel one. It is a
 * separate type because those enums describe the origin of a VALUE and this
 * describes the origin of a SCHEDULE — reusing the enum itself would widen its
 * meaning, which is the change this deliberately avoids.
 */
export const CadenceProvenance = {
  /** Inferred from observed transaction spacing. Carries evidence. */
  DERIVED:       'DERIVED',
  /** The user stated it. Never downgraded by contrary evidence without asking. */
  USER_ASSERTED: 'USER_ASSERTED',
} as const;

export type CadenceProvenanceKind =
  typeof CadenceProvenance[keyof typeof CadenceProvenance];

/** What a derivation actually saw. Absent on USER_ASSERTED. */
export interface CadenceEvidence {
  observations:   number;
  firstISO:       string;
  lastISO:        string;
  /** Median day-gap between consecutive occurrences. */
  medianGapDays:  number;
  /** How many distinct days-of-month the occurrences land on. */
  distinctDaysOfMonth: number;
  /** Fraction of gaps within tolerance of the kind's expected spacing, 0..1. */
  regularity:     number;
  /** Gaps that did not fit — reported, never hidden. */
  irregularGaps:  number[];
}

/**
 * An established cadence.
 *
 * `sourceKey` scopes it: a cadence belongs to ONE income stream on ONE account.
 * Measured why — "interest payment" across two savings accounts produced a
 * nonsense gap histogram (5, 6, 7, 21, 25…33 days) that resolves into two clean
 * monthly series the moment the account is part of the identity. Two employers
 * must never become one schedule for the same reason.
 */
export interface Cadence {
  kind:       CadenceKindName;
  /** The most recent CONFIRMED occurrence. Generation counts forward from here. */
  anchorISO:  string;
  provenance: CadenceProvenanceKind;
  /** Identity of the stream this describes — account + canonical source. */
  sourceKey?: string;
  evidence?:  CadenceEvidence;
  /**
   * For CALENDAR kinds, the days of the month money lands on, ascending:
   * two for SEMIMONTHLY, one for MONTHLY. Absent on interval kinds, which have
   * no day-of-month at all.
   *
   * This is the schedule, and it is why SEMIMONTHLY cannot be generated from an
   * interval — which is precisely why it is not BIWEEKLY. It is the MODAL day,
   * not the anchor's: a payment shifted to the next business day moves the
   * occurrence, never the schedule.
   */
  daysOfMonth?: readonly number[];
}

/** A stream whose spacing could not be established. Licenses nothing. */
export interface UnknownCadence {
  kind:      'UNKNOWN';
  reason:    string;
  evidence?: Partial<CadenceEvidence>;
  sourceKey?: string;
}

export type CadenceResult = Cadence | UnknownCadence;

export function isCadence(c: CadenceResult): c is Cadence {
  return c.kind !== 'UNKNOWN';
}

// ── Arithmetic ───────────────────────────────────────────────────────────────

/**
 * Occurrences per year. A property of the kind, and the whole point of the type.
 *
 * The measured failure was BIWEEKLY read as 24 (two a month). It is 26.
 */
export function annualFactor(kind: CadenceKindName): number {
  switch (kind) {
    case CadenceKind.WEEKLY:      return 52;
    case CadenceKind.BIWEEKLY:    return 26;
    case CadenceKind.SEMIMONTHLY: return 24;
    case CadenceKind.MONTHLY:     return 12;
  }
}

/** Occurrences per month — `annualFactor / 12`, exact, never rounded here. */
export function monthlyFactor(kind: CadenceKindName): number {
  return annualFactor(kind) / 12;
}

/**
 * What a per-occurrence amount is worth per month.
 *
 * NO ROUNDING, per the money authority's D-4 rule (`lib/money/convert.ts`):
 * full precision end to end, display rounding at the edge only. Rounding here
 * would be a second, competing money convention.
 *
 * ⚠️ EVALUATION ORDER IS PINNED. `amount × annual ÷ 12` and the natural-looking
 * `amount × monthlyFactor(kind)` disagree in the last bits for a real minority
 * of inputs — measured, 14 of 60 amount/kind pairs, e.g. $999.99 semimonthly
 * gives 1999.9800000000002 one way and 1999.98 the other. NEITHER order is
 * uniformly more accurate; f64 simply rounds differently. So one order is
 * canonical here and every caller routes through this function: use
 * `monthlyFactor` to describe or compare a cadence, and THIS to put a number on
 * one. Two call sites doing their own multiplication is how the same figure
 * comes out two ways.
 *
 * ⚠️ The cadence supplies only the FACTOR. The amount is the caller's, because
 * a schedule is not a payroll-amount authority — that is FORECAST-2's job, and
 * merging them here would be the same conflation this slice exists to undo.
 */
export function monthlyEquivalent(amount: number, kind: CadenceKindName): number {
  return amount * annualFactor(kind) / 12;
}

// ── Occurrence generation ────────────────────────────────────────────────────


const toISO = (d: Date): string => d.toISOString().slice(0, 10);
const fromISO = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

/** Add days in UTC. Immune to DST because every date here is a UTC calendar day. */
function addDays(iso: string, n: number): string {
  return toISO(new Date(fromISO(iso).getTime() + n * DAY_MS));
}

/**
 * The nth day of a month, clamped to the month's length.
 *
 * A semimonthly stream paid on the 31st is paid on the 28th in February — and
 * on the 29th in a leap February. Clamping is the calendar's own rule, not an
 * approximation.
 */
function dayOfMonth(year: number, month0: number, day: number): string {
  const last = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return toISO(new Date(Date.UTC(year, month0, Math.min(day, last))));
}

/**
 * Every occurrence in [fromISO, toISO], inclusive.
 *
 * Interval kinds count forward and backward from the anchor, so a window that
 * starts between two paydays is handled by construction rather than by the
 * caller guessing an offset. Calendar kinds walk months.
 *
 * Deterministic: same cadence and window always yield the same list.
 */
export function occurrencesBetween(
  cadence: Cadence, fromDateISO: string, toDateISO: string,
): string[] {
  if (fromDateISO > toDateISO) return [];
  const out: string[] = [];

  if (cadence.kind === CadenceKind.WEEKLY || cadence.kind === CadenceKind.BIWEEKLY) {
    const step = cadence.kind === CadenceKind.WEEKLY ? 7 : 14;
    // Jump straight to the first occurrence at or after the window start,
    // forwards or backwards from the anchor. Ceiling division on a signed
    // quotient, so an anchor after the window is handled too.
    const anchor = fromISO(cadence.anchorISO).getTime();
    const start  = fromISO(fromDateISO).getTime();
    const n = Math.ceil((start - anchor) / (step * DAY_MS));
    let cur = toISO(new Date(anchor + n * step * DAY_MS));
    while (cur <= toDateISO) {
      if (cur >= fromDateISO) out.push(cur);
      cur = addDays(cur, step);
    }
    return out;
  }

  // Calendar kinds. Walk from the window's month to its last, emitting the
  // days this cadence lands on. MONTHLY uses the anchor's own day-of-month.
  const days = cadence.daysOfMonth?.length
    ? cadence.daysOfMonth
    : [fromISO(cadence.anchorISO).getUTCDate()];

  const start = fromISO(fromDateISO);
  const end   = fromISO(toDateISO);
  let y = start.getUTCFullYear(), m = start.getUTCMonth();
  while (y < end.getUTCFullYear() || (y === end.getUTCFullYear() && m <= end.getUTCMonth())) {
    for (const d of [...days].sort((a, b) => a - b)) {
      const iso = dayOfMonth(y, m, d);
      if (iso >= fromDateISO && iso <= toDateISO) out.push(iso);
    }
    m += 1; if (m > 11) { m = 0; y += 1; }
  }
  return out.sort();
}

/** The next `count` occurrences strictly after `afterISO`. */
export function nextOccurrences(
  cadence: Cadence, afterISO: string, count: number,
): string[] {
  if (count <= 0) return [];
  // A year and a half is enough for any supported kind to yield `count` dates
  // at the sparsest cadence (monthly), with room for the calendar walk.
  const horizon = addDays(afterISO, 40 * Math.max(count, 1) + 400);
  return occurrencesBetween(cadence, addDays(afterISO, 1), horizon).slice(0, count);
}

// ── Derivation ───────────────────────────────────────────────────────────────

/**
 * Thresholds, named and deliberately conservative.
 *
 * The rule this slice was given is that a cadence must never be forced to
 * improve a hit rate. Below any of these, the answer is UNKNOWN — which is a
 * real answer and licenses nothing.
 */
export const DERIVATION = {
  /** Fewer observations than this cannot establish a repeating pattern. */
  MIN_OBSERVATIONS: 6,
  /** At least this share of gaps must fit the kind's expected spacing. */
  MIN_REGULARITY: 0.7,
  /**
   * Days either side of the expected gap that still count as on-schedule.
   *
   * Split by kind because an interval cadence and a calendar cadence are not
   * the same sort of thing. WEEKLY and BIWEEKLY have a fixed period, so a tight
   * tolerance is exactly right. A month is not a fixed period: legitimate
   * month-to-month gaps run 28–31 days by the calendar alone, and a posting
   * that shifts to the next business day widens that to 27–33. Measured — a
   * flat ±2 rejected a 25-payment mid-month interest series at 67% regularity,
   * which is a false UNKNOWN produced by scoring a calendar schedule as if it
   * were an interval.
   *
   * ⚠️ This widens what counts as ON SCHEDULE. It does NOT lower the bar for
   * establishing a cadence: MIN_OBSERVATIONS and MIN_REGULARITY are untouched,
   * and a genuinely sporadic series still returns UNKNOWN.
   */
  INTERVAL_TOLERANCE_DAYS: 2,
  CALENDAR_TOLERANCE_DAYS: 4,
  /**
   * SEMIMONTHLY lands on a few days of the month; BIWEEKLY drifts across them.
   * Measured: 6 distinct days over 35 payments (semimonthly) against 16 over 19
   * (biweekly). Four is comfortably clear of both.
   */
  MAX_SEMIMONTHLY_DISTINCT_DAYS: 6,
  /** Below this spread, an interval cadence is indistinguishable from a calendar one. */
  MIN_BIWEEKLY_DISTINCT_DAYS: 8,
} as const;

/** Whether a kind is generated from a fixed interval or from the calendar. */
function isIntervalKind(kind: CadenceKindName): boolean {
  return kind === CadenceKind.WEEKLY || kind === CadenceKind.BIWEEKLY;
}

/** Expected gap for a kind, for regularity scoring. Calendar kinds are approximate. */
function expectedGap(kind: CadenceKindName): number {
  switch (kind) {
    case CadenceKind.WEEKLY:      return 7;
    case CadenceKind.BIWEEKLY:    return 14;
    case CadenceKind.SEMIMONTHLY: return 15;
    case CadenceKind.MONTHLY:     return 30;
  }
}

/** Tolerance for a kind — tight for intervals, calendar-shaped for the rest. */
function gapTolerance(kind: CadenceKindName): number {
  return isIntervalKind(kind)
    ? DERIVATION.INTERVAL_TOLERANCE_DAYS
    : DERIVATION.CALENDAR_TOLERANCE_DAYS;
}

/** The `n` most frequent days of the month, ascending. Ties break low. */
function modalDaysOfMonth(dates: readonly string[], n: number): number[] {
  const freq = new Map<number, number>();
  for (const d of dates) {
    const dom = Number(d.slice(8, 10));
    freq.set(dom, (freq.get(dom) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, n).map(([d]) => d).sort((a, b) => a - b);
}

/**
 * Infer a cadence from observed occurrence dates.
 *
 * `dates` must be ONE stream — one account, one source. Merging streams is the
 * measured way to turn two clean monthly series into noise.
 *
 * ── How the kind is chosen ──────────────────────────────────────────────────
 * Median gap proposes; day-of-month spread disposes. Around 14–15 days the gap
 * alone cannot separate biweekly from semimonthly, so the tie is broken by how
 * many distinct days of the month the payments land on — the property that
 * actually differs between the two schedules.
 *
 * Off-cycle payments are tolerated, not fitted: a one-day gap from a correction
 * payment counts against regularity and is reported in `irregularGaps`, but a
 * stream that is otherwise clean still resolves.
 */
export function deriveCadence(
  dates: readonly string[], sourceKey?: string,
): CadenceResult {
  const uniq = [...new Set(dates)].sort();
  if (uniq.length < DERIVATION.MIN_OBSERVATIONS) {
    return {
      kind: 'UNKNOWN', sourceKey,
      reason: `only ${uniq.length} observation(s); ${DERIVATION.MIN_OBSERVATIONS} are required to establish a repeating schedule`,
      evidence: { observations: uniq.length },
    };
  }

  const gaps: number[] = [];
  for (let i = 1; i < uniq.length; i++) {
    gaps.push(Math.round((fromISO(uniq[i]).getTime() - fromISO(uniq[i - 1]).getTime()) / DAY_MS));
  }
  const med = median(gaps);
  const distinctDom = new Set(uniq.map((d) => Number(d.slice(8, 10)))).size;

  // Candidate kinds whose expected spacing is near the observed median.
  const candidates: CadenceKindName[] = [];
  if (med >= 5  && med <= 9)  candidates.push(CadenceKind.WEEKLY);
  if (med >= 12 && med <= 17) candidates.push(CadenceKind.BIWEEKLY, CadenceKind.SEMIMONTHLY);
  if (med >= 26 && med <= 34) candidates.push(CadenceKind.MONTHLY);

  if (candidates.length === 0) {
    return {
      kind: 'UNKNOWN', sourceKey,
      reason: `median spacing of ${med} day(s) matches no supported cadence`,
      evidence: { observations: uniq.length, medianGapDays: med, distinctDaysOfMonth: distinctDom },
    };
  }

  // The biweekly/semimonthly tie-break: day-of-month spread, not interval.
  // Between the two thresholds the evidence genuinely does not separate them,
  // and guessing there is exactly the 8.3%-of-annual-income error this slice
  // exists to prevent — so that band is UNKNOWN rather than a coin flip.
  let kind = candidates[0];
  if (candidates.length > 1) {
    if (distinctDom <= DERIVATION.MAX_SEMIMONTHLY_DISTINCT_DAYS) {
      kind = CadenceKind.SEMIMONTHLY;
    } else if (distinctDom >= DERIVATION.MIN_BIWEEKLY_DISTINCT_DAYS) {
      kind = CadenceKind.BIWEEKLY;
    } else {
      return {
        kind: 'UNKNOWN', sourceKey,
        reason: `spacing of ${med} day(s) over ${distinctDom} distinct day(s) of the month is ambiguous between biweekly and semimonthly`,
        evidence: { observations: uniq.length, medianGapDays: med, distinctDaysOfMonth: distinctDom },
      };
    }
  }

  const exp = expectedGap(kind);
  const tol = gapTolerance(kind);
  const fits = gaps.filter((g) => Math.abs(g - exp) <= tol);
  const regularity = gaps.length > 0 ? fits.length / gaps.length : 0;
  const irregularGaps = gaps.filter((g) => Math.abs(g - exp) > tol);

  const evidence: CadenceEvidence = {
    observations: uniq.length,
    firstISO: uniq[0], lastISO: uniq[uniq.length - 1],
    medianGapDays: med, distinctDaysOfMonth: distinctDom,
    regularity: Math.round(regularity * 100) / 100,
    irregularGaps,
  };

  if (regularity < DERIVATION.MIN_REGULARITY) {
    return {
      kind: 'UNKNOWN', sourceKey,
      reason: `only ${Math.round(regularity * 100)}% of gaps fit a ${kind.toLowerCase()} schedule (${Math.round(DERIVATION.MIN_REGULARITY * 100)}% required)`,
      evidence,
    };
  }

  // The anchor is the LAST confirmed occurrence: generation counts forward from
  // something that actually happened, never from a fitted phase.
  const anchorISO = uniq[uniq.length - 1];

  // Calendar kinds carry their schedule days. The MODAL day is the schedule —
  // taking the anchor's day instead would let one business-day shift in the
  // last observation redefine every future occurrence.
  if (!isIntervalKind(kind)) {
    const want = kind === CadenceKind.SEMIMONTHLY ? 2 : 1;
    const days = modalDaysOfMonth(uniq, want);
    if (days.length < want) {
      return {
        kind: 'UNKNOWN', sourceKey,
        reason: `${kind.toLowerCase()} requires ${want} distinct day(s) of the month`,
        evidence,
      };
    }
    return { kind, anchorISO, provenance: CadenceProvenance.DERIVED, sourceKey, evidence, daysOfMonth: days };
  }

  return { kind, anchorISO, provenance: CadenceProvenance.DERIVED, sourceKey, evidence };
}

/**
 * How many scheduled occurrences have come and gone since the anchor without a
 * confirmed payment.
 *
 * Measured need: the Abacus payroll's cadence is a clean SEMIMONTHLY, and its
 * last confirmed payment is 2025-12-24 — the job ended. Asked on 2026-08-27,
 * generation happily projects 2026-09-10, because a schedule does not know it
 * has stopped.
 *
 * ⚠️ This does NOT decide whether a stream is active. It reports the size of the
 * silence and nothing more; deciding what silence MEANS needs a termination
 * authority this slice deliberately does not build. A consumer that skips this
 * check will state future pay dates for a job that ended.
 */
export function missedSinceAnchor(cadence: Cadence, asOfISO: string): number {
  return occurrencesBetween(cadence, addDays(cadence.anchorISO, 1), asOfISO).length;
}

// ── Rendering ────────────────────────────────────────────────────────────────

// ⚠️ `describeCadence` DELETED (V26-REASONING Slice 0). A prose renderer with no
// caller but its own test. `deriveCadence` and `occurrencesBetween` are the
// authority and are unchanged.
