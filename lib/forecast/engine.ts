/**
 * lib/forecast/engine.ts
 *
 * FORECAST-9 — THE CASH PATH, AND NOTHING ELSE.
 *
 * Pure: no DB, no model, no clock of its own, no persistence. Substrate only.
 *
 *   CurrentOperatingState + FutureCashEvent[] + ForecastPolicy → CashForecast
 *
 * ── This module is deliberately boring ─────────────────────────────────────
 * Eight slices decided eight hard questions — when money arrives, whether a
 * stream still pays, what an amount is an amount of, which bills are known,
 * what the current level is, what ordinary spending looks like, what may be
 * concluded, and what may be supposed. Every one of them is a place where a
 * forecast could go wrong by being clever.
 *
 * So this one is not clever. It orders dated events, spreads a stated rate over
 * days, adds and subtracts, and refuses when an input it needs is not there.
 * If it ever needs to decide something, that is a missing authority upstream
 * and not a gap to fill here.
 *
 * ── What it may not do, and why the list is structural ─────────────────────
 * The measured live failures were not arithmetic errors. They were an engine
 * answering a question nobody had licensed:
 *
 *   #3/#4  biweekly income read as "two checks a month" — 24 a year, not 26.
 *          Closed by never counting paychecks: income arrives as dated events
 *          this module cannot generate and does not know how to.
 *   #5/#6  a trailing average of three unlike months presented as normal
 *          spending. Closed by having no parameter through which a transaction
 *          could arrive. There is no history here to average.
 *   #7     a $10,000 spending scenario nobody asked for. Closed upstream, in
 *          FORECAST-8, and inherited: an amount reaches this engine only from
 *          an authority or from an assumption carrying the words that asked
 *          for it.
 *   #8     $15,500 gross plus $1,500 of unknown basis offered as $17,000 of
 *          spendable cash. Closed by routing every event through FORECAST-3's
 *          `netCashContribution`, which refuses both.
 *
 * ── The one number this module must never produce ──────────────────────────
 * A closing balance that looks factual and is not. Hence: no naked scalar. The
 * full cash path is `number | null` beside a status and the assumptions it
 * rests on, and null is not zero — it is the refusal FORECAST-7 already issued
 * for FORECAST_ENDING_CASH, consumed rather than re-derived.
 */

import { ComponentState } from '../ai/economic-concepts';
import {
  AmountBasis, netCashContribution,
  type EventAmount, type FutureCashEvent,
} from './future-cash-event';
import { dailySpendRate, PeriodBasis, type PeriodBasisKind } from './spending-baseline';
import {
  Conclusion, type ConclusionKind, type CurrentOperatingState,
} from './operating-state';
import {
  AssumptionStance, ConclusionStatus, EMPTY_POLICY, applyPolicy, effectiveEventAmount,
  type ConclusionStatusKind, type ForecastHorizon, type ForecastPolicy,
  type PolicyAssumption, type PolicyResolution, type RejectedAssumption, type ResolvedEvent,
} from './policy';

// ── Dates ───────────────────────────────────────────────────────────────────
//
// ⚠️ DAYS ONLY. Differencing two UTC midnights is exact — there is no
// convention to disagree about and no month to approximate. Calendar MONTH
// arithmetic is deliberately absent for the reason FORECAST-8 gave: it already
// lives in `lib/perspectives/time-range.ts`, and a second copy would be a
// second opinion. Nothing here turns "three months" into a date; a horizon
// arrives as two dates somebody already chose.

const DAY_MS = 86_400_000;
const at = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);
const daysBetween = (fromISO: string, toISO: string) => Math.round((at(toISO) - at(fromISO)) / DAY_MS);
const addDays = (iso: string, n: number) => new Date(at(iso) + n * DAY_MS).toISOString().slice(0, 10);

