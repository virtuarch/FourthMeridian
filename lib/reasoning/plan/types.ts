/**
 * lib/reasoning/plan/types.ts
 *
 * V26-REASONING Slice 5 — ONE PLANNER, AND THE SAFETY ARGUMENT IS ONE SENTENCE.
 *
 * ⚠️ NO FINANCIAL FIGURES GO IN AND NO FINANCIAL FIGURES COME OUT. The planner
 * receives a question, the conversation's state, and a catalogue of what CAN be
 * measured — never a balance, never a rate, never a projection. It returns which
 * measures to evaluate, at which instants, under which scenarios. A WRONG PLAN
 * COSTS RELEVANCE AND CANNOT COST TRUTH, and that is the entire safety argument
 * for letting a language model do this job at all. It is sufficient.
 *
 * ── What it replaces ────────────────────────────────────────────────────────
 * Sixteen readers of the user's message text, none of which agrees with the
 * others about what a question is:
 *
 *   lib/ai/intent/**            a classifier whose own output the prompt prints
 *   retrieval-plan.ts           ~20 regexes over concepts and breadth
 *   economic-concepts.ts        four breadth vocabularies
 *   chat/message-analysis.ts    eight keyword lists
 *   chat/conversation-scope.ts  eleven CLEAR patterns
 *   forecast/horizon.ts         forward-period patterns
 *   forecast/statements.ts      three statement shapes
 *   forecast/pay-dates.ts       three pay-date vocabularies
 *   reasoning/scenario/derive   this programme's own temporary extractor
 *
 * The measured cost of that sediment is on record. On "what are my projections?"
 * the intent classifier returns UNKNOWN / confidence 0.2 / CLARIFY, and the
 * prompt prints "briefly ask what the user wants to focus on rather than
 * guessing" DIRECTLY ABOVE a computed forecast.
 */

import type { MeasureIdName } from '../measure/types';

/** WHEN a measure is wanted. Mirrors the measure layer's own `Instant`. */
export type PlannedInstant = { kind: 'NOW' } | { kind: 'DATE'; iso: string };

/** A scenario the planner wants evaluated. */
export interface PlannedScenario {
  id: string;
  /** The user's own words, or 'if recent patterns continue' for BASE. */
  label: string;
  /**
   * ⚠️ A DELTA REFERENCE, NEVER A VALUE THE PLANNER CHOSE. The planner may say
   * "evaluate under the spending assumption the user stated at turn 2"; it may
   * not say "evaluate at $5,000/month". The number is the user's and reaches the
   * evaluator through `ConversationState`.
   */
  deltaIds: string[];
}

/** Operations on the conversation's state that this turn implies. */
export const StateOp = {
  /** The user stated a new assumption this turn. */
  SET_ASSUMPTION: 'SET_ASSUMPTION',
  /** "Okay, what's realistic though?" — drop every active assumption. */
  DISMISS_ALL:    'DISMISS_ALL',
  /** A follow-up with no subject of its own. */
  INHERIT_LAST:   'INHERIT_LAST',
  /** The user moved off a stated period back to no period at all. */
  CLEAR_HORIZON:  'CLEAR_HORIZON',
} as const;
export type StateOpName = typeof StateOp[keyof typeof StateOp];

/**
 * How much of the user's financial life the question reaches.
 *
 * ⚠️ THIS IS THE FIELD THE OLD ROUTING COULD NOT EXPRESS, and it is why broad
 * questions were the worst-served class. "How am I doing?" is not a spending
 * question or a debt question; it is every question at once, and a classifier
 * that must pick one returns UNKNOWN and asks for clarification.
 */
export type Breadth = 'NARROW' | 'BROAD';

export interface ReasoningPlan {
  measures:  MeasureIdName[];
  at:        PlannedInstant[];
  horizon:   { iso: string; statedAs: string } | null;
  scenarios: PlannedScenario[];
  stateOps:  StateOpName[];
  breadth:   Breadth;
  /** One line: what the planner understood. Shown in comparisons, never to the user. */
  reading:   string;
}

/** BASE is always present, and is what a plan with no scenarios means. */
export const BASE_PLANNED: PlannedScenario = {
  id: 'BASE', label: 'if recent patterns continue', deltaIds: [],
};
