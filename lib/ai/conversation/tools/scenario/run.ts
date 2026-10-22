/**
 * lib/ai/conversation/tools/scenario/run.ts
 *
 * Scenario tools: `scenario_projection` and `scenario_crossing`.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import { SCENARIO_INPUTS } from '../../scenario-inputs';
import {
  findScenarioCrossing, elapsedBetween, metricAt, type CrossingDirection, type LedgerMetric,
} from '../../scenario-crossing';
import { monthEndsBetween, type LedgerCheckpoint } from '../../scenario-ledger';
import type { ToolDefinition } from '../types';
import { obj, str, num } from '../shared/schema';
import { addYearsISO } from '../shared/values';
import { prepareScenario } from './setup';
import {
  scenarioAssumptions, changeSinceOpeningAt, presentScenario, SCENARIO_QUALIFICATION,
} from './present';

/**
 * ⚠️ ONE SENTENCE, ONE DEFINITION, TWO TOOLS. A recomputation rule stated twice
 * in slightly different words is two rules, and the one a model happens to read
 * is the one that applies. It is deliberately about ANY assumption rather than
 * about income: the failure it addresses ("make it nine months", "what about next
 * June?") predates I1 and is not about income at all.
 *
 * ⚠️ WHY A TOOL DESCRIPTION AND NOT THE SYSTEM INSTRUCTION. Post-M1 dogfood
 * measured a changed assumption recomputed 2/6 and a new horizon 2/6. Nothing in
 * the runtime detects that a user changed an assumption — the scenario slot is
 * written only by a tool EXECUTION — and nothing inspects the reply, so the choice
 * is the model's. In the same matrix the one tool carrying an explicit re-call
 * sentence (`get_baselines`) scored 5/6. The system instruction had six words of
 * headroom before a pinned 240-word ceiling; the tool contract had room and the
 * precedent.
 */
const RECOMPUTE_SENTENCE =
  'Call it AGAIN whenever the user changes ANY assumption or the horizon — a rate, a '
  + 'contribution, a floor, a raise, a date. Every figure in the result changes with it, and '
  + 'none of them is to be recomputed in prose: never scale a previous result, add to it, '
  + 'subtract two of them, or read a new date off an old table.';

export const scenarioProjection: ToolDefinition = {
  name: 'scenario_projection',
  // ⚠️ IT LED WITH "NET WORTH" AND EXEMPLIFIED ONLY INVESTING, so a question
  // about CASH this year did not look like this tool's job — the one-off
  // capability was four words between two sentences about investment returns.
  // What changed is the framing and the examples, not the arithmetic: this says
  // what the ledger has always done.
  description:
    'Deterministic projection when something specific happens that the observed pattern ' +
    // ⚠️ THE INCOME CLAUSE LEADS, BECAUSE A MODEL CHOOSING A TOOL READS THE FIRST
    // SENTENCE. Measured on the first I1 dogfood: asked "starting January my income
    // increases 10%, what does that do to my cash?", the model called project_cash,
    // then explained in prose that the question needed this tool. It knew; the
    // description did not say so where it was looking. Same lever, same shape, as
    // the one-off boundary that moved 0/5 to 5/5 (7859d6c).
    'does not contain: a CHANGE TO FUTURE INCOME from a date — a raise, a new salary, an ' +
    'income starting or ending (`incomeChanges`); a CHANGE TO FUTURE SPENDING — cutting a ' +
    'spending line or all spending by a percent or an amount, from now or from a date ' +
    '("cut Dining 20%", "cut Other 20%", `spendingChanges`), passing the user\'s own word for ' +
    'the line; a dated one-off amount arriving or ' +
    'leaving — a bonus, an ' +
    'inheritance, a car, a tax bill, proceeds from a sale — money moved into investments, ' +
    'and an annual return. Cash comes from the same deterministic projection as ' +
    'project_cash; this adds only what the user said, and reports cash, investments, debt ' +
    'and net worth at every checkpoint. Do NOT do this arithmetic yourself. ' +
    RECOMPUTE_SENTENCE + ' The default ' +
    'return is 0% — the no-growth baseline, which is not a prediction that markets return ' +
    'nothing. A rate the user did not state may be run as an explicitly labelled ' +
    'illustration; it may never be called expected, likely, or a forecast.',
  parameters: obj({ to: str('YYYY-MM-DD horizon end. Required.'), ...SCENARIO_INPUTS }, ['to']),
  async run(a, ctx) {
    const setup = await prepareScenario(a, ctx, String(a.to), scenarioProjection);
    if ('unavailable' in setup) return setup;
    return presentScenario(setup, setup.run(), setup.returns);
  },
};

