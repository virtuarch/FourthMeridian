/**
 * lib/ai/intent/types.ts
 *
 * Layer 0 — Intent Routing (D4).
 *
 * Types for the deterministic question-understanding layer that runs BEFORE
 * prompt assembly. Layer 0 classifies the user's latest message and produces
 * routing metadata that Layer 3 (system-prompt assembly) injects as a
 * `=== QUESTION ROUTING ===` block so the LLM knows which parts of the
 * financial context should drive its answer.
 *
 * Design notes:
 *   - This layer NEVER touches the schema, DB queries, the Context Builder,
 *     Financial Intelligence calculations, or the model/provider. It reads a
 *     single string and returns a plain object.
 *   - `primarySections` / `supportingSections` / `suppressSections` reference
 *     the canonical context-domain keys declared in lib/ai/types.ts
 *     (FinanceDomains). They are advisory hints, not a filter — the builder
 *     still assembles the full context; the routing block only tells the LLM
 *     where to focus.
 */

import type { ContextDomain } from '@/lib/ai/types';

/**
 * Recognised financial intents. UNKNOWN is the safe fallback when no rule
 * matches with sufficient confidence.
 */
export const FinancialIntents = {
  CURRENT_DEBT_STATUS:         'CURRENT_DEBT_STATUS',
  DEBT_PAYOFF_PLAN:            'DEBT_PAYOFF_PLAN',
  DEBT_VS_INVESTING:           'DEBT_VS_INVESTING',
  SPENDING_REDUCTION:          'SPENDING_REDUCTION',
  CASH_FLOW_EXPLANATION:       'CASH_FLOW_EXPLANATION',
  GOAL_ALIGNMENT:              'GOAL_ALIGNMENT',
  INVESTMENT_READINESS:        'INVESTMENT_READINESS',
  UPDATE_KNOWLEDGE:            'UPDATE_KNOWLEDGE',
  GENERAL_FINANCIAL_OVERVIEW:  'GENERAL_FINANCIAL_OVERVIEW',
  UNKNOWN:                     'UNKNOWN',
} as const;

export type FinancialIntent =
  typeof FinancialIntents[keyof typeof FinancialIntents];

/**
 * Temporal framing of the question. Tells Layer 3 whether the answer should
 * lead with current state, historical aggregates, trends, or forward plans.
 */
export const TemporalFrames = {
  /** "Right now" — lead with current balances / current state. */
  CURRENT:    'CURRENT',
  /** "In the past" — lead with transaction history / prior periods. */
  HISTORICAL: 'HISTORICAL',
  /** "Over time" — lead with direction of change across periods. */
  TREND:      'TREND',
  /** "Going forward" — lead with projections / plans / scenarios. */
  PLANNING:   'PLANNING',
  /** No dominant temporal framing. */
  GENERAL:    'GENERAL',
} as const;

export type TemporalFrame =
  typeof TemporalFrames[keyof typeof TemporalFrames];

/**
 * Suggested shape of the answer. A hint for tone/structure only — the LLM
 * remains free to deviate when the data warrants.
 */
export const AnswerStyles = {
  DIRECT_STATUS: 'DIRECT_STATUS',
  PLAN:          'PLAN',
  TRADEOFF:      'TRADEOFF',
  RECOMMENDATION:'RECOMMENDATION',
  EXPLANATION:   'EXPLANATION',
  ASSESSMENT:    'ASSESSMENT',
  CONFIRM_ACTION:'CONFIRM_ACTION',
  OVERVIEW:      'OVERVIEW',
  CLARIFY:       'CLARIFY',
} as const;

export type AnswerStyle =
  typeof AnswerStyles[keyof typeof AnswerStyles];

/**
 * Transaction-window request modes (D6 dynamic windows).
 *
 *   DEFAULT        — no historical period detected; the assembler keeps its
 *                    standard 30-day (brief) / 90-day (full) window.
 *   YTD            — Jan 1 of the referenced/current year → today.
 *   LAST_N_MONTHS  — today minus N months → today.
 *   CALENDAR_MONTH — a whole calendar month (this month → today; last month →
 *                    the full prior calendar month).
 *   CUSTOM         — explicit caller-supplied bounds (reserved; not produced by
 *                    the deterministic detector yet).
 */
export const TransactionWindowModes = {
  DEFAULT:        'DEFAULT',
  YTD:            'YTD',
  LAST_N_MONTHS:  'LAST_N_MONTHS',
  CALENDAR_MONTH: 'CALENDAR_MONTH',
  CUSTOM:         'CUSTOM',
} as const;

export type TransactionWindowMode =
  typeof TransactionWindowModes[keyof typeof TransactionWindowModes];

/**
 * An optional, deterministically-resolved request to widen (or otherwise move)
 * the transaction-summary window based on the user's wording. Produced by
 * Layer 0 and threaded to the transactions assembler via BuildContextOptions.
 *
 * `startDate` / `endDate` are UTC calendar dates (YYYY-MM-DD), inclusive. They
 * are always populated for non-DEFAULT modes. `label` is a short human phrase
 * ("year-to-date 2026", "last 6 months") suitable for the provenance block.
 */
export interface TransactionWindowRequest {
  mode:       TransactionWindowMode;
  startDate?: string; // YYYY-MM-DD, inclusive floor
  endDate?:   string; // YYYY-MM-DD, inclusive ceiling
  label:      string;
}

/**
 * Routing metadata produced by classifyFinancialIntent().
 *
 * `confidence` is a 0..1 heuristic. It reflects how strongly the message
 * matched a rule; it is NOT a calibrated probability. Consumers may lower
 * their reliance on the route (or ask a clarifying question) at low values.
 */
export interface IntentRoute {
  /** The classified intent. */
  intent: FinancialIntent;
  /** Temporal framing that should shape the answer. */
  temporalFrame: TemporalFrame;
  /** Context-domain keys most relevant to the answer (should drive it). */
  primarySections: ContextDomain[];
  /** Context-domain keys that may be referenced briefly for support. */
  supportingSections: ContextDomain[];
  /** Context-domain keys that must NOT drive the answer. */
  suppressSections: ContextDomain[];
  /** Suggested answer shape. */
  answerStyle: AnswerStyle;
  /** Heuristic match strength in [0, 1]. */
  confidence: number;
  /**
   * Optional transaction-window request (D6 dynamic windows). Present only when
   * the message names a historical period; absent for general prompts, which
   * preserves the assembler's default 30/90-day behavior.
   */
  transactionWindow?: TransactionWindowRequest;
}
