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
