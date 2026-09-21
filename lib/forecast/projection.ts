/**
 * lib/forecast/projection.ts
 *
 * PROJECTION-1 — THE EVIDENCE-BASED CASH PATH.
 *
 * ── Why this is beside the engine and not inside it ─────────────────────────
 * `forecastCash` computes what the evidence ENTAILS, and its refusals are the
 * product of F7's conclusion licence and F8's policy. Adding a weaker path to it
 * would put two different standards of proof behind one set of field names, and
 * the first thing to go would be the meaning of `fullCashPath`. So this is a
 * separate pure function over the same inputs, producing a separate result that
 * a caller may render BESIDE the licensed one and never in place of it.
 *
 * ── What it changes, exactly ────────────────────────────────────────────────
 * Two things, both narrow:
 *   · income is taken from `observedCashContribution`, which additionally admits
 *     an amount observed settling into a depository account (GROSS still refused);
 *   · spending is taken from an `ObservedSpendingRate` over a disclosed window,
 *     instead of F6's baseline, which is UNKNOWN for this user by measurement.
 * Opening cash is the same licensed figure. Nothing else differs.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 * It does not run when the licensed path succeeds: a FACTUALLY_LICENSED answer
 * is never replaced by a weaker one. It does not run when the user supplied a
 * spending assumption, because that assumption is stronger evidence about the
 * user's intent than the user's own history and the licensed path already
 * carries it — see `USER_OVERRIDE` in the result's `supersededBy`.
 *
 * ⚠️ IT PROJECTS NO DEBT PAYDOWN, and that is a finding rather than an omission.
 * Measured on the real Space, DEBT_PAYMENT since 2026-06-01 totals $55,710 —
 * but every payment appears TWICE, once as a debit on `CHASE COLLEGE` and once
 * as a credit on the card, so the economic total is about half that. Of what
 * remains, the part matching card purchases is already counted as SPENDING (the
 * cards carry $16,854 of the period's $17,012 of spending; checking carries
 * $157), so projecting both would double-count every purchase. The excess over
 * card spending was balance PAYDOWN, and the balances are now $11.09 and
 * -$86.19 — there is nothing left to pay down, so extrapolating it would project
 * an outflow against a debt that no longer exists.
 */

import { addDays, daysBetween } from './_time';
import { observedCashContribution, exactDateOf, type FutureCashEvent } from './future-cash-event';
import { ConclusionStatus, type ConclusionStatusKind } from './policy';
import { monthLabel, type ObservedSpendingRate } from './observed-spending';
import { spendOver, type SpendingSegment } from './spending-change';

/** One component of a projected total, named so the reply can attribute it. */
export interface ProjectionComponent {
  label: string;
  /** MAGNITUDE. Direction is the label's job — see the note at the push sites. */
  value: number;
  /** The measured evidence and the transformation applied to it. */
  derivation: string;
}

export interface ProjectedCash {
  status: ConclusionStatusKind;
  /** Null whenever the status is not EVIDENCE_BASED_PROJECTION. */
  closing: number | null;
  currency: string;
  openingCash: number | null;
  components: ProjectionComponent[];
  /** The `OBSERVED_CONTINUATION` claims this rests on, in the user's terms. */
  assumptions: string[];
  /** What stopped it, when it produced nothing. */
  missing: string[];
  /**
   * Low/high closing implied by the SPENDING WINDOW's own months.
   *
   * ⚠️ SUPPLEMENTAL, NEVER A REPLACEMENT for `closing`. Product policy is that a
   * central estimate is the answer; this exists so a 6.1x window does not read
   * as a settled level, and it is omitted when a single month was averaged.
   */
  range: { low: number; high: number } | null;
  /** Events the projection could not use, with the authority's own reason. */
  excluded: { id: string; reason: string }[];
}