// ── Money ───────────────────────────────────────────────────────────────────
//
// ⚠️ NO ROUNDING, PER THE REPOSITORY'S D-4 DOCTRINE (`lib/money/convert.ts`:
// "full f64 precision end to end; display rounding belongs to the existing
// formatting boundary"). FORECAST-3 restates it and this module follows it,
// rather than introducing minor-unit arithmetic that would disagree with every
// other total in the codebase.
//
// The real Space is exactly why it matters. Vectrus derives $5,286.645 — a
// genuine half-cent, because the level is the median of two payments a cent
// apart. Rounding each occurrence to cents and then summing seven of them
// drifts from the true total; carrying full precision and rounding once, at
// the edge, does not. `money()` below is that edge and the ONLY place a figure
// is rounded.

const CURRENCY = 'USD';
const money = (n: number) => `${CURRENCY} ${n.toFixed(2)}`;

// ── Spending treatment ──────────────────────────────────────────────────────

/**
 * How the discretionary level enters the cash path.
 *
 * ⚠️ ACCRUAL, NEVER FABRICATED EVENTS. A level could be turned into dated
 * outflows — $4,000 on the 1st of each month — and it would make the arithmetic
 * marginally simpler. It would also invent transaction dates the user never
 * gave, put them in the same array as a real rent payment, and make the two
 * indistinguishable to anything downstream. FORECAST-3 refused to invent a date
 * for a range-timed bonus; inventing twelve of them for a rate would be worse.
 *
 * So spending is a rate applied to elapsed days, and it is reported in its own
 * field on every point, never in `outflows`.
 *
 * ── WHY DAILY PRORATION AND NOT CALENDAR-MONTH ALLOCATION ──────────────────
 * Three representations were considered:
 *
 *   calendar-month  $4,000 in each whole month, prorated across the stubs.
 *                   Needs two rules, and the second rule is daily proration
 *                   anyway — so it is this scheme plus a special case. It also
 *                   makes February cheaper than January, which is right for a
 *                   monthly BILL and wrong for a monthly RATE: the user said
 *                   how fast money leaves, not that it leaves on the 1st.
 *   28-day periods  matches how FORECAST-6 MEASURED the baseline, and measuring
 *                   in 28-day windows is a statement about comparable evidence,
 *                   not a claim that cash departs every 28 days. It would also
 *                   need proration for the trailing partial period.
 *   daily rate      one rule, exact for any horizon including a 17-day one, no
 *                   boundary to invent, and identical to the other two over a
 *                   whole number of periods.
 *
 * Daily wins on being smallest, and the day-count conversion lives in
 * FORECAST-6 (`dailySpendRate`) rather than here, so "per month" means the same
 * thing to the authority that established the level and to the engine spending
 * it.
 */
export const SpendingSource = {
  /** FORECAST-6 established the level. */
  AUTHORITATIVE: 'AUTHORITATIVE',
  /** FORECAST-8 supposed it. */
  ASSUMED: 'ASSUMED',
  /** Nobody established it. ⚠️ NOT ZERO — the cash path refuses. */
  UNRESOLVED: 'UNRESOLVED',
} as const;

export type SpendingSourceKind = typeof SpendingSource[keyof typeof SpendingSource];

export interface SpendingTreatment {
  source: SpendingSourceKind;
  /** The stated level, in the unit it was stated in. Null when UNRESOLVED. */
  amount: number | null;
  periodBasis: PeriodBasisKind | null;
  /** The level per day. Null when UNRESOLVED. Never defaulted. */
  dailyRate: number | null;
  /** The assumption this rests on, when it rests on one. */
  assumptionId: string | null;
  reason: string;
}

// ── Events on the path ──────────────────────────────────────────────────────

/**
 * One dated movement, and every separate fact about it kept separate.
 *
 * ⚠️ THREE PROVENANCES, NOT ONE (§17). A Vectrus paycheck inside a scenario has
 * a DERIVED date, a DERIVED amount and a SUPPOSED basis, and flattening those
 * into "assumed paycheck" loses which part the user would have to correct.
 */
