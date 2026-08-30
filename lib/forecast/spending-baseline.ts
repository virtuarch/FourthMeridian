/**
 * lib/forecast/spending-baseline.ts
 *
 * FORECAST-6 — WHAT ORDINARY SPENDING LOOKS LIKE NOW.
 *
 * Pure: no DB, no model, no clock of its own, no persistence. Substrate only.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 * Asked what the user normally spends, the system averaged three materially
 * different months and projected the result forward. That average contained a
 * debt payoff, a holiday, and a round of gifts, and none of it described any
 * month the user had actually lived.
 *
 * ── What the real data says, and it is not what was hoped ───────────────────
 * Measured on the live Space across three time representations, this user's
 * discretionary spending has NO current regime:
 *
 *   calendar months   $2,290 … $14,061 over the last twelve · 6.1x range
 *   28-day windows    $1,943 … $16,144 over the last fourteen · 8.3x range
 *   7-day windows     $370 … $5,594 · 15.1x range
 *
 * At the band this module considers defensible, the most recent complete
 * period has NO neighbour close enough to join it — at any granularity. A
 * number only appears if the band is widened until "the same level" spans a
 * threefold range, or by excluding more than a third of the evidence as
 * outliers. Both are ways of manufacturing an answer, so the answer is UNKNOWN.
 *
 * That is the finding, not a gap in the implementation. Payroll has a regime
 * because an employer sets it. Discretionary spending is a series of decisions,
 * and this user's decisions do not repeat at any cadence.
 *
 * ── Why category cannot rescue it ───────────────────────────────────────────
 * The tempting fix is to call travel exceptional and strip it. Measured, TRAVEL
 * IS THIS USER'S LARGEST CATEGORY — $55,753 across 26 months, ahead of shopping
 * and dining. A rule that treats travel as exceptional would delete the single
 * biggest component of how they actually live, and report the remainder as
 * their normal. Someone who travels every month is not having an exceptional
 * month every month.
 *
 * So category is NOT an exception authority here, and no amount of statistical
 * confidence makes it one.
 */

import { SERIALIZED_SPENDING_FLOWS } from '../transactions/flow-predicates';
import { EventProvenance, type EventProvenanceKind } from './future-cash-event';

// ── Population ──────────────────────────────────────────────────────────────

/** One candidate outflow, straight from the ledger. */
export interface SpendObservation {
  dateISO: string;
  /** Signed as stored; magnitude is taken here. */
  amount: number;
  currency: string;
  flowType: string | null;
}

/**
 * Whether an outflow is ordinary consumption.
 *
 * ⚠️ CANONICAL SEMANTICS, NOT HEURISTICS. `SERIALIZED_SPENDING_FLOWS`
 * ({SPENDING, FEE}) is the existing set from `lib/transactions/flow-predicates`,
 * so transfers, debt payments, refunds, investment flows and adjustments are
 * excluded by the classifier that already decided what they are — never by
 * merchant or category guessing.
 *
 * It is deliberately the NARROW set rather than `COST_FLOWS`, which also holds
 * INTEREST. A card's interest charge accrues on the card; the cash leaves when
 * the card is paid, and FORECAST-4 owns that as a debt obligation. Counting it
 * here would bill the same money twice.
 */
export function isOrdinaryConsumption(flowType: string | null): boolean {
  return flowType !== null && SERIALIZED_SPENDING_FLOWS.has(flowType);
}

// ── Periods ─────────────────────────────────────────────────────────────────