/**
 * Where the spending term comes from.
 *
 * ⚠️ THE USER OUTRANKS THEIR OWN HISTORY. "Assume I spend $5,000/month" is a
 * statement about what they intend, and an average of what they did spend is
 * not evidence against it. So a user assumption REPLACES the observed term
 * rather than suppressing the projection — suppressing it was the first
 * implementation, and it answered an override with nothing at all.
 *
 * The standing changes with the source: an observed rate carries
 * OBSERVED_CONTINUATION and the window that produced it; a user rate carries
 * the existing USER_REQUESTED assumption semantics and no window, because there
 * is no measurement behind it to disclose.
 */
export type ProjectionSpending =
  | { kind: 'OBSERVED'; rate: ObservedSpendingRate }
  | { kind: 'USER_ASSUMED'; dailyRate: number; monthlyAmount: number | null; statedAs: string };

export interface ProjectCashInput {
  openingCash: number | null;
  events: readonly FutureCashEvent[];
  spending: ProjectionSpending | null;
  fromISO: string;
  toISO: string;
  currency: string;
  /**
   * S1 — the spending rate as a scenario's dated spending changes left it: a
   * piecewise schedule over the projected days. Absent ⇒ the rate above, constant.
   *
   * ⚠️ THE ONE SPEND TERM STILL HAS ONE HOME. The cumulative run, an interval of it
   * and the range all integrate THIS through `spendOver`, so a scenario's cut
   * cannot reach one of them and not the others.
   */
  spendingSchedule?: readonly SpendingSegment[];
}

/** The spending term's daily rate, whichever source it came from. */
const dailyRateOf = (spending: ProjectionSpending | null): number | null =>
  spending === null ? null
    : spending.kind === 'OBSERVED' ? spending.rate.dailyRate : spending.dailyRate;

/**
 * THE ONE FOLD. Dated events inside `[eventsFromISO, eventsToISO]` (inclusive)
 * and a daily rate accrued over `days`.
 *
 * ⚠️ BOTH THE CUMULATIVE PROJECTION AND AN INTERVAL OF IT ARE THIS FUNCTION, over
 * different bounds. An interval that summed its own events or accrued its own
 * rate would be a second opinion about the same future, and the first time the
 * two disagreed by a paycheck nobody could say which was right.
 *
 * Income is DATED — it is whatever occurrences fall inside the bounds, never a
 * rate times a length. Spending is a RATE — it has no dates to fall anywhere.
 */
function foldWindow(
  events: readonly FutureCashEvent[], dailyRate: number | null,
  eventsFromISO: string, eventsToISO: string,
  /** Spending accrues over the days AFTER this, through `eventsToISO`. */
  spendFromExclusiveISO: string,
  schedule: readonly SpendingSegment[] | undefined,
) {
  const excluded: { id: string; reason: string }[] = [];
  let inflow = 0, outflow = 0, counted = 0;
  for (const e of events) {
    const date = exactDateOf(e.timing);
    if (date === null || date < eventsFromISO || date > eventsToISO) continue;
    const c = observedCashContribution(e);
    if (!c.assertable) { excluded.push({ id: e.id, reason: c.reason }); continue; }
    counted += 1;
    if (e.direction === 'INFLOW') inflow += c.value; else outflow += c.value;
  }
  // S1 — `spendOver` is `dailyRate × days` exactly when there is no schedule.
  return { inflow, outflow, counted, excluded,
    spend: dailyRate === null ? null : spendOver(schedule, dailyRate, spendFromExclusiveISO, eventsToISO) };
}

/**
 * The named components of a fold. One wording, shared by the cumulative
 * projection and an interval of it.
 *
 * ⚠️ THE LABELS SAY PROJECTED, BECAUSE THAT IS WHAT THEY ARE — see the note in
 * `projectCash`. ⚠️ MAGNITUDES, NOT SIGNED VALUES: direction is the label's job.
 */
