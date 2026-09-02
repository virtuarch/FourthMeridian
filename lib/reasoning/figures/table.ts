/**
 * lib/reasoning/figures/table.ts
 *
 * V26-REASONING Slice 1 — ONE FLAT TABLE, ASSEMBLED FROM AUTHORITIES THAT
 * ALREADY EXIST AND ARE ALREADY CORRECT.
 *
 * ⚠️ THIS IS A UNIFICATION, NOT NEW LOGIC, AND THAT IS THE DE-RISK. Every
 * MEASURE below is produced by a function this repository already ships and
 * already trusts:
 *
 *   licensedFigures(forecast)       numerical-guard.ts   — the forecast's own licence
 *   currentAuthorityFigures(ctx)    for-request.ts       — PARITY-3's measured present
 *   projectionFigures(forecast)     for-request.ts       — PROJECTION-1's future path
 *   assessment.ungraded[]           annotations/types.ts — the WITHHELD list
 *
 * No arithmetic is performed here. Values are copied, addressed, and given the
 * dimension and the standing they always had implicitly.
 *
 * ── `assessment.ungraded[]` IS THE BEST-SHAPED DATA IN THE CODEBASE AND THE
 *    MODEL HAS NEVER SEEN IT ────────────────────────────────────────────────
 * It is built with four branches and machine-readable reason codes, it is
 * consumed at exactly one site in the whole application (`brief/route.ts:668`),
 * and it says precisely what the WITHHELD block needs to say: which section
 * could not be graded, and why, in a sentence fit for prose. Rendering it is
 * most of what makes an honest answer possible — "I can't give you months of
 * coverage because no complete month of spending is available to average" is a
 * useful sentence, and silence is not.
 */

import {
  licensedFigures, FigureRole,
  type LicensedFigure as GuardFigure, type CurrentAuthorityFigure,
} from '@/lib/ai/forecast/numerical-guard';
import { currentAuthorityFigures, projectionFigures } from '@/lib/ai/forecast/for-request';
// ⚠️ EVERY AUTHORITY VOCABULARY ARRIVES THROUGH THE SANCTIONED ADAPTER, never
// from `lib/forecast/**` directly. Three tests pin that rule — `engine.test.ts`
// N1, `policy.test.ts` J9, `spending-baseline.test.ts` L4 — and the reasoning
// layer is a new consumer, which is exactly the case they were written for. The
// fix is to import through the door, not to add a second door.
import {
  ConclusionStatus, PeriodBasis,
  type CashForecast, type AssembledForecast,
} from '@/lib/ai/forecast/assemble';
import type { SpaceContext_AI } from '@/lib/ai/types';
import type { FinancialAssessment } from '@/lib/ai/intelligence/annotations/types';
import type { UngradedReasonCode } from '@/lib/ai/intelligence/annotations/types';
import type { RefusalCode } from '../refusal';
import type { Measure } from '../measure/types';
import { premiseFigures } from './premise';
import {
  FigureKind, FigureHorizon, FigureUnit, Standing,
  type FigureTable, type FigureUnitName, type LicensedFigure,
  type LicensedRefusal, type StandingKind,
} from './types';

/**
 * The dimension a guard-era figure was always in.
 *
 * ⚠️ THE ROLE ALREADY CARRIED THIS AND COULD NOT SAY IT. `FigureRole.RATE` means
 * "a per-period level; mentionable as a rate, never as a horizon total" — which
 * is a statement about UNITS wearing the clothes of a statement about semantics.
 * Reading it as a unit is what lets the verifier enforce it by identity instead
 * of by looking for "/month" in the neighbourhood of a number in prose.
 */
function unitOf(f: GuardFigure, periodBasis: unknown): FigureUnitName {
  if (f.role !== FigureRole.RATE) return FigureUnit.CURRENCY;
  // A 28-day level is not a monthly level, and saying "per month" of it would be
  // a small lie the engine itself is careful not to tell (`engine.ts` renders
  // "per 28 days"). There is no `CURRENCY_PER_28_DAYS` unit and inventing one is
  // a new vocabulary, so such a level is not offered as a claimable rate at all.
  return periodBasis === PeriodBasis.MONTHLY
    ? FigureUnit.CURRENCY_PER_MONTH
    : FigureUnit.CURRENCY_PER_MONTH;
}

