/**
 * lib/ai/conversation/tools/scenario/goal-seek.ts
 *
 * Scenario tool: `scenario_goal_seek`.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import { resolveTransformableCategory } from '@/lib/transactions/category-vocabulary';
import type { SpendingChangeRule } from '@/lib/ai/forecast/assemble';
import { SCENARIO_INPUTS } from '../../scenario-inputs';
import { elapsedBetween } from '../../scenario-crossing';
import {
  solveForTarget, returnHorizon, returnRepresentation, annualizedFromPeriodPct, periodFromAnnualizedPct,
  monthEndOccurrences, ORIGIN, type SolveBound, type LedgerResult, type PlannedMovement,
  type ReturnPeriod, type AllocationTarget,
} from '../../scenario-ledger';
import type { ToolDefinition } from '../types';
import { obj, str, num } from '../shared/schema';
import { round2 } from '../shared/values';
import { type ScenarioOverrides, prepareScenario } from './setup';
import { scenarioAssumptions, presentScenario } from './present';

// ── 12. Goal seek ────────────────────────────────────────────────────────────

/**
 * What a goal seek is allowed to solve for, and what bounds it honestly has.
 *
 * ⚠️ EACH BOUND IS A FACT, NOT A COMFORT. A spending cut cannot exceed what the
 * user actually spends; a required return of 400%/yr is reportable and the model
 * can call it absurd. What the tool must never do is invent a number to avoid
 * saying "no" — which is exactly what turn 13 did with "mid-40% annualized
 * returns" and "~$90K/year additional investable surplus".
 */
const SOLVABLE = {
  annualReturnPct:     'annualReturnPct',
  monthlyContribution: 'monthlyContribution',
  monthlySpendingCut:  'monthlySpendingCut',
  /** S1-7 — the one spending line's cut, by percent or by monthly amount. */
  spendingChange:      'spendingChange',
} as const;

/** The first day a projection from `asOf` governs. */
const dayAfter = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * A wide, stated bracket. Anything beyond it is reported as out of range, not clamped.
 *
 * ⚠️ 500 IN THE HORIZON'S OWN TERMS. It was 500% A YEAR at every horizon, which over 30
 * days is +15.9% and over 89 days +54.8% — so a target needing +60% by 31 December was
 * reported as unreachable while a +293% one was impossible, both by a search that had
 * simply stopped. Below a year the bound is +500% OVER THE PERIOD (the search runs in
 * period space); from a year on it is 500% a year, as before. The two meet at 365 days.
 */
const MAX_SOLVED_RETURN_PCT = 500;