function namedComponents(
  fold: { inflow: number; outflow: number; spend: number },
  spending: ProjectionSpending, days: number,
  /** S1 — how far the scenario's spending changes moved this window's spend (negative = less). */
  changed: number | null = null,
): ProjectionComponent[] {
  const components: ProjectionComponent[] = [];
  if (fold.inflow > 0) {
    components.push({
      label: 'projected income from the observed payroll pattern', value: fold.inflow,
      derivation: `${days} day(s) of the established cadence at the level those deposits `
        + 'have actually been settling at',
    });
  }
  if (fold.outflow > 0) {
    components.push({
      label: 'projected outflows from dated obligations', value: fold.outflow,
      derivation: 'dated known obligations falling inside the horizon',
    });
  }
  const obs = spending.kind === 'OBSERVED' ? spending.rate : null;
  components.push({
    label: (obs ? 'projected spending at the observed rate' : 'projected spending at your assumed rate')
      + (changed !== null ? ', with your spending changes applied' : ''),
    value: fold.spend,
    derivation: (obs
      ? `${obs.monthlyRate.toFixed(2)}/month across the ${obs.monthCount} `
        + `complete month(s) ${obs.months.map(monthLabel).join(' and ')}, accrued over `
        + `${days} day(s)`
      : `${spending.kind === 'USER_ASSUMED' ? spending.statedAs : ''} — the user's own figure, `
        + `accrued over ${days} day(s)`)
      + (changed !== null
        ? `; the scenario's dated spending changes moved it by ${changed.toFixed(2)} over this period`
        : ''),
  });
  return components;
}

/** S1 — the schedule's departure from the constant rate over a span (0 without one). */
const departureOf = (
  schedule: readonly SpendingSegment[] | undefined, dailyRate: number, spend: number, days: number,
): number | null => {
  if (!schedule || schedule.length === 0) return null;
  // A window no rule reaches is reported as unchanged, not as "changed by 0.00".
  const d = spend - dailyRate * days;
  return Math.abs(d) < 0.005 ? null : d;
};

/**
 * Project cash forward from measured evidence.
 *
 * PURE. Full f64 throughout; rounding belongs at the display edge (D-4).
 */
export function projectCash(input: ProjectCashInput): ProjectedCash {
  const { openingCash, events, spending, fromISO, toISO, currency } = input;
  const missing: string[] = [];
  if (openingCash === null) missing.push('current cash balance');
  if (!spending) missing.push('a complete calendar month of spending to average');

  // ⚠️ THE CLAMP IS AT THE CALL SITE NOW, NOT INSIDE THE HELPER (V26-REASONING
  // Slice 0). The private `daysBetween` this module used to carry silently
  // returned 0 for a reversed horizon, and two sibling modules had the same name
  // with different semantics. A horizon whose end precedes its start spends zero
  // days, which is a decision this line makes visibly.
  const days = Math.max(0, daysBetween(fromISO, toISO));
  const schedule = input.spendingSchedule;
  const fold = foldWindow(events, dailyRateOf(spending), fromISO, toISO, fromISO, schedule);
  const { inflow, outflow, spend, excluded } = fold;
  const components: ProjectionComponent[] = [];

  if (openingCash === null || spending === null || spend === null) {
    return {
      status: ConclusionStatus.REFUSED, closing: null, currency, openingCash,
      components, assumptions: [], missing, range: null, excluded,
    };
  }

  // ⚠️ THE LABELS SAY PROJECTED, BECAUSE THAT IS WHAT THEY ARE. This figure is
  // the sum of FUTURE occurrences — 8 x $5,286.64 on the real Space — generated
  // from an observed pattern. Calling it "observed income" was measured in the
  // live UI and is a semantic error of exactly the kind this programme exists to
  // prevent: it renames a projection into a measurement, which is the same move
  // as calling a historical average "normal".
  // ⚠️ MAGNITUDES, NOT SIGNED VALUES. The renderer used to print "USD -16672.27";
  // the model quoted "$16,672.27" and `output-validator`'s NUMBER_RE captures the
  // minus, so the licensed figure and the quoted figure did not reconcile and a
  // correct answer collected "could not be automatically verified". Direction is
  // carried by the label, where a reader gets it too.
  const departure = departureOf(schedule, dailyRateOf(spending) as number, spend, days);
  components.push(...namedComponents({ inflow, outflow, spend }, spending, days, departure));
  const obs = spending.kind === 'OBSERVED' ? spending.rate : null;

  const closing = openingCash + inflow - outflow - spend;
  // The same arithmetic at the window's own extremes. Not a distribution, and
  // meaningless for a user-supplied rate, which has no window to vary over.
  // S1 — a scenario's spending changes move both ends by the same departure; with
  // none this is the pre-S1 arithmetic unchanged.
  const range = obs && obs.monthCount > 1
    ? departure === null
      ? {
        low:  openingCash + inflow - outflow - (obs.high / (365 / 12)) * days,
        high: openingCash + inflow - outflow - (obs.low  / (365 / 12)) * days,
      }
      : {
        low:  openingCash + inflow - outflow - ((obs.high / (365 / 12)) * days + departure),
        high: openingCash + inflow - outflow - ((obs.low  / (365 / 12)) * days + departure),
      }
    : null;

  const assumptions = [
    obs
      ? `spending continues at the ${obs.monthCount}-month observed average of `
        + `${obs.monthlyRate.toFixed(2)}/month, measured over `
        + `${obs.months.map(monthLabel).join(' and ')} and no other period`
      : `spending is ${spending.kind === 'USER_ASSUMED' ? spending.statedAs : 'as the user supposed'} `
        + '— the user\'s supposition for this conversation, not a measurement',
    ...(departure !== null
      ? ['spending then changes on the dates the user stated for this scenario — a supposition '
        + 'about their future, not a measurement']
      : []),
    'settled recurring deposits continue at their observed level and cadence',
  ];

  return {
    status: ConclusionStatus.EVIDENCE_BASED_PROJECTION,
    closing, currency, openingCash, components, assumptions, missing: [], range, excluded,
  };
}

