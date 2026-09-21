/**
 * lib/ai/forecast/assemble.ts
 *
 * FORECAST-10 — THE ONE PLACE PRODUCTION BUILDS AND RUNS A FORECAST.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * Nine slices built a substrate with zero production consumers. This is the
 * adapter: canonical assembler output in, `CashForecast` out, one call to
 * `forecastCash` and no arithmetic of its own.
 *
 * ⚠️ PURE. The database read lives in `./streams.ts`; everything here is a
 * function of values, so the whole assembly is testable without a Space and
 * cannot reach a transaction on its own.
 *
 * ⚠️ IT COMPUTES NOTHING. No paycheck count, no income total, no accrual, no
 * ending balance — every figure comes from an authority, and a test pins that
 * this module contains no arithmetic operator over money. The temptation is
 * real: an adapter that "just totals the paychecks for the summary" becomes a
 * second answer to the question the engine already answered, and CF-11 measured
 * what happens when two authorities disagree in one prompt.
 *
 * ── Fact and supposition arrive by different doors ──────────────────────────
 * A statement the user offers as fact is applied to the STATE — through
 * FORECAST-6's `assertedSpendingBaseline` or FORECAST-9A's `assertedAmountBasis`
 * — before the state is composed. A supposition becomes a `PolicyAssumption`
 * and never touches it. That is the whole of FORECAST-8/9A reaching production,
 * and the two paths are visibly different code below rather than one path with
 * a flag.
 *
 * ⚠️ AND IT NO LONGER READS ENGLISH. Until the AI conversation reset this
 * function took `question: string` and the whole message history, and ran two
 * regex extractors (`./statements.ts`, `./fact-continuity.ts`) to turn prose
 * into those statements. Both were removed with the conversation layer. The
 * input is now `UserStatement[]` — FORECAST-8's own typed vocabulary, from
 * `lib/forecast/policy.ts` — so this module is a function of VALUES end to end
 * and whatever produces those statements is somebody else's problem. Nothing
 * here parses, matches or interprets a sentence.
 */

import { composeInvestments } from '@/lib/ai/economic-concepts';
import { FinanceDomains, type AccountsSectionData, type SpaceContext_AI } from '@/lib/ai/types';
import {
  AmountBasis, EventProvenance, FlowRole,
  type FlowRoleKind, type FutureCashEvent,
} from '@/lib/forecast/future-cash-event';
import { isCadence, type CadenceKindName } from '@/lib/forecast/cadence';
import { ActivityState } from '@/lib/forecast/stream-activity';
import { periodicCashEvents } from '@/lib/forecast/periodic-amount';
import {
  projectCash, projectCashInterval,
  type ProjectedCash, type ProjectedInterval, type ProjectCashInput, type ProjectionSpending,
} from '@/lib/forecast/projection';
import {
  deriveObservedSpendingRate, deriveCategorySpendingRates, withoutModelledInterest,
  type ModelledInterestExclusion, type ObservedSpendingRate,
} from '@/lib/forecast/observed-spending';
import {
  applySpendingChanges,
  type SpendingBaseline, type SpendingChangeResult, type SpendingChangeRule,
} from '@/lib/forecast/spending-change';
import { reliableMonths } from '@/lib/ai/intelligence/annotations/metrics';
import { clampEconomicSpend } from '@/lib/transactions/cash-flow';
import type { TransactionsSummaryData } from '@/lib/ai/types';
import { assertedAmountBasis } from '@/lib/forecast/periodic-amount';
import { assertedSpendingBaseline, PeriodBasis } from '@/lib/forecast/spending-baseline';
import {
  composeOperatingState, conclusionLicence, Conclusion,
  type ConclusionKind, type CurrentOperatingState, type IncomeStreamInput,
} from '@/lib/forecast/operating-state';
import {
  AssumptionDimension, AssumptionOrigin, AssumptionStance, ConclusionStatus, StatementMode,
  routeStatement,
  type ConclusionStatusKind,
  continueLicensedCadence,
  type ForecastHorizon, type ForecastPolicy, type PolicyAssumption, type StatementSubject,
  type UserStatement,
} from '@/lib/forecast/policy';
import { forecastCash, type CashForecast } from '@/lib/forecast/engine';
import {
  applyIncomeChanges,
  type IncomeChangeResult, type IncomeChangeRule, type IncomeStreamRef,
} from '@/lib/forecast/income-change';
import type { ResolvedIncomeStream } from './streams';

