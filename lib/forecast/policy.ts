/**
 * lib/forecast/policy.ts
 *
 * FORECAST-8 — WHAT WE ARE ASSUMING, AND WHAT THAT IS PERMITTED TO UNLOCK.
 *
 * Pure: no DB, no model, no clock of its own, no persistence. Substrate only.
 *
 * ── The third term ─────────────────────────────────────────────────────────
 *
 *   CurrentOperatingState + FutureCashEvent[] + ForecastPolicy → forecast
 *
 * FORECAST-7 built the first term and, more importantly, the refusals: eight of
 * fourteen conclusions are not sayable about the real Space because the spending
 * baseline is UNKNOWN and no income amount has a NET basis. Those refusals are
 * correct and this module does not soften one of them.
 *
 * What it adds is the honest alternative to softening them. A user may say
 * "assume I spend $4,000 a month" and get arithmetic — provided the answer says
 * that the $4,000 was assumed, that the ledger still establishes nothing, and
 * exactly which conclusions rest on it.
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 *
 *   AN ASSUMPTION MAY LICENSE A CALCULATION.
 *   IT MUST NEVER REWRITE THE UNDERLYING FACT.
 *
 * Enforced three ways, none of them a convention:
 *
 *   1. `applyPolicy` receives `readonly` state and events and returns the SAME
 *      object references. There is no code path from a policy to a mutation.
 *   2. Every resolved quantity carries `authority` and `assumption` as separate
 *      fields and has NO merged scalar. A caller reaching for a number has to
 *      choose which one they are reading, and both are labelled.
 *   3. The licence a policy composes over is FORECAST-7's, called unmodified.
 *      This module cannot make a conclusion licensed that FORECAST-7 would not
 *      license given the same components; it can only supply components, and
 *      only as assumptions that travel with the answer.
 *
 * ── Fact, assertion, assumption, hypothesis ────────────────────────────────
 * Four things, and collapsing any two of them is the failure this slice exists
 * to prevent:
 *
 *   "I spend $4,000 a month."          a claim about the world. If accepted it
 *                                      belongs to FORECAST-6, through
 *                                      `assertedSpendingBaseline`, and it makes
 *                                      the baseline genuinely ASSERTABLE.
 *
 *   "Assume I spend $4,000 a month."   not a claim about the world. It belongs
 *                                      here, the baseline stays UNKNOWN, and
 *                                      everything computed from it is labelled.
 *
 *   "Show me spending $10,000 a month" deliberately counterfactual. Same
 *                                      machinery, different stance, and a
 *                                      conclusion that may never be described
 *                                      as the user's actual spending.
 *
 * The first is not this module's business at all. `routeStatement` below exists
 * precisely to send it away — to name the upstream authority and hand back the
 * payload for it — because the tempting shortcut is to accept everything into
 * policy, where it is easy, and then quietly render it like a fact.
 *
 * ── Provenance vocabulary is reused, not reinvented ────────────────────────
 * FORECAST-3 already minted `EventProvenance.HYPOTHETICAL` and reserved it in
 * so many words for "a later forecast-policy slice ... rather than borrowing
 * USER_ASSERTED and making a supposition look like something the user said".
 * This is that slice, and that is the value used. `AmountBasis`, `ComponentState`
 * and `ConclusionKind` are likewise imported rather than paraphrased.
 *
 * Two axes ARE new, because nothing existing carries them:
 *
 *   origin   WHO wanted the assumption — the user, or the system's own policy.
 *   stance   WHETHER it is offered as plausible or as deliberately contrary.
 *
 * Both earn their place by changing behaviour: origin gates what a system
 * default may ever assume (see SYSTEM DEFAULTS), and stance decides whether an
 * assumption is allowed to contradict an established fact (see PRECEDENCE).
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 *
 *   No arithmetic.       No forecast is computed. FORECAST-9's job.
 *   No ratios.           "Assume 70% of the gross bonus arrives" is a
 *                        withholding rate wearing a scenario's coat: it turns
 *                        a GROSS figure into a spendable one by a number this
 *                        program has refused to hold since FORECAST-3. There is
 *                        no field for it and no constructor that could take one.
 *                        A user who knows the net figure may state the net
 *                        figure; that is an amount, not a rate.
 *   No calendar maths.   A horizon is two explicit dates. Turning "three months"
 *                        into a date belongs to `lib/perspectives/time-range.ts`,
 *                        which already owns calendar clamping; forking it here
 *                        to get an `addMonths` would create a second temporal
 *                        authority to disagree with the first.
 *   No history.          `applyPolicy` has no parameter through which a
 *                        transaction, a period or an average could arrive.
 *                        There is no history-to-average-to-forecast path in this
 *                        module because there is nowhere to put the history.
 */

import { ComponentState } from '../ai/economic-concepts';
import {
  AmountBasis, EventProvenance, composeFutureCash,
  type AmountBasisKind, type CashComposition, type EventAmount, type FlowRoleKind,
  type FutureCashEvent,
} from './future-cash-event';
import { PeriodBasis, type PeriodBasisKind } from './spending-baseline';
import {
  Conclusion, conclusionLicence,
  type ConclusionKind, type CurrentOperatingState, type BaselineState,
} from './operating-state';

// ── Origin ──────────────────────────────────────────────────────────────────

/**
 * Who wanted this assumption.
 *
 * ⚠️ SYSTEM DEFAULTS ARE A CLOSED LIST OF ONE. See `CONTINUE_LICENSED_CADENCE`.
 * The test for whether something may be a system default is whether it decides
 * the SCOPE OF A QUESTION or invents a FINANCIAL FACT:
 *
 *   "include occurrences FORECAST-2 already licensed"     scope. Legitimate.
 *   "assume an unknown paycheck is net"                   a fact. Never.
 *   "use trailing three-month spending as the baseline"   a fact, and precisely
 *                                                         the one FORECAST-6
 *                                                         measured and refused.
 *
 * A third value, DERIVED_POLICY, was considered and not minted: nothing here
 * derives a policy from anything, so it would name an empty producer, and the
 * one thing a provenance value must never be is available for the wrong reason.
 */
export const AssumptionOrigin = {
  /** The user asked for this supposition, in this interaction. */
  USER_REQUESTED: 'USER_REQUESTED',
  /** A deterministic scoping choice this system makes and discloses. */
  SYSTEM_POLICY: 'SYSTEM_POLICY',
} as const;

export type AssumptionOriginKind = typeof AssumptionOrigin[keyof typeof AssumptionOrigin];

// ── Stance ──────────────────────────────────────────────────────────────────

/**
 * What the assumption claims about plausibility.
 *
 * ⚠️ THIS IS A PRECEDENCE INPUT, NOT A LABEL. An assumption that contradicts an
 * established fact is REJECTED unless it is declared COUNTERFACTUAL — which is
 * the whole difference between filling a gap and overwriting an answer.
 */
export const AssumptionStance = {
  /** Plausible, unverified, filling something nobody established. */
  SUPPOSED: 'SUPPOSED',
  /** Deliberately contrary or exploratory — "show me a world where". */
  COUNTERFACTUAL: 'COUNTERFACTUAL',
} as const;

export type AssumptionStanceKind = typeof AssumptionStance[keyof typeof AssumptionStance];

// ── Dimensions ──────────────────────────────────────────────────────────────

/**
 * The five things a policy may suppose.
 *
 * Each exists because a measured refusal turns on it, not because a forecast
 * might one day want it:
 *
 *   SPENDING_BASELINE    FORECAST-6 refused; six conclusions block on it.
 *   INCOME_BASIS         FORECAST-3 refused NET; five conclusions block on it.
 *   EVENT_BASIS          the $15,500 GROSS bonus / $1,500 UNKNOWN vacation pay.
 *   EVENT_INCLUSION      a known event the user wants out of one scenario.
 *   STREAM_CONTINUATION  which licensed streams a scenario carries forward.
 */