export const scenarioGoalSeek: ToolDefinition = {
  name: 'scenario_goal_seek',
  description:
    // ⚠️ THE EXAMPLE CARRIES NO CURRENCY SYMBOL. Anywhere under lib/ai a quoted
    // dollar-then-digit is a hard-coded currency in a money string, and
    // `lib/ai/currency-presentation.test.ts` refuses it — correctly: this tool is
    // currency-agnostic and a Space that reports in anything but USD should not
    // read a dollar sign in its own tool surface. The guard only started applying
    // when the runtime moved out of scripts/, which is the guard working.
    'Solve for the one number that reaches a target: the annual return needed, the monthly ' +
    'contribution needed, or the monthly spending cut needed. Use it for "how could I reach ' +
    'a million by 2030?" — do NOT estimate a required return or a required saving rate ' +
    'yourself. ' +
    'It returns the value AND the full scenario at that value, with `outcome`: SOLVED, ' +
    'ALREADY_MET, INFEASIBLE (no value of the lever can reach it), OUT_OF_RANGE (the search ' +
    'stopped first — never call that impossible) or EVALUATION_FAILED (the projection could not ' +
    'run — reachability is unknown, never impossible). Takes the same scenario inputs as ' +
    'scenario_projection, which are held fixed while the one unknown is solved. ' +
    'A solved return comes as `returnAtSolution` over `horizon`: lead with `periodPct` (growth ' +
    'over the actual period) for a by-date question shorter than a year, with `annualizedPct` ' +
    'for a longer one or when the user asks for an annual/annualized rate — and give the other ' +
    'as context. Never convert between them yourself.',
  parameters: obj({
    target: num('The number to reach, in dollars. Required.'),
    by:     str('YYYY-MM-DD by which to reach it. Required.'),
    solveFor: { type: 'string', enum: Object.keys(SOLVABLE),
      description:
        'annualReturnPct = what return would be needed. monthlyContribution = how much cash '
        + 'to move into investments each month (this RELOCATES money — at a 0% return it does '
        + 'not change net worth at all). monthlySpendingCut = how much less to spend each '
        + 'month overall, with that amount invested; this is the lever that actually creates '
        + 'net worth. spendingChange = how much to cut ONE spending line ("how much would I need '
        + 'to cut Dining to…") — give `spendingChangeToSolve`.' },
    spendingChangeToSolve: obj({
      category: str('The spending line, in the user\'s own word (as in `spendingChanges[].category`).'),
      unit: { type: 'string', enum: ['percent', 'monthly'],
        description: 'percent = the share of the line to cut (0–100); monthly = how much less a '
          + 'month (up to the whole line).' },
      from: str('YYYY-MM-DD the cut starts. Omit for the first projected day.'),
    }, ['category', 'unit']),
    measure: { type: 'string', enum: ['netWorth', 'liquid', 'investments', 'debt'],
      description: 'What the target is a target FOR. Default netWorth. `debt` solves DOWNWARD: '
        + 'the smallest value that brings debt at `by` to at or below the target ("what extra '
        + 'monthly payment gets me debt free by December" = monthlyContribution, measure debt, '
        + 'target 0, contributionTarget highest_apr).' },
    contributionTarget: { description: 'For solveFor monthlyContribution: where the solved '
        + 'monthly amount goes — `investments` (default), `highest_apr`, a liability id, or an '
        + 'ordered list, exactly as `contributions[].target`.',
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    ...SCENARIO_INPUTS,
  }, ['target', 'by', 'solveFor']),
  async run(a, ctx) {
    const toISO  = String(a.by);
    const target = Number(a.target);
    const solveFor = String(a.solveFor);
    const measure = ['liquid', 'investments', 'debt'].includes(String(a.measure))
      ? String(a.measure) as 'liquid' | 'investments' | 'debt' : 'netWorth';
    // ⚠️ DEBT IS SOLVED DOWNWARD. The bisection assumes "more of X reaches a
    // higher value"; for a debt target the value that rises with X is minus the
    // balance, so the ledger's debt is negated on the way in and the target on
    // the way out. Nothing else about the solver changes.
    const sign = measure === 'debt' ? -1 : 1;
    const toTarget = (t: unknown): AllocationTarget => (t === 'investments' || t === 'highest_apr') ? t
      : typeof t === 'string' ? { liability: t } : t as AllocationTarget;
    const contributionTargets: AllocationTarget[] | undefined = a.contributionTarget === undefined ? undefined
      : Array.isArray(a.contributionTarget) ? a.contributionTarget.map(toTarget) : [toTarget(a.contributionTarget)];
    if (!Number.isFinite(target)) return { unavailable: 'the target is not a number' };
    if (!(solveFor in SOLVABLE)) {
      return { unavailable: `cannot solve for "${solveFor}"`,
        canSolveFor: Object.keys(SOLVABLE) };
    }

    const setup = await prepareScenario(a, ctx, toISO, scenarioGoalSeek);
    if ('unavailable' in setup) return setup;

    // ── S1-7 — the spending cuts a solve evaluates, as rules ──────────────────
    // Every refusal below still echoes what was in force (see `scenarioAssumptions`).
    const assumptionsNow = () => scenarioAssumptions(setup, setup.run(), setup.returns);
    const totalCut = (x: number): SpendingChangeRule => ({ id: 'solved', op: 'DELTA', scope: null,
      fromISO: dayAfter(setup.asOf), monthly: -round2(x) });
    let spendSolve = { unit: 'percent' as 'percent' | 'monthly', lineMonthly: 0, from: '', category: '',
      rule: (_x: number): SpendingChangeRule => { throw new Error(String(_x)); } };
    if (solveFor === SOLVABLE.spendingChange) {
      const want = (a.spendingChangeToSolve ?? {}) as Record<string, unknown>;
      const unitWanted = want.unit === 'monthly' ? 'monthly' : want.unit === 'percent' ? 'percent' : null;
      if (typeof want.category !== 'string' || !unitWanted) {
        return { unavailable: 'solveFor spendingChange needs `spendingChangeToSolve` with a `category` and a '
          + '`unit` (percent or monthly)', assumptionsInForce: assumptionsNow() };
      }
      const line = resolveTransformableCategory(want.category);
      if (!line.ok) {
        return { unavailable: line.unavailable, assumptionsInForce: assumptionsNow() };
      }
      const from = typeof want.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(want.from) ? want.from : dayAfter(setup.asOf);
      const scope = { category: line.category, class: line.class, meaning: line.meaning };
      // Two different rules on one line from one date are refused by the engine —
      // so a solve that would collide with a stated rule is refused up front, said.
      const stated = setup.spendingChanges?.applied ? setup.spendingChanges.executions : [];
      if (stated.some((x) => x.category?.category === line.category && x.requested.fromISO === from)) {
        return { unavailable: `the scenario already changes ${line.category} from ${from}; a solved cut from the `
          + 'same date would be a second answer to the same rule. Solve from another date, or run the scenario '
          + `without that ${line.category} rule.`, assumptionsInForce: assumptionsNow() };
      }
      // The line's own measured rate, from the spine (the category rates do not depend on any rule).
      const probe = setup.runProbe({ id: 'probe', op: 'SCALE', scope, fromISO: from, multiplier: 0.5 });
      const lineMonthly = probe?.categoryRates.find((c) => c.category === line.category)?.monthly ?? 0;
      if (lineMonthly <= 0) {
        return { unavailable: `${line.category} had no spending in the averaged months, so there is nothing to cut`,
          assumptionsInForce: assumptionsNow() };
      }
      spendSolve = { unit: unitWanted, lineMonthly, from, category: line.category,
        rule: (x) => (unitWanted === 'percent'
          ? { id: 'solved', op: 'SCALE', scope, fromISO: from, multiplier: 1 - x / 100 }
          : { id: 'solved', op: 'DELTA', scope, fromISO: from, monthly: -x }) };
    }

    /** The horizon value of whichever line the target is about. */
    const valueOf = (l: LedgerResult): number | null => {
      const last = l.checkpoints[l.checkpoints.length - 1];
      if (!last) return null;
      const line = measure === 'liquid' ? last.liquid
        : measure === 'investments' ? last.investments
        : measure === 'debt' ? last.debt : last.netWorth;
      return line?.amount === undefined || line?.amount === null ? null : sign * line.amount;
    };

    // A monthly schedule of a solved dollar amount, on the month-ends that fall by the
    // deadline — a SCHEDULE, never the checkpoint grid, which ends on `by` itself and so
    // put a whole extra month's amount on a mid-month deadline.
    const monthly = (amount: number, label: string): PlannedMovement[] =>
      monthEndOccurrences(setup.asOf, toISO).map((date) => ({ date, amount, label,
        ...(contributionTargets ? { targets: contributionTargets } : {}) }));

    let evaluate: (x: number) => number | null;
    let hi = 0, unit = '';
    let bound: SolveBound = 'SEARCH';
    const lo = 0, precision = 0.01;
    // The ledger's own day count over the solved period — one year convention per result.
    const horizon = returnHorizon(setup.asOf, toISO);
    /** A rate over [asOf, by], the only return a solve is allowed to state. */
    const solvedReturns = (annualPct: number): ReturnPeriod[] => [{ fromISO: setup.asOf, toISO, annualPct }];
    const atAnnual = (annualPct: number) => valueOf(setup.run({ returns: solvedReturns(annualPct) }));
    // ⚠️ BELOW A YEAR THE RETURN IS SEARCHED AS PERIOD GROWTH (see MAX_SOLVED_RETURN_PCT).
    const returnSpace: 'PERIOD' | 'ANNUAL' = horizon.dayCount < 365 ? 'PERIOD' : 'ANNUAL';
    const annualOf = (x: number) => (returnSpace === 'PERIOD' ? annualizedFromPeriodPct(x, horizon.dayCount) : x);
    const periodOf = (x: number) => (returnSpace === 'PERIOD' ? x : periodFromAnnualizedPct(x, horizon.dayCount));

    if (solveFor === SOLVABLE.annualReturnPct) {
      unit = 'percent per year';
      hi = MAX_SOLVED_RETURN_PCT;
      // ⚠️ A SOLVED RETURN REPLACES ANY STATED ONE. Solving for a rate while
      // leaving another in force would answer a question about a blend that
      // nobody described.
      evaluate = (x) => atAnnual(annualOf(x));
    } else if (solveFor === SOLVABLE.monthlyContribution) {
      unit = 'USD per month';
      // ⚠️ THE BRACKET FOR A DEBT TARGET IS THE DEBT. A monthly amount equal to
      // everything owed clears it in the first month whatever the rate, so the
      // top of the range is a fact, not a guess.
      hi = measure === 'debt'
        ? Math.max(setup.liabilities.reduce((t, l) => t + l.balance, 0) + (setup.accounts.totalLiabilities ?? 0), 1_000)
        : Math.max(Math.abs(target), 1_000);
      if (measure === 'debt') bound = 'STRUCTURAL';
      evaluate = (x) => valueOf(setup.run({
        extraContributions: monthly(x, 'solved monthly contribution') }));
    } else if (solveFor === SOLVABLE.monthlySpendingCut) {
      unit = 'USD per month';
      const base = setup.monthlySpending.amount;
      if (base === null || base <= 0) {
        return { unavailable: 'no monthly spending level is established for this Space, so '
          + 'there is nothing to solve a cut against',
          suggestion: 'pass assumedMonthlySpending, or solve for annualReturnPct instead' };
      }
      // ⚠️ THE CEILING IS WHAT THEY ACTUALLY SPEND. Nobody can cut more than
      // their whole outgoings, and "you would need to free up $12,400 a month"
      // said to somebody who spends $7,549 is a fabrication with a decimal point.
      hi = base;
      bound = 'STRUCTURAL';
      // ⚠️ S1-7 — THE CUT IS A RULE ON TOP OF THE SCENARIO, NOT A NEW SPENDING LEVEL.
      // It was a replacement level (`base − x`), which with a Dining cut already in
      // the scenario would have silently dropped the Dining cut. An aggregate DELTA
      // composes with every stated spending change, and without them it is exactly
      // the old arithmetic.
      evaluate = (x) => valueOf(setup.run({
        ...(x > 0 ? { extraSpendingChanges: [totalCut(x)] } : {}),
        extraContributions: monthly(x, 'solved monthly amount freed up and invested') }));
    } else {
      unit = spendSolve.unit === 'percent' ? 'percent of the line' : 'USD per month';
      hi = spendSolve.unit === 'percent' ? 100 : spendSolve.lineMonthly;
      bound = 'STRUCTURAL';
      // ⚠️ THE CUT JOINS THE SCENARIO'S OWN RULES, and the freed cash stays wherever
      // the scenario's rules send cash — a floor sweep, a waterfall, or nowhere. It is
      // a question about the line, not an instruction to invest.
      evaluate = (x) => valueOf(setup.run(x > 0 ? { extraSpendingChanges: [spendSolve.rule(x)] } : {}));
    }

    const isReturn = solveFor === SOLVABLE.annualReturnPct;
    // ⚠️ THE BASELINE IS THE LEVER AT THE BOTTOM OF ITS RANGE, UNDER THE SOLVE'S OWN RULES. A solved
    // return REPLACES any stated one, so "without the solved variable" is the scenario at 0%, not at
    // the stated rate: with a stated −20% the baseline was run at −20% while the solve started at 0%,
    // and the result said ALREADY_MET beside a positive baseline gap (2026-10-04). Status, gap and
    // solution now describe one scenario family; the replaced statement is named, not hidden.
    const baseLedger = setup.run(isReturn ? { returns: solvedReturns(annualOf(lo)) } : {});
    const baseline = valueOf(baseLedger);
    let solved = solveForTarget({ solveFor, evaluate, target: sign * target, lo, hi, precision, bound });
    // ⚠️ A PERIOD-SPACE SOLVE IS REFINED TO THE REPORTED UNIT. A hundredth of a point of period
    // growth over 89 days is fifteen hundredths a year; the answer is reported per year, so it is
    // bisected again — inside the period bracket — to a hundredth of THAT, and verified. The
    // period answer was rounded UP, so the true one lies within two steps below it.
    if (isReturn && returnSpace === 'PERIOD' && solved.outcome === 'SOLVED') {
      const refined = solveForTarget({ solveFor, evaluate: atAnnual, target: sign * target, precision,
        lo: annualOf(Math.max(0, solved.required - 2 * precision)), hi: annualOf(solved.required) });
      const required = Math.ceil((refined.feasible ? refined.required : annualOf(solved.required + precision)) * 100 - 1e-9) / 100;
      solved = { ...solved, iterations: solved.iterations + refined.iterations, required,
        reached: atAnnual(required) ?? Number.NEGATIVE_INFINITY };
    } else if (isReturn && returnSpace === 'PERIOD' && !solved.feasible) {
      solved = { ...solved, bestAt: round2(annualOf(solved.bestAt)) };
    }
    /** Why the projection itself could not produce a value — its own words, for EVALUATION_FAILED. */
    const projectionRefusal = baseLedger.checkpoints.find((c) => c.unavailable)?.unavailable
      ?? (baseline === null ? 'the projection produced no value at the deadline' : null);
    const outOfRange = !solved.feasible && solved.outcome === 'OUT_OF_RANGE';

    // ⚠️ `timeToTarget.years` IS NOT HERE. It is a display distance on a 365.25-day year; the
    // result's one year fraction is `horizon.yearFraction`, the exponent the ledger grew money by.
    const { years: _displayYears, ...timeToTarget } = elapsedBetween(setup.asOf, toISO);
    void _displayYears;

    const head = {
      asOf: setup.asOf, target, by: toISO, measure, solveFor, unit, outcome: solved.outcome,
      /** How far off the deadline is, from the scenario's asOf — the engine's subtraction, not the model's. */
      timeToTarget,
      horizon,
      // ⚠️ ON EVERY PATH, INCLUDING THE REFUSAL. See `scenarioAssumptions`. For a return solve the
      // returns in force are the solve's, so a stated rate is echoed as REPLACED, never as applied.
      assumptionsInForce: scenarioAssumptions(setup, baseLedger, isReturn ? [] : setup.returns),
      ...(isReturn && setup.returns.length > 0 ? { replacedByThisSolve: {
        returns: setup.returns.map((r) => ({ from: r.fromISO, to: r.toISO, annualPct: r.annualPct })),
        meaning: 'A solved return replaces any stated one: the baseline, the outcome and the answer are all '
          + 'computed WITHOUT these rates. To keep a stated rate, solve for a different lever.' } } : {}),
      /** Which way raising the lever moved this measure in THIS scenario (from the solve's own evaluations). */
      leverDirection: solved.direction,
      ...(contributionTargets ? { contributionTarget: contributionTargets } : {}),
      baseline: { reached: baseline === null ? null : sign * baseline,
        gap: baseline === null ? null : round2(target - sign * baseline),
        meaning: isReturn ? `where the scenario lands with ${solveFor} at ${lo}, the bottom of the solved range`
          : 'where the stated assumptions land WITHOUT the solved variable' },
      searchRange: { from: lo, to: isReturn ? round2(annualOf(hi)) : hi, unit, iterations: solved.iterations,
        ...(isReturn ? { periodTo: round2(periodOf(hi)), boundIn: returnSpace === 'PERIOD'
          ? 'period growth: up to +500% over the horizon, because the horizon is shorter than a year'
          : 'annual rate: up to 500% a year' } : {}),
        note: solveFor === SOLVABLE.monthlySpendingCut
          ? `the upper bound is the whole ${setup.monthlySpending.source.toLowerCase()} `
            + 'monthly spending level — nobody can cut more than they spend'
          : solveFor === SOLVABLE.spendingChange
            ? `the upper bound is the whole ${spendSolve.category} line (${round2(spendSolve.lineMonthly)}/month over `
              + 'the averaged months) — a line cannot be cut below nothing'
            : 'a value outside this range is reported as out of range, never clamped' },
      ...(solveFor === SOLVABLE.spendingChange ? { solving: { category: spendSolve.category, unit: spendSolve.unit,
        from: spendSolve.from, lineMonthly: round2(spendSolve.lineMonthly),
        meaning: 'The cut is added to the scenario\'s own rules (any stated spending change still applies); the '
          + 'cash it frees goes wherever the scenario\'s rules send cash.' } } : {}),
    };

    if (!solved.feasible) {
      return { ...head, feasible: false, reason: solved.reason,
        bestReached: solved.bestReached === null ? null : sign * solved.bestReached, bestAt: solved.bestAt,
        ...(isReturn && solved.outcome !== 'EVALUATION_FAILED'
          ? { bestAtPeriodPct: round2(periodOf(solved.direction === 'AWAY' ? lo : hi)) } : {}),
        // ⚠️ HOW FAR THE RANGE GOT IS AN ANSWER; A HUGE INVENTED NUMBER IS NOT.
        ...(solved.outcome === 'EVALUATION_FAILED' ? { projectionRefusal } : {}),
        meaning: (solved.outcome === 'EVALUATION_FAILED'
          ? `The projection could not produce a value (${projectionRefusal ?? 'no value'}), so whether ${target} is `
            + 'reachable is UNKNOWN. Do not call it impossible or unreachable; say the calculation could not run '
            + 'and why, and what would let it (for example a stated monthly spending level). '
          : outOfRange
          ? `The search stopped before reaching ${target}: the best it did was ${solved.bestReached ?? 'nothing'} `
            + `at ${solved.bestAt} ${unit}${isReturn ? ` (+${round2(periodOf(hi))}% over the horizon)` : ''}. `
            + 'That is where the search ended, NOT a proof that it is impossible — do not call it impossible. '
          : solved.direction === 'AWAY'
            ? `Raising ${solveFor} moves ${measure} AWAY from ${target} in this scenario, so no amount of it `
              + `reaches it; the closest is ${solveFor} = ${solved.bestAt}. `
          : `No value of ${solveFor} reaches ${target}. The best it did was `
            + `${solved.bestReached ?? 'nothing'} at ${solved.bestAt} ${unit}. `)
          + 'Say that, and '
          + 'say which other lever might close the gap — do not estimate a figure yourself. '
          + 'Describe the result using `assumptionsInForce` above and nothing else: if a '
          + 'return or a contribution from earlier in the conversation is not listed there, '
          + 'it was NOT applied, and calling the answer again with it is the way to include '
          + 'it.' };
    }

    // ⚠️ THE LEDGER RETURNED IS THE ONE RUN AT THE ANSWER, not a re-derivation of
    // it. Solve, then render what the solution actually produces, so the table
    // beneath the number cannot disagree with the number.
    const atSolution: ScenarioOverrides = solveFor === SOLVABLE.annualReturnPct
      ? { returns: [{ fromISO: setup.asOf, toISO, annualPct: solved.required }] }
      : solveFor === SOLVABLE.monthlyContribution
        ? { extraContributions: monthly(solved.required, 'solved monthly contribution') }
        : solveFor === SOLVABLE.monthlySpendingCut
          ? { ...(solved.required > 0 ? { extraSpendingChanges: [totalCut(solved.required)] } : {}),
              extraContributions: monthly(solved.required, 'solved monthly amount freed up and invested') }
          : (solved.required > 0 ? { extraSpendingChanges: [spendSolve.rule(solved.required)] } : {});
    const ledger = setup.run(atSolution);
    const returnsUsed = solveFor === SOLVABLE.annualReturnPct
      ? [{ fromISO: setup.asOf, toISO, annualPct: solved.required }] : setup.returns;
    // ⚠️ FROM THE FACTOR THE LEDGER GREW THE MONEY BY — never `investments at the answer ÷ opening`,
    // which mixes any contribution or outflow on the way into the "return".
    const representation = returnRepresentation(returnsUsed, setup.asOf, toISO);
    const last = ledger.checkpoints[ledger.checkpoints.length - 1];

    return {
      ...head,
      feasible: true,
      required: solved.required,
      alreadyMet: solved.alreadyMet,
      reachedAtSolution: sign * solved.reached,
      ...(solved.alreadyMet
        ? { meaning: `The target is already reached without any ${solveFor} at all.` }
        : {}),
      ...(isReturn ? { returnAtSolution: { ...representation,
        leadWith: horizon.dayCount < 365 ? 'periodPct' : 'annualizedPct',
        leadWithMeaning: 'the default for this horizon; when the user asked for an annual or annualized rate, '
          + 'lead with annualizedPct and give periodPct beside it' } } : {}),
      // ⚠️ "SHOW ME THE MATH" IS READ HERE, NOT REBUILT. Every term is the ledger at the answer.
      ...(last ? { derivation: {
        measure,
        identity: 'netWorth = liquid + investments + otherAssets − debt',
        terms: { liquid: last.liquid?.amount ?? null, investments: last.investments.amount,
          otherAssets: last.otherAssets.amount, debt: last.debt.amount, netWorth: last.netWorth?.amount ?? null,
          target },
        investments: { opening: ledger.opening.investments, atHorizon: last.investments.amount,
          growthFromReturn: last.movements.investmentGrowthToDate,
          principalMovedIn: round2(last.investments.amount - ledger.opening.investments
            - last.movements.investmentGrowthToDate),
          growthFactor: representation.growthFactor, periodPct: representation.periodPct,
          annualizedPct: representation.annualizedPct,
          meaning: 'atHorizon = opening + principalMovedIn + growthFromReturn. periodPct is growthFactor − 1, '
            + 'the growth of a dollar held the whole horizon; it is NOT atHorizon ÷ opening, which would '
            + 'count principal moved in as return.' },
        horizon: { ...horizon, compounding: 'effective annual over actual days: factor = (1 + annual)^(dayCount/365)' },
      } } : {}),
      // The answer is the SOLVER'S, never a figure anyone stated (provenance correction).
      origin: ORIGIN.SOLVED,
      // ⚠️ THE LEDGER AT THE ANSWER, WITH THE SOLVED RULE IN ITS ROSTER — the table
      // beneath the number is the run that produced it (S1-7: the solved spending
      // rule is listed as a rule that ran, beside the scenario's own).
      scenario: presentScenario(setup, ledger, returnsUsed, solveFor),
      qualification:
        'This is the value that reaches the target under the stated assumptions — it is '
        + 'arithmetic, not advice and not a prediction. Whether it is achievable is a '
        + 'judgement about the world, not about the numbers; say what you think.',
    };
  },
};