/** What a forecast needs that is not already a FORECAST-* authority's job. */
export interface ForecastAssemblyInput {
  ctx: SpaceContext_AI;
  /** Already resolved by FORECAST-1/2/5 in `./streams.ts`. */
  streams: readonly ResolvedIncomeStream[];
  horizon: ForecastHorizon;
  asOfISO: string;
  /**
   * What the user stated, ALREADY TYPED.
   *
   * ⚠️ THE CALLER DECIDES WHAT IS IN HERE, INCLUDING ITS SCOPE. FORECAST-13's
   * rule — a fact survives the turn it was stated in, a supposition does not —
   * is a rule about which statements a caller collects, not one this module can
   * enforce, and pretending otherwise is what put a regex extractor inside a
   * deterministic assembler. `ASSERTS_FACT` statements are applied to the STATE
   * through FORECAST-6/9A; every other mode becomes a `PolicyAssumption`.
   *
   * Order matters: for a given subject the LAST statement wins, so a correction
   * is expressed by appending, never by mutating.
   */
  statements?: readonly UserStatement[];
  /**
   * Dated events some OTHER authority already licensed — a bonus the user named
   * with a date and an amount, an obligation FORECAST-4 dated.
   *
   * ⚠️ NO PRODUCTION EXTRACTOR FEEDS THIS YET, and that is a reported gap
   * rather than a hidden one. FORECAST-3 has licensed a USER_ASSERTED event
   * since f849c05, and FORECAST-10 built no natural-language route to one; the
   * conformance harness supplies them directly so the GROSS/UNKNOWN-basis
   * behaviour can be MEASURED against the real model before anything is built
   * to produce them. Whatever arrives here has already been licensed by
   * somebody; this module does not license it.
   */
  additionalEvents?: readonly FutureCashEvent[];
  /**
   * I1 — dated changes to FUTURE income, as a scenario supposition.
   *
   * ⚠️ THE STATE IS NOT TOUCHED. A rule here changes the dated occurrences a
   * licensed stream generates; it does not change `CurrentOperatingState`, the
   * observed history, or any measured figure. "Starting January I make $180k" is
   * a hypothetical about next year, not a claim about this month's payroll, and
   * the two must not be able to become each other. A test pins that the state is
   * identical with and without these rules.
   *
   * ⚠️ AND IT IS APPLIED HERE RATHER THAN AS A POLICY DIMENSION, for the reason
   * `income-change.ts`'s header sets out: `applyPolicy` feeds the LICENSED path,
   * which refuses on a real Space, and PROJECTION-1's `projectCash` — the path
   * that answers — never sees a policy. A change expressed only as a supposition
   * would be reported everywhere and move nothing.
   */
  incomeChanges?: readonly IncomeChangeRule[];
  /**
   * S1-N1 — liabilities whose FUTURE interest the caller's ledger accrues itself
   * (a known rate). Their historical interest charges are left out of the observed
   * spending rate so the interest is counted once. Only the scenario ledger passes
   * this; a plain projection has no liability model and keeps every cost flow.
   */
  interestModelledOn?: readonly string[];
  /**
   * S1 — dated changes to FUTURE spending, as a scenario supposition, with their
   * categories already resolved by the caller.
   *
   * ⚠️ APPLIED TO THE PROJECTION'S RATE, NOWHERE ELSE. Like I1's rules they never
   * touch the state or the measured history; unlike them they are not events — the
   * projection's spend term integrates the schedule they produce. The LICENSED path
   * never sees them, and when it is the one that answered they are reported as not
   * applied rather than quietly dropped.
   */
  spendingChanges?: readonly SpendingChangeRule[];
}

/**
 * S1 — what the spending rules did: applied to the projection, or not applied at
 * all with the reason. Never absent when rules were supplied.
 */
export type SpendingChangeOutcome =
  | (SpendingChangeResult & { applied: true })
  | { applied: false; reason: string; ruleIds: string[] };

