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
  projectCash, type ProjectedCash, type ProjectionSpending,
} from '@/lib/forecast/projection';
import {
  deriveObservedSpendingRate, type ObservedSpendingRate,
} from '@/lib/forecast/observed-spending';
import { reliableMonths } from '@/lib/ai/intelligence/annotations/metrics';
import type { TransactionsSummaryData } from '@/lib/ai/types';
import { assertedAmountBasis } from '@/lib/forecast/periodic-amount';
import { assertedSpendingBaseline, PeriodBasis } from '@/lib/forecast/spending-baseline';
import {
  composeOperatingState, conclusionLicence, Conclusion,
  type ConclusionKind, type CurrentOperatingState, type IncomeStreamInput,
} from '@/lib/forecast/operating-state';
import {
  AssumptionDimension, AssumptionOrigin, AssumptionStance, ConclusionStatus, StatementMode,
  type ConclusionStatusKind,
  continueLicensedCadence,
  type ForecastHorizon, type ForecastPolicy, type PolicyAssumption, type StatementSubject,
} from '@/lib/forecast/policy';
import { forecastCash, type CashForecast } from '@/lib/forecast/engine';
import type { ResolvedIncomeStream } from './streams';
import { extractForecastStatements, type ExtractedStatement } from './statements';
import {
  resolveAssertedFacts, type AssertedFacts, type FactMessage,
} from './fact-continuity';

/** What a forecast needs that is not already a FORECAST-* authority's job. */
export interface ForecastAssemblyInput {
  ctx: SpaceContext_AI;
  /** Already resolved by FORECAST-1/2/5 in `./streams.ts`. */
  streams: readonly ResolvedIncomeStream[];
  horizon: ForecastHorizon;
  asOfISO: string;
  /** This turn's message. Suppositions come from HERE and nowhere else. */
  question: string;
  /**
   * The whole conversation, for FACT continuity.
   *
   * ⚠️ FACTS AND SUPPOSITIONS READ DIFFERENT INPUTS, and that is the entire
   * distinction FORECAST-13 exists to draw. A supposition is scoped to the turn
   * that makes it (`question`); a fact the user asserted is still true three
   * turns later and is re-derived from the history (`messages`), exactly as CF-4
   * re-derives the temporal scope. Omitting `messages` falls back to the
   * question alone — the pre-FORECAST-13 behaviour, so every existing caller
   * and every prior measurement is unchanged.
   */
  messages?: readonly FactMessage[];
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
}

export interface AssembledForecast {
  state: CurrentOperatingState;
  events: FutureCashEvent[];
  policy: ForecastPolicy;
  forecast: CashForecast | { refused: true; reason: string };
  /** Every statement recognised this turn, and where it was routed. */
  statements: ExtractedStatement[];
  /** What the user has asserted across the conversation, latest in force. */
  facts: AssertedFacts;
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
  const { ctx, streams, horizon, asOfISO, question } = input;
  const acc = accountsOf(ctx);

  // The stream a bare "my paycheck" refers to: the one licensed to continue
  // that carries an amount. Null when there is no single obvious candidate —
  // in which case a basis statement is not extracted at all rather than
  // attached to a guess.
  const candidates = streams.filter((s) => s.projectionEligible && s.amount !== null);
  const primaryKey = candidates.length === 1 ? candidates[0].sourceKey : null;

  // ── Facts, from the whole conversation, applied to the authorities ───────
  //
  // ⚠️ THE HISTORY IS THE SOURCE, NOT THIS TURN. A correction stated on a turn
  // that asked for nothing is still the user's stated fact when a forecast is
  // finally requested; re-deriving it here is what makes it reachable without
  // a store to keep in sync. Latest statement per subject wins.
  const facts: AssertedFacts = resolveAssertedFacts(
    input.messages ?? [{ role: 'user', content: question }], asOfISO, streams);

  const appliedFacts: string[] = [];
  let assertedBaseline: ReturnType<typeof assertedSpendingBaseline> | null = null;
  const assertedBasis = new Map<string, ReturnType<typeof assertedAmountBasis>>();

  if (facts.spending) {
    assertedBaseline = assertedSpendingBaseline(
      facts.spending.amount, facts.spending.currency, facts.spending.periodBasis, asOfISO);
    appliedFacts.push(
      `spending baseline ${facts.spending.amount} ${facts.spending.currency}: "${facts.spending.statedAs}"`);
  }
  // ⚠️ SUPPOSITIONS ARE READ AFTER THE FACTS, AND FROM THIS TURN ONLY. They
  // borrow the facts' antecedent — "what if it were $10,000" revises the level
  // the user established — without becoming one: the result is a HYPOTHETICAL
  // policy assumption over an unchanged authoritative baseline.
  const statements = extractForecastStatements(question, asOfISO, primaryKey,
    facts.spending
      ? { kind: 'SPENDING_LEVEL', currency: facts.spending.currency,
        periodBasis: facts.spending.periodBasis }
      : undefined);

