/**
 * lib/reasoning/measure/evaluate.ts
 *
 * V26-REASONING Slice 3 — THE ADAPTERS, AND THE ONE COMPOSITION.
 *
 * ⚠️ NO NEW ARITHMETIC. This is the de-risk and it is not negotiable. Every
 * value below comes out of an authority this repository already ships:
 *
 *   liquid_cash@NOW          the accounts payload's own `totalLiquid`
 *   debt_balance@NOW         its `totalLiabilities`
 *   investments_value@NOW    `composeInvestments`, via the operating state
 *   monthly_spending         `computeAverageMonthlySpending`
 *   runway_months            the assessment's liquidity section
 *   liquid_cash@DATE         `forecastCash` / `projectCash`
 *   concentration_top_weight `computeConcentration`
 *
 * The substrate is a RE-SHAPING of truth already trusted, not a rewrite of it,
 * and `parity.test.ts` asserts exactly that against the real production fixture.
 */

import { FinanceDomains, type AccountsSectionData, type SpaceContext_AI } from '@/lib/ai/types';
import type { FinancialAssessment } from '@/lib/ai/intelligence/annotations/types';
import { ConclusionStatus, type AssembledForecast } from '@/lib/ai/forecast/assemble';
import {
  MeasureId, MEASURE_LABEL, MEASURE_UNIT, BASE_SCENARIO_ID, Standing, FigureUnit,
  resolved, unresolved, weakestStanding, instantKey, FLAT,
  type Instant, type Measure, type MeasureIdName, type Resolution,
  type ReturnBasis, type StandingKind, type Refusal,
} from './types';

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface MeasureContext {
  ctx?:        SpaceContext_AI;
  assessment?: FinancialAssessment;
  /** Present only when the turn built one. Its absence is not a refusal. */
  forecast?:   AssembledForecast;
  currency?:   string;
  /**
   * ⚠️ THE LEG THE QUESTION IS ABOUT. Named by the caller (Slice 5's planner);
   * absent means "no leg is the subject", which is the safe reading because the
   * only thing it gates is the persistence fallback, and gating it OFF is the
   * conservative direction.
   */
  subject?:    MeasureIdName;
  /** How investments are carried forward. Default FLAT. */
  returnBasis?: ReturnBasis;
}