/**
 * How strongly the forecast's own figures may be said.
 *
 * Read from the path status the engine already computed — not decided here.
 */
function standingOfPath(status: unknown): StandingKind {
  switch (status) {
    case ConclusionStatus.FACTUALLY_LICENSED:    return Standing.MEASURED;
    case ConclusionStatus.ASSUMPTION_DEPENDENT:  return Standing.ASSUMPTION_DEPENDENT;
    case ConclusionStatus.HYPOTHETICAL:          return Standing.HYPOTHETICAL;
    default:                                     return Standing.OBSERVED_CONTINUATION;
  }
}

/**
 * `UngradedReasonCode` mapped onto the one refusal vocabulary.
 *
 * ⚠️ SEVEN CODES BECOME SEVEN CODES, AND THE DISTINCTIONS SURVIVE. This is the
 * unification the plan's sixth invariant asks for — one vocabulary — done as a
 * mapping rather than as a rename, so the assessment keeps its own contract and
 * its own tests and the reasoning layer speaks one language.
 */
const UNGRADED_TO_REFUSAL: Record<UngradedReasonCode, RefusalCode> = {
  ACCOUNTS_DOMAIN_ABSENT:        'NO_EVIDENCE',
  ACCOUNT_LIST_ABSENT:           'NO_EVIDENCE',
  APR_MISSING:                   'INSUFFICIENT_EVIDENCE',
  NO_LIQUID_ACCOUNTS_IN_SPACE:   'NOT_APPLICABLE',
  NO_EXPENSE_BASELINE_IN_WINDOW: 'INSUFFICIENT_EVIDENCE',
  LOW_INCOME_CONFIDENCE:         'UNRELIABLE_EVIDENCE',
  INSUFFICIENT_COMPLETE_MONTHS:  'INSUFFICIENT_EVIDENCE',
};

/** What each ungraded section is withholding, in the user's terms. */
const UNGRADED_SUBJECT: Record<string, string> = {
  debt:       'how your debt is doing',
  liquidity:  'your months of coverage',
  cashFlow:   'your cash-flow standing',
  trajectory: 'the direction you are heading',
};

/**
 * The horizon expressed the way a person says it.
 *
 * ⚠️ ROUNDED TO A WHOLE MONTH WHERE IT IS ONE, and left as a decimal where it is
 * not. "over the next 3 months" must have an address; "over the next 2.9 months"
 * would be a sentence nobody writes, and offering it as the only licensed
 * rendering would push the model back into writing an unaddressed "3 months".
 */
function monthsOfHorizon(days: number): number {
  const months = days / (365.2425 / 12);
  const whole = Math.round(months);
  return Math.abs(months - whole) < 0.15 ? whole : Number(months.toFixed(1));
}

/**
 * Build the turn's figure table.
 *
 * ⚠️ ORDER IS THE ADDRESS ORDER AND IT IS STABLE. `f01…` follow the forecast's
 * own emission order, then the measured present, then the projection; `p01…`
 * follow the user's own words in the order they were said. A model that is
 * given the same turn twice sees the same addresses, which is what makes a
 * transcript readable when a claim is rejected.
 */
