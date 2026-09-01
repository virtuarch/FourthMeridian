/**
 * lib/reasoning/scenario/turn.ts
 *
 * V26-REASONING Slice 4 — ONE TURN, UNDER A SCENARIO.
 *
 * ⚠️ THE SELECTOR IN HERE IS TEMPORARY AND IS MARKED FOR DELETION IN SLICE 5,
 * exactly like `derive.ts`'s extractor. Deciding which measures a question is
 * about is the planner's job; what this file does is show that ONCE THE
 * MEASURES ARE CHOSEN, the scenario machinery answers the conversation
 * correctly. Quarantined to one function (`selectMeasures`) with a header
 * saying so, so Slice 5 deletes a named thing rather than untangling one.
 *
 * ── How an ACTIVE delta reaches a figure ────────────────────────────────────
 * `assembleForecast` reads suppositions from `question` and NOTHING ELSE —
 * FORECAST-13 drew that line deliberately, so a supposition is scoped to the
 * turn that makes it. A delta that is still ACTIVE is a supposition the user has
 * not withdrawn, so it is replayed into the effective question as THEIR OWN
 * SENTENCE, verbatim.
 *
 * That is not a workaround. It is what "the assumption is still in force" means,
 * expressed in the only vocabulary the forecast authorities accept, and it means
 * no second path can price an answer differently from the first.
 */

import { computeAssessment } from '@/lib/ai/intelligence';
// ⚠️ THROUGH THE SANCTIONED ADAPTER, never from lib/forecast directly.
// `engine.test.ts` N1, `policy.test.ts` J9 and `spending-baseline.test.ts` L4
// pin that door, and the reasoning layer is exactly the new consumer they were
// written for.
import {
  assembleForecast, type AssembledForecast, type ForecastHorizon,
} from '@/lib/ai/forecast/assemble';
import type { SpaceContext_AI } from '@/lib/ai/types';
import type { ResolvedIncomeStream } from '@/lib/ai/forecast/streams';

import { MeasureId, at, NOW, FLAT, type Instant, type Measure, type MeasureIdName, type ReturnBasis } from '../measure/types';
import { evaluate, type MeasureContext } from '../measure/evaluate';
import type { LicensedRefusal } from '../figures/types';
import { deriveConversationState, type Turn } from './derive';
import {
  DeltaDimension, DeltaStatus, activeDeltas, currentScenario,
  type AssumptionDelta, type ConversationState, type Scenario,
} from './types';

export interface TurnResolution {
  state:    ConversationState;
  scenario: Scenario;
  /** The instant this turn is about. */
  when:     Instant;
  measures: Measure[];
  forecast: AssembledForecast | undefined;
  /**
   * ⚠️ RULE 1'S MECHANISM. Every ACTIVE delta, in the user's own words, passed to
   * narration as a REQUIRED framing item — not a style preference. An assumption
   * the user cannot see is the dangerous one.
   */
  framing:  string[];
  /** True when this turn dismissed the assumptions that were in force. */
  dismissedThisTurn: boolean;
  /**
   * Turn-level withholdings.
   *
   * ⚠️ "NOBODY KNOWS" IS A WITHHOLDING AND HAS TO BE SAID AS ONE. Asked what
   * Bitcoin will be worth in December, a flat figure with a caveat is truthful
   * and reads as a forecast of no change. The unknowability is not a hedge on
   * the figure — it is a separate, stateable fact, and putting it in the
   * WITHHELD block is what makes the model say it rather than imply it.
   */
  withheld: LicensedRefusal[];
}

/**
 * ⚠️ TEMPORARY — SLICE 5's PLANNER REPLACES THIS WHOLE FUNCTION.
 *
 * Which measures a question is about. Six patterns, chosen to cover the
 * conversation this slice is graded on and nothing more. It is deliberately NOT
 * a seventeenth message-text reader that anybody should build on: it exists to
 * prove the scenario machinery, and Slice 5 deletes it.
 *
 * ⚠️ IT SELECTS AND NEVER COMPUTES. A wrong selection costs relevance; it cannot
 * cost truth, because every figure still comes from a measure and every measure
 * still comes from an authority. That is the same safety argument the planner
 * will make, made early.
 */
