/**
 * lib/ai/intelligence/index.ts
 *
 * Public API for the Layer 2 Financial Intelligence module (D4 v2).
 *
 * Usage:
 *   import { computeAssessment } from '@/lib/ai/intelligence';
 *   import type { FinancialAssessment } from '@/lib/ai/intelligence';
 *
 * Backward-compat aliases:
 *   computeAnnotations  → computeAssessment
 *   FinancialAnnotations → FinancialAssessment
 */

export { computeAssessment, computeAnnotations } from './annotations';

export type {
  FinancialAssessment,
  FinancialAnnotations,
  DataQualitySection,
  CashFlowSection,
  DebtSection,
  LiquiditySection,
  AssessmentPriority,
  AdvisorHeuristic,
  HeuristicSeverity,
  AprCompleteness,
  CompletenessLevel,
  ConfidenceLevel,
  CashFlowReliability,
  DeficitCauseClassification,
  DebtHealthClassification,
  LiquidityCoverageClassification,
  CurrentStatePriority,
} from './annotations';