// ── An interval of the projection ────────────────────────────────────────────

/**
 * The projected components INSIDE a future-dated window, and the cash change
 * across it.
 *
 * ⚠️ THE MISSING HALF OF A WINDOW WAS ITS START. The projection has always owned
 * forward spending — `dailyRate × days` — but only FROM TODAY, so "how much will
 * I spend during 2027?" took two cumulative runs and a subtraction the model
 * performed (66,733.35 − 14,575.59). That subtraction is this function. It is
 * not an annual-spending figure and knows nothing about years: any `[from, to]`
 * after today, over the same events and the same rate the cumulative run used.
 *
 * ⚠️ DEFINED AS A DIFFERENCE OF TWO CUMULATIVE POSITIONS, SO IT CANNOT DISAGREE
 * WITH THEM. `opening` is the cumulative run to the day before `from`; `closing`
 * is the cumulative run to `to`; both are `projectCash`'s own closing, to the
 * bit. The components come from the one fold over the window's own bounds, and
 * a test pins that they equal the difference of the two runs.
 *
 * ⚠️ INCOME IS DATED, SPENDING IS A RATE. Interval income is the occurrences
 * dated inside `[from, to]`, both ends inclusive — never a rate times a length,
 * which would put a thirteenth paycheck in some years and lose one in others.
 * Spending accrues over the inclusive day count of the same window.
 *
 * ⚠️ THE PAST IS NOT PROJECTED. A window that ends on or before `asOf` is
 * REFUSED: what happened is a measurement, and answering it from a forward rate
 * would restate history as a forecast. A window that merely STARTS on or before
 * `asOf` is CLAMPED to the projection's own start and says so — it is then
 * exactly the cumulative projection (income dated from `asOf`, spending accrued
 * from the day after it, because today's balance already contains today), and
 * `clamped` carries what was asked and why it moved.
 */
