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
  AmountBasis, EventProvenance, FlowRole, type FutureCashEvent,
} from '@/lib/forecast/future-cash-event';
import { isCadence, type CadenceKindName } from '@/lib/forecast/cadence';
import { ActivityState } from '@/lib/forecast/stream-activity';
import { periodicCashEvents } from '@/lib/forecast/periodic-amount';
import { assertedAmountBasis } from '@/lib/forecast/periodic-amount';
import { assertedSpendingBaseline, PeriodBasis } from '@/lib/forecast/spending-baseline';
import {
  composeOperatingState, conclusionLicence, Conclusion,
  type ConclusionKind, type CurrentOperatingState, type IncomeStreamInput,
} from '@/lib/forecast/operating-state';
import {
  AssumptionDimension, AssumptionOrigin, AssumptionStance, continueLicensedCadence,
  type ForecastHorizon, type ForecastPolicy, type PolicyAssumption,
} from '@/lib/forecast/policy';
import { forecastCash, type CashForecast } from '@/lib/forecast/engine';
import type { ResolvedIncomeStream } from './streams';
import { extractForecastStatements, type ExtractedStatement } from './statements';

/** What a forecast needs that is not already a FORECAST-* authority's job. */
export interface ForecastAssemblyInput {
  ctx: SpaceContext_AI;
  /** Already resolved by FORECAST-1/2/5 in `./streams.ts`. */
  streams: readonly ResolvedIncomeStream[];
  horizon: ForecastHorizon;
  asOfISO: string;
  /** This turn's message, for fact/supposition extraction. */
  question: string;
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
  /** Facts applied to the STATE, kept separate from suppositions. */
  appliedFacts: string[];
  /** Why a forecast could not be assembled at all, when it could not. */
  unavailable: string | null;
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

  const statements = extractForecastStatements(question, asOfISO, primaryKey);

  // ── Facts, applied to the authorities that own them ──────────────────────
  const appliedFacts: string[] = [];
  let assertedBaseline: ReturnType<typeof assertedSpendingBaseline> | null = null;
  const assertedBasis = new Map<string, ReturnType<typeof assertedAmountBasis>>();

  for (const st of statements) {
    if (st.routing.destination !== 'UPSTREAM_AUTHORITY' || !st.routing.reachable) continue;
    const sub = st.routing.subject;
    if (sub.kind === 'SPENDING_LEVEL') {
      assertedBaseline = assertedSpendingBaseline(sub.amount, sub.currency, sub.periodBasis, asOfISO);
      appliedFacts.push(`spending baseline ${sub.amount} ${sub.currency}: "${st.statedAs}"`);
    } else if (sub.kind === 'STREAM_AMOUNT_BASIS' && sub.basis !== AmountBasis.UNKNOWN) {
      const stream = streams.find((s) => s.sourceKey === sub.sourceKey);
      if (stream?.amount?.assertable) {
        assertedBasis.set(sub.sourceKey,
          assertedAmountBasis(stream.amount, sub.basis as 'NET' | 'GROSS', asOfISO));
        appliedFacts.push(`${sub.sourceKey} basis ${sub.basis}: "${st.statedAs}"`);
      }
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
    obligations: { licensedEvents: [], activeButUndatedCount: 0, evaluated: true },
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
  const events: FutureCashEvent[] = [...(input.additionalEvents ?? [])];
  for (const s of streams) {
    if (!isCadence(s.cadence)) continue;
    const asserted = assertedBasis.get(s.sourceKey);
    const amount = asserted ?? s.amount;
    if (!amount) continue;
    events.push(...periodicCashEvents(
      s.activity, s.cadence, amount, horizon.fromISO, horizon.toISO, s.role));
  }

  // ── Policy: horizon, the one licensed system default, and suppositions ────
  const assumptions: PolicyAssumption[] = [continueLicensedCadence()];
  let n = 0;
  for (const st of statements) {
    if (st.routing.destination !== 'FORECAST_POLICY') continue;
    assumptions.push({ ...st.routing.assumption, id: `p${n++}` });
  }

  const policy: ForecastPolicy = { horizon, assumptions };
  return {
    state, events, policy,
    forecast: forecastCash(state, events, policy),
    statements, appliedFacts,
    unavailable: acc ? null : 'account balances could not be assembled for this Space',
  };
}

// ── Question-specific capability (§17) ──────────────────────────────────────

/**
 * Which conclusion the question actually asks for.
 *
 * ⚠️ THE CAPABILITY MATRIX, NOT A SECOND ROUTER. FORECAST-7 already decided
 * that "when is my next payday" and "what is my cash in three months" have
 * different evidence costs, and the second is licensed while the first is not.
 * Routing every forecast-shaped question through the full engine would make a
 * question that IS answerable today report a refusal.
 */
export const ForecastAsk = {
  ENDING_CASH: Conclusion.FORECAST_ENDING_CASH,
  RUNWAY: Conclusion.CASH_RUNWAY,
  NEXT_PAY_DATES: Conclusion.NEXT_PAY_DATES,
  NOMINAL_INCOME: Conclusion.NOMINAL_MONTHLY_INCOME,
} as const;

const NEXT_PAY_RE = /\b(next (?:pay ?check|pay ?day|payment|deposit)|when (?:do|will) i (?:get|be) paid|when is my next)\b/i;
const RUNWAY_RE = /\b(runway|how long (?:will|can) my (?:cash|money|savings)|how long (?:do|will) i have|months of (?:cash|runway|expenses))\b/i;
const NOMINAL_INCOME_RE = /\b(monthly income|how much (?:do|will) i (?:earn|make) (?:a|per|each) month)\b/i;

/** The conclusion a forecast question is asking for. */
export function forecastAsk(question: string): ConclusionKind {
  if (NEXT_PAY_RE.test(question)) return ForecastAsk.NEXT_PAY_DATES;
  if (RUNWAY_RE.test(question)) return ForecastAsk.RUNWAY;
  if (NOMINAL_INCOME_RE.test(question)) return ForecastAsk.NOMINAL_INCOME;
  return ForecastAsk.ENDING_CASH;
}

/** Whether the state alone already licenses what was asked. Delegated, not re-derived. */
export function asksSomethingAlreadyLicensed(
  state: CurrentOperatingState, question: string,
): boolean {
  return conclusionLicence(state, forecastAsk(question)).licensed;
}

export { PeriodBasis, AssumptionDimension, AssumptionOrigin, AssumptionStance, EventProvenance, FlowRole, ActivityState };
