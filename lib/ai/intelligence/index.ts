/**
 * lib/ai/intelligence/index.ts
 *
 * Public API for the Layer 2 Financial Intelligence module (D4 v2).
 *
 * Usage:
 *   import { computeAssessment } from '@/lib/ai/intelligence';
 *   import type { FinancialAssessment } from '@/lib/ai/intelligence';
 *
 */

export { computeAssessment, computeSpendingTrends } from './annotations';

export type {
  FinancialAssessment,
  DataQualitySection,
  CashFlowSection,
  DebtSection,
  LiquiditySection,
  CapitalAllocationSection,
  CapitalAllocationRecommendation,
  CapitalAllocationEvidence,
  AllocationEvidenceDomain,
  DebtStrategySection,
  DebtPayoffUrgency,
  DebtCandidate,
  SpendingOpportunitySection,
  SpendingCategoryOpportunity,
  SpendingCategoryClassification,
  SpendingTrendsSection,
  MetricTrend,
  SpendingTrendMetric,
  TrendDirection,
  GoalAlignmentSection,
  GoalAlignmentItem,
  GoalAlignmentStatus,
  InvestmentReadinessSection,
  InvestmentReadinessClassification,
  RiskOpportunitySection,
  AssessmentRisk,
  AssessmentOpportunity,
  RiskCode,
  OpportunityCode,
  RiskSeverity,
  OpportunityImpact,
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