export interface ProjectedInterval {
  status: 'PROJECTED' | 'REFUSED';
  /** Why nothing was produced. Null when it was. */
  refusal: string | null;
  /** What the caller asked for, verbatim. */
  requested: { fromISO: string; toISO: string };
  /** The window measured: dated events in [fromISO, toISO] inclusive; spending over `days`. */
  fromISO: string | null;
  toISO: string | null;
  days: number | null;
  /** Present when the measured window is not the requested one. */
  clamped: { requestedFromISO: string; reason: string } | null;
  /** Projected cash at the close of the day BEFORE the window (or `asOf`, when clamped). */
  opening: { dateISO: string; cash: number } | null;
  /** Projected cash at the close of `toISO` — `projectCash`'s closing for that horizon. */
  closing: { dateISO: string; cash: number } | null;
  /** closing − opening. Equals income − obligations − spending over the window. */
  cashChange: number | null;
  components: ProjectionComponent[];
  eventsCounted: number;
  excluded: { id: string; reason: string }[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function projectCashInterval(
  input: ProjectCashInput, window: { fromISO: string; toISO: string },
): ProjectedInterval {
  const { openingCash, events, spending, fromISO: asOf, toISO: horizon } = input;
  const requested = { fromISO: window.fromISO, toISO: window.toISO };
  const refuse = (refusal: string): ProjectedInterval => ({
    status: 'REFUSED', refusal, requested, fromISO: null, toISO: null, days: null,
    clamped: null, opening: null, closing: null, cashChange: null, components: [],
    eventsCounted: 0, excluded: [] });

  if (!ISO_DATE.test(window.fromISO) || !ISO_DATE.test(window.toISO)) {
    return refuse('an interval needs a `from` and a `to` as YYYY-MM-DD');
  }
  if (window.fromISO > window.toISO) {
    return refuse(`the interval ${window.fromISO}..${window.toISO} ends before it starts`);
  }
  if (window.toISO <= asOf) {
    return refuse(`the interval ${window.fromISO}..${window.toISO} is not in the future of `
      + `${asOf}: the projection owns only what has not happened yet, and what already `
      + 'happened is measured from transactions, not projected');
  }
  if (window.toISO > horizon) {
    return refuse(`the interval ends ${window.toISO}, after the projection's horizon ${horizon}; `
      + 'dated income beyond the horizon was never generated');
  }
  const dailyRate = dailyRateOf(spending);
  if (openingCash === null || spending === null || dailyRate === null) {
    return refuse('the projection itself could not be built: '
      + [openingCash === null ? 'current cash balance' : null,
        spending === null ? 'a complete calendar month of spending to average' : null]
        .filter(Boolean).join('; '));
  }
  const schedule = input.spendingSchedule;

  // The cumulative position on a date, exactly as `projectCash` computes it.
  const cumulative = (toISO: string): number => {
    const f = foldWindow(events, dailyRate, asOf, toISO, asOf, schedule);
    return openingCash + f.inflow - f.outflow - (f.spend as number);
  };

  const isClamped = window.fromISO <= asOf;
  // Clamped: the cumulative projection itself — events dated from `asOf`, spending
  // from the day after it. Otherwise: both ends inclusive.
  const measuredFrom = isClamped ? asOf : window.fromISO;
  const openingDate = isClamped ? asOf : addDays(window.fromISO, -1);
  const days = daysBetween(openingDate, window.toISO);
  const fold = foldWindow(events, dailyRate, measuredFrom, window.toISO, openingDate, schedule);
  const opening = isClamped ? openingCash : cumulative(openingDate);
  const closing = cumulative(window.toISO);

  return {
    status: 'PROJECTED', refusal: null, requested,
    fromISO: measuredFrom, toISO: window.toISO, days,
    clamped: isClamped ? { requestedFromISO: window.fromISO,
      reason: `the part of the interval up to ${asOf} has already happened and is not projected; `
        + `this is the projection from ${asOf}: income dated from ${asOf}, spending accrued `
        + `from the day after it. Measure ${window.fromISO}..${asOf} from transactions.` } : null,
    opening: { dateISO: openingDate, cash: opening },
    closing: { dateISO: window.toISO, cash: closing },
    cashChange: closing - opening,
    components: namedComponents(
      { inflow: fold.inflow, outflow: fold.outflow, spend: fold.spend as number }, spending, days,
      departureOf(schedule, dailyRate, fold.spend as number, days)),
    eventsCounted: fold.counted,
    excluded: fold.excluded,
  };
}