export interface ForecastEvent {
  id: string;
  dateISO: string;
  direction: 'INFLOW' | 'OUTFLOW';
  role: string;
  /** Who established the DATE. */
  timingProvenance: string;
  /** The authoritative amount, exactly as the event holds it. Never rewritten. */
  authoritativeAmount: EventAmount | null;
  /** The basis this scenario treats it as having, when a policy supposed one. */
  assumedBasis: string | null;
  /** Signed contribution to spendable cash. Null when not licensed — never 0. */
  cashDelta: number | null;
  /** Why `cashDelta` is null, when it is. FORECAST-3's own words. */
  refusalReason: string | null;
  included: boolean;
  dependencies: string[];
}

// ── Points ──────────────────────────────────────────────────────────────────

/**
 * The balance at one date on the path.
 *
 * ⚠️ POINTS ARE SPARSE, AND THAT IS A MEASURED CHOICE (§27). One point per
 * distinct event date, plus the horizon end. Daily points were considered and
 * rejected: with spending as a uniform daily rate the balance between two
 * events is a straight line, so 94 daily rows carry the information of 8 and
 * cost twelve times the tokens. Month-end points were considered and rejected
 * for the same reason — a prorated rate has no month boundary to preserve; the
 * boundary only exists in the calendar-month scheme this engine did not choose.
 *
 * Nothing is lost by the sparseness. `openingBalance` is the trough of its
 * segment — the balance after all accrual and before the day's inflows — so the
 * lowest point of every straight line is a row here, and `firstNegativeDateISO`
 * is solved exactly rather than sampled.
 */
export interface ForecastPoint {
  dateISO: string;
  /** Days of spending accrued since the previous point. Zero at the first. */
  elapsedDays: number;
  /**
   * Balance after this segment's accrual and BEFORE this date's events.
   *
   * Null when the full path is refused. ⚠️ Null is not zero.
   */
  openingBalance: number | null;
  /** Licensed spendable inflows landing on this date. */
  inflows: number;
  /** Licensed event outflows landing on this date. */
  outflows: number;
  /** Accrued discretionary spending for `elapsedDays`. Null when unresolved. */
  discretionarySpend: number | null;
  closingBalance: number | null;
  /**
   * Opening cash plus licensed event deltas to date, with NO spending.
   *
   * ⚠️ A DIFFERENT QUESTION, NOT A FALLBACK. "What do the movements I know
   * about do to my balance" is answerable while ordinary spending is unknown,
   * and it is not an estimate of the closing balance — it is an upper bound
   * that omits a term. It is never called ending cash.
   */
  knownEventBalance: number | null;
  eventIds: string[];
  /** Assumptions this point's balance rests on. Minimal, and cumulative. */
  dependencies: string[];
}

// ── Paths ───────────────────────────────────────────────────────────────────

export interface CashPath {
  status: ConclusionStatusKind;
  /** ⚠️ Null when REFUSED. Never zero, never a partial sum wearing the name. */
  closing: number | null;
  dependencies: string[];
  /** What is still missing, when REFUSED. FORECAST-7's wording, unedited. */
  missing: string[];
}