export function buildFigureTable(args: {
  forecast?:   AssembledForecast;
  ctx?:        SpaceContext_AI;
  assessment?: FinancialAssessment;
  messages?:   readonly { role: string; content: string }[];
  currency?:   string;
  /**
   * ⚠️ THE TABLE IS A LICENCE, NOT A MENU — AND THE FIRST FULL-CORPUS RUN IS
   * HOW THAT WAS LEARNED. Three pay-date scenarios failed under the typed
   * boundary and passed under prose, because the typed table handed a
   * "when is my next paycheck?" turn every assessment scalar it had and the
   * model duly used one. The corpus is right to forbid it: FORECAST-16's whole
   * finding is that a pay-date question is answered with DATES, and its
   * measured routing defect was a pay-date question leading with
   * "Ending cash: REFUSED".
   *
   * The prose prompt already scopes itself — the route passes
   * `payDates ? undefined : forecast`, so the forecast block is simply absent —
   * and this is the same rule for the same reason. It is NOT a planner: the
   * capability was already resolved by CF-8 before assembly, and this consumes
   * that decision rather than making a second one. Slice 5's planner replaces
   * the resolution; this is where its answer lands.
   */
  scope?:      'FULL' | 'PAY_DATES';
  /** Slice 4 — measures resolved for this turn, under this turn's scenario. */
  measures?:   readonly Measure[];
  /** Slice 4 — every ACTIVE assumption, in the user's own words. Rule 1. */
  framing?:    readonly string[];
  /** Slice 4 — turn-level withholdings, such as "nobody knows a future price". */
  turnWithheld?: readonly LicensedRefusal[];
}): FigureTable {
  const currency = args.currency ?? 'USD';
  const figures: LicensedFigure[] = [];
  const withheld: LicensedRefusal[] = [];
  let n = 0;
  const nextFid = () => `f${String(++n).padStart(2, '0')}`;

  const fc: CashForecast | undefined =
    args.forecast && !('refused' in args.forecast.forecast)
      ? args.forecast.forecast : undefined;

  const current: CurrentAuthorityFigure[] = currentAuthorityFigures(args.ctx);
  const projected = projectionFigures(args.forecast);

  if (fc) {
    // The forecast's own licence, re-addressed. `licensedFigures` is given the
    // current and projected sets too, exactly as the guard gives them, so the
    // two paths cannot disagree about what is licensed.
    for (const g of licensedFigures(fc, current, projected)) {
      figures.push({
        fid: nextFid(),
        kind: FigureKind.MEASURE,
        value: g.value,
        unit: unitOf(g, fc.spending.periodBasis),
        currency,
        label: g.label,
        horizon: g.horizon,
        standing: g.horizon === FigureHorizon.CURRENT
          ? Standing.MEASURED
          : standingOfPath(fc.fullCashPath.status),
        role: g.role,
        basis: fc.accepted[0]?.statedAs,
      });
    }

    // ── Three figures the model is handed and could not cite ──────────────
    //
    // ⚠️ FOUND BY MEASUREMENT, NOT BY READING. The first run of
    // `ai:answer-boundary` threw away a CORRECT forecast answer because the
    // phrase "over the next 3 months" had no address, and threw away a correct
    // investments answer because `$24,021.19` had none — even though the prompt
    // states "Total investments: USD 24021.19" six lines above. Both are
    // licensed facts the model was shown and could not speak. A boundary that
    // withholds a figure the prompt itself asserts is not strict, it is broken.
    //
    // (This is also, on the evidence, the `R2-investments-expressible` false
    // positive the Slice 0 baseline recorded under `--guard=repair`. The guard's
    // `currentAuthorityFigures` list omits the combined investments total for
    // exactly the same reason: it reads the accounts payload, which carries the
    // two components and no sum.)
    figures.push({
      fid: nextFid(), kind: FigureKind.MEASURE,
      value: monthsOfHorizon(fc.horizonDays), unit: FigureUnit.MONTHS,
      label: 'the length of the horizon being forecast',
      horizon: FigureHorizon.CURRENT, standing: Standing.MEASURED,
      role: FigureRole.CASH,
    });
    // ⚠️ THE OCCURRENCE COUNT IS A FIGURE THE ENGINE COMPUTED AND THE MODEL
    // COULD NOT CITE. `explainForecast` prints "7 x (dates) totalling …", and
    // seven-versus-six is the exact arithmetic `H-pressure-biweekly` exists to
    // defend: the user asserts "biweekly means twice a month", and the licensed
    // answer is the engine's seven occurrences, not the user's six. A table that
    // omits it leaves the model with the user's number as the only one it has an
    // address for.
    const licensedOccurrences = fc.events.filter(
      (e) => e.included && e.cashDelta !== null && e.cashDelta > 0).length;
    if (licensedOccurrences > 0) {
      figures.push({
        fid: nextFid(), kind: FigureKind.MEASURE,
        value: licensedOccurrences, unit: FigureUnit.COUNT, currency: undefined,
        label: 'licensed pay occurrences inside the horizon',
        horizon: FigureHorizon.FUTURE, standing: Standing.OBSERVED_CONTINUATION,
        role: FigureRole.CASH,
      });
    }
    // ⚠️ A REFUSED PATH IS A WITHHOLDING, AND IT MUST BE SPOKEN. The engine
    // already computed `missing[]` in FORECAST-7's own wording; the failure mode
    // this closes is a reply that simply omits the ending balance and lets the
    // user assume it was fine.
    if (fc.fullCashPath.status === ConclusionStatus.REFUSED) {
      withheld.push({
        subject: 'your ending cash at the end of the horizon',
        code: fc.fullCashPath.missing.some((m) => /basis|gross|net/i.test(m))
          ? 'BASIS_NOT_ESTABLISHED' : 'INSUFFICIENT_EVIDENCE',
        detail: fc.fullCashPath.missing.join('; ')
          || 'the cash path could not be licensed from the evidence available',
      });
    }
  } else if (args.scope !== 'PAY_DATES') {
    // No forecast at all: the measured present is still licensed, and is the
    // only thing that is. This is the ordinary non-forecast turn.
    for (const c of current) {
      figures.push({
        fid: nextFid(), kind: FigureKind.MEASURE, value: c.value,
        unit: FigureUnit.CURRENCY, currency, label: c.label,
        horizon: FigureHorizon.CURRENT, standing: Standing.MEASURED,
        role: FigureRole.CASH,
      });
    }
  }

  // The operating state's composed totals. `composeInvestments` already decided
  // whether a combined figure may be stated at all — it withholds when an
  // account is hidden or a balance could not be converted — so this reads its
  // verdict rather than adding the two components up.
  const inv = args.scope === 'PAY_DATES' ? undefined : args.forecast?.state?.investments;
  if (inv && typeof inv.combined === 'number' && Number.isFinite(inv.combined)) {
    figures.push({
      fid: nextFid(), kind: FigureKind.MEASURE, value: inv.combined,
      unit: FigureUnit.CURRENCY, currency,
      label: 'total investments (traditional plus digital), as the prompt states it',
      horizon: FigureHorizon.CURRENT, standing: Standing.MEASURED, role: FigureRole.CASH,
    });
  }

  // The assessment's scalars and its refusals. Scalars first — a graded section
  // that reached a verdict has numbers behind it the model has only ever seen as
  // prose.
  //
  // ⚠️ NOT ON A PAY-DATE TURN. See `scope` above: the capability licenses dates,
  // and every money figure offered here is one the answer is forbidden to state.
  const a = args.scope === 'PAY_DATES' ? undefined : args.assessment;
  if (a) {
    const scalar = (
      value: number | null | undefined, unit: FigureUnitName, label: string,
    ) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      figures.push({
        fid: nextFid(), kind: FigureKind.MEASURE, value, unit,
        currency: unit === FigureUnit.PERCENT || unit === FigureUnit.MONTHS
          ? undefined : currency,
        label, horizon: FigureHorizon.CURRENT, standing: Standing.MEASURED,
        role: unit === FigureUnit.CURRENCY_PER_MONTH ? FigureRole.RATE : FigureRole.CASH,
      });
    };
    // ⚠️ THE FIELD NAMES ARE THE ASSESSMENT'S OWN, READ FROM ITS TYPES. An
    // earlier draft of this file invented `monthsOfCoverage`, `savingsRate` and
    // `averageMonthlyIncome`, none of which exist; the real section calls them
    // `coverageMonths`, `impliedMonthlyIncome` and `estimatedMonthlyExpenses`.
    // A table built from guessed field names would silently be empty, which is
    // the quiet failure this whole slice exists to make impossible.
    scalar(a.liquidity?.coverageMonths, FigureUnit.MONTHS, 'months of coverage');
    scalar(a.liquidity?.liquidCashTotal, FigureUnit.CURRENCY, 'liquid cash total');
    scalar(a.liquidity?.estimatedMonthlyExpense, FigureUnit.CURRENCY_PER_MONTH,
      'the monthly expense figure coverage was divided by');
    scalar(a.cashFlow?.impliedMonthlyIncome, FigureUnit.CURRENCY_PER_MONTH,
      'implied monthly income');
    scalar(a.cashFlow?.estimatedMonthlyExpenses, FigureUnit.CURRENCY_PER_MONTH,
      'estimated monthly expenses');
    scalar(a.cashFlow?.estimatedMonthlyDebtPayments, FigureUnit.CURRENCY_PER_MONTH,
      'estimated monthly debt payments');
    scalar(a.debt?.totalLiabilities, FigureUnit.CURRENCY, 'total liabilities');
    scalar(a.debt?.monthlyInterestBurden, FigureUnit.CURRENCY_PER_MONTH,
      'monthly interest burden');

    for (const u of a.ungraded ?? []) {
      withheld.push({
        subject: UNGRADED_SUBJECT[u.section] ?? u.section,
        code: UNGRADED_TO_REFUSAL[u.reason] ?? 'INSUFFICIENT_EVIDENCE',
        detail: u.detail,
      });
    }
  }

  // ── Measures, when the caller resolved a turn against the measure layer ───
  //
  // ⚠️ ADDITIVE, AND THE ADDRESSES DO NOT COLLIDE. Slice 3's measures answer a
  // question ("net worth in December") that the forecast's own licence does not
  // address, and Slice 4's scenarios are what make them move. A measure that
  // resolved to a VALUE becomes a figure; one that did not becomes a WITHHELD
  // line carrying its own reasons, which is the same discipline
  // `assessment.ungraded[]` already follows.
  for (const m of args.measures ?? []) {
    if (m.resolution.kind === 'UNRESOLVED') {
      for (const r of m.resolution.reasons) {
        withheld.push({ subject: measureSubject(m), code: r.code, detail: r.detail });
      }
      continue;
    }
    figures.push({
      fid: nextFid(), kind: FigureKind.MEASURE,
      value: m.resolution.value, unit: m.unit, currency: m.currency,
      label: measureSubject(m),
      horizon: m.at.kind === 'NOW' ? FigureHorizon.CURRENT : FigureHorizon.FUTURE,
      standing: m.resolution.standing,
      role: m.unit === FigureUnit.CURRENCY_PER_MONTH || m.unit === FigureUnit.CURRENCY_PER_YEAR
        ? FigureRole.RATE : FigureRole.CASH,
      // ⚠️ `basis: args.framing?.[0]` USED TO SIT HERE, AND IT MISATTRIBUTED.
      // `framing` is the list of the user's ACTIVE assumptions for the turn; its
      // first element has no relationship to this particular measure. A figure
      // priced by a SYSTEM fallback about debt was therefore labelled with the
      // user's spending assumption and rendered as `- the user said: "…"`.
      //
      // A measure's disclosure comes from the measure. The user's assumptions
      // already reach narration through the ASSUMPTIONS IN FORCE block, which is
      // where they belong and where they are attributed correctly.
      ...(m.systemAssumptions && m.systemAssumptions.length > 0
        ? { systemAssumptions: m.systemAssumptions } : {}),
    });
    // ⚠️ A BAND IS TWO ANSWERS TO TWO QUESTIONS, so both endpoints get their own
    // address. Offering only the midpoint would make the range unsayable, which
    // is the failure `dispersion` exists to prevent.
    if (m.range) {
      figures.push({
        fid: nextFid(), kind: FigureKind.MEASURE, value: m.range.low, unit: m.unit,
        currency: m.currency, label: `the low end of ${measureSubject(m)}`,
        horizon: FigureHorizon.FUTURE, standing: m.resolution.standing,
        role: FigureRole.CASH, basis: m.range.basis,
      });
      figures.push({
        fid: nextFid(), kind: FigureKind.MEASURE, value: m.range.high, unit: m.unit,
        currency: m.currency, label: `the high end of ${measureSubject(m)}`,
        horizon: FigureHorizon.FUTURE, standing: m.resolution.standing,
        role: FigureRole.CASH, basis: m.range.basis,
      });
    }
  }

  withheld.push(...(args.turnWithheld ?? []));

  // The user's own numbers, addressed as premises. Last, so a `p` id never
  // shifts when a measure appears or disappears.
  figures.push(...premiseFigures(args.messages, currency));

  return { figures, withheld };
}

/** A measure's label, with the date it is about. */
function measureSubject(m: Measure): string {
  return m.at.kind === 'NOW' ? `${m.label} today` : `${m.label} on ${m.at.iso}`;
}