export const AssumptionDimension = {
  SPENDING_BASELINE: 'SPENDING_BASELINE',
  INCOME_BASIS: 'INCOME_BASIS',
  EVENT_BASIS: 'EVENT_BASIS',
  EVENT_INCLUSION: 'EVENT_INCLUSION',
  STREAM_CONTINUATION: 'STREAM_CONTINUATION',
} as const;

export type AssumptionDimensionKind =
  typeof AssumptionDimension[keyof typeof AssumptionDimension];

/** Common to every assumption. No field is optional; nothing is anonymous. */
interface AssumptionBase {
  /** Stable within a policy. Every dependency is reported as one of these. */
  id: string;
  origin: AssumptionOriginKind;
  stance: AssumptionStanceKind;
  /**
   * How it was asked for, carried verbatim.
   *
   * ⚠️ REQUIRED. §9's regression is a scenario amount that appears with nothing
   * behind it; a constructor that could omit this is a producer of exactly that.
   */
  statedAs: string;
}

/** A supposed level of ordinary spending. The baseline authority is untouched. */
export interface SpendingBaselineAssumption extends AssumptionBase {
  dimension: typeof AssumptionDimension.SPENDING_BASELINE;
  amount: number;
  currency: string;
  periodBasis: PeriodBasisKind;
}

/** A supposition that one stream's periodic amount may be treated as net. */
export interface IncomeBasisAssumption extends AssumptionBase {
  dimension: typeof AssumptionDimension.INCOME_BASIS;
  sourceKey: string;
  /** Only NET licenses anything. Anything else is rejected as a no-op. */
  basis: AmountBasisKind;
}

/** The same supposition, for one dated event. */
export interface EventBasisAssumption extends AssumptionBase {
  dimension: typeof AssumptionDimension.EVENT_BASIS;
  eventId: string;
  basis: AmountBasisKind;
}

/**
 * Whether one known event is in this scenario.
 *
 * ⚠️ BY ID, ALWAYS. There is no rule-shaped event policy, which is how §12's
 * precedence is enforced structurally rather than by adjudication: a generic
 * policy cannot reach a known event because a policy cannot address events
 * generically.
 */
export interface EventInclusionAssumption extends AssumptionBase {
  dimension: typeof AssumptionDimension.EVENT_INCLUSION;
  eventId: string;
  include: boolean;
}

/**
 * Whether a stream's already-licensed occurrences are carried forward.
 *
 * ⚠️ THIS CANNOT REACTIVATE ANYTHING. `include: true` against a stream that
 * FORECAST-2 did not make projection-eligible is rejected outright — not
 * downgraded to a hypothetical, not permitted with a COUNTERFACTUAL stance.
 * "I still work at Abacus" is a claim about the world and has a door of its own
 * (`UserAssertion` on FORECAST-2's resolver); letting a continuation policy
 * serve as a second door would make the licence decorative.
 *
 * `sourceKey: null` means every projection-eligible stream — the system default.
 */
export interface StreamContinuationAssumption extends AssumptionBase {
  dimension: typeof AssumptionDimension.STREAM_CONTINUATION;
  sourceKey: string | null;
  include: boolean;
}

export type PolicyAssumption =
  | SpendingBaselineAssumption
  | IncomeBasisAssumption
  | EventBasisAssumption
  | EventInclusionAssumption
  | StreamContinuationAssumption;

// ── System defaults ─────────────────────────────────────────────────────────

/**
 * SYSTEM DEFAULTS — the complete inventory, and it has one member.
 *
 * CONTINUE_LICENSED_CADENCE: occurrences that FORECAST-2 has already licensed
 * are carried through the horizon.
 *
 * Why this is a policy choice and not an invented financial fact: it asserts
 * nothing about money. It decides which already-licensed evidence a scenario
 * spans, and it is gated entirely by `projectionEligible`, so it moves no stream
 * from SILENT to CURRENT and creates no occurrence FORECAST-2 did not license.
 * Its opposite — carry nothing forward — is not more conservative, it is just a
 * different scope, and it would make every forecast empty. The choice is real,
 * so it is materialised as a visible assumption rather than left implicit.
 *
 * Rejected as system defaults, for the record:
 *   "an unknown paycheck is net"        invents the tax treatment FORECAST-3
 *                                       measured as unguessable.
 *   "trailing three months is normal"   invents the level FORECAST-6 measured
 *                                       as underivable, and is live failure #5.
 *   "a range event lands mid-range"     invents a date; FORECAST-3 refused it.
 */
export function continueLicensedCadence(): StreamContinuationAssumption {
  return {
    id: 'system:continue-licensed-cadence',
    dimension: AssumptionDimension.STREAM_CONTINUATION,
    sourceKey: null,
    include: true,
    origin: AssumptionOrigin.SYSTEM_POLICY,
    stance: AssumptionStance.SUPPOSED,
    statedAs: 'occurrences already licensed by observed activity continue through the horizon',
  };
}

// ── Horizon ─────────────────────────────────────────────────────────────────

/**
 * The interval a scenario covers.
 *
 * ⚠️ TWO EXPLICIT DATES, AND NO WAY TO PRODUCE THEM FROM A DURATION. See "No
 * calendar maths" above: the repo's calendar semantics live in
 * `lib/perspectives/time-range.ts` and this module will not fork them into an
 * average-day approximation to make "three months" convenient.
 *
 * A horizon is not a supposition about the world, so it is a field rather than
 * an assumption — but it IS a choice, so it carries an origin and appears in
 * dependency lists under `HORIZON_DEPENDENCY`.
 */
export interface ForecastHorizon {
  fromISO: string;
  toISO: string;
  origin: AssumptionOriginKind;
  statedAs: string;
}

/** The id a horizon reports itself as when a conclusion depends on it. */
export const HORIZON_DEPENDENCY = 'horizon';

export interface ForecastPolicy {
  horizon: ForecastHorizon | null;
  assumptions: readonly PolicyAssumption[];
}

/**
 * No assumptions and no horizon.
 *
 * ⚠️ APPLYING THIS MUST REPRODUCE FORECAST-7 EXACTLY. A test pins the whole
 * capability matrix against `forecastCapabilities`, because the moment an empty
 * policy changes an answer, the policy layer has started asserting things.
 */
export const EMPTY_POLICY: ForecastPolicy = { horizon: null, assumptions: [] };

// ── Validation ──────────────────────────────────────────────────────────────

export const PolicyIssue = {
  DUPLICATE_ASSUMPTION_ID: 'DUPLICATE_ASSUMPTION_ID',
  UNKNOWN_STREAM: 'UNKNOWN_STREAM',
  UNKNOWN_EVENT: 'UNKNOWN_EVENT',
  STREAM_AMOUNT_NOT_ESTABLISHED: 'STREAM_AMOUNT_NOT_ESTABLISHED',
  REACTIVATION_NOT_PERMITTED: 'REACTIVATION_NOT_PERMITTED',
  NOT_A_NET_ASSUMPTION: 'NOT_A_NET_ASSUMPTION',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  INVALID_HORIZON: 'INVALID_HORIZON',
  CONTRADICTS_ESTABLISHED_FACT: 'CONTRADICTS_ESTABLISHED_FACT',
} as const;

export type PolicyIssueKind = typeof PolicyIssue[keyof typeof PolicyIssue];

export interface RejectedAssumption {
  assumptionId: string | null;
  code: PolicyIssueKind;
  reason: string;
}

const isDate = (s: unknown): s is string =>
  typeof s === 'string' && s.length === 10 && Number.isFinite(Date.parse(`${s}T00:00:00.000Z`));

const money = (n: number | null, cur: string) => (n === null ? 'unknown' : `${cur} ${n.toFixed(2)}`);

const perPeriod = (b: PeriodBasisKind) => (b === PeriodBasis.MONTHLY ? 'month' : '28 days');

/**
 * Whether an assumption contradicts something an authority already established.
 *
 * ⚠️ COMPUTED, NEVER DECLARED. A caller cannot mark an assumption
 * non-contradictory to get it past validation; the state and the events decide.
 * Stance is the only escape, and stance is disclosed in every rendering.
 *
 * A spending assumption in a different period basis from an established
 * baseline counts as contradicting it, because comparing them would require
 * converting one — arithmetic this module does not do, over a question
 * FORECAST-6 owns.
 */