export interface CashForecast {
  horizon: ForecastHorizon;
  /** Elapsed days from start to end. Both endpoints' events are included. */
  horizonDays: number;
  openingCash: {
    state: string;
    amount: number | null;
    asOfISO: string | null;
    reason: string | null;
  };
  points: ForecastPoint[];
  events: ForecastEvent[];
  spending: SpendingTreatment;
  /**
   * Opening cash plus every licensed event, with no spending term.
   *
   * Computable whenever opening cash and the events are licensed, including
   * when ordinary spending is unknown — which is the real Space today.
   */
  knownEventPath: CashPath;
  /** The whole thing. Refused unless every term is licensed. */
  fullCashPath: CashPath;
  /**
   * The same full path with the policy removed.
   *
   * ⚠️ FORECAST-8'S PATTERN, KEPT (§13): authoritative BESIDE scenario, never
   * one path whose supposed values read as facts. Present only when the policy
   * has assumptions — with none, `fullCashPath` already IS the authoritative
   * answer and repeating it would suggest two calculations happened.
   *
   * It is not always a refusal. A counterfactual replacing an established
   * baseline gives two real numbers, and this is where the one the user's own
   * evidence supports can still be read.
   */
  withoutAssumptions: CashPath | null;
  /** First date the balance is below zero, when the full path is computed. */
  firstNegativeDateISO: string | null;
  accepted: readonly PolicyAssumption[];
  rejected: readonly RejectedAssumption[];
  unresolvedInputs: string[];
}

// ── Engine ──────────────────────────────────────────────────────────────────

/** A licensed cash contribution, signed for direction. Null means unlicensed. */
function cashDeltaOf(r: ResolvedEvent): { delta: number | null; reason: string | null } {
  const amount = effectiveEventAmount(r);
  if (!amount) {
    // ⚠️ An event with no amount is UNRESOLVED, not zero. FORECAST-3's own
    // refusal is used verbatim rather than paraphrased.
    return { delta: null, reason: netCashContribution(r.event).assertable
      ? null : (netCashContribution(r.event) as { reason: string }).reason };
  }
  const view: FutureCashEvent = { ...r.event, amount };
  const c = netCashContribution(view);
  if (!c.assertable) return { delta: null, reason: c.reason };
  return { delta: r.event.direction === 'INFLOW' ? c.value : -c.value, reason: null };
}

/** How the discretionary level enters, or why it cannot. */
function spendingTreatment(res: PolicyResolution): SpendingTreatment {
  const authority = res.baseline.authority;
  const supposed = res.baseline.assumption;

  // ⚠️ PRECEDENCE IS FORECAST-8'S, NOT A SECOND ONE. A supposition survives
  // validation over an established baseline only when it is explicitly
  // counterfactual, so by the time it arrives here it is entitled to displace
  // the fact. Preferring the authority unconditionally would silently discard
  // the scenario the user asked for.
  if (supposed && (authority.state !== ComponentState.ASSERTABLE
    || supposed.stance === AssumptionStance.COUNTERFACTUAL)) {
    return {
      source: SpendingSource.ASSUMED, amount: supposed.amount, periodBasis: supposed.periodBasis,
      dailyRate: dailySpendRate(supposed.amount, supposed.periodBasis),
      assumptionId: supposed.id,
      reason: `supposed for this forecast: ${supposed.statedAs}`,
    };
  }
  if (authority.state === ComponentState.ASSERTABLE && authority.amount !== null) {
    const basis = authority.periodBasis ?? PeriodBasis.PER_28_DAYS;
    return {
      source: SpendingSource.AUTHORITATIVE, amount: authority.amount, periodBasis: basis,
      dailyRate: dailySpendRate(authority.amount, basis), assumptionId: null,
      reason: authority.reason,
    };
  }
  return {
    // ⚠️ NOT ZERO, AND NO TRAILING AVERAGE. There is no parameter on
    // `forecastCash` through which a transaction could arrive, so this branch
    // cannot be talked out of by better evidence — only by an authority or an
    // assumption, both of which are already checked above.
    source: SpendingSource.UNRESOLVED, amount: null, periodBasis: null,
    dailyRate: null, assumptionId: null, reason: authority.reason,
  };
}

const statusOf = (res: PolicyResolution, c: ConclusionKind) =>
  res.conclusions.find((x) => x.conclusion === c)!;

