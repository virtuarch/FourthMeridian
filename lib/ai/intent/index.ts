/**
 * lib/ai/intent/index.ts
 *
 * Barrel export for Layer 0 — Intent Routing (D4).
 */

export {
  FinancialIntents,
  TemporalFrames,
  AnswerStyles,
  TransactionWindowModes,
  type FinancialIntent,
  type TemporalFrame,
  type AnswerStyle,
  type IntentRoute,
  type TransactionWindowMode,
  type TransactionWindowRequest,
} from './types';

export { classifyFinancialIntent } from './classifier';
export { serializeRoutingBlock, confidenceBand, type RoutingConfidenceBand } from './prompt';

// KD-11: knowledge-gap gating heuristics (relocated from the chat route) and the
// authoritative keyword vocabulary now owned by this module.
export {
  detectsPayoffIntent,
  detectsExplicitUpdateIntent,
  PAYOFF_INTENT_KEYWORDS,
  UPDATE_ACTION_KEYWORDS,
  UPDATE_FIELD_KEYWORDS,
} from './gap-intent';