// ── 11b. Scenario threshold crossing ─────────────────────────────────────────

/** What each line means to a reader. The values themselves are the ledger's. */
const CROSSING_METRICS: Record<LedgerMetric, string> = {
  netWorth:    'everything owned less everything owed',
  liquid:      'unrestricted cash (checking + savings, excluding restricted accounts such as an HSA)',
  investments: 'traditional investments + crypto',
  debt:        'what is owed, as a positive amount',
  otherAssets: 'property, restricted cash such as an HSA, and anything else that is not unrestricted cash, an investment or a debt',
};
const CROSSING_DIRECTIONS: CrossingDirection[] = ['at_or_above', 'at_or_below'];

/**
 * How far forward a search may look when nobody says.
 *
 * ⚠️ A SEARCH NEEDS A WALL, AND THE WALL IS PRODUCT. `scenario_projection` will
 * happily run to 2100 because a caller naming a horizon has said what they mean;
 * a caller asking "when?" has not, and an unbounded forward walk is a loop. Thirty
 * years covers every goal anybody states in a sentence and costs about a third of
 * a second to search.
 */
const CROSSING_DEFAULT_YEARS = 30;
const CROSSING_MAX_YEARS = 30;

export const scenarioCrossing: ToolDefinition = {
  name: 'scenario_crossing',
  description:
    'WHEN a scenario first reaches a number: the first future month-end where net worth, cash, '
    + 'investments or debt crosses a threshold, under the same assumptions scenario_projection '
    + 'takes. Use it for "when do I hit a million", "when will I be debt free", "how long until '
    + 'I have X" — anything asking WHEN rather than HOW MUCH. It returns the crossing month, the '
    + 'month before it, and what the position looks like there. Do NOT read a date off a '
    + 'projection table yourself, and do NOT guess a deadline to hand scenario_goal_seek: that '
    + 'tool answers "what would it take by DATE", this one answers "when". '
    + RECOMPUTE_SENTENCE,
  parameters: obj({
    metric: { type: 'string', enum: Object.keys(CROSSING_METRICS),
      description: 'Which line crosses. `liquid` is unrestricted cash (checking + savings, excluding restricted accounts such as an HSA); `debt` is what is owed, '
        + 'as a positive amount.' },
    direction: { type: 'string', enum: CROSSING_DIRECTIONS,
      description: 'at_or_above for reaching a target; at_or_below for falling to one. '
        + '"When is my debt gone" is metric `debt`, at_or_below, threshold 0.' },
    threshold: num('The number to reach, in dollars. Required.'),
    searchThrough: str('YYYY-MM-DD to stop looking. Omit to search '
      + `${CROSSING_DEFAULT_YEARS} years ahead. Use it when the user named a window — `
      + '"do I get there by 2035?" — and the search will not look past it.'),
    ...SCENARIO_INPUTS,
  }, ['metric', 'direction', 'threshold']),
  async run(a, ctx) {
    const metric = a.metric as LedgerMetric;
    const direction = a.direction as CrossingDirection;
    const threshold = Number(a.threshold);
    if (!(metric in CROSSING_METRICS)) {
      return { unavailable: `unknown metric: ${String(a.metric)}`,
        canSearch: Object.keys(CROSSING_METRICS) };
    }
    if (!CROSSING_DIRECTIONS.includes(direction)) {
      return { unavailable: `unknown direction: ${String(a.direction)}`,
        canSearch: CROSSING_DIRECTIONS };
    }
    if (!Number.isFinite(threshold)) {
      return { unavailable: 'the threshold is not a number' };
    }

    // ⚠️ THE CAP IS ABSOLUTE AND THE REQUEST IS NOT EXTENDED PAST IT. A user who
    // said "through 2035" is answered about 2035; silently searching to 2056 and
    // reporting a date they excluded would answer a question they did not ask.
    const capISO = addYearsISO(ctx.asOfISO, CROSSING_MAX_YEARS);
    const asked = (a.searchThrough as string) || addYearsISO(ctx.asOfISO, CROSSING_DEFAULT_YEARS);
    const searchThrough = asked > capISO ? capISO : asked;
    if (searchThrough <= ctx.asOfISO) {
      return { unavailable: `the search window ${searchThrough} is not in the future` };
    }

    // ⚠️ EVERY MONTH-END, IN ORDER, THROUGH ONE LEDGER RUN. Not a bisection: a
    // scenario path is not guaranteed to rise — a one-off outflow, a negative
    // return or a falling month can take a line back down — so a search that
    // assumed monotonicity could report the second crossing as the first, or
    // miss one entirely. Walking the grid is O(months) and costs less than the
    // model reading a table.
    const dates = monthEndsBetween(ctx.asOfISO, searchThrough);
    const setup = await prepareScenario(a, ctx, searchThrough, scenarioCrossing, dates);
    if ('unavailable' in setup) return setup;
    const ledger = setup.run();

    const composition = (c: LedgerCheckpoint) => ({
      liquid: c.liquid?.amount ?? null, investments: c.investments.amount,
      debt: c.debt.amount, otherAssets: c.otherAssets.amount,
      netWorth: c.netWorth?.amount ?? null,
    });
    // ⚠️ BESIDE `composition`, NEVER INSIDE IT. The active-scenario envelope reads
    // its six numbers off `composition`; how far the position is from the opening
    // is a sibling, computed by the same function the projection table uses.
    const changeAt = (c: LedgerCheckpoint) => changeSinceOpeningAt(setup, ledger, c);
    // ⚠️ THE WALK IS PURE AND LIVES NEXT DOOR. Nothing about money is decided
    // here: the ledger produced the path, `findScenarioCrossing` says where the
    // line is first crossed on it, and this only says it in words.
    const found = findScenarioCrossing({ checkpoints: ledger.checkpoints,
      opening: ledger.opening, metric, direction, threshold });

    // ⚠️ AN UNEVALUATED MONTH-END IS NOT A MONTH THE CONDITION FAILED. A Space with no complete
    // month of spending has no projection at all, and "not met at any month-end through 2056" was
    // said after examining ZERO of them (2026-10-04). Count what could not be read, and never fold
    // it into a negative.
    const unevaluated = ledger.checkpoints.filter((c) => metricAt(c, metric) === null);
    const head = {
      asOf: setup.asOf, metric, metricMeans: CROSSING_METRICS[metric], direction, threshold,
      searchedThrough: { to: searchThrough, monthsExamined: found.examined,
        ...(unevaluated.length > 0 ? { monthsUnevaluated: unevaluated.length,
          firstUnevaluated: unevaluated[0].date } : {}),
        grain: 'month-end',
        ...(asked > capISO ? { cappedAt: `${CROSSING_MAX_YEARS} years` } : {}) },
      assumptionsInForce: scenarioAssumptions(setup, ledger, setup.returns),
      rejected: [...setup.rejected, ...ledger.rejected],
      warnings: ledger.warnings,
      basis: ledger.basis,
      qualification: SCENARIO_QUALIFICATION,
    };

    // ⚠️ ALREADY TRUE IS NOT A CROSSING, AND SAYING SO IS THE WHOLE POINT. The
    // goal seek's `alreadyMet` is what produced "the solver says 0% is needed",
    // narrated as though a future event had been found. A position that already
    // satisfies the condition has a date, and it is today.
    if (found.alreadySatisfied) {
      return { ...head, outcome: 'ALREADY_SATISFIED', crossing: null,
        alreadySatisfied: { ...found.alreadySatisfied,
          elapsed: elapsedBetween(setup.asOf, found.alreadySatisfied.date) },
        meaning: 'This is already true today. Nothing here is a future event.' };
    }

    if (!found.crossing && found.examined === 0) {
      return { ...head, outcome: 'EVALUATION_FAILED', crossing: null, neverCrossesBy: null,
        projectionRefusal: unevaluated.find((c) => c.unavailable)?.unavailable ?? 'the projection produced no value',
        meaning: 'The projection could not produce a value at any month-end, so whether and when this '
          + 'condition is met is UNKNOWN. Do not say it is never met; say the calculation could not run and why.' };
    }

    if (!found.crossing) {
      return { ...head, outcome: 'NOT_WITHIN_WINDOW', crossing: null,
        neverCrossesBy: found.end
          ? { date: found.end.checkpoint.date, value: found.end.value,
              elapsed: elapsedBetween(setup.asOf, found.end.checkpoint.date),
              composition: composition(found.end.checkpoint),
              changeSinceOpening: changeAt(found.end.checkpoint) }
          : null,
        meaning: (unevaluated.length > 0
          ? `Under these assumptions the condition is not met at any of the ${found.examined} month-ends the `
            + `projection could evaluate through ${searchThrough}; ${unevaluated.length} could not be evaluated `
            + `(from ${unevaluated[0].date}), and nothing is known about those. `
          : 'Under these assumptions the condition is not met at any month-end through '
            + `${searchThrough}. `) + 'That is a statement about this search window, not about ever.' };
    }

    const hit = found.crossing;
    // ⚠️ A PAYOFF OVER AN UNMODELLED RATE IS A LOWER BOUND, AND THE DATE SAYS SO
    // ITSELF. The echo above carries the basis; this puts it beside the number
    // the model is about to quote, so "exact" cannot be read off a field that
    // was never exact.
    const interest = ledger.liabilities && ledger.liabilities.interestBasis !== 'NOT_APPLICABLE'
      ? { basis: ledger.liabilities.interestBasis,
          aprMissingFor: ledger.liabilities.unmodelled.map((u) => u.label),
          reading: ledger.liabilities.interestBasis === 'COMPLETE'
            ? 'interest modelled on every owed liability'
            : 'PAYMENTS-ONLY LOWER BOUND: interest was not modelled on the liabilities named; '
              + 'with a positive rate this crossing would come later (for debt) — say so' }
      : null;
    return {
      ...head,
      outcome: 'CROSSES',
      crossing: {
        ...(interest ? { interestEvidence: interest } : {}),
        date: hit.checkpoint.date, value: hit.value,
        // ⚠️ HOW FAR AWAY, IN NUMBERS THE ENGINE OWNS. The date was always
        // right; "1.5 years" for a gap of five and a half months was the model
        // subtracting. Measured from the scenario's own asOf.
        elapsed: elapsedBetween(setup.asOf, hit.checkpoint.date),
        // ⚠️ THE MONTH BEFORE IS WHAT MAKES IT A FIRST. Without it a reader
        // cannot tell a crossing from a value that merely happens to be above
        // the line.
        previousCheckpoint: hit.previous
          ? { ...hit.previous, elapsed: elapsedBetween(setup.asOf, hit.previous.date) } : null,
        composition: composition(hit.checkpoint),
        changeSinceOpening: changeAt(hit.checkpoint),
      },
      alreadySatisfied: null,
      meaning: 'The first month-end at which this is true. The projection is month-grain, so '
        + 'say "by the end of that month" — nothing here establishes a day within it.',
    };
  },
};