function selectMeasures(question: string, state: ConversationState): MeasureIdName[] {
  const q = question.toLowerCase();

  if (/\bnet worth\b|\bnetworth\b/.test(q)) return [MeasureId.NET_WORTH];
  if (/\bbitcoin\b|\bcrypto\b|\bdigital asset/.test(q)) return [MeasureId.DIGITAL_ASSETS_VALUE];
  if (/\binvestments?\b|\bportfolio\b/.test(q)) return [MeasureId.INVESTMENTS_VALUE];
  if (/\bdebt\b|\bowe\b|\bcard balance\b/.test(q)) return [MeasureId.DEBT_BALANCE];
  if (/\brunway\b|\bmonths of\b|\bcoverage\b|\blast\b/.test(q)) return [MeasureId.RUNWAY_MONTHS];
  if (/\bcash\b|\bhave\b|\bsave\b|\bsavings?\b|\bleft\b|\bbalance\b/.test(q)) {
    return [MeasureId.LIQUID_CASH];
  }

  // ⚠️ A FOLLOW-UP WITH NO SUBJECT INHERITS THE LAST ANSWER'S. "And what about
  // February?" names no measure at all, and answering it with a default rather
  // than with what was just discussed is how a conversation becomes a sequence
  // of unrelated questions.
  const inherited = state.lastAnswer?.measureIds as MeasureIdName[] | undefined;
  if (inherited && inherited.length > 0) return inherited;
  return [MeasureId.LIQUID_CASH];
}

/**
 * The return basis this turn's scenario implies.
 *
 * An INVESTMENT_RETURN delta becomes a `SCENARIO_BAND` carrying the user's own
 * words; with none, investments are held FLAT — which is the honest base case,
 * not a limitation.
 */
function returnBasisOf(deltas: readonly AssumptionDelta[]): ReturnBasis {
  const d = [...deltas].reverse()
    .find((x) => x.dimension === DeltaDimension.INVESTMENT_RETURN);
  if (!d || d.payload.kind !== 'RETURN_PCT') return FLAT;
  return { kind: 'SCENARIO_BAND', pct: d.payload.pct, statedAs: d.statedAs };
}

/**
 * The question the forecast authorities are given.
 *
 * ⚠️ THE USER'S OWN SENTENCES, REPLAYED — never our paraphrase of them. An
 * ACTIVE spending or income delta is a supposition the user has not withdrawn,
 * and `assembleForecast` reads suppositions from `question` alone. Replaying
 * `statedAs` verbatim is what keeps the figure the scenario produces identical
 * to the figure the same sentence produced on the turn it was said.
 */
export function effectiveQuestion(question: string, active: readonly AssumptionDelta[]): string {
  const carried = active
    .filter((d) => d.dimension === DeltaDimension.SPENDING
      || d.dimension === DeltaDimension.INCOME)
    .map((d) => d.statedAs);
  return carried.length === 0 ? question : `${carried.join(' ')} ${question}`;
}

/**
 * The illustrative band for a volatile asset asked about at a future date.
 *
 * ⚠️ THIS IS THE ANSWER TO "WHAT WILL BITCOIN BE WORTH IN DECEMBER?", AND IT IS
 * THE WHOLE REGISTER THE BRIEF ASKED FOR:
 *
 *     "nobody knows where Bitcoin will be in December... if your portfolio stays
 *      flat, around A. At +5%, around B."
 *
 * A single flat number is a truthful answer and a poor one — the user asked what
 * it will be WORTH, and "the same as today, because we assume no change" reads
 * as a forecast of no change. Three evaluations make the shape of the uncertainty
 * visible without predicting anything.
 *
 * ⚠️ AND IT IS NOT A PREDICTION, WHICH IS WHY ±10% IS ALLOWED TO BE ARBITRARY.
 * A band produced from a MODEL of returns would be a forecast this product has
 * no authority to make — `ReturnBasis` has no `DERIVED_FROM_HISTORY` for exactly
 * that reason. A band produced from two ROUND NUMBERS is an illustration, it is
 * labelled as one, and it carries HYPOTHETICAL standing, which is the same thing
 * a user's own "what if it goes up 10%" carries.
 *
 * ⚠️ SUPPRESSED WHEN THE USER HAS ALREADY NAMED A SCENARIO. Their number is the
 * one that matters, and offering ours beside it would bury it.
 */
const ILLUSTRATIVE_PCT = 10;
const VOLATILE: MeasureIdName[] = [
  MeasureId.DIGITAL_ASSETS_VALUE, MeasureId.INVESTMENTS_VALUE,
];