function contradicts(
  a: PolicyAssumption,
  state: CurrentOperatingState,
  events: ReadonlyMap<string, FutureCashEvent>,
): string | null {
  if (a.dimension === AssumptionDimension.SPENDING_BASELINE) {
    const b = state.discretionaryBaseline;
    if (b.state !== ComponentState.ASSERTABLE) return null;
    if (b.periodBasis === a.periodBasis && b.amount === a.amount) return null;
    return `an ordinary spending level of ${money(b.amount, b.currency)} per `
      + `${b.periodBasis ? perPeriod(b.periodBasis) : 'period'} is already established`;
  }
  if (a.dimension === AssumptionDimension.INCOME_BASIS) {
    const s = state.incomeStreams.find((x) => x.sourceKey === a.sourceKey);
    if (!s || s.basis === AmountBasis.UNKNOWN || s.basis === a.basis) return null;
    return `${a.sourceKey}'s amount is already established as ${s.basis}`;
  }
  if (a.dimension === AssumptionDimension.EVENT_BASIS) {
    const e = events.get(a.eventId);
    const basis = e?.amount?.basis;
    if (!basis || basis === AmountBasis.UNKNOWN || basis === a.basis) return null;
    return `event ${a.eventId} carries an amount already established as ${basis}`;
  }
  return null;
}

/**
 * Which assumptions a policy may actually use, and why the rest were dropped.
 *
 * ⚠️ FAILS CLOSED. A rejected assumption is not repaired, not coerced and not
 * partially honoured — it is removed, and every conclusion that would have
 * depended on it goes back to REFUSED. The rejection travels on the result so
 * the refusal can say which supposition was not usable.
 */
export function validatePolicy(
  state: CurrentOperatingState,
  events: readonly FutureCashEvent[],
  policy: ForecastPolicy,
): { accepted: PolicyAssumption[]; rejected: RejectedAssumption[]; horizon: ForecastHorizon | null } {
  const byId = new Map(events.map((e) => [e.id, e]));
  const accepted: PolicyAssumption[] = [];
  const rejected: RejectedAssumption[] = [];
  const seen = new Set<string>();

  const reject = (id: string | null, code: PolicyIssueKind, reason: string) =>
    rejected.push({ assumptionId: id, code, reason });

  for (const a of policy.assumptions) {
    if (seen.has(a.id)) {
      reject(a.id, PolicyIssue.DUPLICATE_ASSUMPTION_ID,
        `two assumptions share the id "${a.id}", so a dependency could not name either`);
      continue;
    }
    seen.add(a.id);

    if (a.dimension === AssumptionDimension.SPENDING_BASELINE) {
      if (!Number.isFinite(a.amount) || a.amount < 0) {
        reject(a.id, PolicyIssue.INVALID_AMOUNT,
          'a supposed spending level must be a finite, non-negative amount');
        continue;
      }
    } else if (a.dimension === AssumptionDimension.INCOME_BASIS) {
      const s = state.incomeStreams.find((x) => x.sourceKey === a.sourceKey);
      if (!s) {
        reject(a.id, PolicyIssue.UNKNOWN_STREAM, `no income stream "${a.sourceKey}" exists in this state`);
        continue;
      }
      // ⚠️ ORDERED, AND THE ORDER IS THE POINT. Supposing GROSS over an
      // UNESTABLISHED basis licenses nothing and is rejected here. Supposing
      // GROSS over a basis the user has ESTABLISHED as NET is a different and
      // worse thing — it overwrites a stated fact — so it falls through to the
      // contradiction check, which names the fact being overwritten and offers
      // the counterfactual route. Rejecting both as "not a net assumption"
      // would hide the second behind the first.
      if (a.basis !== AmountBasis.NET && s.basis === AmountBasis.UNKNOWN) {
        reject(a.id, PolicyIssue.NOT_A_NET_ASSUMPTION,
          `supposing a ${a.basis} basis licenses nothing — only NET makes an amount spendable`);
        continue;
      }
      // ⚠️ The tightest of the guards, and the one that closes two holes at
      // once. A NET supposition over a stream with no monthly figure would
      // license "net monthly inflow" with no number behind it, and a NET
      // supposition over a SILENT stream would be reactivation by the back
      // door. Requiring the monthly equivalent FORECAST-7 computed — which
      // exists only when the stream is projection-eligible AND its amount is
      // assertable — refuses both.
      if (s.nominalMonthly === null) {
        reject(a.id, PolicyIssue.STREAM_AMOUNT_NOT_ESTABLISHED,
          `"${a.sourceKey}" has no established periodic amount that is licensed to continue, `
          + 'so there is nothing for a basis supposition to apply to');
        continue;
      }
    } else if (a.dimension === AssumptionDimension.EVENT_BASIS) {
      const e = byId.get(a.eventId);
      if (!e) {
        reject(a.id, PolicyIssue.UNKNOWN_EVENT, `no event "${a.eventId}" was supplied`);
        continue;
      }
      if (!e.amount) {
        reject(a.id, PolicyIssue.INVALID_AMOUNT,
          `event "${a.eventId}" carries no amount, so its basis cannot be supposed`);
        continue;
      }
      if (a.basis !== AmountBasis.NET) {
        reject(a.id, PolicyIssue.NOT_A_NET_ASSUMPTION,
          `supposing a ${a.basis} basis licenses nothing — only NET makes an amount spendable`);
        continue;
      }
    } else if (a.dimension === AssumptionDimension.EVENT_INCLUSION) {
      if (!byId.has(a.eventId)) {
        reject(a.id, PolicyIssue.UNKNOWN_EVENT, `no event "${a.eventId}" was supplied`);
        continue;
      }
    } else if (a.dimension === AssumptionDimension.STREAM_CONTINUATION) {
      if (a.sourceKey !== null) {
        const s = state.incomeStreams.find((x) => x.sourceKey === a.sourceKey);
        if (!s) {
          reject(a.id, PolicyIssue.UNKNOWN_STREAM, `no income stream "${a.sourceKey}" exists in this state`);
          continue;
        }
        // ⚠️ NOT STANCE-ESCAPABLE. Unlike a contradiction, this is refused for
        // a COUNTERFACTUAL too: FORECAST-2 owns whether a stream may generate
        // occurrences at all, and a scenario that could overrule it would make
        // the activity licence advisory.
        if (a.include && !s.projectionEligible) {
          reject(a.id, PolicyIssue.REACTIVATION_NOT_PERMITTED,
            `"${a.sourceKey}" is ${s.activity} and is not licensed to generate future occurrences. `
            + 'A policy cannot restart it; a statement that the stream continues belongs to the '
            + 'activity authority as an assertion about the world.');
          continue;
        }
      }
    }

    const clash = contradicts(a, state, byId);
    if (clash && a.stance !== AssumptionStance.COUNTERFACTUAL) {
      reject(a.id, PolicyIssue.CONTRADICTS_ESTABLISHED_FACT,
        `${clash}; a supposition may not overwrite it. State this as an explicitly `
        + 'counterfactual scenario, or assert the new figure as a fact to the authority that owns it.');
      continue;
    }
    accepted.push(a);
  }

  let horizon = policy.horizon;
  if (horizon && !(isDate(horizon.fromISO) && isDate(horizon.toISO) && horizon.fromISO < horizon.toISO)) {
    reject(HORIZON_DEPENDENCY, PolicyIssue.INVALID_HORIZON,
      `the horizon ${horizon.fromISO}..${horizon.toISO} is not a forward-ordered pair of dates`);
    horizon = null;
  }
  return { accepted, rejected, horizon };
}

// ── Conclusion status ───────────────────────────────────────────────────────

/**
 * What kind of answer a conclusion is.
 *
 * Four values, and each was checked for a downstream difference before being
 * minted — the standing rule since CF-7 that a distinction without a decision
 * behind it is vocabulary:
 *
 *   FACTUALLY_LICENSED    sayable flatly. Depends on nothing supposed.
 *   ASSUMPTION_DEPENDENT  sayable only alongside the suppositions it names.
 *   HYPOTHETICAL          sayable only as a scenario. Differs from the above in
 *                         two places, not one: it renders in its own section
 *                         (never beside the user's real figures), and its
 *                         assumptions were permitted to contradict an
 *                         established fact, which SUPPOSED ones are not.
 *   REFUSED               not sayable. The FORECAST-7 default.
 */