export const BASELINE = {
  /**
   * Period length, in days.
   *
   * MEASURED CHOICE. Three representations were run against the live ledger and
   * fixed 28-day windows win on the three things that matter, none of which is
   * statistical:
   *
   *   equal length      windows are directly comparable with no normalisation.
   *                     Calendar months are 28-31 days and need an adjustment
   *                     that is itself a judgement.
   *   no partial period the incomplete leading window is simply not a window
   *                     yet. A partial calendar month has to be either dropped
   *                     or scaled, and scaling a half-month is how a quiet
   *                     fortnight becomes a spending forecast.
   *   no boundary effect a holiday spanning a month end lands in one window
   *                     rather than being split by an accident of the calendar.
   *
   * Weekly was also measured and is too noisy to be a level (15x range).
   *
   * ⚠️ The choice does not change the verdict on the real data: calendar months
   * yield a single-period regime at EVERY band up to +/-100%.
   */
  PERIOD_DAYS: 28,
  /**
   * How far a period may sit from the level and still belong.
   *
   * Wider than FORECAST-5's 5% because spending genuinely is noisier than
   * payroll — but bounded by what the claim can survive. At +/-25% a "level" of
   * $5,000 already spans $3,750-$6,250, which is the outer edge of a figure
   * anyone should plan against. At +/-50% it spans a threefold range and stops
   * meaning anything, which is the honest reason the real data's UNKNOWN is not
   * a threshold artifact: a number appears at 50% and it would be vacuous.
   */
  BAND: 0.25,
  /** Consecutive out-of-band periods that end a regime. One is an exception. */
  BREAK_RUN: 2,
  /**
   * Periods required. One period is not a regime and two cannot say which of
   * them is the exception — the same argument as FORECAST-5's minimum.
   */
  MIN_PERIODS: 3,
  /**
   * Excluded outliers may not exceed this share of the regime.
   *
   * ⚠️ This is the guard against manufacturing a baseline. On the real data a
   * +/-35% band reaches nine periods only by discarding five of fourteen as
   * outliers; a third of the evidence removed is not a level with noise, and
   * dropping the expensive periods until the rest agree is precisely the
   * failure this slice exists to prevent.
   */
  MAX_OUTLIER_SHARE: 1 / 3,
} as const;

/** Why a period did not contribute. */
export const SpendExclusion = {
  /** Nothing in it was consumption, or it held no eligible rows. */
  STRUCTURAL_NON_CONSUMPTION: 'STRUCTURAL_NON_CONSUMPTION',
  /** The user said this period was not ordinary. */
  USER_ASSERTED_EXCEPTION: 'USER_ASSERTED_EXCEPTION',
  /** Inside the regime window, too far from the level to describe it. */
  STATISTICAL_OUTLIER: 'STATISTICAL_OUTLIER',
  /** Older than the current regime — a different level, not bad evidence. */
  OUTSIDE_CURRENT_REGIME: 'OUTSIDE_CURRENT_REGIME',
  /** Not a whole period yet. Never scaled up to look like one. */
  PARTIAL_PERIOD: 'PARTIAL_PERIOD',
} as const;

export type SpendExclusionKind = typeof SpendExclusion[keyof typeof SpendExclusion];

/** One period's total and its fate. Nothing is ever silently dropped. */
export interface PeriodEvidence {
  fromISO: string;
  toISO: string;
  total: number;
  transactionCount: number;
  included: boolean;
  excludedBecause: SpendExclusionKind | null;
}

// ── Result ──────────────────────────────────────────────────────────────────

/** The unit an amount is expressed in. Stated, never assumed by a reader. */
export const PeriodBasis = {
  PER_28_DAYS: 'PER_28_DAYS',
  MONTHLY: 'MONTHLY',
} as const;

export type PeriodBasisKind = typeof PeriodBasis[keyof typeof PeriodBasis];

export interface AssertableSpendingBaseline {
  assertable: true;
  amount: number;
  currency: string;
  periodBasis: PeriodBasisKind;
  provenance: EventProvenanceKind;
  regimeStartISO: string;
  observationCount: number;
  spread: number;
  periods: PeriodEvidence[];
  reason: string;
}

export interface UnknownSpendingBaseline {
  assertable: false;
  reason: string;
  periods: PeriodEvidence[];
}