/**
 * Compute the cash path.
 *
 * ⚠️ THE SIGNATURE IS THE ARCHITECTURE, AGAIN. Three authorities and nothing
 * else: no transactions, no snapshots, no accounts, no recurring candidates, no
 * ledger, no context. §2's boundary is enforced by there being nowhere for any
 * of that to enter, and a test pins the parameter list character by character.
 *
 * ⚠️ IT DECIDES NO LICENCE OF ITS OWN. Whether the full path may be stated is
 * FORECAST-7's `FORECAST_ENDING_CASH` conclusion, resolved through FORECAST-8
 * and read off the resolution. This engine can no more license a forecast than
 * it can invent a paycheck.
 */
export function forecastCash(
  state: CurrentOperatingState,
  events: readonly FutureCashEvent[],
  policy: ForecastPolicy,
): CashForecast | { refused: true; reason: string } {
  if (!policy.horizon) {
    return { refused: true, reason: 'a forecast needs a bounded horizon, and the policy states none' };
  }
  return runForecast(state, events, policy, policy.horizon, true);
}

function runForecast(
  state: CurrentOperatingState,
  events: readonly FutureCashEvent[],
  policy: ForecastPolicy,
  horizon: ForecastHorizon,
  withCounterfactualPath: boolean,
): CashForecast {
  const res = applyPolicy(state, events, policy);
  const spending = spendingTreatment(res);
  const { fromISO, toISO } = horizon;
  const horizonDays = daysBetween(fromISO, toISO);

  // ── Opening cash ──────────────────────────────────────────────────────────
  // ⚠️ LIQUIDITY, AND ONLY LIQUIDITY. `state.investments` is right there on the
  // same object, holding $24,021.19 of which $19,014.63 is crypto, and it is not
  // cash. Nothing below reads it; a test pins that the identifier never appears.
  const liq = state.liquidity;
  const openingCash = {
    state: liq.state, amount: liq.state === ComponentState.UNKNOWN ? null : liq.amount,
    asOfISO: liq.asOfISO, reason: liq.reason,
  };
  const openingLicensed = statusOf(res, Conclusion.CURRENT_LIQUID_BALANCE).status
    === ConclusionStatus.FACTUALLY_LICENSED && openingCash.amount !== null;

  // ── Events on the path ────────────────────────────────────────────────────
  // ⚠️ FILTERED BY DATE, NEVER GENERATED. FORECAST-1 and FORECAST-3 own
  // occurrence generation and this module cannot reach either; whatever it is
  // handed is what happens. Both endpoints are inclusive.
  const inWindow = res.events.filter((r) => {
    const d = r.event.timing.kind === 'EXACT' ? r.event.timing.dateISO : null;
    return d !== null && d >= fromISO && d <= toISO;
  });

  const counterfactual = new Set(res.accepted
    .filter((a) => a.stance === AssumptionStance.COUNTERFACTUAL).map((a) => a.id));

  const forecastEvents: ForecastEvent[] = inWindow.map((r) => {
    const { delta, reason } = cashDeltaOf(r);
    const deps: string[] = [];
    // A basis supposition is a dependency only where it changed the answer.
    if (r.basisAssumptionId && r.authorityAmount?.basis !== AmountBasis.NET) {
      deps.push(r.basisAssumptionId);
    }
    if (r.inclusionAssumptionId) deps.push(r.inclusionAssumptionId);
    return {
      id: r.id,
      dateISO: (r.event.timing as { dateISO: string }).dateISO,
      direction: r.event.direction, role: r.event.role,
      timingProvenance: r.event.timingProvenance,
      authoritativeAmount: r.authorityAmount,
      assumedBasis: r.assumedBasis,
      cashDelta: r.included ? delta : null,
      refusalReason: r.included ? reason : 'excluded from this scenario by an explicit assumption',
      included: r.included,
      dependencies: deps,
    };
  });

  // ── Unresolved inputs ─────────────────────────────────────────────────────
  const unresolvedInputs: string[] = [];
  if (!openingLicensed) unresolvedInputs.push('current liquid balance');
  if (spending.source === SpendingSource.UNRESOLVED) {
    unresolvedInputs.push('current-normal discretionary spending');
  }
  // ⚠️ ONE ENTRY PER REASON, not per event: what is unresolved is the question,
  // and seven paychecks share one.
  const refusedEvents = forecastEvents.filter((e) => e.included && e.cashDelta === null);
  for (const reason of new Set(refusedEvents.map(
    (e) => e.refusalReason ?? 'no cash contribution is licensed'))) {
    const n = refusedEvents.filter((e) => (e.refusalReason ?? '') === reason).length;
    unresolvedInputs.push(`${n} event(s): ${reason}`);
  }

  // ── The licence, consumed rather than re-derived ──────────────────────────
  const endingLicence = statusOf(res, Conclusion.FORECAST_ENDING_CASH);
  const eventsAllLicensed = forecastEvents.every((e) => !e.included || e.cashDelta !== null);
  const fullComputable = endingLicence.status !== ConclusionStatus.REFUSED
    && openingLicensed && spending.dailyRate !== null && eventsAllLicensed;

  // ── Walk the path ─────────────────────────────────────────────────────────
  const dates = [...new Set([fromISO, ...forecastEvents.filter((e) => e.included).map((e) => e.dateISO), toISO])]
    .sort();
  const byDate = new Map<string, ForecastEvent[]>();
  for (const e of forecastEvents) {
    if (!e.included) continue;
    byDate.set(e.dateISO, [...(byDate.get(e.dateISO) ?? []), e]);
  }

  const points: ForecastPoint[] = [];
  let balance = openingLicensed ? (openingCash.amount as number) : null;
  let known = openingLicensed ? (openingCash.amount as number) : null;
  let prev = fromISO;
  const deps = new Set<string>();
  let firstNegativeDateISO: string | null = null;

  for (const dateISO of dates) {
    const elapsedDays = daysBetween(prev, dateISO);
    const accrual = spending.dailyRate !== null ? spending.dailyRate * elapsedDays : null;
    if (spending.assumptionId && accrual !== null && elapsedDays > 0) deps.add(spending.assumptionId);

    const opening = balance !== null && accrual !== null ? balance - accrual : null;

    // ⚠️ SAME-DAY EVENTS ARE AGGREGATED, NOT ORDERED (§6). Nothing in the
    // evidence says which of two payments on the 11th settled first, and
    // inventing an order would put an intraday sequence into a daily model that
    // could not honour it. Addition is commutative, so the closing balance is
    // exact either way; only a claim about an intraday trough would need more,
    // and this engine makes none.
    const here = byDate.get(dateISO) ?? [];
    let inflows = 0, outflows = 0;
    for (const e of here) {
      if (e.cashDelta === null) continue;
      if (e.cashDelta >= 0) inflows += e.cashDelta; else outflows += -e.cashDelta;
      for (const d of e.dependencies) deps.add(d);
    }

    const closing = opening !== null ? opening + inflows - outflows : null;
    const knownClosing = known !== null ? known + inflows - outflows : null;

    // First crossing INSIDE the segment, solved rather than sampled: the
    // balance falls in a straight line, so the day it goes below zero is exact.
    if (firstNegativeDateISO === null && balance !== null && spending.dailyRate !== null
      && spending.dailyRate > 0 && elapsedDays > 0) {
      const d = Math.floor(balance / spending.dailyRate) + 1;
      if (balance < 0) firstNegativeDateISO = prev;
      else if (d <= elapsedDays) firstNegativeDateISO = addDays(prev, d);
    }
    if (firstNegativeDateISO === null && closing !== null && closing < 0) firstNegativeDateISO = dateISO;

    points.push({
      dateISO, elapsedDays,
      openingBalance: fullComputable ? opening : null,
      inflows, outflows,
      discretionarySpend: fullComputable ? accrual : null,
      closingBalance: fullComputable ? closing : null,
      knownEventBalance: openingLicensed && eventsAllLicensed ? knownClosing : null,
      eventIds: here.map((e) => e.id),
      dependencies: [...deps],
    });
    balance = closing; known = knownClosing; prev = dateISO;
  }

  if (!fullComputable) firstNegativeDateISO = null;

  // ── Statuses ──────────────────────────────────────────────────────────────
  // ⚠️ ESCALATION ONLY, NEVER A DOWNGRADE. A path is factual only when nothing
  // it used was supposed; one counterfactual anywhere in its dependencies makes
  // it hypothetical, and that verdict cannot be walked back by a later term.
  const rank = (dependencies: string[]): ConclusionStatusKind =>
    dependencies.some((d) => counterfactual.has(d)) ? ConclusionStatus.HYPOTHETICAL
      : dependencies.length > 0 ? ConclusionStatus.ASSUMPTION_DEPENDENT
        : ConclusionStatus.FACTUALLY_LICENSED;

  const last = points.at(-1);
  // ⚠️ THE HORIZON IS NOT LISTED HERE, AND THAT IS DELIBERATE. FORECAST-8's
  // FORECAST_ENDING_CASH conclusion names `horizon` among its dependencies,
  // correctly: a different end date gives a different number. But a horizon is a
  // question boundary somebody chose, not a supposition about the world, and
  // carrying it in this list would make every forecast ever computed
  // ASSUMPTION_DEPENDENT — including one built entirely from asserted facts,
  // which is the case FORECAST-9A existed to make possible. The horizon is a
  // top-level field on the result; nothing is hidden by keeping it out of a list
  // whose members are things somebody supposed.
  const fullDeps = fullComputable ? [...new Set(last?.dependencies ?? [])] : [];
  const fullCashPath: CashPath = fullComputable
    ? { status: rank(fullDeps), closing: last?.closingBalance ?? null, dependencies: fullDeps, missing: [] }
    : {
      status: ConclusionStatus.REFUSED, closing: null, dependencies: [],
      missing: [...new Set([...endingLicence.missing, ...unresolvedInputs])],
    };

  // The known-event path never uses spending, so it never depends on a spending
  // assumption — §16's minimality, applied to a whole path.
  const knownDeps = [...new Set(forecastEvents.filter((e) => e.included)
    .flatMap((e) => e.dependencies))];
  const knownEventPath: CashPath = openingLicensed && eventsAllLicensed
    ? {
      status: rank(knownDeps), closing: last?.knownEventBalance ?? null,
      dependencies: knownDeps, missing: [],
    }
    : {
      status: ConclusionStatus.REFUSED, closing: null, dependencies: [],
      missing: openingLicensed
        ? unresolvedInputs.filter((u) => u !== 'current-normal discretionary spending')
        : ['current liquid balance'],
    };

  const withoutAssumptions = withCounterfactualPath && policy.assumptions.length > 0
    ? runForecast(state, events, { ...EMPTY_POLICY, horizon }, horizon, false).fullCashPath
    : null;

  return {
    horizon, horizonDays, openingCash, points, events: forecastEvents, spending,
    knownEventPath, fullCashPath, withoutAssumptions, firstNegativeDateISO,
    accepted: res.accepted, rejected: res.rejected,
    unresolvedInputs: [...new Set(unresolvedInputs)],
  };
}