function illustrativeBands(
  ids: readonly MeasureIdName[], active: readonly AssumptionDelta[],
  when: Instant, mc: MeasureContext,
): Measure[] {
  if (when.kind === 'NOW') return [];
  if (active.some((d) => d.dimension === DeltaDimension.INVESTMENT_RETURN)) return [];
  const out: Measure[] = [];
  for (const id of ids) {
    if (!VOLATILE.includes(id)) continue;
    for (const pct of [ILLUSTRATIVE_PCT, -ILLUSTRATIVE_PCT]) {
      const m = evaluate(id, when, {
        ...mc,
        returnBasis: { kind: 'SCENARIO_BAND', pct,
          statedAs: `an illustration only: ${pct > 0 ? '+' : ''}${pct}% — nobody knows` },
      });
      if (m.resolution.kind !== 'VALUE') continue;
      out.push({ ...m, scenarioId: `ILLUSTRATION_${pct > 0 ? 'UP' : 'DOWN'}`,
        label: `${m.label} if it moved ${pct > 0 ? 'up' : 'down'} by the share below `
          + '(an illustration, not a forecast)' });
      // ⚠️ THE PERCENTAGE NEEDS ITS OWN ADDRESS, AND PUTTING IT IN THE LABEL WAS
      // THE BUG. Measured: the model wrote "if Bitcoin goes up 10%", the `10%`
      // came from a licensed figure's LABEL and had no fid of its own, and a
      // correct answer was discarded. Handing the model an unaddressed number
      // inside a licensed label is the boundary undermining itself — the same
      // shape as the table printing a figure the verifier then rejected.
      out.push({
        id: id, at: when, scenarioId: `ILLUSTRATION_${pct > 0 ? 'UP' : 'DOWN'}`,
        resolution: { kind: 'VALUE', value: Math.abs(pct), standing: 'HYPOTHETICAL' },
        unit: 'PERCENT', label: `the ${pct > 0 ? 'upward' : 'downward'} move that `
          + 'illustration assumes (chosen as a round number, not predicted)',
        dependsOn: [],
      });
    }
  }
  return out;
}

