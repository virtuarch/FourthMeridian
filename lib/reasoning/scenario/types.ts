/**
 * lib/reasoning/scenario/types.ts
 *
 * V26-REASONING Slice 4 — LIFECYCLE, NOT FORGETTING.
 *
 * ── The rule this replaces, and why it was the wrong solution ───────────────
 * `fact-continuity.ts:40-44` makes assumptions per-turn by explicit doctrine —
 * only the horizon survives:
 *
 *     "'Assume I spend $4,000' three turns ago must not silently price today's
 *      answer, and the two semantics are kept apart by which function reads
 *      them."
 *
 * The concern is exactly right. A stale assumption silently pricing today's
 * answer is a real defect and FORECAST-13 was correct to close it. But the rule
 * breaks four of the five turns of the conversation this product is for:
 *
 *     "Nah, assume I spend $5K/month."       -> "What would my net worth be?"
 *     -> "What if Bitcoin goes up 10%?"      -> "And what about February?"
 *
 * Every one of those follow-ups is meaningless if the previous assumption is
 * gone. What is needed is not memory and not forgetting — it is LIFECYCLE. A
 * delta that is ACTIVE, visible in every answer it prices, and dismissable in
 * one sentence is not a stale assumption; it is a stated one.
 *
 * ── The five rules that make this safe ──────────────────────────────────────
 *
 * 1. EVERY ACTIVE DELTA APPEARS IN THE ANSWER IT PRICES. Not a style preference
 *    — it is passed to narration as a required framing item. An assumption the
 *    user cannot see is the dangerous one; an assumption named in every sentence
 *    it prices is not.
 * 2. DELTAS SUPERSEDE, NEVER OVERWRITE. `statedAtTurn`, `effectiveFrom/Until`,
 *    `supersededBy`. This is the temporal semantics memory will eventually need,
 *    built for the in-conversation case first, where it costs nothing.
 * 3. `DISMISS_ALL` IS A FIRST-CLASS OPERATION. "Okay, what's realistic though?"
 *    sets every ACTIVE delta to DISMISSED and re-evaluates BASE.
 * 4. AN ASSUMPTION LICENSES A CALCULATION; IT NEVER REWRITES A FACT.
 *    `assemble.ts` already enforces this and it is one of the best invariants in
 *    the codebase. Carried verbatim.
 * 5. SCOPED TO THE CONVERSATION. NEVER PERSISTED. That is precisely the line
 *    between conversation state and memory, and it is why this ships now and
 *    memory does not.
 */

/** What a delta changes. Four dimensions, closed. */
export const DeltaDimension = {
  SPENDING:          'SPENDING',
  INCOME:            'INCOME',
  INVESTMENT_RETURN: 'INVESTMENT_RETURN',
  ONE_OFF_EVENT:     'ONE_OFF_EVENT',
} as const;
export type DeltaDimensionName = typeof DeltaDimension[keyof typeof DeltaDimension];

export const DeltaStatus = {
  ACTIVE:     'ACTIVE',
  SUPERSEDED: 'SUPERSEDED',
  DISMISSED:  'DISMISSED',
} as const;
export type DeltaStatusName = typeof DeltaStatus[keyof typeof DeltaStatus];

/** The value a delta carries, by dimension. */
export type DeltaPayload =
  | { kind: 'MONTHLY_AMOUNT'; value: number; currency: string }
  | { kind: 'RETURN_PCT';     pct: number }
  | { kind: 'ONE_OFF';        value: number; currency: string; dateISO: string | null };

export interface AssumptionDelta {
  id: string;
  dimension: DeltaDimensionName;
  /**
   * The user's own words. REQUIRED, and required by the type rather than by a
   * convention somebody has to remember.
   *
   * ⚠️ THIS IS RULE 1'S MECHANISM. Narration renders `statedAs`, so an
   * assumption cannot price an answer without appearing in it.
   */
  statedAs: string;
  /** 0-based index among USER turns. */
  statedAtTurn: number;
  effectiveFrom:  string | null;
  effectiveUntil: string | null;
  status: DeltaStatusName;
  /** The delta that replaced this one. Set on SUPERSEDED, never on DISMISSED. */
  supersededBy?: string;
  /**
   * The turn on which this was dismissed. Set only on DISMISSED.
   *
   * ⚠️ WITHOUT IT, "A DISMISSAL HAPPENED" AND "A DISMISSAL HAPPENED THIS TURN"
   * ARE THE SAME QUESTION, and they are not. Measured: the turn after
   * "what's realistic though?" also announced the dismissal, and the model read
   * "do not attribute any scenario below to them" as "do not use the scenarios",
   * answered with a single flat figure, and called a FUTURE value "measured".
   */
  dismissedAtTurn?: number;
  payload: DeltaPayload;
}

export interface Scenario {
  id: string;
  label: string;
  deltas: AssumptionDelta[];
}

export const BASE: Scenario = {
  id: 'BASE',
  label: 'if recent patterns continue',
  deltas: [],
};

/** What the previous answer was about, so a follow-up can inherit it. */
export interface LastAnswer {
  measureIds: string[];
  scenarioIds: string[];
  /** The instant the last answer was about, so "what about February?" has a subject. */
  horizonISO: string | null;
}

export interface ConversationState {
  turn: number;
  horizon: { iso: string; statedAs: string; statedAtTurn: number } | null;
  /**
   * The FULL history, status-flagged, never overwritten.
   *
   * ⚠️ SUPERSEDED AND DISMISSED ROWS ARE KEPT, and that is rule 2. "Make that
   * $6K instead" does not erase the $5K it replaced — it records that at turn 2
   * the user said $5K and at turn 4 they said $6K, which is a different and
   * truer thing, and it is the shape a checkpoint will eventually need.
   */
  deltas: AssumptionDelta[];
  lastAnswer: LastAnswer | null;
}

export const activeDeltas = (s: ConversationState): AssumptionDelta[] =>
  s.deltas.filter((d) => d.status === DeltaStatus.ACTIVE);

/** The scenario the current turn is evaluated under. */
export function currentScenario(s: ConversationState): Scenario {
  const active = activeDeltas(s);
  if (active.length === 0) return BASE;
  return {
    id: `S${s.turn}`,
    label: active.map((d) => d.statedAs).join('; '),
    deltas: active,
  };
}