  for (const b of facts.basis) {
    const stream = streams.find((s) => s.sourceKey === b.sourceKey);
    if (stream?.amount?.assertable && b.basis !== AmountBasis.UNKNOWN) {
      assertedBasis.set(b.sourceKey,
        assertedAmountBasis(stream.amount, b.basis as 'NET' | 'GROSS', asOfISO));
      appliedFacts.push(`${b.sourceKey} basis ${b.basis}: "${b.statedAs}"`);
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
  const assertedEvents: FutureCashEvent[] = facts.events.map((e) => ({
    // ⚠️ THE ID CARRIES THE AMOUNT, matching fact-continuity's identity exactly.
    // Without it the dedupe map below collapsed "a $15,500 gross bonus on
    // October 15" and "a $1,500 payout on October 15" into one event — the
    // programme's own live-failure fixture, silently losing the payout. Two
    // identities that must agree and did not is how a movement disappears.
    id: `user:${e.direction}:${e.role}:${e.dateISO}:${e.amount}`,
    timing: { kind: 'EXACT', dateISO: e.dateISO },
    timingProvenance: EventProvenance.USER_ASSERTED,
    direction: e.direction,
    role: e.role as FlowRoleKind,
    amount: { value: e.amount, currency: e.currency, basis: e.basis,
      provenance: EventProvenance.USER_ASSERTED },
  }));

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
  const events: FutureCashEvent[] = [...byId.values()];
  for (const s of streams) {
    if (!isCadence(s.cadence)) continue;
    const asserted = assertedBasis.get(s.sourceKey);
    const amount = asserted ?? s.amount;
    if (!amount) continue;
    // PROJECTION-1 — the observed-settled marker travels ONLY with the stream's
    // OWN derived level. A user-asserted basis (`asserted`) is a statement about
    // a payroll figure and answers the basis question directly; it needs no
    // observation marker and must not borrow one.
    events.push(...periodicCashEvents(
      s.activity, s.cadence, amount, horizon.fromISO, horizon.toISO, s.role,
      asserted === undefined && s.settledDepository));
  }

  // ── Policy: horizon, the one licensed system default, and suppositions ────
  const assumptions: PolicyAssumption[] = [continueLicensedCadence()];
  let n = 0;
  for (const st of statements) {
    if (st.routing.destination !== 'FORECAST_POLICY') continue;
    assumptions.push({ ...st.routing.assumption, id: `p${n++}` });
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
  if (!hasLicensedAnswer && projectionEnabled()) {
    // ⚠️ THE USER'S OWN RATE WINS, AND THE ENGINE ALREADY RESOLVED IT. When the
    // conversation supplied a spending level, `forecast.spending` carries it as
    // ASSUMED with a daily rate and the assumption's id; the projection takes
    // that instead of the observed window, so an override CHANGES the answer
    // rather than removing it.
    const engineSpending = 'refused' in forecast ? null : forecast.spending;
    let spending: ProjectionSpending | null = null;
    if (engineSpending && engineSpending.dailyRate !== null) {
      spending = {
        kind: 'USER_ASSUMED',
        dailyRate: engineSpending.dailyRate,
        monthlyAmount: engineSpending.amount,
        statedAs: engineSpending.reason,
      };
    } else {
      const txn = ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY]?.data as
        TransactionsSummaryData | undefined;
      const rate = deriveObservedSpendingRate(
        reliableMonths(txn ?? null).map((m) => ({ month: m.month, expenseTotal: m.expenseTotal })));
      if (rate.assertable) { observedSpending = rate; spending = { kind: 'OBSERVED', rate }; }
    }
    projection = projectCash({
      openingCash: 'refused' in forecast ? null : forecast.openingCash.amount,
      events, spending,
      fromISO: horizon.fromISO, toISO: horizon.toISO,
      currency: state.liquidity.currency ?? 'USD',
    });
  }

  return {
    state, events, policy, forecast,
    statements, facts, appliedFacts,
    unavailable: acc ? null : 'account balances could not be assembled for this Space',
    projection, observedSpending,
  };
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
export { PeriodBasis, AssumptionDimension, AssumptionOrigin, AssumptionStance, EventProvenance, FlowRole, ActivityState, ConclusionStatus };
export type { CashForecast, ConclusionStatusKind };