export interface AssembledForecast {
  state: CurrentOperatingState;
  events: FutureCashEvent[];
  policy: ForecastPolicy;
  forecast: CashForecast | { refused: true; reason: string };
  /** The statements this assembly consumed, echoed back in the order applied. */
  statements: readonly UserStatement[];
  /** Facts applied to the STATE, kept separate from suppositions. */
  appliedFacts: string[];
  /** Why a forecast could not be assembled at all, when it could not. */
  unavailable: string | null;
  /**
   * PROJECTION-1 — the evidence-based path, when the licensed one refused.
   *
   * ⚠️ ABSENT WHENEVER THE LICENSED PATH SUCCEEDED. A FACTUALLY_LICENSED answer
   * is never accompanied by a weaker one competing for the same sentence.
   */
  projection?: ProjectedCash;
  /** The window and dispersion behind the projection's spending term. */
  observedSpending?: ObservedSpendingRate;
  /**
   * Exactly what `projection` was computed from. Present whenever it is.
   *
   * ⚠️ KEPT SO AN INTERVAL OF THE PROJECTION IS THE SAME PROJECTION. `projectInterval`
   * folds THESE events at THIS rate over a narrower window; an interval that
   * re-resolved its own spending term or regenerated its own events could
   * disagree with the cumulative figure printed beside it.
   */
  projectionInput?: ProjectCashInput;
  /**
   * I1 — what the income rules ACTUALLY DID, counted off the event arrays.
   *
   * ⚠️ THE EXECUTION EVIDENCE, AND THE ONLY THING ENTITLED TO SAY A RULE RAN.
   * Absent when no rule was supplied. Present with `ran: false` and a reason when
   * one was supplied and changed nothing — which is a different sentence from
   * absence, and the one a reader needs.
   */
  incomeChanges?: IncomeChangeResult;
  /**
   * S1-N1 — interest left out of the observed rate because the caller's ledger
   * accrues it, restricted to the months the rate averaged. Absent when nothing was.
   */
  modelledInterest?: ModelledInterestExclusion;
  /** S1 — what the spending rules did. Absent when none was supplied. */
  spendingChanges?: SpendingChangeOutcome;
}

/**
 * PROJECTION-1 — the capability switch, and why it exists.
 *
 * ⚠️ IT IS NOT CAUTION, IT IS ATTRIBUTION. The F15 conformance corpus encodes the
 * PRE-PROJECTION contract for this Space: ten of its scenarios forbid an ending
 * cash figure and a historical baseline outright, which is exactly what an
 * evidence-based projection is authorised to provide. Those scenarios now fail
 * BY DESIGN, and a flag is what lets the same corpus be run both ways so the
 * delta is measured rather than argued about — and lets the capability be turned
 * off in one place if the delta is judged unacceptable.
 *
 * Default ON: the product decision to answer these questions has been taken.
 * `AI_FORECAST_PROJECTION=off` restores the prior contract exactly.
 */
export function projectionEnabled(): boolean {
  return process.env.AI_FORECAST_PROJECTION !== 'off';
}

const accountsOf = (ctx: SpaceContext_AI) =>
  ctx.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData | undefined;

/**
 * Build state, events and policy, then run the engine exactly once.
 *
 * ⚠️ THE ONLY PRODUCTION CALL TO `forecastCash`. A test pins that no other file
 * outside lib/forecast imports it, because two call sites is two forecasts and
 * eventually two answers.
 */