export type SpendingBaseline = AssertableSpendingBaseline | UnknownSpendingBaseline;

/** A stretch the user marked as not ordinary. */
export interface AssertedException {
  fromISO: string;
  toISO: string;
  /** What the user said, carried through so the exclusion can be explained. */
  note: string;
}

const DAY_MS = 86_400_000;
const parse = (s: string) => Date.parse(`${s}T00:00:00.000Z`);
const shift = (iso: string, n: number) => new Date(parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * The spending level the current regime supports, or UNKNOWN.
 *
 * Order matters and is not negotiable: structural exclusion happens BEFORE any
 * statistics. A debt payoff is not a large outlier to be detected — it is not
 * consumption at all, and letting it into the population so a statistical rule
 * can find it would mean trusting a threshold to do a classifier's job.
 *
 * The regime walk is FORECAST-5's shape — backward from the newest period, one
 * deviation is an exception and two in a row is a new level — reimplemented
 * here rather than shared, because the pieces that made FORECAST-5 work
 * (cadence alignment, slot contention, one-source identity) have no analogue in
 * spending, and the pieces that transfer are a dozen lines. FORECAST-5 is left
 * untouched.
 */
export function deriveSpendingBaseline(
  observations: readonly SpendObservation[],
  asOfISO: string,
  exceptions: readonly AssertedException[] = [],
  /**
   * How far the ledger reaches. Periods are measured back from this rather than
   * from the as-of date when it is older.
   *
   * ⚠️ FORECAST-2's lesson applied to spending: days the feed has not yet
   * reported are not quiet days. Without this, a two-day ingestion lag makes
   * the newest period look cheaper than it was — which either invents a lower
   * level or breaks a real one. Omit it and the as-of date is used, which is
   * correct only when the ledger is known to be current.
   */
  observedThroughISO?: string,
): SpendingBaseline {
  const consumption = observations.filter((o) => isOrdinaryConsumption(o.flowType));
  if (consumption.length === 0) {
    return { assertable: false, periods: [], reason: 'no ordinary consumption was observed' };
  }

  const currencies = [...new Set(consumption.map((o) => o.currency))];
  if (currencies.length > 1) {
    return {
      assertable: false, periods: [],
      reason: `consumption spans ${currencies.join(' and ')}; a baseline must be a single currency`,
    };
  }
  const currency = currencies[0];

  const earliest = consumption.reduce((a, o) => (o.dateISO < a ? o.dateISO : a), consumption[0].dateISO);

  // Bucket backward from as-of into whole periods. The leading remainder is not
  // a period yet and is never scaled to look like one.
  const periods: PeriodEvidence[] = [];
  let hi = observedThroughISO && observedThroughISO < asOfISO ? observedThroughISO : asOfISO;
  while (hi > earliest) {
    const lo = shift(hi, -BASELINE.PERIOD_DAYS);
    const inWindow = consumption.filter((o) => o.dateISO > lo && o.dateISO <= hi);
    periods.push({
      fromISO: shift(lo, 1), toISO: hi,
      total: inWindow.reduce((a, o) => a + Math.abs(o.amount), 0),
      transactionCount: inWindow.length,
      included: false,
      // A window that begins before the first observation was never fully
      // observed. It is reported with its real bounds and excluded — never
      // scaled up to look like a whole period, which is how a half-covered
      // window becomes a spending forecast.
      excludedBecause: lo < earliest ? SpendExclusion.PARTIAL_PERIOD : null,
    });
    hi = lo;
  }

  // periods[0] is the newest. Apply user exceptions and empty-period exclusion
  // before the walk, so neither is mistaken for a statistical judgement.
  for (const p of periods) {
    if (p.excludedBecause) continue;
    const hit = exceptions.find((e) => !(e.toISO < p.fromISO || e.fromISO > p.toISO));
    if (hit) p.excludedBecause = SpendExclusion.USER_ASSERTED_EXCEPTION;
    else if (p.transactionCount === 0) p.excludedBecause = SpendExclusion.STRUCTURAL_NON_CONSUMPTION;
  }

  const eligible = periods.filter((p) => p.excludedBecause === null);
  if (eligible.length < BASELINE.MIN_PERIODS) {
    return {
      assertable: false, periods,
      reason: `only ${eligible.length} whole period(s) of ordinary consumption are available; `
        + `${BASELINE.MIN_PERIODS} are required to establish a level`,
    };
  }

  // Backward walk. eligible[0] is newest.
  const included: number[] = [];
  let regimeEndIndex = -1;
  const deviates = (level: number, v: number) =>
    level !== 0 && Math.abs(v - level) / Math.abs(level) > BASELINE.BAND;

  for (let i = 0; i < eligible.length; i++) {
    const p = eligible[i];
    const level = included.length ? median(included) : p.total;
    if (deviates(level, p.total)) {
      let run = 1;
      while (run < BASELINE.BREAK_RUN && i + run < eligible.length
             && deviates(level, eligible[i + run].total)) run += 1;
      if (run >= BASELINE.BREAK_RUN) break;
      p.excludedBecause = SpendExclusion.STATISTICAL_OUTLIER;
      continue;
    }
    included.push(p.total);
    p.included = true;
    regimeEndIndex = i;
  }

  for (const [i, p] of eligible.entries()) {
    if (!p.included && p.excludedBecause === null) p.excludedBecause = SpendExclusion.OUTSIDE_CURRENT_REGIME;
    // An "outlier" older than the regime belongs to the old level, not this one.
    if (i > regimeEndIndex && p.excludedBecause === SpendExclusion.STATISTICAL_OUTLIER) {
      p.excludedBecause = SpendExclusion.OUTSIDE_CURRENT_REGIME;
    }
  }

  if (included.length < BASELINE.MIN_PERIODS) {
    return {
      assertable: false, periods,
      reason: `the most recent ${included.length} period(s) hold a common level and `
        + `${BASELINE.MIN_PERIODS} are required — recent spending does not repeat closely enough to `
        + 'describe a current normal',
    };
  }
  const outlierCount = eligible.filter((p) => p.excludedBecause === SpendExclusion.STATISTICAL_OUTLIER).length;
  if (outlierCount > included.length * BASELINE.MAX_OUTLIER_SHARE) {
    return {
      assertable: false, periods,
      reason: `${outlierCount} of ${included.length + outlierCount} recent periods sit outside the band; `
        + 'discarding that many to make the rest agree would manufacture a level rather than measure one',
    };
  }

  const amount = median(included);
  const spread = Math.max(...included.map((v) => Math.abs(v - amount) / Math.abs(amount)));
  const regimeStartISO = eligible[regimeEndIndex].fromISO;

  return {
    assertable: true, amount, currency,
    periodBasis: PeriodBasis.PER_28_DAYS,
    provenance: EventProvenance.DERIVED,
    regimeStartISO, observationCount: included.length, spread, periods,
    reason: `${included.length} periods since ${regimeStartISO} hold a level of ${amount} ${currency} `
      + `per ${BASELINE.PERIOD_DAYS} days within ${(spread * 100).toFixed(1)}%`
      + (outlierCount ? `, with ${outlierCount} excluded as exceptional` : '')
      + '. Older periods belong to a different level and were not averaged in.',
  };
}

/**
 * What the user said their normal spending is.
 *
 * ⚠️ A NUMBER IS REQUIRED. "I spend a lot" cannot enter through this door,
 * because the door only accepts an amount — vagueness has no representation
 * here and must not acquire one.
 *
 * The derived evidence travels unchanged, so a consumer can still see what the
 * ledger shows and that the user's figure differs from it.
 */
export function assertedSpendingBaseline(
  amount: number, currency: string, periodBasis: PeriodBasisKind,
  asOfISO: string, derived?: SpendingBaseline,
): AssertableSpendingBaseline {
  return {
    assertable: true, amount, currency, periodBasis,
    provenance: EventProvenance.USER_ASSERTED,
    regimeStartISO: asOfISO, observationCount: 0, spread: 0,
    periods: derived?.periods ?? [],
    reason: `the user stated ordinary spending is ${amount} ${currency} per `
      + `${periodBasis === PeriodBasis.MONTHLY ? 'month' : `${BASELINE.PERIOD_DAYS} days`} as at ${asOfISO}`
      + (derived?.assertable ? `; the ledger shows ${derived.amount} per ${BASELINE.PERIOD_DAYS} days` : ''),
  };
}

/** The mean Gregorian month, in days. The only month-length constant here. */
export const MEAN_MONTH_DAYS = 365.2425 / 12;

/**
 * How many days the stated period covers.
 *
 * ⚠️ THE DAY-COUNT CONVENTION LIVES HERE, IN THE AUTHORITY THAT STATES THE
 * BASIS. Added for FORECAST-9, whose cash path has to spread a level across an
 * arbitrary horizon: an engine that divided by its own idea of a month would be
 * a second opinion about what "per month" means, and the first place the two
 * would disagree is a partial period.
 */
export function periodDaysOf(periodBasis: PeriodBasisKind): number {
  return periodBasis === PeriodBasis.MONTHLY ? MEAN_MONTH_DAYS : BASELINE.PERIOD_DAYS;
}

/**
 * The same level expressed per day.
 *
 * ⚠️ A LEVEL IS A RATE, NOT A DATED BILL. "$4,000 a month" says how fast money
 * leaves, not that $4,000 departs on the 1st, and this is the conversion that
 * keeps it a rate — so a 17-day stretch costs 17 days of it and no calendar
 * boundary has to be invented to make the arithmetic work.
 *
 * It takes an amount and a basis rather than a baseline, because FORECAST-8's
 * supposed baselines carry exactly the same two facts and must convert by
 * exactly the same rule.
 */
export function dailySpendRate(amount: number, periodBasis: PeriodBasisKind): number {
  return amount / periodDaysOf(periodBasis);
}

/**
 * The same level expressed per calendar month.
 *
 * Honest unit conversion of a RATE, using the mean Gregorian month. It is not a
 * prediction of any particular month's spending, and a period that was never
 * whole is never scaled into one — only an established level is converted.
 */
export function monthlyRate(baseline: AssertableSpendingBaseline): number {
  return baseline.periodBasis === PeriodBasis.MONTHLY
    ? baseline.amount
    : baseline.amount / BASELINE.PERIOD_DAYS * MEAN_MONTH_DAYS;
}

/** Period counts by fate, so exclusions are always inspectable. */
export function periodSummary(b: SpendingBaseline): Record<string, number> {
  const out: Record<string, number> = { included: 0 };
  for (const p of b.periods) {
    if (p.included) out.included += 1;
    else out[p.excludedBecause ?? 'UNRESOLVED'] = (out[p.excludedBecause ?? 'UNRESOLVED'] ?? 0) + 1;
  }
  return out;
}

/** A compact statement. Not wired into any prompt. */
export function describeSpendingBaseline(b: SpendingBaseline): string[] {
  if (!b.assertable) {
    return [
      `Current-normal discretionary spending: UNKNOWN — ${b.reason}.`,
      '  No baseline spending figure may be stated. A historical average is not a current normal, '
      + 'and presenting one would describe a period the user never lived.',
    ];
  }
  return [
    `Current-normal discretionary spending: ${b.amount} ${b.currency} per ${BASELINE.PERIOD_DAYS} days `
    + `(~${monthlyRate(b).toFixed(2)} per month). Basis: ${b.provenance}.`,
    `  ${b.reason}`,
    '  This is ordinary consumption only. Known obligations are counted separately and are '
    + 'not included here.',
  ];
}