export const ConclusionStatus = {
  FACTUALLY_LICENSED: 'FACTUALLY_LICENSED',
  ASSUMPTION_DEPENDENT: 'ASSUMPTION_DEPENDENT',
  HYPOTHETICAL: 'HYPOTHETICAL',
  REFUSED: 'REFUSED',
} as const;

export type ConclusionStatusKind = typeof ConclusionStatus[keyof typeof ConclusionStatus];

/**
 * Conclusions whose VALUE a dimension changes even where its LICENCE does not.
 *
 * ⚠️ THIS IS THE MINIMALITY TABLE, and it is short on purpose. §20's failure is
 * a spending supposition making the current cash balance assumption-dependent,
 * which happens the moment "the policy had an assumption" is confused with
 * "this number used one". SPENDING_BASELINE and INCOME_BASIS appear nowhere
 * below: they reach conclusions only through the licence, so a conclusion the
 * licence already grants never acquires them.
 */
const AFFECTS: Record<AssumptionDimensionKind, ReadonlySet<ConclusionKind>> = {
  SPENDING_BASELINE: new Set(),
  INCOME_BASIS: new Set(),
  EVENT_BASIS: new Set<ConclusionKind>([Conclusion.FORECAST_ENDING_CASH]),
  EVENT_INCLUSION: new Set<ConclusionKind>([
    Conclusion.KNOWN_OBLIGATION_SCHEDULE, Conclusion.FORECAST_ENDING_CASH,
  ]),
  STREAM_CONTINUATION: new Set<ConclusionKind>([
    Conclusion.NEXT_PAY_DATES, Conclusion.NOMINAL_MONTHLY_INCOME,
    Conclusion.NET_MONTHLY_INFLOW, Conclusion.FORECAST_ENDING_CASH,
  ]),
};

/**
 * Whether an assumption changes anything, versus restating the default.
 *
 * Including a known event, or continuing one licensed stream that was going to
 * continue anyway, alters no answer and must not appear as a dependency. The
 * blanket continuation default is the exception: it decides the span of every
 * projected occurrence, so the one conclusion built from projected occurrences
 * names it.
 */
function isDeviation(a: PolicyAssumption): boolean {
  if (a.dimension === AssumptionDimension.EVENT_INCLUSION) return !a.include;
  if (a.dimension === AssumptionDimension.STREAM_CONTINUATION) return a.sourceKey === null || !a.include;
  return true;
}

/** Conclusions that are undefined without an end date. */
const NEEDS_HORIZON: ReadonlySet<ConclusionKind> = new Set<ConclusionKind>([
  Conclusion.FORECAST_ENDING_CASH,
]);

/**
 * A state as it would be IF the accepted assumptions were true.
 *
 * ⚠️ NEVER EXPORTED, NEVER RETURNED, NEVER RENDERED. This exists for exactly
 * one purpose: to ask FORECAST-7's unmodified `conclusionLicence` a
 * counterfactual question, so that the licensing rules have precisely one
 * implementation. A `CurrentOperatingState` whose baseline reads ASSERTABLE on
 * the strength of a supposition is the exact object §3 forbids handing to a
 * caller, which is why it is built inside a call and discarded inside the same
 * call. `applyPolicy` returns `input.state` by reference.
 *
 * Provenance on the shadow is HYPOTHETICAL, not USER_ASSERTED: the user asked
 * for the supposition, they did not assert the figure.
 */
function licensingShadow(
  state: CurrentOperatingState,
  accepted: readonly PolicyAssumption[],
): CurrentOperatingState {
  let baseline: BaselineState = state.discretionaryBaseline;
  const spend = accepted.find(
    (a): a is SpendingBaselineAssumption => a.dimension === AssumptionDimension.SPENDING_BASELINE);
  if (spend) {
    baseline = {
      state: ComponentState.ASSERTABLE, amount: spend.amount, periodBasis: spend.periodBasis,
      provenance: EventProvenance.HYPOTHETICAL, currency: spend.currency,
      reason: `supposed for this forecast: ${spend.statedAs}`,
    };
  }

  // ⚠️ THE SUPPOSED BASIS, NOT A FIXED NET. While UNKNOWN was the only basis a
  // state could hold, every accepted income-basis supposition was necessarily
  // NET and hard-coding it was harmless. From FORECAST-9A a stream can arrive
  // already NET, and a counterfactual may then suppose GROSS over it — at which
  // point a hard-coded NET would have the shadow LICENSING the conclusion the
  // counterfactual exists to withdraw.
  const supposedBasis = new Map(accepted
    .filter((a): a is IncomeBasisAssumption => a.dimension === AssumptionDimension.INCOME_BASIS)
    .map((a) => [a.sourceKey, a.basis]));
  const dropped = new Set(accepted
    .filter((a): a is StreamContinuationAssumption =>
      a.dimension === AssumptionDimension.STREAM_CONTINUATION && a.sourceKey !== null && !a.include)
    .map((a) => a.sourceKey as string));

  const incomeStreams = state.incomeStreams
    .filter((s) => !dropped.has(s.sourceKey))
    .map((s) => (supposedBasis.has(s.sourceKey)
      ? { ...s, basis: supposedBasis.get(s.sourceKey)! } : s));

  return { ...state, discretionaryBaseline: baseline, incomeStreams };
}

/** One conclusion, its status, and every supposition it rests on. */
export interface PolicyConclusion {
  conclusion: ConclusionKind;
  status: ConclusionStatusKind;
  /**
   * Assumption ids (and `horizon`) this conclusion actually needs.
   *
   * ⚠️ MINIMAL AND NEVER A BOOLEAN. §8's requirement is that "which assumptions
   * make this number possible" be answerable deterministically, which an
   * `assumed: true` flag cannot do.
   */
  dependencies: string[];
  /** What is still missing, when REFUSED. Empty otherwise. */
  missing: string[];
}

/**
 * The state with one authority's verdict taken away.
 *
 * ⚠️ THE MIRROR OF THE SHADOW, AND IT SOLVES A DIFFERENT PROBLEM. When an
 * authority has established nothing, leave-one-out over the shadow finds the
 * assumptions a conclusion needs. When an authority HAS established something
 * and an explicitly counterfactual assumption replaces it, no licence changes
 * at all — the conclusion was already licensed — and yet its VALUE now comes
 * from the scenario. Depriving the state of that authority and asking whether
 * the conclusion survives is how a conclusion learns it was requiring the
 * figure the counterfactual just replaced.
 *
 * Doing it this way rather than by declaring which conclusions need which
 * authority keeps FORECAST-7's requirement table the only copy of itself.
 */
function deprive(
  state: CurrentOperatingState, dimension: AssumptionDimensionKind,
): CurrentOperatingState {
  if (dimension === AssumptionDimension.SPENDING_BASELINE) {
    return { ...state, discretionaryBaseline: {
      ...state.discretionaryBaseline, state: ComponentState.UNKNOWN, amount: null } };
  }
  if (dimension === AssumptionDimension.INCOME_BASIS) {
    return { ...state, incomeStreams: state.incomeStreams.map(
      (s) => ({ ...s, basis: AmountBasis.UNKNOWN })) };
  }
  return state;
}

/**
 * Assumptions that REPLACE an established authority a conclusion was using.
 *
 * ⚠️ ONLY CONTRADICTING ASSUMPTIONS QUALIFY, which is what keeps §20 intact: a
 * supposition that fills a gap reaches conclusions through the licence and is
 * attributed there, so a spending supposition over an UNKNOWN baseline still
 * leaves the cash balance factual.
 */
function overrideDependencies(
  state: CurrentOperatingState,
  accepted: readonly PolicyAssumption[],
  events: ReadonlyMap<string, FutureCashEvent>,
  conclusion: ConclusionKind,
): string[] {
  return accepted
    .filter((a) => contradicts(a, state, events) !== null
      && !conclusionLicence(deprive(state, a.dimension), conclusion).licensed)
    .map((a) => a.id);
}