export function assembleForecast(input: ForecastAssemblyInput): AssembledForecast {
  const { ctx, streams, horizon, asOfISO } = input;
  const acc = accountsOf(ctx);
  const statements = input.statements ?? [];

  // ── Facts, applied to the authorities that own them ──────────────────────
  //
  // ⚠️ ONE PASS, LAST WINS. A later statement about the same subject supersedes
  // an earlier one, which is how a correction reaches the substrate without a
  // store to keep in sync. Nothing is merged by guess and nothing is inferred:
  // a statement that names no subject this module can route simply does not
  // appear below.
  const assertedFacts = statements.filter((st) => st.mode === StatementMode.ASSERTS_FACT);

  const appliedFacts: string[] = [];
  let assertedBaseline: ReturnType<typeof assertedSpendingBaseline> | null = null;
  const assertedBasis = new Map<string, ReturnType<typeof assertedAmountBasis>>();

  // ⚠️ THE LAST STATEMENT IS SELECTED BEFORE ANYTHING IS APPLIED, not applied
  // over the top of the earlier one. Applying each in turn produced the right
  // baseline and a `appliedFacts` list naming BOTH — a report that two spending
  // levels were in force when only one was, which is precisely the kind of
  // parallel-authority statement this substrate exists to prevent.
  const lastSpending = [...assertedFacts].reverse()
    .find((st) => st.subject.kind === 'SPENDING_LEVEL');
  if (lastSpending && lastSpending.subject.kind === 'SPENDING_LEVEL') {
    const sub = lastSpending.subject;
    assertedBaseline = assertedSpendingBaseline(
      sub.amount, sub.currency, sub.periodBasis, asOfISO);
    appliedFacts.push(
      `spending baseline ${sub.amount} ${sub.currency}: "${lastSpending.statedAs}"`);
  }

  // Per stream, the same rule: the latest claim about a stream's basis is the
  // one in force, and it is the only one reported.
  const lastBasis = new Map<string, UserStatement>();
  for (const st of assertedFacts) {
    if (st.subject.kind === 'STREAM_AMOUNT_BASIS') lastBasis.set(st.subject.sourceKey, st);
  }
  for (const st of lastBasis.values()) {
    if (st.subject.kind !== 'STREAM_AMOUNT_BASIS') continue;
    const { sourceKey, basis } = st.subject;
    const stream = streams.find((s) => s.sourceKey === sourceKey);
    // ⚠️ UNKNOWN IS NOT A BASIS. FORECAST-9A's `assertedAmountBasis` produces
    // NET or GROSS and nothing else; a claim that resolves neither is dropped
    // rather than downgraded into one.
    if (stream?.amount?.assertable && basis !== AmountBasis.UNKNOWN) {
      assertedBasis.set(sourceKey,
        assertedAmountBasis(stream.amount, basis as 'NET' | 'GROSS', asOfISO));
      appliedFacts.push(`${sourceKey} basis ${basis}: "${st.statedAs}"`);
    }
  }

  // ── CurrentOperatingState, from canonical authorities only ───────────────
  const incomeStreams: IncomeStreamInput[] = streams.map((s) => {
    const asserted = assertedBasis.get(s.sourceKey);
    const amount = asserted ?? (s.amount?.assertable ? s.amount : null);
    return {
      sourceKey: s.sourceKey,
      role: s.role,
      cadence: (isCadence(s.cadence) ? s.cadence.kind : null) as CadenceKindName | null,
      activity: s.activity.state,
      // ⚠️ FORECAST-2's licence, carried. Never recomputed, never widened.
      projectionEligible: s.activity.mayGenerateExpectedOccurrences,
      amount: amount
        ? {
          value: amount.value, currency: amount.currency, provenance: amount.provenance,
          basis: amount.basis, basisProvenance: amount.basisProvenance,
        }
        : null,
    };
  });

  const state = composeOperatingState({
    asOfISO,
    accounts: acc
      ? {
        totalLiquid: acc.totalLiquid, totalLiabilities: acc.totalLiabilities,
        counts: { liquid: acc.counts.liquid, liabilities: acc.counts.liabilities },
        redactedCount: acc.redactedCount, totalsUnconverted: acc.totalsUnconverted,
        asOfISO,
      }
      : null,
    // ⚠️ CF-7's composition, passed through. Digital assets stay visible in the
    // state and stay out of opening cash — the engine reads `liquidity` only.
    investments: acc ? composeInvestments(acc) : null,
    incomeStreams,
    // FORECAST-4 licenses obligations from debt terms. Nothing in the AI
    // context carries a licensed due date today, so this reports "evaluated,
    // none licensed" — ABSENT, which FORECAST-7 treats as usable evidence and
    // renders as a statement about the EVIDENCE, not about the user's bills.
    //
    // ⚠️ BUT THE COUNT WAS HARD-CODED ZERO, AND ZERO IS A DIFFERENT SENTENCE
    // (V26-REASONING Slice 3). `operating-state.ts` appends "; N obligation(s)
    // are active but carry no due date" to the user-visible reason, so a
    // hard-coded 0 turns "five bills we know about and cannot date" into
    // "nothing to say". FORECAST-4's census of the real database found exactly
    // five such accounts — balance owed, a stated minimum, and `dueDay` null —
    // and this counts them from the payload rather than asserting none exist.
    //
    // ⚠️ THIS CHANGES NO PROJECTED NUMBER. `licensedEvents` stays empty, because
    // no authority can invent a due date that was never captured; only the
    // COMPLETENESS OF THE DISCLOSURE changes. `obligation.ts` stays unwired: it
    // would be a no-op with a false air of capability.
    obligations: {
      licensedEvents: [], evaluated: true,
      activeButUndatedCount: activeUndatedObligations(acc),
    },
    baseline: assertedBaseline
      ? {
        assertable: true, amount: assertedBaseline.amount,
        periodBasis: assertedBaseline.periodBasis, provenance: assertedBaseline.provenance,
        currency: assertedBaseline.currency, reason: assertedBaseline.reason,
      }
      // ⚠️ NOT DERIVED HERE. FORECAST-6 measured that the live ledger does not
      // establish a current-normal level, and this adapter has no transactions
      // through which to disagree with it.
      : { assertable: false, reason: 'no current-normal spending level is established from available evidence' },
  });

  // ── Future events, from licensed authorities only ────────────────────────
  //
  // ⚠️ `periodicCashEvents` IS THE ONLY DOOR, and it consults FORECAST-2's
  // activity licence before producing a single date. A SILENT stream yields
  // nothing however good its amount. Nothing here reads a merchant frequency,
  // a subscription or a recurring candidate — none of which carry a date, and
  // all of which FORECAST-4 explicitly declined to license.
  // ── One-off dated events the user named (FORECAST-17) ────────────────────
  //
  // ⚠️ TWO PROVENANCES, TWO SCOPES, ONE AUTHORITY. A fact is re-derived from the
  // whole conversation and carries USER_ASSERTED; a supposition comes from THIS
  // turn and carries HYPOTHETICAL — FORECAST-3's own value, reserved in writing
  // for exactly this. Neither becomes the other, and neither needs a policy
  // dimension to hold it: the event's provenance says which it is.
  const assertedEvents: FutureCashEvent[] = assertedFacts
    .filter((st) => st.subject.kind === 'ONE_OFF_EVENT')
    .map((st) => {
      const sub = st.subject as Extract<StatementSubject, { kind: 'ONE_OFF_EVENT' }>;
      return {
        // ⚠️ THE ID CARRIES THE AMOUNT. Without it the dedupe map below
        // collapsed "a $15,500 gross bonus on October 15" and "a $1,500 payout
        // on October 15" into one event — the programme's own live-failure
        // fixture, silently losing the payout. Two movements that share a day
        // and a role are still two movements.
        id: `user:${sub.direction}:${sub.role}:${sub.dateISO}:${sub.amount}`,
        timing: { kind: 'EXACT' as const, dateISO: sub.dateISO },
        timingProvenance: EventProvenance.USER_ASSERTED,
        direction: sub.direction,
        role: sub.role as FlowRoleKind,
        amount: { value: sub.amount, currency: sub.currency, basis: sub.basis,
          provenance: EventProvenance.USER_ASSERTED },
      };
    });

  const supposedEvents: FutureCashEvent[] = statements
    .filter((st) => st.mode !== StatementMode.ASSERTS_FACT
      && st.subject.kind === 'ONE_OFF_EVENT')
    .map((st) => {
      const sub = st.subject as Extract<StatementSubject, { kind: 'ONE_OFF_EVENT' }>;
      return {
        id: `supposed:${sub.direction}:${sub.role}:${sub.dateISO}:${sub.amount}`,
        timing: { kind: 'EXACT' as const, dateISO: sub.dateISO },
        timingProvenance: EventProvenance.HYPOTHETICAL,
        direction: sub.direction,
        role: sub.role,
        amount: { value: sub.amount, currency: sub.currency, basis: sub.basis,
          provenance: EventProvenance.HYPOTHETICAL },
      };
    });

  // ⚠️ DEDUPED BY ID, NOT BY VALUE. A caller-supplied event and a user-stated
  // one describing the same movement collapse; two distinct movements that
  // happen to share an amount and a day do not, because their ids differ in
  // direction or role.
  const byId = new Map<string, FutureCashEvent>();
  for (const e of [...(input.additionalEvents ?? []), ...assertedEvents, ...supposedEvents]) {
    if (!byId.has(e.id)) byId.set(e.id, e);
  }
  const derivedEvents: FutureCashEvent[] = [...byId.values()];
  for (const s of streams) {
    if (!isCadence(s.cadence)) continue;
    const asserted = assertedBasis.get(s.sourceKey);
    const amount = asserted ?? s.amount;
    if (!amount) continue;
    // PROJECTION-1 — the observed-settled marker travels ONLY with the stream's
    // OWN derived level. A user-asserted basis (`asserted`) is a statement about
    // a payroll figure and answers the basis question directly; it needs no
    // observation marker and must not borrow one.
    derivedEvents.push(...periodicCashEvents(
      s.activity, s.cadence, amount, horizon.fromISO, horizon.toISO, s.role,
      asserted === undefined && s.settledDepository));
  }

  // ── I1: dated income changes, applied to the occurrences ─────────────────
  //
  // ⚠️ AFTER the licensed streams have generated their dates and BEFORE either
  // path folds them, because both paths fold the same array. The rules reach no
  // other event: an asserted one-off carries no `sourceKey`, so a rule cannot
  // touch a bonus, and an OUTFLOW is not income however it is dated.
  const incomeChanges = (input.incomeChanges && input.incomeChanges.length > 0)
    ? applyIncomeChanges({
      events: derivedEvents,
      streams: streams.map((s): IncomeStreamRef => ({
        sourceKey: s.sourceKey,
        ...(s.label ? { label: s.label } : {}),
        role: s.role,
        cadence: isCadence(s.cadence) ? s.cadence.kind : null,
        // ⚠️ FORECAST-2's licence, carried — never re-derived. A rule cannot
        // reach a stream the activity authority has not licensed to continue,
        // which is what keeps "my income goes up 10%" from resurrecting an
        // employer the user left.
        projectionEligible: s.activity.mayGenerateExpectedOccurrences,
      })),
      rules: input.incomeChanges,
      horizon: { fromISO: horizon.fromISO, toISO: horizon.toISO },
      currency: state.liquidity.currency ?? 'USD',
    })
    : null;
  const events: FutureCashEvent[] = incomeChanges ? incomeChanges.events : derivedEvents;

  // ── Policy: horizon, the one licensed system default, and suppositions ────
  const assumptions: PolicyAssumption[] = [continueLicensedCadence()];
  let n = 0;
  for (const st of statements) {
    // ⚠️ FORECAST-8 DECIDES, NOT THIS MODULE. `routeStatement` is the authority
    // on where a statement belongs; an ASSERTS_FACT statement routes UPSTREAM
    // and is skipped here by its own verdict, never by a mode check duplicated
    // in the caller.
    const routing = routeStatement(st, `p${n}`);
    if (routing.destination !== 'FORECAST_POLICY') continue;
    assumptions.push({ ...routing.assumption, id: `p${n++}` });
  }

  const policy: ForecastPolicy = { horizon, assumptions };
  const forecast = forecastCash(state, events, policy);

  // ── PROJECTION-1 — the evidence-based path ────────────────────────────────
  //
  // Runs only where the licensed one could not, and never where the USER supplied
  // the spending level: their own statement about what they will spend outranks
  // an average of what they did spend, and the licensed path already carries it.
  // ⚠️ THE TEST IS "IS THERE AN ANSWER", NOT "IS IT FACTUALLY_LICENSED". This
  // read `status === FACTUALLY_LICENSED`, which treated ASSUMPTION_DEPENDENT as
  // no answer at all — and ASSUMPTION_DEPENDENT is the ordinary result whenever
  // the user supplies a spending level or a payroll basis. Measured on the
  // conformance corpus: "Assume I spend $4,000/month and that my Vectrus
  // paycheck is net" produced a licensed ASSUMPTION_DEPENDENT closing of
  // $35,144.66, and a projection then computed the SAME $35,144.66 and overlaid
  // it as the answer. Two harms, both real:
  //
  //   · the authority was misattributed — a result resting on the user's own
  //     stated assumptions was narrated as "if these patterns continue", which
  //     is observed-continuation framing for a conclusion no observation
  //     supports on its own; and
  //   · the assumption provenance disappeared with it. The user's "my paycheck
  //     is net" is what licenses $37,006.51 as cash, and the projection block
  //     lists OBSERVED_CONTINUATION assumptions instead, so the one input that
  //     materially changes the result stopped being visible.
  //
  // A path with a closing figure has answered. Only a REFUSED one has not, and
  // only then is there a gap for a weaker path to fill.
  const hasLicensedAnswer = !('refused' in forecast)
    && forecast.fullCashPath.closing !== null;

  let projection: ProjectedCash | undefined;
  let observedSpending: ObservedSpendingRate | undefined;
  let projectionInput: ProjectCashInput | undefined;
  let modelledInterest: ModelledInterestExclusion | undefined;
  let spendingChanges: SpendingChangeOutcome | undefined;
  const spendingRules = input.spendingChanges ?? [];
  const notApplied = (reason: string): SpendingChangeOutcome =>
    ({ applied: false, reason, ruleIds: spendingRules.map((r) => r.id) });
  if (spendingRules.length > 0 && hasLicensedAnswer) {
    // ⚠️ THE LICENSED ENGINE IGNORES SPENDING CHANGES, AND SAYS SO. It answers from
    // licensed evidence and a policy; a scenario supposition about next year's
    // Dining is neither, and a second, divergent implementation of it inside the
    // engine is exactly the parallel path this adapter exists to prevent.
    spendingChanges = notApplied('the licensed forecast is what answered here, and it does not apply '
      + 'scenario spending changes — so NONE was applied. The figures are without them.');
  }
  if (!hasLicensedAnswer && projectionEnabled()) {
    // ⚠️ THE USER'S OWN RATE WINS, AND THE ENGINE ALREADY RESOLVED IT. When the
    // conversation supplied a spending level, `forecast.spending` carries it as
    // ASSUMED with a daily rate and the assumption's id; the projection takes
    // that instead of the observed window, so an override CHANGES the answer
    // rather than removing it.
    const engineSpending = 'refused' in forecast ? null : forecast.spending;
    let spending: ProjectionSpending | null = null;
    const txnForRates = ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY]?.data as
      TransactionsSummaryData | undefined;
    if (engineSpending && engineSpending.dailyRate !== null) {
      spending = {
        kind: 'USER_ASSUMED',
        dailyRate: engineSpending.dailyRate,
        monthlyAmount: engineSpending.amount,
        statedAs: engineSpending.reason,
      };
    } else {
      const txn = txnForRates;
      // S1-N1 — interest the caller's ledger accrues itself leaves the months
      // BEFORE the clamp, by the authority in observed-spending; nothing else does.
      const net = withoutModelledInterest(reliableMonths(txn ?? null), input.interestModelledOn ?? []);
      const rate = deriveObservedSpendingRate(
        // NET-BASELINE-1 — the projection spends at NET economic spending: the
        // month's charges less the refunds dated in it, floored at 0 (the canonical
        // clamp). A refund returns the money, so a rate built on gross charges
        // drains cash the user still has. Same months, same definition, as the
        // measured expense baseline — one "monthly spending" across both.
        net.months.map((m) => ({
          month: m.month, expenseTotal: clampEconomicSpend(m.expenseTotal, m.refundTotal) })));
      if (rate.assertable) {
        observedSpending = rate; spending = { kind: 'OBSERVED', rate };
        const inWindow = net.excluded?.months.filter((x) => rate.months.includes(x.month)) ?? [];
        if (net.excluded && inWindow.length > 0) modelledInterest = { ...net.excluded, months: inWindow };
      }
    }
    // ── S1: the spending rules, on the rate this projection spends at ─────────
    //
    // The TOTAL is the rate just resolved (observed, or the user's stated level);
    // each category line is the canonical ledger's over the SAME averaged months.
    let spendingSchedule: SpendingChangeResult['schedule'] | undefined;
    if (spendingRules.length > 0) {
      const reliable = withoutModelledInterest(reliableMonths(txnForRates ?? null), input.interestModelledOn ?? []).months;
      const observed = observedSpending ?? deriveObservedSpendingRate(reliable.map((m) => ({
        month: m.month, expenseTotal: clampEconomicSpend(m.expenseTotal, m.refundTotal) })));
      const windowMonths = observed.assertable ? observed.months : [];
      const baseline: SpendingBaseline | null = spending === null ? null
        : spending.kind === 'OBSERVED'
          ? { monthly: spending.rate.monthlyRate, daily: spending.rate.dailyRate, basis: 'MEASURED',
            months: spending.rate.months, values: spending.rate.values }
          : spending.monthlyAmount !== null
            ? { monthly: spending.monthlyAmount, daily: spending.dailyRate, basis: 'STATED_TOTAL',
              months: windowMonths, values: [] }
            : null;
      if (baseline === null) {
        spendingChanges = notApplied('there is no monthly spending rate for these changes to apply to, so '
          + 'NONE was applied.');
      } else {
        const result = applySpendingChanges({
          baseline, categoryRates: deriveCategorySpendingRates(reliable, windowMonths),
          rules: spendingRules, asOfISO: horizon.fromISO, horizonISO: horizon.toISO,
        });
        spendingChanges = { ...result, applied: true };
        spendingSchedule = result.schedule;
      }
    }
    projectionInput = {
      openingCash: 'refused' in forecast ? null : forecast.openingCash.amount,
      events, spending,
      fromISO: horizon.fromISO, toISO: horizon.toISO,
      currency: state.liquidity.currency ?? 'USD',
      ...(spendingSchedule ? { spendingSchedule } : {}),
    };
    projection = projectCash(projectionInput);
  } else if (spendingRules.length > 0 && !spendingChanges) {
    spendingChanges = notApplied('the evidence-based projection is switched off here, so NONE was applied.');
  }

  return {
    state, events, policy, forecast,
    statements, appliedFacts,
    unavailable: acc ? null : 'account balances could not be assembled for this Space',
    projection, observedSpending, projectionInput,
    ...(incomeChanges ? { incomeChanges } : {}),
    ...(modelledInterest ? { modelledInterest } : {}),
    ...(spendingChanges ? { spendingChanges } : {}),
  };
}