const accountsOf = (c: MeasureContext): AccountsSectionData | undefined =>
  c.ctx?.domains?.[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData | undefined;

const NO_ACCOUNTS: Refusal = {
  code: 'NO_EVIDENCE',
  detail: 'no account data was assembled for this Space, so there is nothing to read a balance from',
};

const mk = (
  id: MeasureIdName, when: Instant, resolution: Resolution,
  c: MeasureContext, extra: Partial<Measure> = {},
): Measure => ({
  id, at: when, scenarioId: BASE_SCENARIO_ID, resolution,
  unit: MEASURE_UNIT[id], label: MEASURE_LABEL[id],
  currency: MEASURE_UNIT[id] === FigureUnit.PERCENT || MEASURE_UNIT[id] === FigureUnit.MONTHS
    ? undefined : (c.currency ?? 'USD'),
  dependsOn: [], ...extra,
});

/**
 * A number the accounts payload states, or a refusal that names why not.
 *
 * ⚠️ `undefined` AND `0` ARE DIFFERENT ANSWERS, and conflating them is the
 * single most-repeated defect in this repository's own record: W6's
 * `nativeBalance ?? 0`, W-M3a's NOT-NULL-DEFAULT-0 balance column, W6's
 * "unknown is not zero". A payload that carries no field for a class has not
 * told us the class is empty.
 */
function fromAccounts(
  a: AccountsSectionData | undefined, field: keyof AccountsSectionData, what: string,
): Resolution {
  if (!a) return unresolved(NO_ACCOUNTS);
  const v = a[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return unresolved({
      code: 'NO_EVIDENCE',
      detail: `the accounts payload states no ${what} for this Space`,
    });
  }
  return resolved(v, Standing.MEASURED);
}

// ── The present ─────────────────────────────────────────────────────────────

function evaluateNow(id: MeasureIdName, c: MeasureContext): Measure {
  const a = accountsOf(c);
  const now: Instant = { kind: 'NOW' };

  switch (id) {
    case MeasureId.LIQUID_CASH:
      return mk(id, now, fromAccounts(a, 'totalLiquid', 'liquid cash total'), c);
    case MeasureId.DEBT_BALANCE:
      return mk(id, now, fromAccounts(a, 'totalLiabilities', 'liabilities total'), c);
    case MeasureId.INVESTMENTS_VALUE:
      return mk(id, now, fromAccounts(a, 'totalInvestments', 'traditional investments total'), c);
    case MeasureId.DIGITAL_ASSETS_VALUE:
      return mk(id, now, fromAccounts(a, 'totalDigitalAssets', 'digital assets total'), c);
    case MeasureId.REAL_ASSETS_VALUE:
      return mk(id, now, fromAccounts(a, 'totalRealAssets', 'real assets total'), c);

    case MeasureId.NET_WORTH:
      // ⚠️ THE PAYLOAD'S OWN `netWorth`, NOT A SUM OF THE FOUR ABOVE. The
      // accounts authority already decided what participates and how currency
      // was converted; adding the components here would be a second opinion
      // about a number it already publishes. The COMPOSITION path below exists
      // for the FUTURE, where no such authority answers.
      return mk(id, now, fromAccounts(a, 'netWorth', 'net worth'), c);

    case MeasureId.MONTHLY_SPENDING: {
      const v = c.assessment?.cashFlow?.estimatedMonthlyExpenses;
      return mk(id, now, typeof v === 'number' && Number.isFinite(v)
        ? resolved(v, Standing.OBSERVED_CONTINUATION)
        : unresolved(refusalFromUngraded(c, 'cashFlow', 'a monthly spending level')), c,
      { dispersion: spendingDispersion(c) });
    }
    case MeasureId.MONTHLY_INCOME: {
      const v = c.assessment?.cashFlow?.impliedMonthlyIncome;
      return mk(id, now, typeof v === 'number' && Number.isFinite(v)
        ? resolved(v, Standing.OBSERVED_CONTINUATION)
        : unresolved(refusalFromUngraded(c, 'cashFlow', 'a monthly income level')), c);
    }
    case MeasureId.MONTHLY_NET: {
      const inc = c.assessment?.cashFlow?.impliedMonthlyIncome;
      const exp = c.assessment?.cashFlow?.estimatedMonthlyExpenses;
      // ⚠️ BOTH LEGS OR NEITHER. A "net" computed from a known income and an
      // unknown spend is the income wearing a different name.
      return mk(id, now,
        typeof inc === 'number' && typeof exp === 'number'
          && Number.isFinite(inc) && Number.isFinite(exp)
          ? resolved(inc - exp, Standing.OBSERVED_CONTINUATION)
          : unresolved(refusalFromUngraded(c, 'cashFlow', 'a monthly net')),
        c, { dependsOn: [MeasureId.MONTHLY_INCOME, MeasureId.MONTHLY_SPENDING] });
    }
    case MeasureId.RUNWAY_MONTHS: {
      const v = c.assessment?.liquidity?.coverageMonths;
      return mk(id, now, typeof v === 'number' && Number.isFinite(v)
        ? resolved(v, Standing.OBSERVED_CONTINUATION)
        : unresolved(refusalFromUngraded(c, 'liquidity', 'months of coverage')), c);
    }
    case MeasureId.SAVINGS_RATE: {
      const inc = c.assessment?.cashFlow?.impliedMonthlyIncome;
      const exp = c.assessment?.cashFlow?.estimatedMonthlyExpenses;
      return mk(id, now,
        typeof inc === 'number' && typeof exp === 'number' && inc > 0 && Number.isFinite(exp)
          ? resolved(((inc - exp) / inc) * 100, Standing.OBSERVED_CONTINUATION)
          : unresolved(refusalFromUngraded(c, 'cashFlow', 'a savings rate')),
        c, { dependsOn: [MeasureId.MONTHLY_INCOME, MeasureId.MONTHLY_SPENDING] });
    }
    case MeasureId.CONCENTRATION_TOP_WEIGHT: {
      // ⚠️ `computeConcentration`'S VERDICT, READ — NOT RE-RUN. The holdings
      // assembler already calls it and publishes the result; calling it again
      // here from a different position list is how two surfaces come to
      // disagree about the same portfolio.
      const h = c.ctx?.domains?.[FinanceDomains.HOLDINGS_SUMMARY]?.data as
        { concentration?: { topWeight: number | null; classification: string };
          positionsPartiallyHidden?: boolean } | undefined;
      const w = h?.concentration?.topWeight;
      if (typeof w !== 'number' || !Number.isFinite(w)) {
        return mk(id, now, unresolved({
          code: h ? 'INSUFFICIENT_EVIDENCE' : 'NO_EVIDENCE',
          detail: h
            ? 'the holdings payload reports no largest-holding share for this Space'
            : 'no holdings data was assembled for this Space',
        }), c);
      }
      // ⚠️ HIDDEN POSITIONS MAKE THE SHARE UNRELIABLE, NOT MERELY APPROXIMATE.
      // A weight computed over a partial population is a share of the wrong
      // denominator, and the payload says so itself.
      if (h?.positionsPartiallyHidden === true) {
        return mk(id, now, unresolved({
          code: 'BLOCKED_BY_PERMISSION',
          detail: 'some positions in this Space are not visible here, so a '
            + 'largest-holding share would be a share of an incomplete portfolio',
        }), c);
      }
      return mk(id, now, resolved(w, Standing.MEASURED), c);
    }
  }
}

/**
 * The assessment's own refusal for a section, translated — or a generic one.
 *
 * ⚠️ ITS WORDS, NOT OURS. `ungraded[]` carries a `detail` written to be read by
 * a person and a machine-readable code beside it. Re-phrasing it here would put
 * a second explanation of the same gap into the product.
 */
function refusalFromUngraded(
  c: MeasureContext, section: string, what: string,
): Refusal {
  const u = c.assessment?.ungraded?.find((x) => x.section === section);
  if (u) {
    return {
      code: u.reason === 'LOW_INCOME_CONFIDENCE' ? 'UNRELIABLE_EVIDENCE'
        : u.reason === 'NO_LIQUID_ACCOUNTS_IN_SPACE' ? 'NOT_APPLICABLE'
          : u.reason === 'ACCOUNTS_DOMAIN_ABSENT' || u.reason === 'ACCOUNT_LIST_ABSENT'
            ? 'NO_EVIDENCE' : 'INSUFFICIENT_EVIDENCE',
      detail: u.detail,
    };
  }
  return { code: 'INSUFFICIENT_EVIDENCE', detail: `${what} could not be established from the evidence available` };
}

/**
 * How much this user's spending actually moves, month to month.
 *
 * ⚠️ A PRODUCT FEATURE, NOT A DIAGNOSTIC, AND IT IS THE GUARD AGAINST THE
 * FAILURE MODE ON THE OTHER SIDE OF THIS PROGRAMME. Everything else here works
 * to stop the assistant refusing useful answers; nothing else stops "stop
 * refusing" degrading into "always produce a point estimate."
 *
 * `spending-baseline.ts` records what the fixture Space actually looks like:
 * months from $2,290.03 to $14,060.81, a 6.1x spread, NO CURRENT REGIME. A mean
 * over that is arithmetically correct and reads as a settled level. Carrying the
 * spread lets narration say "your spending swings a lot month to month, so I'd
 * give you a range rather than a number" — which is neither a point estimate nor
 * a refusal.
 *
 * Read from the forecast's own `observedSpending`, which is where FORECAST-6's
 * window and its dispersion already live. Nothing is computed here but the
 * coefficient of variation, and that only because `ObservedSpendingRate`
 * publishes a max/min RATIO rather than a CV and the two say different things.
 */
function spendingDispersion(c: MeasureContext) {
  const o = c.forecast?.observedSpending;
  if (!o || !o.assertable || o.values.length < 2) return undefined;
  const n = o.values.length;
  const mean = o.values.reduce((t, v) => t + v, 0) / n;
  if (!(mean > 0)) return undefined;
  const variance = o.values.reduce((t, v) => t + (v - mean) ** 2, 0) / n;
  return {
    cv: Math.sqrt(variance) / mean,
    min: Math.min(...o.values),
    max: Math.max(...o.values),
    sampleN: n,
  };
}

// ── The future ──────────────────────────────────────────────────────────────

/**
 * `liquid_cash` at a date, from whichever cash path the forecast licensed.
 *
 * ⚠️ THE LICENSED PATH FIRST, AND A WEAKER ONE NEVER OVERLAYS IT. That is
 * PROJECTION-3's rule verbatim: "a licensed answer is never overlaid by a weaker
 * one", and its inverse — an answer never silently replaces a refusal it did not
 * resolve. So `fullCashPath` is read when it is not REFUSED, and PROJECTION-1's
 * evidence-based path is read only when it is.
 */
function cashAtDate(c: MeasureContext, when: Instant): Measure {
  const id = MeasureId.LIQUID_CASH;
  const f = c.forecast;
  if (!f || 'refused' in f.forecast) {
    return mk(id, when, unresolved({
      code: 'NO_LICENCE_AT_HORIZON',
      detail: f && 'refused' in f.forecast
        ? f.forecast.reason
        : 'no forecast was assembled for this turn, so no cash figure is licensed for a future date',
    }), c);
  }
  const fc = f.forecast;
  if (fc.fullCashPath.status !== ConclusionStatus.REFUSED
      && typeof fc.fullCashPath.closing === 'number') {
    return mk(id, when, resolved(fc.fullCashPath.closing,
      standingOfStatus(fc.fullCashPath.status)), c,
    { dependsOn: [...fc.fullCashPath.dependencies] });
  }
  const p = f.projection;
  if (p && typeof p.closing === 'number') {
    return mk(id, when, resolved(p.closing, Standing.OBSERVED_CONTINUATION), c, {
      dependsOn: [...p.assumptions],
      range: p.range
        ? { low: p.range.low, high: p.range.high,
          basis: 'the spread across the months this rate was averaged from' }
        : undefined,
    });
  }
  return mk(id, when, unresolved({
    code: 'INSUFFICIENT_EVIDENCE',
    detail: fc.fullCashPath.missing.join('; ')
      || 'the cash path could not be licensed from the evidence available',
  }), c);
}

function standingOfStatus(s: unknown): StandingKind {
  switch (s) {
    case ConclusionStatus.FACTUALLY_LICENSED:   return Standing.MEASURED;
    case ConclusionStatus.ASSUMPTION_DEPENDENT: return Standing.ASSUMPTION_DEPENDENT;
    case ConclusionStatus.HYPOTHETICAL:         return Standing.HYPOTHETICAL;
    default:                                    return Standing.OBSERVED_CONTINUATION;
  }
}

/**
 * An investment class carried to a date.
 *
 * FLAT is the base case and it is the honest one. A SCENARIO_BAND is the user's
 * own "what if it goes up 10%" made explicit, and it carries HYPOTHETICAL
 * standing because it is a counterfactual and not a claim about their money.
 */
function investmentAtDate(id: MeasureIdName, c: MeasureContext, when: Instant): Measure {
  const nowM = evaluateNow(id, c);
  if (nowM.resolution.kind !== 'VALUE') {
    return mk(id, when, unresolved(...nowM.resolution.reasons), c);
  }
  const basis = c.returnBasis ?? FLAT;
  if (basis.kind === 'FLAT') {
    return mk(id, when, resolved(nowM.resolution.value, Standing.ASSUMPTION_DEPENDENT), c, {
      dependsOn: [id],
      range: undefined,
    });
  }
  return mk(id, when,
    resolved(nowM.resolution.value * (1 + basis.pct / 100), Standing.HYPOTHETICAL), c,
    { dependsOn: [id] });
}

// ── The composition ─────────────────────────────────────────────────────────

const NET_WORTH_LEGS: { id: MeasureIdName; sign: 1 | -1 }[] = [
  { id: MeasureId.LIQUID_CASH,          sign:  1 },
  { id: MeasureId.INVESTMENTS_VALUE,    sign:  1 },
  { id: MeasureId.DIGITAL_ASSETS_VALUE, sign:  1 },
  { id: MeasureId.REAL_ASSETS_VALUE,    sign:  1 },
  { id: MeasureId.DEBT_BALANCE,         sign: -1 },
];

/**
 * `net_worth@t` — the first real composition, and it does NOT refuse wholesale.
 *
 * ⚠️ REFUSING BECAUSE ONE LEG IS UNKNOWN IS THE BEHAVIOUR THIS WHOLE PROGRAMME
 * EXISTS TO REMOVE. The brief says it outright: "I do NOT want: 'I cannot
 * project your year-end net worth because future Bitcoin prices are unknown.'"
 * The rule is:
 *
 *     1. leg resolves to a VALUE                          -> use it
 *     2. leg is UNRESOLVED, AND leg@NOW is MEASURED,
 *        AND leg is not the SUBJECT of the question       -> persistence fallback
 *     3. otherwise                                        -> UNRESOLVED, carrying
 *                                                            that leg's reasons
 *
 * ── The two constraints that stop this becoming invention ──
 *
 * ⚠️ A FALLBACK MAY ONLY HOLD A CURRENTLY-MEASURED VALUE CONSTANT. It may never
 * ORIGINATE a value. "Hold today's debt balance flat" is licensed because
 * `debt_balance@NOW` is MEASURED; if today's balance were itself unresolved
 * there is no fallback and the composition is unresolved. There is exactly ONE
 * fallback form, so the set is closed and cannot grow into a library of guesses.
 *
 * ⚠️ AND IT MAY NEVER BE APPLIED TO THE SUBJECT OF THE QUESTION. Asked "what
 * will my debt be in December?", holding debt flat and answering $549.75 would
 * answer a DIFFERENT QUESTION IN THE VOICE OF AN ANSWER. That is the shape of
 * the defect PROJECTION-3 closed, inverted.
 *
 * ⚠️ REJECTED: a separate `completeness: COMPLETE | CONDITIONAL | PARTIAL` axis.
 * It is derivable — if any leg used a fallback the composition is
 * ASSUMPTION_DEPENDENT and `dependsOn` names which one — and adding a parallel
 * enum is exactly how a codebase gets from three vocabularies to forty-two, in
 * the slice whose purpose is to unify them.
 */
export function composeNetWorth(c: MeasureContext, when: Instant): Measure {
  if (when.kind === 'NOW') return evaluateNow(MeasureId.NET_WORTH, c);

  let total = 0;
  const standings: StandingKind[] = [];
  const dependsOn: string[] = [];
  const fallbacks: string[] = [];
  const currency = c.currency ?? 'USD';

  // ── The double-count join ─────────────────────────────────────────────────
  //
  // ⚠️ THREE LEDGERS MEET HERE AND EACH ONE CAN BILL THE SAME MONEY. Card
  // spending is the case: a purchase reduces future CASH through the forecast's
  // spending accrual, and it also increases the card BALANCE. Counting both
  // would subtract it twice.
  //
  // It cannot happen in this composition, and the reason is worth stating rather
  // than leaving to be rediscovered: `debt_balance@FUTURE` is a PERSISTENCE
  // FALLBACK — today's measured balance, held flat — so the debt leg contributes
  // nothing that moves with spending. The whole of the horizon's consumption is
  // absorbed by the cash leg exactly once. What this composition therefore gets
  // right is the TOTAL and not the SPLIT: a card purchase is modelled as cash
  // leaving rather than as debt rising, and net worth is the same either way.
  //
  // ⚠️ SO IF `debt_balance@FUTURE` EVER GAINS A REAL SCHEDULE, THIS JOIN GAINS A
  // DOUBLE COUNT ON THE SAME DAY. That is not hypothetical — it is what a due
  // date would unlock — and the answer then is the existing authority, not a new
  // one: `isOrdinaryConsumption` (spending-baseline.ts) already decides what is
  // consumption, and `projection.ts` already records the measured shape of the
  // problem ("the cards carry $16,854 of the period's $17,012 of spending, so
  // projecting both would double-count every purchase").
  for (const leg of NET_WORTH_LEGS) {
    const m = evaluate(leg.id, when, c);

    // ⚠️ CURRENCY IS CHECKED AT THE JOIN, and it was not checked anywhere before
    // this. `forecastCash` sums `cashDelta` with no currency check at all —
    // `cashDeltaOf` discards `c.currency` (engine.ts:298). A three-ledger
    // composition meets that gap at every leg, so it is closed here.
    if (m.resolution.kind === 'VALUE' && m.currency && m.currency !== currency) {
      return mk(MeasureId.NET_WORTH, when, unresolved({
        code: 'UNRELIABLE_EVIDENCE',
        detail: `${m.label} is stated in ${m.currency} and the rest of this Space in `
          + `${currency}; adding them would assert a conversion nobody made`,
      }), c, { dependsOn });
    }

    if (m.resolution.kind === 'VALUE') {
      total += leg.sign * m.resolution.value;
      standings.push(m.resolution.standing);
      dependsOn.push(...m.dependsOn, `${leg.id}@${instantKey(when)}`);
      // ⚠️ A LEG'S DISCLOSURE IS THE COMPOSITION'S DISCLOSURE, and this is the
      // path the fallback actually takes. `debt_balance@FUTURE` applies the
      // persistence fallback INSIDE `debtAtDate` and returns a VALUE, so the
      // composition's own fallback branch below never runs for it — and without
      // this line the composed net worth rested on "holding today's debt balance
      // flat" with nothing anywhere saying so.
      fallbacks.push(...(m.systemAssumptions ?? []));
      continue;
    }

    const fallback = persistenceFallback(leg.id, c, m.resolution.reasons);
    if (fallback === null) {
      return mk(MeasureId.NET_WORTH, when,
        unresolved(...m.resolution.reasons), c, { dependsOn });
    }
    total += leg.sign * fallback.value;
    standings.push(Standing.ASSUMPTION_DEPENDENT);
    dependsOn.push(`${leg.id}@NOW`);
    fallbacks.push(fallback.statedAs);
  }

  return mk(MeasureId.NET_WORTH, when,
    resolved(total, weakestStanding(standings)), c, {
      dependsOn,
      // ⚠️ THE FALLBACKS TRAVEL WITH THE FIGURE THEY PRICED. This line used to be
      // `...(fallbacks.length > 0 ? { range: undefined } : {})` — a spread of an
      // undefined key, which is nothing at all — under a comment asserting that
      // narration could say them. `dependsOn` carries IDS, not sentences, and is
      // rendered nowhere. An assumption the user cannot see is the dangerous one,
      // and this composition was the one place the codebase stated that principle
      // in a comment and contradicted it on the line beneath.
      ...(fallbacks.length > 0 ? { systemAssumptions: fallbacks } : {}),
    });
}

/**
 * The ONE system fallback: hold a currently-MEASURED value constant.
 *
 * Returns null when it does not apply, which is the answer in three cases: the
 * leg is the SUBJECT, today's value is not MEASURED, or there is no today's
 * value at all.
 *
 * ⚠️ THE MECHANISM ALREADY EXISTS AND IS NOT REBUILT HERE.
 * `AssumptionOrigin.SYSTEM_POLICY` is already the third origin beside
 * USER_REQUESTED and OBSERVED_CONTINUATION, and there is a live shipping
 * precedent: `for-request.ts` carries the default horizon with
 * `statedAs: 'no period was named; the default 3-month horizon applies'`. The
 * system already proposes a default, names it in the user's language, and
 * carries it as an assumption rather than smuggling it in as a fact. A
 * persistence fallback is the same move at a different axis.
 */
export function persistenceFallback(
  id: MeasureIdName, c: MeasureContext, because: readonly Refusal[],
): { value: number; statedAs: string } | null {
  if (c.subject === id) return null;
  const nowM = evaluateNow(id, c);
  if (nowM.resolution.kind !== 'VALUE') return null;
  if (nowM.resolution.standing !== Standing.MEASURED) return null;
  const why = because[0]?.detail ?? 'no forward figure is licensed for it';
  return {
    value: nowM.resolution.value,
    statedAs: `holding today's ${MEASURE_LABEL[id]} flat because ${why}`,
  };
}

// ── The entry point ─────────────────────────────────────────────────────────

export function evaluate(id: MeasureIdName, when: Instant, c: MeasureContext): Measure {
  if (when.kind === 'NOW') return evaluateNow(id, c);

  switch (id) {
    case MeasureId.LIQUID_CASH:
      return cashAtDate(c, when);

    case MeasureId.INVESTMENTS_VALUE:
    case MeasureId.DIGITAL_ASSETS_VALUE:
    case MeasureId.REAL_ASSETS_VALUE:
      return investmentAtDate(id, c, when);

    case MeasureId.DEBT_BALANCE:
      // ⚠️ NO AMORTISATION, AND THE REASON IS EVIDENCE RATHER THAN EFFORT.
      // FORECAST-4's census of the real database: across every Space, FIVE debt
      // accounts carry stated minimums and APRs and NOT ONE carries a due date.
      // `DebtProfile` holds zero rows and `dueDay` lives only there; Plaid
      // cannot supply one because link tokens are created with
      // `products=[transactions]`, so there is no liabilities product and no
      // `next_payment_due_date`. Total licensed obligation events in the entire
      // database: zero. The binding constraint is TIMING, not amount, and an
      // amortisation schedule has no dates to run on.
      //
      // So a future debt balance is the persistence fallback, named as an
      // assumption — unless debt is what was asked about, in which case
      // answering with today's number would answer a different question.
      return debtAtDate(c, when);

    case MeasureId.NET_WORTH:
      return composeNetWorth(c, when);

    // ⚠️ RATES AND RATIOS ARE NOT PROJECTED. A "monthly spending in December" is
    // either the same observed rate (in which case it is the present measure and
    // saying otherwise implies evidence about December) or an assumption the
    // user supplied, which arrives as a scenario delta in Slice 4. Nothing here
    // may originate one.
    default: {
      const nowM = evaluateNow(id, c);
      if (nowM.resolution.kind !== 'VALUE') return mk(id, when, nowM.resolution, c);
      return mk(id, when, resolved(nowM.resolution.value, Standing.OBSERVED_CONTINUATION), c,
        { dependsOn: [`${id}@NOW`] });
    }
  }
}

function debtAtDate(c: MeasureContext, when: Instant): Measure {
  const id = MeasureId.DEBT_BALANCE;
  const reason: Refusal = {
    code: 'NO_LICENCE_AT_HORIZON',
    detail: 'no due dates are recorded for these accounts, so a repayment schedule cannot be run',
  };
  const fb = persistenceFallback(id, c, [reason]);
  if (fb === null) return mk(id, when, unresolved(reason), c);
  return mk(id, when, resolved(fb.value, Standing.ASSUMPTION_DEPENDENT), c, {
    dependsOn: [`${id}@NOW`],
    // Same rule as the composition above: the sentence that licensed the number
    // travels with the number. This used to take `fb.value` and drop
    // `fb.statedAs` on the floor.
    systemAssumptions: [fb.statedAs],
  });
}
