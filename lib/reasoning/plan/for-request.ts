/**
 * lib/reasoning/plan/for-request.ts
 *
 * V26-REASONING Slice 5 — THE STRANGLER'S SEAM.
 *
 * ⚠️ TWO CLASSES FLIP, THREE DO NOT, AND THAT IS A MEASUREMENT RATHER THAN
 * CAUTION. Across 112 real questions harvested from this repository's own
 * corpora, harnesses and tests:
 *
 *   class            n    planner answered   overlap   legacy blank   legacy CLARIFY
 *   forecast        14         13/14          13/14          1              14
 *   broad            7          6/7            2/7           5               5
 *   spending-income 46         44/46          42/46          0              46
 *   debt             5          5/5            5/5           0               0
 *   other           40         37/40          18/40         21              37
 *
 * FORECAST and BROAD flip. On forecast the planner matches legacy's selection
 * and legacy asks for clarification on ALL FOURTEEN; on broad, legacy resolves
 * NOTHING on five of seven, which is the class this whole programme exists for.
 *
 * ⚠️ THE OTHER THREE DO NOT FLIP, AND THE REASON IS THE MEASURE CATALOGUE, NOT
 * THE PLANNER. A large share of `spending-income` and `other` are TRANSACTION
 * questions — "what was my biggest purchase", "who do I pay the most", "show me
 * the largest transactions", "do you have anything from 2025" — and there is no
 * MeasureId for a transaction record or for a coverage claim. Asked for the
 * biggest purchase the planner returned `real_assets_value, debt_balance,
 * net_worth`, which is a confident wrong reading of a question legacy's
 * domain routing serves correctly. `debt` is simpler: legacy is already right
 * on all five and asks for clarification on none, so there is nothing to win.
 *
 * The plan anticipated exactly this — "if a narrow legacy route is materially
 * better, preserve it until the planner actually earns replacement" — and this
 * is where it lands. Flipping those classes would trade a working route for a
 * vocabulary that cannot express the question.
 */

import { todayUTCISO } from '@/lib/time/clock';
import { Concepts } from '@/lib/ai/retrieval-plan';
import type { RetrievalPlan } from '@/lib/ai/retrieval-plan';
import { planTurn } from './planner';
import type { ReasoningPlan } from './types';
import { deriveConversationState, type Turn } from '../scenario/derive';
import type { ConversationState } from '../scenario/types';
import { resolveTurn, type TurnResolution } from '../scenario/turn';
import { loadForecastIncomeStreams } from '@/lib/ai/forecast/streams';
import { DEFAULT_HORIZON_MONTHS } from '@/lib/ai/forecast/for-request';
import { AssumptionOrigin } from '@/lib/ai/forecast/assemble';
import { addMonths } from '@/lib/perspectives/time-range';
import type { SpaceContext_AI } from '@/lib/ai/types';

export type ReasoningPath = 'legacy' | 'new';

/**
 * ⚠️ UNSET IS `legacy`. A strangler's new path arrives when somebody decides it
 * should, never by omission — which is the lesson `AI_FORECAST_GUARD_MODE`
 * taught expensively, in the other direction.
 */
export function resolveReasoningPath(raw: string | undefined): ReasoningPath {
  return String(raw ?? '').toLowerCase() === 'new' ? 'new' : 'legacy';
}

/**
 * The classes the planner owns, as of the recorded decision.
 *
 * ⚠️ THIS SET IS THE CUTOVER, AND IT GROWS ONLY WITH A NEW MEASUREMENT. When a
 * class flips, its legacy branch is deleted in the SAME COMMIT — never left
 * behind "just in case" — and `scripts/compare-plans.ts` is deleted when the
 * last class flips. This repository has shipped two shadow planners and ended
 * neither; that is why the ending is written down.
 */
export const FLIPPED_CLASSES = ['forecast', 'broad'] as const;

export interface PlannedTurn {
  plan:  ReasoningPlan;
  state: ConversationState;
}

/**
 * Plan this turn if the planner owns its class, or return null.
 *
 * ⚠️ NULL MEANS "LEGACY ANSWERS THIS", AND EVERY FAILURE PATH RETURNS IT. A
 * planner that threw, a plan that named no measure, a class that has not
 * flipped — all the same answer, all fall through to a path that works.
 */
export async function planForRequest(args: {
  question:  string;
  messages:  readonly Turn[];
  /** CF-8's plan, which is what decides whether this is a FORECAST turn. */
  retrieval?: RetrievalPlan;
  lastAnswer?: ConversationState['lastAnswer'];
  model?:    string;
}): Promise<PlannedTurn | null> {
  const asOfISO = todayUTCISO();
  const isForecast = args.retrieval?.concepts.includes(Concepts.FORECAST) ?? false;

  // ⚠️ PAY-DATE TURNS ARE EXPLICITLY NOT THE PLANNER'S. FORECAST-16's whole
  // finding is that a pay-date question is answered with DATES, and there is no
  // MeasureId for a date. Routing one here would hand it a catalogue of money
  // measures and get a money answer to a scheduling question.
  if (args.retrieval?.concepts.includes(Concepts.PAY_DATES)) return null;

  const state = deriveConversationState(args.messages, asOfISO,
    { lastAnswer: args.lastAnswer ?? null });

  let plan: ReasoningPlan | null;
  try {
    plan = await planTurn({ question: args.question, state, todayISO: asOfISO, model: args.model });
  } catch {
    return null;
  }
  if (plan === null) return null;

  // The class this turn belongs to, decided by the two authorities that are
  // entitled to say: CF-8 for FORECAST, and the planner itself for BROAD.
  const owned = isForecast || plan.breadth === 'BROAD';
  if (!owned) return null;

  return { plan, state };
}

/**
 * The whole planner seam, in one call — because the route's job is to sequence a
 * request.
 *
 * ⚠️ EXTRACTED FOR THE REASON `route-authority.aiarch` HAS ENFORCED THREE TIMES
 * ALREADY: the chat route is capped at 700 lines, and the answer to a block that
 * pushes it over is to move the block, not the ceiling. Inlining this took the
 * route to 732.
 *
 * Returns undefined whenever the legacy path should answer, and swallows every
 * failure to get there — a planning diagnostic must never cost a user their
 * answer.
 */
export async function resolvePlannedTurn(args: {
  enabled:    boolean;
  spaceId:    string;
  ctx?:       SpaceContext_AI;
  messages:   readonly Turn[];
  question:   string;
  retrieval?: RetrievalPlan;
  lastAnswer?: ConversationState['lastAnswer'];
}): Promise<TurnResolution | undefined> {
  if (!args.enabled || !args.ctx) return undefined;
  try {
    const planned = await planForRequest({
      question: args.question, messages: args.messages,
      retrieval: args.retrieval, lastAnswer: args.lastAnswer,
    });
    if (!planned) return undefined;

    const asOfISO = todayUTCISO();
    return resolveTurn({
      messages: args.messages, ctx: args.ctx,
      streams: await loadForecastIncomeStreams(args.spaceId, asOfISO),
      asOfISO,
      // The same disclosed default the forecast path uses, so a question with no
      // period gets one answer rather than two.
      defaultHorizon: {
        fromISO: asOfISO, toISO: addMonths(asOfISO, DEFAULT_HORIZON_MONTHS),
        origin: AssumptionOrigin.SYSTEM_POLICY,
        statedAs: `no period was named; the default ${DEFAULT_HORIZON_MONTHS}-month horizon applies`,
      },
      plan: planned.plan,
    });
  } catch (err) {
    console.error('[ai/plan] planning failed (non-fatal):', err);
    return undefined;
  }
}