/**
 * The projected components inside a future-dated window of an assembled forecast.
 *
 * ⚠️ THE SANCTIONED WAY TO ASK, FOR THE SAME REASON `assembleForecast` IS. The
 * conversation tools may not reach past this adapter into the projection
 * authority, and they do not need to: an interval is a property of a forecast
 * that was already assembled, so it takes that forecast and a window and nothing
 * else. Null when there is no evidence-based projection to take an interval OF —
 * the licensed path answered, or nothing did.
 */
export function projectInterval(
  assembled: AssembledForecast, window: { fromISO: string; toISO: string },
): ProjectedInterval | null {
  return assembled.projectionInput ? projectCashInterval(assembled.projectionInput, window) : null;
}

/**
 * Debt accounts that are ACTIVE and carry NO due date.
 *
 * ⚠️ THE BINDING CONSTRAINT IS TIMING, NOT AMOUNT. An account with a balance
 * owed and a stated minimum is a bill we know about; without a `dueDay` it is a
 * bill we cannot place on a calendar, and a projection that silently omits it is
 * not the same thing as a projection that says so.
 *
 * Reads the payload's own resolved debt fields (`amountOwed`, `minimumPayment`,
 * `dueDay` — all from `lib/debt/balance-semantics` and `effective-terms`), so
 * this counts rows rather than deciding anything about them. BALANCE_ONLY rows
 * carry none of these fields and are therefore not counted, which is correct:
 * their absence is a visibility fact, not a due-date fact, and counting them
 * would disclose that a hidden account is a debt account.
 */