/**
 * Attribute a licensed-under-policy conclusion to the smallest set of
 * assumptions that licenses it.
 *
 * Leave-one-out: an assumption is a dependency exactly when removing it breaks
 * the conclusion. This is minimal by construction and reuses the real licence
 * rather than a second copy of the requirement table.
 *
 * ⚠️ THE DEGENERATE CASE IS REAL. Two assumptions that independently satisfy
 * the same requirement — say a NET supposition on each of two streams — make
 * every single removal harmless, and leave-one-out would report a conclusion
 * that plainly rests on suppositions as resting on none. So an empty result
 * escalates to leaving out a whole dimension at a time, which cannot be empty
 * when the shadow licensed something the state did not.
 */
function licensingDependencies(
  state: CurrentOperatingState,
  accepted: readonly PolicyAssumption[],
  conclusion: ConclusionKind,
): string[] {
  const without = (keep: (a: PolicyAssumption) => boolean) =>
    conclusionLicence(licensingShadow(state, accepted.filter(keep)), conclusion).licensed;

  const single = accepted.filter((a) => !without((x) => x.id !== a.id)).map((a) => a.id);
  if (single.length > 0) return single;

  const dims = [...new Set(accepted.map((a) => a.dimension))]
    .filter((d) => !without((x) => x.dimension !== d));
  return accepted.filter((a) => dims.includes(a.dimension)).map((a) => a.id);
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Spending, with the authority and the supposition side by side.
 *
 * ⚠️ THERE IS NO `amount` FIELD. Reading a number means reading either
 * `authority.amount` (which is null while the baseline is UNKNOWN) or
 * `assumption.amount` (which is labelled a supposition all the way down). §3's
 * "no API returns only the assumed scalar" is a property of the type, not of
 * the callers.
 */
export interface ResolvedBaseline {
  /** FORECAST-6's verdict, carried through unchanged. */
  authority: BaselineState;
  assumption: SpendingBaselineAssumption | null;
  status: ConclusionStatusKind;
}

/** One stream's basis, likewise unmerged. */
export interface ResolvedIncomeStream {
  sourceKey: string;
  /** What FORECAST-3/7 establish. Never rewritten by a policy. */
  authorityBasis: AmountBasisKind;
  assumedBasis: AmountBasisKind | null;
  basisAssumptionId: string | null;
  included: boolean;
  inclusionAssumptionId: string | null;
  /** FORECAST-2's licence, restated so nobody has to infer it from `included`. */
  projectionEligible: boolean;
  /**
   * Whether there is a periodic figure for a basis to be a basis OF.
   *
   * ⚠️ A stream with no amount has no gross-or-net question, and reporting one
   * turns "nobody knows what the interest payments are" into "nobody knows
   * whether the interest payments are taxed", which is a different and false
   * statement about what is missing.
   */
  hasEstablishedAmount: boolean;
}

/** One event's treatment. The event itself travels by reference, unmodified. */
export interface ResolvedEvent {
  id: string;
  /** The original. `event.amount.basis` is the authoritative basis, always. */
  event: FutureCashEvent;
  authorityAmount: EventAmount | null;
  assumedBasis: AmountBasisKind | null;
  basisAssumptionId: string | null;
  included: boolean;
  inclusionAssumptionId: string | null;
}

export interface PolicyResolution {
  asOfISO: string;
  horizon: ForecastHorizon | null;
  /** ⚠️ THE SAME OBJECT THAT WAS PASSED IN. Identity is pinned by a test. */
  state: CurrentOperatingState;
  accepted: readonly PolicyAssumption[];
  rejected: readonly RejectedAssumption[];
  baseline: ResolvedBaseline;
  incomeStreams: ResolvedIncomeStream[];
  events: ResolvedEvent[];
  conclusions: PolicyConclusion[];
}

/**
 * Overlay a policy on a state and a set of events.
 *
 * ⚠️ THE SIGNATURE IS THE ARCHITECTURE. There is no fourth parameter, and in
 * particular no transactions, no periods and no history — §16's "no
 * history → average → forecast path" is enforced by there being nowhere for
 * history to enter. Everything this function can reach is a verdict some
 * authority already reached.
 */
export function applyPolicy(
  state: CurrentOperatingState,
  events: readonly FutureCashEvent[],
  policy: ForecastPolicy,
): PolicyResolution {
  const { accepted, rejected, horizon } = validatePolicy(state, events, policy);
  const byId = new Map(events.map((e) => [e.id, e]));

  const spend = accepted.find(
    (a): a is SpendingBaselineAssumption => a.dimension === AssumptionDimension.SPENDING_BASELINE) ?? null;

  const netFor = new Map(accepted
    .filter((a): a is IncomeBasisAssumption => a.dimension === AssumptionDimension.INCOME_BASIS)
    .map((a) => [a.sourceKey, a]));
  const contFor = new Map(accepted
    .filter((a): a is StreamContinuationAssumption =>
      a.dimension === AssumptionDimension.STREAM_CONTINUATION && a.sourceKey !== null)
    .map((a) => [a.sourceKey as string, a]));
  const eventBasis = new Map(accepted
    .filter((a): a is EventBasisAssumption => a.dimension === AssumptionDimension.EVENT_BASIS)
    .map((a) => [a.eventId, a]));
  const eventIncl = new Map(accepted
    .filter((a): a is EventInclusionAssumption => a.dimension === AssumptionDimension.EVENT_INCLUSION)
    .map((a) => [a.eventId, a]));
  /** Income-basis suppositions, reachable by the events their stream produced. */
  const streamBasisFor = new Map<string, { id: string; basis: AmountBasisKind }>(
    [...netFor.entries()].map(([k, a]) => [k, { id: a.id, basis: a.basis }]));

  const incomeStreams: ResolvedIncomeStream[] = state.incomeStreams.map((s) => {
    const cont = contFor.get(s.sourceKey);
    const net = netFor.get(s.sourceKey);
    return {
      sourceKey: s.sourceKey,
      // Read from the state, never from the assumption. This is the field that
      // must still say UNKNOWN after a net supposition has been applied.
      authorityBasis: s.basis,
      assumedBasis: net?.basis ?? null,
      basisAssumptionId: net?.id ?? null,
      included: cont ? cont.include : s.projectionEligible,
      inclusionAssumptionId: cont && isDeviation(cont) ? cont.id : null,
      projectionEligible: s.projectionEligible,
      hasEstablishedAmount: s.nominalMonthly !== null,
    };
  });

  const resolvedEvents: ResolvedEvent[] = events.map((e) => {
    // ⚠️ A STREAM-LEVEL BASIS SUPPOSITION REACHES THAT STREAM'S OWN EVENTS, and
    // only where nothing is established (FORECAST-9). "Assume that paycheck is
    // net" is one sentence about one stream; before this it reached the state
    // and stopped, so a forecast over seven cadence-derived occurrences needed
    // seven identical id-scoped assumptions to say the same thing — which the
    // caller had to enumerate, and which then filled the explanation with seven
    // copies of one supposition.
    //
    // This is NOT the generic event policy §12 forbids. It is scoped by
    // `sourceKey` — exactly as specific as an event id, and matching only the
    // events that stream generated — and it applies solely to an UNKNOWN basis.
    // A GROSS event is untouched by it, so the $15,500 bonus still requires its
    // own explicitly counterfactual assumption and the contradiction guard
    // cannot be walked around by widening the scope.
    const streamBasis = e.sourceKey && e.amount?.basis === AmountBasis.UNKNOWN
      ? streamBasisFor.get(e.sourceKey) : undefined;
    const b = eventBasis.get(e.id) ?? streamBasis;
    const inc = eventIncl.get(e.id);
    return {
      id: e.id,
      event: e,
      authorityAmount: e.amount,
      assumedBasis: b?.basis ?? null,
      basisAssumptionId: b?.id ?? null,
      included: inc ? inc.include : true,
      inclusionAssumptionId: inc && isDeviation(inc) ? inc.id : null,
    };
  });

  const counterfactual = new Set(accepted
    .filter((a) => a.stance === AssumptionStance.COUNTERFACTUAL).map((a) => a.id));

  const conclusions = (Object.values(Conclusion) as ConclusionKind[]).map((c) => {
    const factual = conclusionLicence(state, c);
    const affecting = [...new Set([
      ...accepted.filter((a) => isDeviation(a) && AFFECTS[a.dimension].has(c)).map((a) => a.id),
      ...overrideDependencies(state, accepted, byId, c),
    ])];

    if (NEEDS_HORIZON.has(c) && !horizon) {
      // ⚠️ THE SHADOW'S MISSING LIST, NOT THE FACTUAL ONE. Reporting what is
      // missing before the assumptions were applied would tell a user who has
      // just supplied a spending level that a spending level is still missing.
      const withPolicy = conclusionLicence(licensingShadow(state, accepted), c);
      const missing = [...(withPolicy.licensed ? [] : withPolicy.missing), 'a bounded forecast horizon'];
      return { conclusion: c, status: ConclusionStatus.REFUSED, dependencies: [], missing };
    }

    let deps: string[];
    if (factual.licensed) {
      // ⚠️ A POLICY CAN SUBTRACT, NOT ONLY ADD. Almost every assumption supplies
      // a component the state lacked, and for those the shadow is a superset of
      // the facts and this check is a no-op. Two cannot be: a counterfactual
      // that replaces an established NET basis with GROSS, and an exclusion that
      // removes the only stream carrying a monthly figure. Both leave the
      // FACTUAL licence intact while making the conclusion unstatable inside the
      // scenario, and reporting it as HYPOTHETICAL would offer a net figure in a
      // world the user has just said has no net figure. Unreachable before
      // FORECAST-9A, because UNKNOWN was the only basis a state could hold and
      // no supposition could therefore take anything away.
      const scoped = accepted.length > 0
        ? conclusionLicence(licensingShadow(state, accepted), c) : factual;
      if (!scoped.licensed) {
        return { conclusion: c, status: ConclusionStatus.REFUSED, dependencies: [], missing: scoped.missing };
      }
      // §20: a conclusion the facts already support acquires a dependency only
      // from an assumption that changes its VALUE — never from one that merely
      // shares the policy.
      if (affecting.length === 0 && !NEEDS_HORIZON.has(c)) {
        return { conclusion: c, status: ConclusionStatus.FACTUALLY_LICENSED, dependencies: [], missing: [] };
      }
      deps = affecting;
    } else {
      const shadow = conclusionLicence(licensingShadow(state, accepted), c);
      if (!shadow.licensed) {
        return { conclusion: c, status: ConclusionStatus.REFUSED, dependencies: [], missing: shadow.missing };
      }
      deps = [...new Set([...licensingDependencies(state, accepted, c), ...affecting])];
    }

    if (NEEDS_HORIZON.has(c)) deps = [...deps, HORIZON_DEPENDENCY];
    const status = deps.some((d) => counterfactual.has(d))
      ? ConclusionStatus.HYPOTHETICAL
      : ConclusionStatus.ASSUMPTION_DEPENDENT;
    return { conclusion: c, status, dependencies: deps, missing: [] };
  });

  const baselineStatus = state.discretionaryBaseline.state === ComponentState.ASSERTABLE
      && !(spend && contradicts(spend, state, byId))
    ? ConclusionStatus.FACTUALLY_LICENSED
    : spend
      ? (spend.stance === AssumptionStance.COUNTERFACTUAL
        ? ConclusionStatus.HYPOTHETICAL : ConclusionStatus.ASSUMPTION_DEPENDENT)
      : ConclusionStatus.REFUSED;

  return {
    asOfISO: state.asOfISO, horizon, state, accepted, rejected,
    baseline: { authority: state.discretionaryBaseline, assumption: spend, status: baselineStatus },
    incomeStreams, events: resolvedEvents, conclusions,
  };
}

/** The conclusions a policy unlocked that the facts alone did not. */
export function unlockedByPolicy(r: PolicyResolution): PolicyConclusion[] {
  return r.conclusions.filter((c) =>
    c.status === ConclusionStatus.ASSUMPTION_DEPENDENT || c.status === ConclusionStatus.HYPOTHETICAL);
}

/**
 * WHAT THE EVENTS ADD UP TO UNDER THE POLICY — and what they add up to without it.
 *
 * ⚠️ BOTH COMPOSITIONS ARE RETURNED. `authoritative` is FORECAST-3's answer
 * about the events exactly as they are, which for the measured fixture is
 * "$17,000 stated, spendable cash NOT ASSERTABLE". `scenario` is the same
 * function's answer about the same events under the accepted suppositions. A
 * caller cannot read the second without the first sitting beside it, which is
 * §3's requirement expressed as a return type.
 *
 * The scenario composition is produced by handing FORECAST-3's UNMODIFIED
 * `composeFutureCash` a set of throwaway copies. The originals are never
 * touched, `EventAmount.basis` is never reassigned, and every refusal
 * FORECAST-3 would make about a GROSS or amount-less event still happens —
 * a supposition can supply a basis, it cannot supply a missing amount.
 */
export interface ScenarioCash {
  /** The events as they are. Assumption-free, always. */
  authoritative: CashComposition;
  /** The same events under the accepted suppositions. */
  scenario: CashComposition;
  status: ConclusionStatusKind;
  /** The suppositions the scenario figure rests on. Empty means it rests on none. */
  dependencies: string[];
}

/**
 * The amount an event has UNDER THE POLICY — the authoritative one, or the same
 * amount wearing a supposed basis.
 *
 * ⚠️ ONE IMPLEMENTATION OF THE SUBSTITUTION RULE, exported so FORECAST-9's
 * engine consumes it rather than rebuilding it. Two copies of "which basis
 * applies here" is exactly how the event layer and the state layer came to
 * disagree in the first place (see FORECAST-9A). The returned object is a fresh
 * copy; the event's own `amount` is never touched.
 */
export function effectiveEventAmount(e: ResolvedEvent): EventAmount | null {
  if (!e.event.amount) return null;
  return e.assumedBasis ? { ...e.event.amount, basis: e.assumedBasis } : e.event.amount;
}

/** The event as the policy sees it. Never mutates, never escapes as evidence. */
function policyView(e: ResolvedEvent): FutureCashEvent {
  const amount = effectiveEventAmount(e);
  return amount === e.event.amount ? e.event : { ...e.event, amount };
}

export function scenarioCash(r: PolicyResolution): ScenarioCash {
  const originals = r.events.map((e) => e.event);
  const included = r.events.filter((e) => e.included);

  const shadows: FutureCashEvent[] = included.map(policyView);

  // A basis supposition is a dependency only where the authority was not
  // already NET — restating an established basis changes no figure.
  const used = included
    .filter((e) => e.assumedBasis && e.authorityAmount?.basis !== e.assumedBasis)
    .map((e) => e.basisAssumptionId as string);
  const dropped = r.events.filter((e) => !e.included && e.inclusionAssumptionId)
    .map((e) => e.inclusionAssumptionId as string);
  const dependencies = [...new Set([...used, ...dropped])];

  const counterfactual = new Set(r.accepted
    .filter((a) => a.stance === AssumptionStance.COUNTERFACTUAL).map((a) => a.id));
  const scenario = composeFutureCash(shadows);
  const status = scenario.assertableNet === null
    ? ConclusionStatus.REFUSED
    : dependencies.length === 0
      ? ConclusionStatus.FACTUALLY_LICENSED
      : dependencies.some((d) => counterfactual.has(d))
        ? ConclusionStatus.HYPOTHETICAL
        : ConclusionStatus.ASSUMPTION_DEPENDENT;

  return { authoritative: composeFutureCash(originals), scenario, status, dependencies };
}

// ── Routing: a fact is not an assumption ────────────────────────────────────

/**
 * WHERE A USER'S STATEMENT BELONGS.
 *
 * ⚠️ NO PROSE IS PARSED HERE. The caller supplies `mode` and a typed subject;
 * this module has no string matching and no lexicon, for the same reason
 * FORECAST-7 has none. What it owns is the CONSEQUENCE of the distinction:
 * a statement offered as fact must leave this module, and a statement offered
 * as a supposition must stay in it.
 *
 * The tempting shortcut is to accept everything into policy, because policy is
 * permissive and always works. That shortcut is how "I spend $4,000 a month"
 * becomes a scenario the user never sees credited to them, and how "assume the
 * paycheck is net" becomes a fact they never stated.
 */
export const StatementMode = {
  /** "My paycheck is take-home." A claim about the world. */
  ASSERTS_FACT: 'ASSERTS_FACT',
  /** "Assume the paycheck is take-home." A supposition for a calculation. */
  REQUESTS_ASSUMPTION: 'REQUESTS_ASSUMPTION',
  /** "Show me a scenario where I spend $10,000." Deliberately contrary. */
  REQUESTS_SCENARIO: 'REQUESTS_SCENARIO',
} as const;

export type StatementModeKind = typeof StatementMode[keyof typeof StatementMode];

export type StatementSubject =
  | { kind: 'SPENDING_LEVEL'; amount: number; currency: string; periodBasis: PeriodBasisKind }
  | { kind: 'STREAM_AMOUNT_BASIS'; sourceKey: string; basis: AmountBasisKind }
  | { kind: 'EVENT_AMOUNT_BASIS'; eventId: string; basis: AmountBasisKind }
  | { kind: 'STREAM_CONTINUES'; sourceKey: string; continues: boolean }
  /**
   * FORECAST-17 — a single dated movement the user named.
   *
   * ⚠️ ONE-OFF, AND THE TYPE SAYS SO. There is no cadence here and no way to
   * express one: a recurring payment is FORECAST-1/2/5's business and a known
   * obligation is FORECAST-4's, and a subject that could carry a schedule would
   * be a fourth authority for the same question. `dateISO` is one day because
   * FORECAST-3 refuses to invent a day inside a range.
   */
  | {
    kind: 'ONE_OFF_EVENT'; amount: number; currency: string; basis: AmountBasisKind;
    direction: 'INFLOW' | 'OUTFLOW'; role: FlowRoleKind; dateISO: string;
  };

export interface UserStatement {
  mode: StatementModeKind;
  subject: StatementSubject;
  /** The user's own words, carried so every downstream label can quote them. */
  statedAs: string;
  asOfISO: string;
}

/**
 * The authority a fact-shaped statement belongs to.
 *
 * ⚠️ `PERIODIC_AMOUNT_BASIS` WAS A MEASURED GAP AND IS NOW CLOSED (FORECAST-9A).
 * FORECAST-5's `assertedPeriodicAmount` took a value and no basis, and
 * `composeOperatingState` hard-coded `basis: AmountBasis.UNKNOWN` with no input
 * field to override it — so a user who stated, truthfully, that their paycheck
 * was take-home had no route by which that fact reached the operating state,
 * and the same assertion reached the EVENT layer as NET while the STATE layer
 * said UNKNOWN. A *supposition* was more expressive than a *fact*.
 *
 * What kept the fix honest was that this module refused the easy repair. The
 * cheap way to make "my paycheck is take-home" work was to accept it here as a
 * policy assumption, where it would have functioned perfectly and been reported
 * as a supposition the user never made. Routing it upstream and marking it
 * UNREACHABLE was the expensive answer, and it is the reason the gap was
 * findable at all: an unreachable route is a defect somebody has to close,
 * where a quietly-working one is not.
 *
 * `assertedAmountBasis` is that door. Every route below is now reachable.
 */
export const FactAuthority = {
  /** FORECAST-6 · `assertedSpendingBaseline`. Complete; the fact lands. */
  SPENDING_BASELINE: 'SPENDING_BASELINE',
  /** FORECAST-5/3 · `assertedPeriodicAmount` + `AssertedRecurringAmount`. */
  PERIODIC_AMOUNT_BASIS: 'PERIODIC_AMOUNT_BASIS',
  /** FORECAST-3 · the event's own `EventAmount.basis`. */
  EVENT_AMOUNT_BASIS: 'EVENT_AMOUNT_BASIS',
  /** FORECAST-2 · `UserAssertion` on the activity resolver. */
  STREAM_ACTIVITY: 'STREAM_ACTIVITY',
  /** FORECAST-3 · a `FutureCashEvent` the user named. Complete; the fact lands. */
  FUTURE_EVENT: 'FUTURE_EVENT',
} as const;

export type FactAuthorityKind = typeof FactAuthority[keyof typeof FactAuthority];

export type Routing =
  | {
    destination: 'UPSTREAM_AUTHORITY';
    authority: FactAuthorityKind;
    /** Whether that authority can currently receive it. */
    reachable: boolean;
    subject: StatementSubject;
    note: string;
  }
  | { destination: 'FORECAST_POLICY'; assumption: PolicyAssumption }
  | { destination: 'UNROUTABLE'; note: string };

/**
 * Send a statement to the authority that owns it.
 *
 * ⚠️ A FACT NEVER RETURNS A POLICY ASSUMPTION, AND A SUPPOSITION NEVER RETURNS
 * AN UPSTREAM ROUTING. Both directions are pinned by tests: the first is
 * laundering a fact into a scenario, the second is laundering a scenario into
 * the ledger, and each is a live failure in its own right.
 */
export function routeStatement(s: UserStatement, id: string): Routing {
  if (s.mode === StatementMode.ASSERTS_FACT) {
    const note = (a: string, reachable: boolean) => reachable
      ? `this is a claim about the world; it belongs to ${a} and must be applied there, `
        + 'not carried as a forecast assumption'
      : `this is a claim about the world and belongs to ${a}, which currently has no input `
        + 'field for it — see the PERIODIC_AMOUNT_BASIS note. It must NOT be accepted as a '
        + 'forecast assumption instead, because that would report a stated fact as a supposition.';
    switch (s.subject.kind) {
      case 'SPENDING_LEVEL':
        return { destination: 'UPSTREAM_AUTHORITY', authority: FactAuthority.SPENDING_BASELINE,
          reachable: true, subject: s.subject, note: note('the spending-baseline authority', true) };
      case 'STREAM_AMOUNT_BASIS':
        return { destination: 'UPSTREAM_AUTHORITY', authority: FactAuthority.PERIODIC_AMOUNT_BASIS,
          reachable: true, subject: s.subject, note: note('the periodic-amount authority', true) };
      case 'EVENT_AMOUNT_BASIS':
        return { destination: 'UPSTREAM_AUTHORITY', authority: FactAuthority.EVENT_AMOUNT_BASIS,
          reachable: true, subject: s.subject, note: note('the future-cash-event authority', true) };
      case 'STREAM_CONTINUES':
        return { destination: 'UPSTREAM_AUTHORITY', authority: FactAuthority.STREAM_ACTIVITY,
          reachable: true, subject: s.subject, note: note('the stream-activity authority', true) };
      case 'ONE_OFF_EVENT':
        return { destination: 'UPSTREAM_AUTHORITY', authority: FactAuthority.FUTURE_EVENT,
          reachable: true, subject: s.subject, note: note('the future-cash-event authority', true) };
    }
  }

  const stance = s.mode === StatementMode.REQUESTS_SCENARIO
    ? AssumptionStance.COUNTERFACTUAL : AssumptionStance.SUPPOSED;
  const base = { id, origin: AssumptionOrigin.USER_REQUESTED, stance, statedAs: s.statedAs };

  switch (s.subject.kind) {
    case 'SPENDING_LEVEL':
      return { destination: 'FORECAST_POLICY', assumption: {
        ...base, dimension: AssumptionDimension.SPENDING_BASELINE,
        amount: s.subject.amount, currency: s.subject.currency, periodBasis: s.subject.periodBasis } };
    case 'STREAM_AMOUNT_BASIS':
      return { destination: 'FORECAST_POLICY', assumption: {
        ...base, dimension: AssumptionDimension.INCOME_BASIS,
        sourceKey: s.subject.sourceKey, basis: s.subject.basis } };
    case 'EVENT_AMOUNT_BASIS':
      return { destination: 'FORECAST_POLICY', assumption: {
        ...base, dimension: AssumptionDimension.EVENT_BASIS,
        eventId: s.subject.eventId, basis: s.subject.basis } };
    case 'ONE_OFF_EVENT':
      // ⚠️ NOT A POLICY ASSUMPTION, AND DELIBERATELY NOT GIVEN A DIMENSION.
      // FORECAST-8's assumptions are suppositions ABOUT authorities that already
      // hold something — a basis, a level, an inclusion. "Assume I get $5,000 on
      // October 15" does not suppose anything about an existing event; it
      // supposes an event. FORECAST-3 already has somewhere truthful to put
      // that: `EventProvenance.HYPOTHETICAL`, minted for exactly this and
      // reserved in writing for "a later forecast-policy slice". So the
      // supposition reaches the EVENT authority wearing hypothetical
      // provenance, and the caller scopes it to the turn — which is what keeps
      // it from becoming a fact without inventing a policy dimension to hold it.
      return { destination: 'UNROUTABLE', note:
        'a supposed one-off event is a FutureCashEvent with HYPOTHETICAL provenance, not a '
        + 'policy assumption: nothing existing is being supposed about. It is scoped to the '
        + 'turn that states it and never becomes an asserted fact.' };
    case 'STREAM_CONTINUES':
      // ⚠️ NOT ROUTED TO POLICY. "Assume I still work there" is a supposition
      // about EMPLOYMENT, and FORECAST-2 decides that on evidence or on an
      // assertion. A continuation policy chooses among licensed streams; it is
      // not a second way to license one.
      return { destination: 'UNROUTABLE', note:
        'whether a stream is still active is decided by the activity authority on evidence or on '
        + 'an assertion about the world. A forecast policy may include or exclude streams that are '
        + 'already licensed to continue; it cannot suppose one back to life.' };
  }
}

// ── Explanation ─────────────────────────────────────────────────────────────

const label = (c: ConclusionKind) => c.toLowerCase().replace(/_/g, ' ');

const describeAssumption = (a: PolicyAssumption): string => {
  const who = a.origin === AssumptionOrigin.SYSTEM_POLICY ? 'system policy' : 'user-requested';
  switch (a.dimension) {
    case AssumptionDimension.SPENDING_BASELINE:
      return `[${a.id}] ordinary spending ${money(a.amount, a.currency)} per ${perPeriod(a.periodBasis)} (${who})`;
    case AssumptionDimension.INCOME_BASIS:
      return `[${a.id}] ${a.sourceKey}'s amount treated as ${a.basis} (${who})`;
    case AssumptionDimension.EVENT_BASIS:
      return `[${a.id}] event ${a.eventId}'s amount treated as ${a.basis} (${who})`;
    case AssumptionDimension.EVENT_INCLUSION:
      return `[${a.id}] event ${a.eventId} ${a.include ? 'included' : 'EXCLUDED'} (${who})`;
    case AssumptionDimension.STREAM_CONTINUATION:
      return `[${a.id}] ${a.sourceKey ?? 'every licensed stream'} `
        + `${a.include ? 'continues' : 'EXCLUDED'} (${who})`;
  }
};

/**
 * A compact statement of the policy and what it did. Designed and measured;
 * NOT production-wired.
 *
 * ⚠️ THE MODEL IS NEVER ASKED TO RECONSTRUCT PROVENANCE. Every section below is
 * computed. The one thing this must never become is a list of numbers with a
 * general instruction to be careful about them, which is the shape every
 * measured failure in this program had.
 */
export function explainPolicy(r: PolicyResolution): string[] {
  const lines: string[] = [];
  const by = (s: ConclusionStatusKind) => r.conclusions.filter((c) => c.status === s);

  lines.push(r.horizon
    ? `Forecast policy, ${r.horizon.fromISO}..${r.horizon.toISO}:`
    : 'Forecast policy (no horizon set):');

  // FACTS USED — from the authorities, never from an assumption.
  const facts = by(ConclusionStatus.FACTUALLY_LICENSED).map((c) => label(c.conclusion));
  lines.push(`  Facts used: ${facts.length ? facts.join(', ') : 'none'}.`);

  const supposed = r.accepted.filter((a) => a.stance === AssumptionStance.SUPPOSED);
  const counter = r.accepted.filter((a) => a.stance === AssumptionStance.COUNTERFACTUAL);
  lines.push('  Assumptions:');
  if (supposed.length === 0) lines.push('   - none');
  for (const a of supposed) lines.push(`   - ${describeAssumption(a)}`);
  if (counter.length) {
    lines.push("  Hypotheticals (NOT observed, NOT the user's actual figures):");
    // ⚠️ The request is quoted here and nowhere else. A counterfactual figure is
    // the one number in this program with nothing behind it but somebody asking
    // for it, so the asking travels with it.
    for (const a of counter) lines.push(`   - ${describeAssumption(a)} · asked as "${a.statedAs}"`);
  }

  // STILL UNKNOWN — the authoritative gap an assumption did not close. Grouped,
  // because three streams sharing one gap is one fact, not three.
  const unknown: string[] = [];
  if (r.baseline.authority.state !== ComponentState.ASSERTABLE) {
    unknown.push(`current-normal spending is ${r.baseline.authority.state}`
      + (r.baseline.assumption ? ' (above figure supposed, not observed)' : ''));
  }
  const nonNet = r.incomeStreams.filter(
    (s) => s.hasEstablishedAmount && s.authorityBasis !== AmountBasis.NET);
  const supposedNet = nonNet.filter((s) => s.assumedBasis);
  if (nonNet.length) {
    unknown.push(`gross-or-net basis for ${nonNet.map((s) => s.sourceKey).join(', ')}`
      + (supposedNet.length
        ? ` (${supposedNet.map((s) => s.sourceKey).join(', ')} treated as NET by supposition only)`
        : ''));
  }
  const evNonNet = r.events.filter((e) => e.authorityAmount && e.authorityAmount.basis !== AmountBasis.NET);
  if (evNonNet.length) {
    unknown.push(`events ${evNonNet.map((e) => `${e.id} is ${e.authorityAmount!.basis}`).join(', ')}`
      + (evNonNet.some((e) => e.assumedBasis) ? ' (treated as NET by supposition only)' : ''));
  }
  lines.push(`  Still unknown: ${unknown.length ? unknown.join('; ') : 'nothing blocking'}.`);

  const dep = (c: PolicyConclusion) => `${label(c.conclusion)} (needs ${c.dependencies.join(' + ')})`;
  const unlocked = [...by(ConclusionStatus.ASSUMPTION_DEPENDENT), ...by(ConclusionStatus.HYPOTHETICAL)];
  lines.push(`  Unlocked by assumption: ${unlocked.length ? unlocked.map(dep).join(', ') : 'none'}.`);

  // ⚠️ INVERTED — keyed by the MISSING INPUT, not by the conclusion. Grouping
  // the other way round repeats FORECAST-7's blocker wording once per refused
  // conclusion, which on the real Space spends half the budget restating one
  // sentence four times. Ordered by how much each input unblocks, so the reader
  // sees the single most valuable thing to establish first.
  const blocks = new Map<string, string[]>();
  for (const c of by(ConclusionStatus.REFUSED)) {
    for (const m of c.missing) blocks.set(m, [...(blocks.get(m) ?? []), label(c.conclusion)]);
  }
  if (blocks.size) {
    lines.push(`  Still REFUSED, by what is missing: ${[...blocks.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([missing, cs]) => `${missing} → ${cs.join(', ')}`).join('; ')}.`);
  }
  if (r.rejected.length) {
    lines.push(`  Rejected assumptions: ${r.rejected
      .map((x) => `${x.assumptionId} (${x.code})`).join('; ')}.`);
  }
  lines.push('  An assumed figure may be used in arithmetic; it may NOT be reported as observed. '
    + 'Never substitute a historical average for anything still unknown.');
  return lines;
}