export function resolveTurn(args: {
  messages: readonly Turn[];
  ctx: SpaceContext_AI;
  streams: readonly ResolvedIncomeStream[];
  asOfISO: string;
  defaultHorizon: ForecastHorizon;
  lastAnswer?: ConversationState['lastAnswer'];
  currency?: string;
  /**
   * Slice 5 — the planner's selection, when the planner owns this turn's class.
   *
   * ⚠️ IT REPLACES `selectMeasures` AND NOTHING ELSE. The scenario lifecycle,
   * the horizon, the fallback rules and every figure still come from exactly
   * where they came from before; what the planner changes is WHICH question is
   * being answered, which is the one thing it is allowed to decide. A wrong plan
   * costs relevance and cannot cost truth.
   */
  plan?: { measures: readonly MeasureIdName[]; horizon: { iso: string; statedAs: string } | null } | null;
}): TurnResolution {
  const { messages, ctx, streams, asOfISO, defaultHorizon } = args;
  const currency = args.currency ?? 'USD';
  const question = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  const state = deriveConversationState(messages, asOfISO,
    { currency, lastAnswer: args.lastAnswer ?? null });
  const active = activeDeltas(state);
  const scenario = currentScenario(state);

  // ⚠️ A TURN THAT DISMISSED IS A TURN THAT MUST SAY SO. "Okay, what's realistic
  // though?" changes the answer, and an answer that silently reverts to BASE
  // without saying it dropped the assumptions has changed the question under the
  // user.
  // ⚠️ THIS TURN, NOT EVER. A dismissal is news once. Re-announcing it on every
  // subsequent turn cost a correct answer: the model read the notice as "do not
  // use the scenarios below", answered "what will Bitcoin be worth?" with a
  // single flat figure, and called a FUTURE value "measured".
  const dismissedThisTurn = state.deltas.some((d) => d.dismissedAtTurn === state.turn);

  // ⚠️ THE CONVERSATION'S OWN HORIZON WINS OVER THE PLANNER'S. `deriveConversationState`
  // reads it from the user's messages across turns and a planner reading one
  // question cannot see turn 1's December. The planner fills a silence; it does
  // not overrule the history.
  const planHorizon = state.horizon ?? (args.plan?.horizon
    ? { iso: args.plan.horizon.iso, statedAs: args.plan.horizon.statedAs, statedAtTurn: state.turn }
    : null);
  const horizon: ForecastHorizon = planHorizon
    ? { ...defaultHorizon, toISO: planHorizon.iso, statedAs: planHorizon.statedAs }
    : defaultHorizon;
  const when: Instant = planHorizon ? at(planHorizon.iso) : at(horizon.toISO);

  let forecast: AssembledForecast | undefined;
  try {
    forecast = assembleForecast({
      ctx, streams, horizon, asOfISO,
      question: effectiveQuestion(question, active),
      messages,
    });
  } catch {
    forecast = undefined;
  }

  const mc: MeasureContext = {
    ctx, assessment: computeAssessment(ctx), forecast, currency,
    returnBasis: returnBasisOf(active),
  };

  const ids = args.plan?.measures && args.plan.measures.length > 0
    ? [...args.plan.measures]
    : selectMeasures(question, state);
  const bands = illustrativeBands(ids, active, when, mc);
  const withheld: LicensedRefusal[] = [];
  if (bands.length > 0) {
    withheld.push({
      subject: 'what these will actually be worth on that date',
      code: 'NO_EVIDENCE',
      detail: 'nobody can know a future market price, and this product does not '
        + 'estimate one. The figures offered are illustrations of what different '
        + 'moves would mean, not a view about which will happen.',
    });
  }
  const measures = ids.map((id) => {
    // ⚠️ THE SUBJECT IS THE MEASURE BEING ASKED ABOUT, and naming it is what
    // stops the persistence fallback answering a different question in the voice
    // of an answer.
    const m = evaluate(id, when, { ...mc, subject: id });
    return { ...m, scenarioId: scenario.id };
  });
  // The present is always available beside the future, so a present fact quoted
  // inside a forward-looking answer is licensed rather than collateral damage.
  const present = ids.map((id) => ({ ...evaluate(id, NOW, mc), scenarioId: 'BASE' }));

  // ⚠️ A DISMISSAL IS A FRAMING ITEM TOO. Rule 1 says every ACTIVE assumption
  // appears in the answer it prices; its mirror is that an answer which just
  // STOPPED assuming something has to say so, or the number changes under the
  // user with no explanation. Measured: with no such notice, the model
  // attributed an illustrative band to the user ("as you suggested") three turns
  // after they had dropped that very assumption.
  const framing = active.map((d) => d.statedAs);
  const dismissed = state.deltas.filter((d) => d.dismissedAtTurn === state.turn);
  if (dismissedThisTurn) {
    // ⚠️ THE DIMENSION, NOT THE AMOUNT — AND THIS IS THE SECOND TIME IN ONE SLICE
    // THAT PUTTING A NUMBER IN A LABEL BROKE THE BOUNDARY. The illustrative
    // band's "10%" lived in a figure's label and had no fid, and a correct
    // answer was discarded for it. Quoting the dismissed assumption's own
    // sentence here does exactly the same thing: it puts "$5K" in front of the
    // model inside text that carries no address.
    //
    // The amount is not lost — it is a PREMISE figure with its own id, from the
    // user's own turn, and the model may cite it like anything else. What this
    // line has to convey is that the assumptions are OFF, which is a fact about
    // status and needs no figure at all.
    // ⚠️ IT FORBIDS ATTRIBUTION, NOT USE — AND THE FIRST WORDING FORBADE BOTH.
    // "do not attribute any scenario below to them" was read as "do not use the
    // scenarios", and the answer collapsed to one number described as measured.
    // Illustrations are still the right answer to an unknowable question; what
    // must not happen is calling one the user's.
    framing.push('THE USER HAS DROPPED THEIR EARLIER ASSUMPTIONS ('
      + [...new Set(dismissed.map((d) => d.dimension.toLowerCase().replace(/_/g, ' ')))].join(', ')
      + '). Say so plainly. Any scenario or illustration below is OURS, offered to '
      + 'show a range — use them freely, and do not describe one as something the '
      + 'user asked for.');
    // ⚠️ A DISMISSED VALUE MUST STAY QUOTABLE, OR THE SYSTEM CANNOT TELL THE USER
    // WHAT IT STOPPED ASSUMING. Measured: the model wrote "dropping your
    // $5,000/month assumption" — exactly the right sentence — and the answer was
    // discarded, because with the delta dismissed no figure carried 5000 any
    // more. Dismissing an assumption removes its LICENCE TO PRICE AN ANSWER; it
    // does not remove the user's right to hear what they said.
    for (const dim of new Set(dismissed.map((d) => d.dimension))) {
      withheld.push({
        subject: `anything priced by the ${dim.toLowerCase().replace(/_/g, ' ')} `
          + 'assumption you asked me to make',
        code: 'NOT_APPLICABLE',
        detail: 'you have since asked for a realistic view, so nothing below rests '
          + 'on it any more. The figure you named is still yours to refer to — it '
          + "is listed under THE USER'S OWN NUMBERS.",
      });
    }
  }

  return {
    state: planHorizon === state.horizon ? state : { ...state, horizon: planHorizon },
    scenario, when,
    measures: [...measures, ...bands, ...present],
    forecast,
    framing,
    dismissedThisTurn,
    withheld,
  };
}