function activeUndatedObligations(acc: AccountsSectionData | undefined): number {
  const rows = acc?.accounts;
  if (!Array.isArray(rows)) return 0;
  return rows.filter((r) =>
    typeof r.amountOwed === 'number' && r.amountOwed > 0
    && typeof r.minimumPayment === 'number' && r.minimumPayment > 0
    && (r.dueDay === null || r.dueDay === undefined)).length;
}

// ── Question-specific capability (§17) — DELETED (V26-REASONING Slice 0) ─────
//
// ⚠️ A THIRD ROUTER, AND IT HAD NO CALLERS. `ForecastAsk`, `forecastAsk`,
// `asksSomethingAlreadyLicensed` and the three regexes behind them
// (NEXT_PAY_RE / RUNWAY_RE / NOMINAL_INCOME_RE) were reachable only from
// `forecast-integration.test.ts`. Nothing in production ever asked this module
// which conclusion a question wanted: CF-8's retrieval plan decides FORECAST vs
// PAY_DATES before assembly, and FORECAST-16's own finding was that folding pay
// dates into the forecast ask is what made a pay-date question answer "Ending
// cash: REFUSED". The capability matrix it documented survives where it is
// actually consulted — `conclusionLicence(state, conclusion)`.
//
// Deleted here rather than kept "until the planner lands" because Slice 5
// replaces question interpretation wholesale, and a fourth vocabulary of
// forward-looking regexes is precisely what that slice exists to remove.

