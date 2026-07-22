/**
 * lib/ai/intelligence/annotations/index.ts
 *
 * Public barrel for the decomposed Financial Intelligence engine. Preserves the
 * exact export surface of the former single-file annotations.ts so every
 * consumer ('@/lib/ai/intelligence/annotations' and './annotations') resolves
 * unchanged. Internal cross-module exports (helpers, section engines) are NOT
 * forwarded here — encapsulation matches the pre-split private surface.
 */

export { computeAssessment } from './engine';
export {
  metricValue,
  reliableMonths,
  computeAverageMonthlySpending,
  computeSpendingTrends,
} from './metrics';

export type {
  CompletenessLevel,
  ConfidenceLevel,
  CashFlowReliability,
  DeficitCauseClassification,
  DebtHealthClassification,
  LiquidityCoverageClassification,
  CurrentStatePriority,
  AprCompleteness,
  AdvisorHeuristic,
  HeuristicSeverity,
  AssessmentPriority,
  DataQualitySection,
  CashFlowSection,
  DebtSection,
  LiquiditySection,
  CapitalAllocationRecommendation,
  CapitalAllocationSection,
  DebtPayoffUrgency,
  DebtCandidate,
  DebtStrategySection,
  AllocationEvidenceDomain,
  CapitalAllocationEvidence,
  SpendingCategoryClassification,
  SpendingCategoryOpportunity,
  SpendingOpportunitySection,
  TrendDirection,
  SpendingTrendMetric,
  MetricTrend,
  SpendingTrendsSection,
  GoalAlignmentStatus,
  GoalAlignmentItem,
  GoalAlignmentSection,
  InvestmentReadinessClassification,
  InvestmentReadinessSection,
  RiskSeverity,
  OpportunityImpact,
  RiskCode,
  OpportunityCode,
  AssessmentRisk,
  AssessmentOpportunity,
  RiskOpportunitySection,
  FinancialAssessment,
} from './types';