// ── Explanation ─────────────────────────────────────────────────────────────

const label = (s: string) => s.toLowerCase().replace(/_/g, ' ');

/**
 * A compact statement of the forecast. Designed and measured; NOT production-wired.
 *
 * ⚠️ STRUCTURE FOR A MODEL TO RENDER, NOT PROSE THAT PRETENDS CERTAINTY. Every
 * line is computed. The later model-facing slice explains this; it does not
 * redo the arithmetic, and it is never handed a bare closing balance to
 * narrate.
 */
export function explainForecast(f: CashForecast): string[] {
  const lines = [`Cash forecast ${f.horizon.fromISO}..${f.horizon.toISO} (${f.horizonDays} days):`];

  lines.push(`  Opening cash: ${f.openingCash.amount !== null
    ? money(f.openingCash.amount) : `${f.openingCash.state} — ${f.openingCash.reason}`}`
    + '. Investments and digital assets are NOT opening cash.');

  const inc = f.events.filter((e) => e.included && e.direction === 'INFLOW');
  const out = f.events.filter((e) => e.included && e.direction === 'OUTFLOW');
  const sum = (xs: ForecastEvent[]) => xs.reduce((t, e) => t + Math.abs(e.cashDelta ?? 0), 0);
  // ⚠️ GROUPED BY REASON, NOT LISTED PER EVENT. Seven paychecks refused for one
  // reason is one fact; printing the same sentence seven times spent 600 tokens
  // of an 500-token budget saying it once.
  const dates = (xs: ForecastEvent[]) => {
    const d = [...new Set(xs.map((e) => e.dateISO))].sort();
    return d.length <= 3 ? d.join(', ') : `${d[0]}..${d.at(-1)}, ${d.length} dates`;
  };
  const listed = (xs: ForecastEvent[]) => xs.length
    ? `${xs.length} × (${dates(xs)}) totalling ${money(sum(xs))}`
    : 'none';

  lines.push(`  Known inflows: ${listed(inc)}.`);
  lines.push(`  Known outflows: ${listed(out)}.`);
  const unlicensed = f.events.filter((e) => e.included && e.cashDelta === null);
  if (unlicensed.length) {
    const byReason = new Map<string, ForecastEvent[]>();
    for (const e of unlicensed) {
      const k = e.refusalReason ?? 'no cash contribution is licensed';
      byReason.set(k, [...(byReason.get(k) ?? []), e]);
    }
    lines.push(`  NOT counted as cash: ${[...byReason.entries()].map(([reason, xs]) =>
      `${xs.length} × (${dates(xs)}) — ${reason}`).join('; ')}.`);
  }

  lines.push(`  Baseline spending: ${f.spending.dailyRate !== null
    ? `${money(f.spending.amount as number)} per ${f.spending.periodBasis === PeriodBasis.MONTHLY
      ? 'month' : '28 days'} — ${label(f.spending.source)}, accrued as a rate over `
      + `${f.horizonDays} days, not as dated payments`
    : `UNRESOLVED — ${f.spending.reason}`}`);

  if (f.accepted.length) {
    lines.push(`  Assumptions: ${f.accepted.map((a) => `[${a.id}] ${a.statedAs}`
      + (a.stance === AssumptionStance.COUNTERFACTUAL ? ' (HYPOTHETICAL)' : '')).join('; ')}.`);
  }
  if (f.unresolvedInputs.length) lines.push(`  Unresolved: ${f.unresolvedInputs.join('; ')}.`);

  const path = (name: string, p: CashPath) => `  ${name}: ${p.closing !== null
    ? `${money(p.closing)} · ${p.status}${p.dependencies.length
      ? ` (needs ${p.dependencies.join(' + ')})` : ''}`
    : `REFUSED — needs ${p.missing.join(', ')}`}`;

  lines.push(path('Known-event balance (excludes ordinary spending)', f.knownEventPath));
  lines.push(path('Ending cash', f.fullCashPath));
  if (f.withoutAssumptions) lines.push(path('Ending cash WITHOUT the assumptions', f.withoutAssumptions));
  if (f.firstNegativeDateISO) lines.push(`  Balance first goes below zero on ${f.firstNegativeDateISO}.`);
  lines.push('  Investments are not liquidated and debt balances do not change; this is a cash path only. '
    + 'An assumed figure may NOT be reported as observed.');
  return lines;
}