// ⚠️ THE ADAPTER IS THE DOOR, AND THIS LINE IS THE DOOR (V26-REASONING Slice 1).
// `engine.test.ts` N1, `policy.test.ts` J9 and `spending-baseline.test.ts` L4
// all pin the same rule: no assembler, prompt, route or component reaches past
// `lib/ai/forecast/` into the authorities. The reasoning layer needs three
// vocabularies from behind that door — the conclusion statuses, the period
// basis, and the forecast's own result type — and the right way to give it them
// is to widen this re-export, not to widen the allowlist. A second consumer
// root would be the first crack in the rule the three tests exist to hold.
// ⚠️ THE ADAPTER RE-EXPORTS THE VOCABULARY ITS CALLERS NEED, which is what makes
// "consumed only through the sanctioned adapter" (FORECAST-6/8/9's guard) a
// boundary a caller can actually live behind rather than one it must breach.
// `StatementMode` and `UserStatement` joined the list when `assembleForecast`
// started taking `UserStatement[]` — a caller cannot construct the input
// without them, so omitting them forced the exact reach-past the guard forbids.
export { PeriodBasis, AssumptionDimension, AssumptionOrigin, AssumptionStance, EventProvenance, FlowRole, ActivityState, ConclusionStatus, StatementMode };
export type { CashForecast, ConclusionStatusKind, ForecastHorizon, UserStatement, ProjectedInterval, ModelledInterestExclusion };
export type { SpendingChangeRule, SpendingChangeResult } from '@/lib/forecast/spending-change';
export { SpendingChangeOp } from '@/lib/forecast/spending-change';
