/**
 * lib/ai/intelligence/annotations.ts
 *
 * Layer 2 Financial Intelligence — D4 v2.
 *
 * computeAssessment() runs a deterministic, single-pass analysis over an
 * already-assembled SpaceContext_AI and returns a FinancialAssessment object.
 * The assessment is injected into the system prompt as a === FINANCIAL ASSESSMENT ===
 * block, giving the LLM interpreted financial state before it reads raw context numbers.
 *
 * Changes from Slice 1:
 *   - Flat FinancialAnnotations replaced by typed sections:
 *       dataQuality, cashFlow, debt, liquidity
 *   - Each section carries its own confidence level.
 *   - New: advisorHeuristics — deterministic typed flags (no prose).
 *   - New: priorities — ranked, severity-coded hints for the LLM.
 *   - computeAnnotations is kept as a backward-compat alias.
 *
 * Design constraints (unchanged from Slice 1):
 *   - Pure function. No DB queries, no LLM calls, no side effects.
 *   - Called after buildContext() and before prompt construction.
 *   - All classification thresholds are named constants.
 *   - Never import from lib/plaid/encryption or any decrypt function.
 *
 * Principle:
 *   The deterministic layer computes math, classifications, confidence, and
 *   explainability. The LLM decides how to phrase, prioritize, and recommend
 *   based on the user's actual question.
 */

import type {
  SpaceContext_AI,
  TransactionsSummaryData,
  SnapshotSectionData,
  AccountsSectionData,
  GoalsSectionData,
} from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';

// ── Primitive classification types ────────────────────────────────────────────

export type CompletenessLevel  = 'LOW' | 'MEDIUM' | 'HIGH';
export type ConfidenceLevel    = 'LOW' | 'MEDIUM' | 'HIGH';
export type CashFlowReliability = 'UNRELIABLE' | 'PARTIAL' | 'RELIABLE';

export type DeficitCauseClassification =
  | 'INTENTIONAL_DEBT_PAYOFF'  // debt payments dominate + active debt goal confirms strategy
  | 'POSSIBLE_OVERSPENDING'    // deficit not explained by intentional debt payoff
  | 'LOW_INCOME_SAMPLE'        // income data is incomplete — deficit is a data artifact
  | 'MIXED'                    // significant debt payments but not dominant cause
  | 'NOT_APPLICABLE';          // no deficit (cash flow ≥ 0)

export type DebtHealthClassification =
  | 'CRITICAL'          // high-APR debt needing urgent attention
  | 'WARNING'           // elevated APR worth active management
  | 'IMPROVING'         // liabilities declining over snapshot window
  | 'HEALTHY'           // APR manageable and not rising
  | 'INSUFFICIENT_DATA' // APR missing for one or more debt accounts
  | 'NO_DEBT';          // no liabilities in context

export type LiquidityCoverageClassification =
  | 'CRITICAL'   // < 1 month
  | 'WARNING'    // 1 – 2 months
  | 'SAFE'       // 3 – 5 months
  | 'EXCELLENT'  // ≥ 6 months
  | 'UNKNOWN';   // cannot compute (no expense data or no liquid accounts)

export type CurrentStatePriority =
  | 'DATA_QUALITY'  // incomplete data overrides all other findings
  | 'LIQUIDITY'     // critically low or notably high liquid coverage
  | 'DEBT'          // critical or warning-level debt health
  | 'CASH_FLOW'     // spending problem or intentional payoff to surface
  | 'GOALS'         // goal needs attention
  | 'GOALS_GOOD';   // position looks healthy — affirm progress

/** Whether APR is known for all, some, or no FULL-visibility debt accounts. */
export type AprCompleteness = 'FULL' | 'PARTIAL' | 'NONE';

// ── Advisor heuristics ────────────────────────────────────────────────────────

/**
 * Deterministic typed flags the LLM uses to calibrate its advice.
 * These are structured facts, not prose recommendations.
 * The LLM decides how to apply them to the user's specific question.
 */
export type AdvisorHeuristic =
  | 'HIGH_APR_DEBT_PRIORITY'                  // CRITICAL or WARNING debt classification
  | 'DATA_QUALITY_LIMITS_CASH_FLOW_ADVICE'    // income confidence is LOW
  | 'LIQUIDITY_UNKNOWN_FOR_SPACE'             // accounts present but no liquid accounts in this Space
  | 'DEBT_PAYOFF_IS_INTENTIONAL'              // INTENTIONAL_DEBT_PAYOFF or MIXED deficit cause
  | 'APR_REQUIRED_FOR_PRECISE_PAYOFF'         // hasNullAPR with outstanding liabilities
  | 'INCOME_INCOMPLETE_DO_NOT_DEFICIT_FRAME'  // income confidence LOW — never frame as cash deficit
  | 'LOW_LIQUIDITY_COVERAGE';                 // CRITICAL or WARNING liquidity classification

export type HeuristicSeverity = 'info' | 'warning' | 'critical';

/**
 * A single ranked priority hint.
 * Not a recommendation — deterministic input for LLM reasoning.
 */
export interface AssessmentPriority {
  code:     CurrentStatePriority;
  severity: HeuristicSeverity;
  reason:   string;
}

// ── Typed assessment sections ─────────────────────────────────────────────────

export interface DataQualitySection {
  transactionHistoryCompleteness: CompletenessLevel;
  snapshotSpanDays:               number;
  incomeConfidence:               ConfidenceLevel;
  incomeTransactionCount:         number;
}

export interface CashFlowSection {
  reliability:                  CashFlowReliability;
  /** Mirrors income confidence — income is the volatile input in the cash flow equation. */
  confidence:                   ConfidenceLevel;
  deficitCause:                 DeficitCauseClassification;
  transactionCompleteness:      CompletenessLevel;
  impliedMonthlyIncome:         number | null;
  estimatedMonthlyExpenses:     number | null;
  /** Annualized debt payment flow divided into monthly equivalent. Reliable when window is ≥ 30 days. */
  estimatedMonthlyDebtPayments: number | null;
  incomeTransactionCount:       number;
  /**
   * True when income confidence is LOW.
   * Instructs the LLM not to declare negative cash flow as a fact —
   * the apparent deficit is a data artifact.
   */
  incompleteIncomeWarning:      boolean;
}

export interface DebtSection {
  classification:        DebtHealthClassification;
  /**
   * HIGH   — all FULL-visibility debt APRs are known.
   * MEDIUM — some FULL-visibility debt APRs known, some missing.
   * LOW    — no APRs known, or no FULL-visibility debt accounts.
   */
  confidence:            ConfidenceLevel;
  totalLiabilities:      number;
  monthlyInterestBurden: number | null;
  /** APR coverage across FULL-visibility debt accounts only. */
  aprCompleteness:       AprCompleteness;
  /** True when any debt account (FULL or BALANCE_ONLY) has no APR available. */
  hasNullAPR:            boolean;
  /**
   * True when any debt account is BALANCE_ONLY — APR is structurally inaccessible
   * in this Space, not a missing user-input problem.
   */
  hasBalanceOnlyDebt:    boolean;
  /**
   * Names of FULL-visibility debt accounts where APR is null (user can fix these).
   * Never contains BALANCE_ONLY account names.
   */
  aprGapAccountNames:    string[];
}

export interface LiquiditySection {
  classification:          LiquidityCoverageClassification;
  /**
   * HIGH   — liquid accounts present in this Space, balance data reliable.
   * MEDIUM — accounts present but no liquid accounts linked to this Space.
   * LOW    — no accounts domain at all.
   */
  confidence:              ConfidenceLevel;
  liquidCashTotal:         number;
  liquidAccountCount:      number;
  coverageMonths:          number | null;
  estimatedMonthlyExpense: number | null;
  /**
   * True when the accounts domain was assembled (hasAccountsDomain)
   * but no checking or savings accounts are linked to this Space.
   * Liquid assets may exist in other Spaces — the LLM must not say the
   * user has no liquid cash globally.
   */
  noLiquidAccountsInSpace: boolean;
  /** False when the accounts domain was not assembled for this Space. */
  hasAccountsDomain:       boolean;
}

// ── 2.1 Capital Allocation Engine ─────────────────────────────────────────────

/**
 * Classification of the primary capital allocation context.
 * The LLM uses this as a framing input — NOT as a final recommendation.
 */
export type CapitalAllocationRecommendation =
  | 'BUILD_LIQUIDITY'        // liquidity CRITICAL/WARNING — stabilise cash before anything else
  | 'PAY_HIGH_APR_DEBT'     // debt CRITICAL/WARNING and liquidity is safe
  | 'DEBT_BEFORE_INVESTING'  // weighted APR exceeds market return reference; liquidity safe
  | 'INVEST_ELIGIBLE'        // debt manageable, liquidity safe, investing context supported
  | 'BLOCKED_BY_DATA';       // insufficient data to classify

/**
 * Deterministic inputs for capital allocation framing.
 * Layer 2 computes math/thresholds only. Final recommendation stays with the LLM.
 *
 * `evidence` exposes numeric facts the LLM can quote directly (APR, guaranteed return
 * advantage, interest burden, coverage months).
 * `primaryEvidence` / `ignoredEvidence` tell the LLM which data domains drove this
 * recommendation — enabling it to say "although income data is incomplete, this
 * recommendation is driven by your debt APR and liquid coverage."
 */
export interface CapitalAllocationSection {
  recommendation:              CapitalAllocationRecommendation;
  confidence:                  ConfidenceLevel;
  liquidCashAvailable:         number;
  highInterestDebtPresent:     boolean;
  liquidityFirstRequired:      boolean;
  /** True when debt exists but one or more APR values are missing — blocks precise comparison. */
  missingAprPreventsComparison: boolean;
  /** Data gaps that prevent a precise classification. */
  blockers:                    string[];
  /** Concrete numeric facts for the LLM to quote when explaining the recommendation. */
  evidence:                    CapitalAllocationEvidence;
  /** Data domains that primarily drove the recommendation. */
  primaryEvidence:             AllocationEvidenceDomain[];
  /** Data domains that are unreliable or irrelevant to this recommendation. */
  ignoredEvidence:             AllocationEvidenceDomain[];
}

// ── 2.2 Debt Strategy Engine ──────────────────────────────────────────────────

/** Urgency of debt payoff action, derived from debt classification. */
export type DebtPayoffUrgency = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' | 'NONE' | 'UNKNOWN';

/** A single debt account as a payoff strategy candidate. */
export interface DebtCandidate {
  accountName: string;
  balance:     number;
  /** null when APR is structurally inaccessible (balance-only account or missing user input). */
  apr:         number | null;
}

/**
 * Deterministic debt payoff strategy inputs.
 * Identifies avalanche/snowball candidates and quantifies the interest burden.
 * No payoff schedule — minimum-payment data is too often null to be reliable.
 */
export interface DebtStrategySection {
  confidence:                 ConfidenceLevel;
  payoffUrgency:              DebtPayoffUrgency;
  /** Highest-APR FULL-visibility account — the avalanche strategy target. null if APR unknown everywhere. */
  avalancheCandidate:         DebtCandidate | null;
  /** Lowest-balance debt account — the snowball strategy target. null if no accounts available. */
  snowballCandidate:          DebtCandidate | null;
  /** Weighted average APR across accounts where APR is known. null if none known. */
  weightedAvgApr:             number | null;
  knownMonthlyInterestBurden: number | null;
  missingAprAccountNames:     string[];
  hasBalanceOnlyDebt:         boolean;
}

// ── 2.1 Capital Allocation — evidence enhancement ─────────────────────────────

/**
 * Named data domains that drive or are irrelevant to a capital allocation decision.
 * Used in primaryEvidence / ignoredEvidence so the LLM can explain its reasoning.
 */
export type AllocationEvidenceDomain = 'cashFlow' | 'debt' | 'liquidity' | 'investments' | 'goals';

/**
 * Concrete numeric facts for the LLM to quote directly.
 * Layer 2 computes; LLM explains.
 */
export interface CapitalAllocationEvidence {
  /** Weighted average APR across FULL-visibility debt accounts with known APR. null if none known. */
  weightedDebtApr:           number | null;
  /** Passive-index annual return reference used as the investing comparison baseline. */
  expectedMarketReturn:      number;
  /**
   * weightedDebtApr − expectedMarketReturn.
   * Positive = paying down debt yields a better guaranteed return than the market reference.
   * null when APR is unknown for any debt account.
   */
  guaranteedReturnAdvantage: number | null;
  /** APR data coverage across FULL-visibility debt accounts. */
  aprCompleteness:           AprCompleteness;
  /** Liquid cash coverage in months. null if not computable. */
  liquidityMonths:           number | null;
  /** Known monthly cost of carrying current debt. null when APR is missing. */
  monthlyInterestBurden:     number | null;
}

// ── 2.3 Spending Opportunity Engine types ─────────────────────────────────────

/** Classification of a transaction category for spending opportunity analysis. */
export type SpendingCategoryClassification =
  | 'DISCRETIONARY'      // flexible, reducible: Dining, Shopping, Travel, Subscriptions
  | 'SEMI_DISCRETIONARY' // necessary but amount varies: Groceries
  | 'FIXED'              // typically non-negotiable: Utilities
  | 'REVIEW_NEEDED';     // uncertain or catch-all: Other

/** A single expense category with monthly equivalent and opportunity classification. */
export interface SpendingCategoryOpportunity {
  category:          string;
  monthlyEquivalent: number;
  classification:    SpendingCategoryClassification;
  transactionCount:  number;
}

/**
 * Deterministic spending opportunity facts.
 * Classifies and ranks expense categories.
 * No moralizing — Layer 2 computes; LLM decides what to surface.
 */
export interface SpendingOpportunitySection {
  confidence:              ConfidenceLevel;
  windowDays:              number;
  /** Expense categories sorted by monthly equivalent descending. Excludes Income/Interest/Transfer/Payment. */
  topCategories:           SpendingCategoryOpportunity[];
  /** Sum of monthly equivalents for DISCRETIONARY categories. */
  discretionaryTotal:      number;
  /** Largest DISCRETIONARY category — highest-leverage reduction opportunity. */
  topReductionOpportunity: SpendingCategoryOpportunity | null;
  /** Categories classified as REVIEW_NEEDED with ≥ $20/mo in spend. */
  categoriesNeedingReview: string[];
  hasTransactionData:      boolean;
}

// ── 2.4 Goal Alignment Engine types ──────────────────────────────────────────

/** Alignment status of a single goal based on observable behavior. */
export type GoalAlignmentStatus =
  | 'ALIGNED'            // behavior clearly supports this goal
  | 'LIKELY_ALIGNED'     // partial or indirect evidence of alignment
  | 'MISALIGNED'         // behavior appears to conflict with goal
  | 'INSUFFICIENT_DATA'; // cannot assess from available context

/** Alignment assessment for a single active goal. */
export interface GoalAlignmentItem {
  goalId:    string;
  goalName:  string;
  goalType:  string;
  status:    GoalAlignmentStatus;
  /** One-line deterministic fact supporting the classification. */
  evidence:  string;
  /** Data that would improve confidence. Omitted when assessment is confident. */
  blocker?:  string;
}

/** Aggregate goal alignment across all active goals in the Space. */
export interface GoalAlignmentSection {
  confidence:      ConfidenceLevel;
  overallStatus:   'ALIGNED' | 'MIXED' | 'MISALIGNED' | 'INSUFFICIENT_DATA';
  alignedCount:    number;
  misalignedCount: number;
  blockedCount:    number;
  goalAlignments:  GoalAlignmentItem[];
  hasGoalsDomain:  boolean;
  activeGoalCount: number;
}

// ── 2.5 Investment Readiness Engine types ─────────────────────────────────────

/** Readiness context for investing, derived from liquidity and debt without requiring holdings data. */
export type InvestmentReadinessClassification =
  | 'READY'                 // liquidity safe, debt manageable — conditions support investing
  | 'CONDITIONALLY_READY'  // some debt or uncertain liquidity, but not a clear blocker
  | 'DEBT_FIRST'            // high-APR debt or APR > market return — resolve before investing
  | 'BUILD_LIQUIDITY_FIRST' // emergency fund too low — stabilise before investing
  | 'BLOCKED_BY_DATA';      // insufficient account data to assess

/**
 * Deterministic investment readiness context.
 * Assesses pre-conditions for investing without requiring holdings data.
 * Does not give investment advice — only whether the context supports it.
 */
export interface InvestmentReadinessSection {
  classification:        InvestmentReadinessClassification;
  confidence:            ConfidenceLevel;
  /** Whether HOLDINGS_SUMMARY domain was assembled in this context. */
  holdingsDomainPresent: boolean;
  liquiditySafe:         boolean;  // classification is SAFE or EXCELLENT
  highAprDebtPresent:    boolean;  // debt classification is CRITICAL or WARNING
  /** True when weighted APR exceeds market return reference. null if APR incomplete. */
  debtBeatsMarket:       boolean | null;
  blockers:              string[];
}

// ── 2.6 Risk & Opportunity Engine types ──────────────────────────────────────

/** Severity of a detected risk. */
export type RiskSeverity = 'info' | 'warning' | 'critical';

/** Potential impact of a detected opportunity. */
export type OpportunityImpact = 'low' | 'medium' | 'high';

/**
 * Deterministic risk candidate codes.
 * Each maps to a rule that aggregates one or more existing assessment sections.
 * Not exhaustive advice — candidates for the LLM to reason from.
 */
export type RiskCode =
  | 'LOW_LIQUIDITY'
  | 'INCOMPLETE_INCOME_DATA'
  | 'CASH_FLOW_UNRELIABLE'
  | 'HIGH_INTEREST_DEBT'
  | 'APR_MISSING_FOR_DEBT'
  | 'DEBT_PAYOFF_BLOCKED_BY_DATA'
  | 'GOALS_MISALIGNED'
  | 'INVESTING_NOT_READY'
  | 'HISTORY_INCOMPLETE';

/**
 * Deterministic opportunity candidate codes.
 * Each maps to a rule that aggregates one or more existing assessment sections.
 */
export type OpportunityCode =
  | 'CUT_TOP_DISCRETIONARY_CATEGORY'
  | 'REVIEW_OTHER_CATEGORY'
  | 'PAY_HIGH_APR_DEBT'
  | 'BUILD_EMERGENCY_FUND'
  | 'IMPROVE_DATA_QUALITY'
  | 'ALIGN_SPENDING_WITH_GOALS'
  | 'READY_TO_INVEST'
  | 'EXPAND_TRANSACTION_HISTORY';

/**
 * A single detected risk.
 * `code` is a RiskCode value (typed as string per the section contract).
 * `evidence` is a one-line deterministic fact drawn from existing sections.
 * `affectedSections` lists the FinancialAssessment section keys this risk aggregates.
 */
export interface AssessmentRisk {
  code:             string;
  severity:         RiskSeverity;
  confidence:       ConfidenceLevel;
  evidence:         string;
  affectedSections: string[];
}

/**
 * A single detected opportunity.
 * `code` is an OpportunityCode value (typed as string per the section contract).
 */
export interface AssessmentOpportunity {
  code:             string;
  impact:           OpportunityImpact;
  confidence:       ConfidenceLevel;
  evidence:         string;
  affectedSections: string[];
}

/**
 * Deterministic aggregation of existing FinancialAssessment sections into
 * ranked risk and opportunity candidates.
 *
 * This engine AGGREGATES — it never recalculates from raw context. It reads the
 * classifications, confidences, and metrics already produced by sections 2.1–2.5
 * plus the base sections, and emits candidate risks/opportunities for the LLM to
 * reason from. It does not produce final recommendations.
 *
 * Risks are sorted by severity (critical → warning → info) then confidence
 * (HIGH → MEDIUM → LOW). Opportunities are sorted by impact (high → medium → low)
 * then confidence. The serializer surfaces only the top few of each to the prompt.
 */
export interface RiskOpportunitySection {
  risks:         AssessmentRisk[];
  opportunities: AssessmentOpportunity[];
  confidence:    ConfidenceLevel;
}

// ── Main v2 type ──────────────────────────────────────────────────────────────

/**
 * Structured financial assessment produced by computeAssessment().
 *
 * Replaces the flat FinancialAnnotations from Slice 1.
 * Each section owns its classification, confidence, and supporting metrics.
 * The LLM receives this as the FINANCIAL ASSESSMENT prompt block.
 *
 * Layer 2 engines:
 *   capitalAllocation    — 2.1 Capital Allocation Engine (with evidence)
 *   debtStrategy         — 2.2 Debt Strategy Engine
 *   spendingOpportunities — 2.3 Spending Opportunity Engine
 *   goalAlignment        — 2.4 Goal Alignment Engine
 *   investmentReadiness  — 2.5 Investment Readiness Engine
 *   riskOpportunities    — 2.6 Risk & Opportunity Engine (aggregates 2.1–2.5 + base)
 */
export interface FinancialAssessment {
  dataQuality:           DataQualitySection;
  cashFlow:              CashFlowSection;
  debt:                  DebtSection;
  liquidity:             LiquiditySection;
  capitalAllocation:     CapitalAllocationSection;      // 2.1
  debtStrategy:          DebtStrategySection;           // 2.2
  spendingOpportunities: SpendingOpportunitySection;    // 2.3
  goalAlignment:         GoalAlignmentSection;          // 2.4
  investmentReadiness:   InvestmentReadinessSection;    // 2.5
  riskOpportunities:     RiskOpportunitySection;        // 2.6
  /** Top-ranked priority — used by the prompt for the leading instruction. */
  currentStatePriority:  CurrentStatePriority;
  /** Typed advisor flags derived deterministically from the sections above. */
  advisorHeuristics:     AdvisorHeuristic[];
  /** Ranked list of active priorities — deterministic hints, not recommendations. */
  priorities:            AssessmentPriority[];
}

/**
 * Backward-compat alias.
 * Slice 1 callers that imported FinancialAnnotations still compile; they must
 * update field access from flat (annotations.incomeConfidence) to nested
 * (assessment.dataQuality.incomeConfidence).
 */
export type FinancialAnnotations = FinancialAssessment;

// ── Thresholds ────────────────────────────────────────────────────────────────

const SNAPSHOT_LOW_THRESHOLD    = 14;
/** Reference passive-index annual return (%) used to determine whether debt payoff beats investing. */
const MARKET_RETURN_THRESHOLD   = 7;
const SNAPSHOT_HIGH_THRESHOLD   = 45;
const TXN_COUNT_MINIMUM         = 20;
const INCOME_PLAUS_RATIO_LOW    = 0.5;
const INCOME_TXN_HIGH_THRESHOLD = 3;
const APR_CRITICAL_THRESHOLD    = 22;
const APR_WARNING_THRESHOLD     = 15;
const LIQUIDITY_CRITICAL_MONTHS = 1;
const LIQUIDITY_WARNING_MONTHS  = 3;
const LIQUIDITY_EXCELLENT_MONTHS = 6;
const DEBT_FRACTION_DOMINANT    = 0.5;
const DEBT_FRACTION_PARTIAL     = 0.25;
/** Minimum monthly equivalent ($) for a REVIEW_NEEDED category to be surfaced. */
const REVIEW_MIN_MONTHLY        = 20;
/** Days without a habit check-in before the habit is considered stale. */
const HABIT_STALE_DAYS          = 14;
/** Monthly discretionary spend ($) above which a cut opportunity is HIGH impact. */
const OPP_DISCRETIONARY_HIGH_MONTHLY = 300;
/** Monthly discretionary spend ($) above which a cut opportunity is MEDIUM impact. */
const OPP_DISCRETIONARY_MED_MONTHLY  = 100;

// ── Domain extraction helpers ─────────────────────────────────────────────────

function getTxnData(ctx: SpaceContext_AI): TransactionsSummaryData | null {
  const section = ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY];
  if (!section?.data) return null;
  return section.data as TransactionsSummaryData;
}

function getSnapData(ctx: SpaceContext_AI): SnapshotSectionData | null {
  const section = ctx.domains[FinanceDomains.SNAPSHOT_HISTORY];
  if (!section?.data) return null;
  return section.data as SnapshotSectionData;
}

function getAcctsData(ctx: SpaceContext_AI): AccountsSectionData | null {
  const section = ctx.domains[FinanceDomains.ACCOUNTS];
  if (!section?.data) return null;
  return section.data as AccountsSectionData;
}

function getGoalsData(ctx: SpaceContext_AI): GoalsSectionData | null {
  const section = ctx.domains[FinanceDomains.GOALS];
  if (!section?.data) return null;
  return section.data as GoalsSectionData;
}

// ── Heuristic derivation ──────────────────────────────────────────────────────

function deriveHeuristics(
  dataQuality: DataQualitySection,
  cashFlow:    CashFlowSection,
  debt:        DebtSection,
  liquidity:   LiquiditySection,
): AdvisorHeuristic[] {
  const h: AdvisorHeuristic[] = [];

  if (dataQuality.incomeConfidence === 'LOW') {
    h.push('DATA_QUALITY_LIMITS_CASH_FLOW_ADVICE');
    h.push('INCOME_INCOMPLETE_DO_NOT_DEFICIT_FRAME');
  }

  if (debt.classification === 'CRITICAL' || debt.classification === 'WARNING') {
    h.push('HIGH_APR_DEBT_PRIORITY');
  }

  if (debt.hasNullAPR && debt.totalLiabilities > 0) {
    h.push('APR_REQUIRED_FOR_PRECISE_PAYOFF');
  }

  if (liquidity.noLiquidAccountsInSpace) {
    h.push('LIQUIDITY_UNKNOWN_FOR_SPACE');
  }

  if (
    cashFlow.deficitCause === 'INTENTIONAL_DEBT_PAYOFF' ||
    cashFlow.deficitCause === 'MIXED'
  ) {
    h.push('DEBT_PAYOFF_IS_INTENTIONAL');
  }

  if (
    liquidity.classification === 'CRITICAL' ||
    liquidity.classification === 'WARNING'
  ) {
    h.push('LOW_LIQUIDITY_COVERAGE');
  }

  return h;
}

// ── Priority ranking ──────────────────────────────────────────────────────────

/**
 * Produce an ordered list of active priorities.
 * Each active condition that the LLM should know about gets an entry.
 * Severity reflects urgency: critical > warning > info.
 * This is NOT a recommendation — the LLM decides how to act on these hints.
 */
function derivePriorities(
  dataQuality: DataQualitySection,
  cashFlow:    CashFlowSection,
  debt:        DebtSection,
  liquidity:   LiquiditySection,
): AssessmentPriority[] {
  const result: AssessmentPriority[] = [];

  if (
    dataQuality.transactionHistoryCompleteness === 'LOW' ||
    dataQuality.incomeConfidence === 'LOW'
  ) {
    result.push({
      code:     'DATA_QUALITY',
      severity: 'warning',
      reason:   dataQuality.incomeConfidence === 'LOW'
        ? 'Income history incomplete — connect all income accounts for accurate analysis'
        : 'Transaction history is sparse — financial analysis is limited',
    });
  }

  if (liquidity.classification === 'CRITICAL') {
    result.push({
      code:     'LIQUIDITY',
      severity: 'critical',
      reason:   'Liquid coverage below 1 month',
    });
  }

  if (debt.classification === 'CRITICAL') {
    result.push({
      code:     'DEBT',
      severity: 'critical',
      reason:   'High-APR debt requires urgent attention',
    });
  }

  if (cashFlow.deficitCause === 'POSSIBLE_OVERSPENDING') {
    result.push({
      code:     'CASH_FLOW',
      severity: 'warning',
      reason:   'Spending may be exceeding income',
    });
  }

  if (debt.classification === 'WARNING') {
    result.push({
      code:     'DEBT',
      severity: 'warning',
      reason:   'Elevated APR worth active management',
    });
  }

  if (liquidity.classification === 'WARNING') {
    result.push({
      code:     'LIQUIDITY',
      severity: 'warning',
      reason:   `Liquid coverage below ${LIQUIDITY_WARNING_MONTHS} months`,
    });
  }

  if (cashFlow.deficitCause === 'INTENTIONAL_DEBT_PAYOFF') {
    result.push({
      code:     'CASH_FLOW',
      severity: 'info',
      reason:   'Intentional debt payoff strategy — active debt goal confirmed',
    });
  } else if (cashFlow.deficitCause === 'MIXED') {
    result.push({
      code:     'CASH_FLOW',
      severity: 'warning',
      reason:   'Mixed deficit — debt payments plus non-debt spending above income',
    });
  }

  return result;
}

// ── 2.3 Spending Opportunity computation ─────────────────────────────────────

/**
 * Categories excluded from expense opportunity analysis.
 * Income / Interest (income) / Transfer are not spending.
 * Payment (debt repayment) is handled by the Debt Strategy engine.
 */
const SPENDING_EXCLUDED = new Set(['Income', 'Interest', 'Transfer', 'Payment']);

const SPENDING_DISCRETIONARY      = new Set(['Dining', 'Shopping', 'Travel', 'Subscriptions']);
const SPENDING_SEMI_DISCRETIONARY = new Set(['Groceries']);
const SPENDING_FIXED              = new Set(['Utilities']);

function classifySpendingCategory(category: string): SpendingCategoryClassification | null {
  if (SPENDING_EXCLUDED.has(category))             return null;
  if (SPENDING_DISCRETIONARY.has(category))        return 'DISCRETIONARY';
  if (SPENDING_SEMI_DISCRETIONARY.has(category))   return 'SEMI_DISCRETIONARY';
  if (SPENDING_FIXED.has(category))                return 'FIXED';
  return 'REVIEW_NEEDED'; // Other and any future categories
}

/**
 * Classifies and ranks expense categories by monthly equivalent.
 * Pure function. No DB queries. Excludes income, transfer, and debt-payment categories.
 */
function computeSpendingOpportunities(
  txn:         TransactionsSummaryData | null,
  dataQuality: DataQualitySection,
): SpendingOpportunitySection {
  if (!txn || txn.transactionCount === 0) {
    return {
      confidence:              'LOW',
      windowDays:              txn?.windowDays ?? 0,
      topCategories:           [],
      discretionaryTotal:      0,
      topReductionOpportunity: null,
      categoriesNeedingReview: [],
      hasTransactionData:      false,
    };
  }

  const windowDays = txn.windowDays > 0 ? txn.windowDays : 90;

  const categories: SpendingCategoryOpportunity[] = [];
  for (const cat of txn.byCategory) {
    const classification = classifySpendingCategory(cat.category);
    if (classification === null) continue;
    const monthlyEquivalent = Math.round((cat.total / windowDays * 30) * 100) / 100;
    if (monthlyEquivalent < 1) continue; // skip negligible amounts
    categories.push({
      category: cat.category,
      monthlyEquivalent,
      classification,
      transactionCount: cat.count,
    });
  }

  categories.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);

  const discretionaryTotal = Math.round(
    categories
      .filter((c) => c.classification === 'DISCRETIONARY')
      .reduce((sum, c) => sum + c.monthlyEquivalent, 0) * 100,
  ) / 100;

  const topReductionOpportunity =
    categories.find((c) => c.classification === 'DISCRETIONARY') ?? null;

  const categoriesNeedingReview = categories
    .filter((c) => c.classification === 'REVIEW_NEEDED' && c.monthlyEquivalent >= REVIEW_MIN_MONTHLY)
    .map((c) => c.category);

  return {
    confidence:              dataQuality.transactionHistoryCompleteness,
    windowDays,
    topCategories:           categories,
    discretionaryTotal,
    topReductionOpportunity,
    categoriesNeedingReview,
    hasTransactionData:      true,
  };
}

// ── 2.4 Goal Alignment computation ───────────────────────────────────────────

/**
 * Cross-references active goal state against observable spending, debt, and
 * snapshot behavior.
 * Pure function. No DB queries. Alignment is determined from assembled domain
 * data — no LLM inference.
 */
function computeGoalAlignment(
  goals:    GoalsSectionData | null,
  cashFlow: CashFlowSection,
  debt:     DebtSection,
  txn:      TransactionsSummaryData | null,
  snap:     SnapshotSectionData | null,
): GoalAlignmentSection {
  const noGoals: GoalAlignmentSection = {
    confidence:      'LOW',
    overallStatus:   'INSUFFICIENT_DATA',
    alignedCount:    0,
    misalignedCount: 0,
    blockedCount:    0,
    goalAlignments:  [],
    hasGoalsDomain:  goals !== null,
    activeGoalCount: 0,
  };

  if (!goals) return noGoals;

  const activeGoals = goals.goals.filter((g) => g.status === 'ACTIVE');
  if (activeGoals.length === 0) return { ...noGoals, hasGoalsDomain: true };

  const goalAlignments: GoalAlignmentItem[] = [];
  const isLiabilitiesDeclining =
    (snap?.history?.length ?? 0) >= 2 &&
    snap!.history[snap!.history.length - 1].liabilities < snap!.history[0].liabilities;

  for (const goal of activeGoals) {
    let status:  GoalAlignmentStatus;
    let evidence: string;
    let blocker: string | undefined;

    switch (goal.goalType) {
      case 'DEBT_REDUCTION': {
        const hasDebt       = debt.totalLiabilities > 0;
        const makingPayments = (txn?.debtPaymentTotal ?? 0) > 0;

        if (!hasDebt) {
          status   = 'ALIGNED';
          evidence = 'No outstanding liabilities — debt reduction goal may already be met';
        } else if (makingPayments && isLiabilitiesDeclining) {
          status   = 'ALIGNED';
          evidence = 'Debt payments detected and total liabilities are declining';
        } else if (makingPayments) {
          status   = 'LIKELY_ALIGNED';
          evidence = 'Debt payments detected in the current transaction window';
          blocker  = 'Insufficient snapshot history to confirm a declining balance trend';
        } else if (!txn) {
          status   = 'INSUFFICIENT_DATA';
          evidence = 'No transaction data — cannot assess debt payment behavior';
          blocker  = 'Connect bank accounts and allow transaction history to accumulate';
        } else {
          status   = 'MISALIGNED';
          evidence = 'No debt payments visible in the current transaction window';
        }
        break;
      }

      case 'FINANCIAL': {
        const progressPct   = goal.progressPct   ?? null;
        const targetAmount  = goal.targetAmount  ?? null;
        const currentAmount = goal.currentAmount ?? null;

        if (progressPct !== null) {
          if (progressPct >= 80) {
            status   = 'ALIGNED';
            evidence = `Goal is ${progressPct}% funded`;
          } else if (progressPct >= 40) {
            status   = 'LIKELY_ALIGNED';
            evidence = `Goal is ${progressPct}% funded — progress is active`;
          } else if (goal.targetDate) {
            status   = 'MISALIGNED';
            evidence = `Goal is only ${progressPct}% funded with a target date set`;
          } else {
            status   = 'LIKELY_ALIGNED';
            evidence = `Goal is ${progressPct}% funded`;
          }
        } else if (currentAmount !== null && targetAmount !== null) {
          if (currentAmount >= targetAmount) {
            status   = 'ALIGNED';
            evidence = `Current amount meets target`;
          } else {
            status   = 'LIKELY_ALIGNED';
            evidence = `Tracking toward target amount`;
          }
        } else {
          status   = 'INSUFFICIENT_DATA';
          evidence = 'No progress data available for this goal';
          blocker  = 'Set a target amount or link a savings account to track progress';
        }
        break;
      }

      case 'SPENDING_LIMIT': {
        const progressPct   = goal.progressPct   ?? null;
        const targetAmount  = goal.targetAmount  ?? null;
        const currentAmount = goal.currentAmount ?? null;

        if (progressPct !== null) {
          if (progressPct > 100) {
            status   = 'MISALIGNED';
            evidence = `Spending limit exceeded (${progressPct}% of limit used)`;
          } else if (progressPct >= 80) {
            status   = 'LIKELY_ALIGNED';
            evidence = `Approaching spending limit (${progressPct}% used)`;
          } else {
            status   = 'ALIGNED';
            evidence = `Within spending limit (${progressPct}% used)`;
          }
        } else if (currentAmount !== null && targetAmount !== null) {
          status   = currentAmount > targetAmount ? 'MISALIGNED' : 'ALIGNED';
          evidence = currentAmount > targetAmount ? 'Spend exceeds limit' : 'Spend is within limit';
        } else {
          status   = 'INSUFFICIENT_DATA';
          evidence = 'No spending limit data available for comparison';
          blocker  = 'Allow spending history to accumulate for assessment';
        }
        break;
      }

      case 'HABIT': {
        const streak      = goal.currentStreak ?? 0;
        const lastCheckIn = goal.lastCheckIn   ?? null;

        if (!lastCheckIn) {
          status   = 'INSUFFICIENT_DATA';
          evidence = 'No check-in recorded for this habit';
          blocker  = 'Complete the first check-in to start tracking';
        } else {
          const daysSince = Math.floor(
            (Date.now() - new Date(lastCheckIn).getTime()) / (1000 * 60 * 60 * 24),
          );
          if (streak > 0 && daysSince <= HABIT_STALE_DAYS) {
            status   = 'ALIGNED';
            evidence = `Active streak of ${streak} — last check-in ${daysSince} day(s) ago`;
          } else if (daysSince > HABIT_STALE_DAYS) {
            status   = 'MISALIGNED';
            evidence = `No check-in for ${daysSince} days`;
          } else {
            status   = 'LIKELY_ALIGNED';
            evidence = `Recent check-in (${daysSince} day(s) ago) — streak: ${streak}`;
          }
        }
        break;
      }

      default: {
        status   = 'INSUFFICIENT_DATA';
        evidence = `Goal type not yet assessable deterministically`;
        break;
      }
    }

    const item: GoalAlignmentItem = { goalId: goal.id, goalName: goal.name, goalType: goal.goalType, status, evidence };
    if (blocker !== undefined) item.blocker = blocker;
    goalAlignments.push(item);
  }

  const alignedCount    = goalAlignments.filter((g) => g.status === 'ALIGNED' || g.status === 'LIKELY_ALIGNED').length;
  const misalignedCount = goalAlignments.filter((g) => g.status === 'MISALIGNED').length;
  const blockedCount    = goalAlignments.filter((g) => g.status === 'INSUFFICIENT_DATA').length;

  const overallStatus: GoalAlignmentSection['overallStatus'] = (() => {
    if (blockedCount === goalAlignments.length)  return 'INSUFFICIENT_DATA';
    if (misalignedCount === 0)                   return 'ALIGNED';
    if (alignedCount > 0 && misalignedCount > 0) return 'MIXED';
    return 'MISALIGNED';
  })();

  const confidence: ConfidenceLevel =
    blockedCount === goalAlignments.length ? 'LOW' :
    alignedCount + misalignedCount > blockedCount ? 'MEDIUM' :
    'LOW';

  return {
    confidence,
    overallStatus,
    alignedCount,
    misalignedCount,
    blockedCount,
    goalAlignments,
    hasGoalsDomain:  true,
    activeGoalCount: activeGoals.length,
  };
}

// ── 2.5 Investment Readiness computation ──────────────────────────────────────

/**
 * Determines investment readiness from liquidity and debt — no holdings data required.
 * Detects whether the HOLDINGS_SUMMARY domain was assembled as a presence flag only.
 * Does not give investment advice — only whether the financial context supports investing.
 */
function computeInvestmentReadiness(
  liquidity:    LiquiditySection,
  debt:         DebtSection,
  debtStrategy: DebtStrategySection,
  ctx:          SpaceContext_AI,
): InvestmentReadinessSection {
  const blockers: string[] = [];

  const holdingsDomainPresent = !!ctx.domains[FinanceDomains.HOLDINGS_SUMMARY]?.data;

  const liquiditySafe =
    liquidity.classification === 'SAFE' || liquidity.classification === 'EXCELLENT';

  const highAprDebtPresent =
    debt.classification === 'CRITICAL' || debt.classification === 'WARNING';

  const debtBeatsMarket: boolean | null =
    debtStrategy.weightedAvgApr !== null && !debt.hasNullAPR
      ? debtStrategy.weightedAvgApr > MARKET_RETURN_THRESHOLD
      : null;

  if (!liquidity.hasAccountsDomain) {
    blockers.push('No accounts linked — liquidity status unknown');
  }
  if (debt.hasNullAPR && debt.totalLiabilities > 0) {
    blockers.push('APR missing for some debt accounts — full carry cost unknown');
  }

  let classification: InvestmentReadinessClassification;
  let confidence: ConfidenceLevel;

  if (!liquidity.hasAccountsDomain) {
    classification = 'BLOCKED_BY_DATA';
    confidence     = 'LOW';
  } else if (liquidity.classification === 'CRITICAL' || liquidity.classification === 'WARNING') {
    classification = 'BUILD_LIQUIDITY_FIRST';
    confidence     = liquidity.confidence;
  } else if (highAprDebtPresent) {
    classification = 'DEBT_FIRST';
    confidence     = debt.confidence;
  } else if (debtBeatsMarket === true) {
    // APR confirmed above market return reference but below CRITICAL/WARNING threshold.
    classification = 'DEBT_FIRST';
    confidence     = 'MEDIUM';
  } else if (debtBeatsMarket === null && debt.totalLiabilities > 0) {
    // APR unknown — cannot confirm debt cost vs. investing trade-off.
    classification = 'CONDITIONALLY_READY';
    confidence     = 'LOW';
    blockers.push('APR unknown — cannot confirm debt vs. investing trade-off');
  } else {
    classification = (liquiditySafe && debt.totalLiabilities === 0) ? 'READY' : 'CONDITIONALLY_READY';
    confidence     = 'MEDIUM';
  }

  return {
    classification,
    confidence,
    holdingsDomainPresent,
    liquiditySafe,
    highAprDebtPresent,
    debtBeatsMarket,
    blockers,
  };
}

// ── 2.2 Debt Strategy computation ────────────────────────────────────────────

/**
 * Derives avalanche/snowball candidates and payoff urgency from the assembled
 * accounts list + the already-computed DebtSection.
 *
 * Pure function. No DB queries. Must be called after Step 3 (DebtSection).
 */
function computeDebtStrategy(
  accts: AccountsSectionData | null,
  debt:  DebtSection,
): DebtStrategySection {
  if (!accts || debt.totalLiabilities === 0) {
    return {
      confidence:                 debt.totalLiabilities === 0 ? 'HIGH' : 'LOW',
      payoffUrgency:              debt.totalLiabilities === 0 ? 'NONE'  : 'UNKNOWN',
      avalancheCandidate:         null,
      snowballCandidate:          null,
      weightedAvgApr:             null,
      knownMonthlyInterestBurden: null,
      missingAprAccountNames:     [],
      hasBalanceOnlyDebt:         false,
    };
  }

  const debtAccounts = (accts.accounts ?? []).filter((a) => a.type === 'debt');

  // Avalanche target: highest APR — FULL visibility, APR known and positive.
  const fullWithApr = [...debtAccounts]
    .filter((a) => a.visibilityLevel === 'FULL' && a.apr != null && a.apr > 0)
    .sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0));

  const avalancheCandidate: DebtCandidate | null = fullWithApr.length > 0
    ? { accountName: fullWithApr[0].name, balance: Math.abs(fullWithApr[0].balance), apr: fullWithApr[0].apr! }
    : null;

  // Snowball target: lowest absolute balance — any debt account.
  const byBalance = [...debtAccounts].sort(
    (a, b) => Math.abs(a.balance) - Math.abs(b.balance),
  );
  const snowballCandidate: DebtCandidate | null = byBalance.length > 0
    ? {
        accountName: byBalance[0].name,
        balance:     Math.abs(byBalance[0].balance),
        apr:         byBalance[0].apr ?? null,
      }
    : null;

  // Weighted average APR across accounts where APR is known.
  let totalWeighted    = 0;
  let totalForWeighting = 0;
  for (const a of fullWithApr) {
    const bal         = Math.abs(a.balance);
    totalWeighted    += (a.apr ?? 0) * bal;
    totalForWeighting += bal;
  }
  const weightedAvgApr: number | null = totalForWeighting > 0
    ? Math.round((totalWeighted / totalForWeighting) * 100) / 100
    : null;

  const payoffUrgency: DebtPayoffUrgency =
    debt.classification === 'CRITICAL'         ? 'CRITICAL' :
    debt.classification === 'WARNING'           ? 'HIGH'     :
    debt.classification === 'IMPROVING'         ? 'LOW'      :
    debt.classification === 'HEALTHY'           ? 'MODERATE' :
    debt.classification === 'INSUFFICIENT_DATA' ? 'UNKNOWN'  :
    'NONE';

  return {
    confidence:                 debt.confidence,
    payoffUrgency,
    avalancheCandidate,
    snowballCandidate,
    weightedAvgApr,
    knownMonthlyInterestBurden: debt.monthlyInterestBurden,
    missingAprAccountNames:     debt.aprGapAccountNames,
    hasBalanceOnlyDebt:         debt.hasBalanceOnlyDebt,
  };
}

// ── 2.1 Capital Allocation computation ───────────────────────────────────────

/**
 * Derives capital allocation context from liquidity, debt, cash flow, and
 * the already-computed DebtStrategySection.
 *
 * Pure function. No DB queries. Must be called after computeDebtStrategy().
 * Uses MARKET_RETURN_THRESHOLD (7%) as the passive-index reference return.
 *
 * Outputs evidence (concrete numbers the LLM can quote) and
 * primaryEvidence/ignoredEvidence (which data domains drove the recommendation).
 */
function computeCapitalAllocation(
  liquidity:    LiquiditySection,
  debt:         DebtSection,
  cashFlow:     CashFlowSection,
  debtStrategy: DebtStrategySection,
): CapitalAllocationSection {
  const blockers: string[] = [];

  const liquidityFirstRequired =
    liquidity.classification === 'CRITICAL' || liquidity.classification === 'WARNING';

  const highInterestDebtPresent =
    debt.classification === 'CRITICAL' || debt.classification === 'WARNING';

  const missingAprPreventsComparison = debt.hasNullAPR && debt.totalLiabilities > 0;

  if (cashFlow.confidence === 'LOW') {
    blockers.push('Income history incomplete — cash flow not primary to this recommendation');
  }
  if (missingAprPreventsComparison) {
    blockers.push('APR missing for one or more debt accounts — debt vs. investing comparison blocked');
  }
  if (!liquidity.hasAccountsDomain) {
    blockers.push('No accounts linked to this Space — liquidity unknown');
  }

  // ── Evidence: concrete numbers the LLM can quote ─────────────────────────

  const guaranteedReturnAdvantage: number | null =
    debtStrategy.weightedAvgApr !== null && !debt.hasNullAPR
      ? Math.round((debtStrategy.weightedAvgApr - MARKET_RETURN_THRESHOLD) * 100) / 100
      : null;

  const evidence: CapitalAllocationEvidence = {
    weightedDebtApr:           debtStrategy.weightedAvgApr,
    expectedMarketReturn:      MARKET_RETURN_THRESHOLD,
    guaranteedReturnAdvantage,
    aprCompleteness:           debt.aprCompleteness,
    liquidityMonths:           liquidity.coverageMonths,
    monthlyInterestBurden:     debt.monthlyInterestBurden,
  };

  // ── Recommendation ───────────────────────────────────────────────────────

  let recommendation: CapitalAllocationRecommendation;
  let confidence: ConfidenceLevel;

  if (!liquidity.hasAccountsDomain && cashFlow.confidence === 'LOW') {
    recommendation = 'BLOCKED_BY_DATA';
    confidence     = 'LOW';
  } else if (liquidityFirstRequired) {
    recommendation = 'BUILD_LIQUIDITY';
    confidence     = liquidity.confidence;
  } else if (highInterestDebtPresent) {
    recommendation = 'PAY_HIGH_APR_DEBT';
    confidence     = debt.confidence;
  } else if (missingAprPreventsComparison) {
    recommendation = 'BLOCKED_BY_DATA';
    confidence     = 'MEDIUM';
  } else if (guaranteedReturnAdvantage !== null && guaranteedReturnAdvantage > 0) {
    recommendation = 'DEBT_BEFORE_INVESTING';
    confidence     = 'MEDIUM'; // market returns are variable — cap at MEDIUM
  } else {
    recommendation = 'INVEST_ELIGIBLE';
    confidence     = debt.totalLiabilities === 0 ? 'HIGH' : 'MEDIUM';
  }

  // ── Primary / ignored evidence ───────────────────────────────────────────
  // Tells the LLM which data domains drove the recommendation and which to
  // de-emphasise — enables "although income data is incomplete, this is driven by
  // your APR and liquid coverage" framing.

  const primaryEvidence: AllocationEvidenceDomain[] = [];
  const ignoredEvidence: AllocationEvidenceDomain[] = [];

  if (liquidityFirstRequired) {
    primaryEvidence.push('liquidity');
    if (debt.totalLiabilities > 0) primaryEvidence.push('debt');
  } else if (highInterestDebtPresent || recommendation === 'DEBT_BEFORE_INVESTING') {
    primaryEvidence.push('debt', 'liquidity');
  } else {
    primaryEvidence.push('liquidity', 'debt');
  }

  // Cash flow: note whether it was relied on or sidelined.
  // Recommendations driven by balance-sheet data (APR, liabilities, liquid cash)
  // do not depend on income/expense reliability.
  const cashFlowIsDecidingFactor =
    recommendation === 'INVEST_ELIGIBLE' && cashFlow.confidence !== 'LOW';

  if (!cashFlowIsDecidingFactor) {
    ignoredEvidence.push('cashFlow');
  }

  return {
    recommendation,
    confidence,
    liquidCashAvailable:          liquidity.liquidCashTotal,
    highInterestDebtPresent,
    liquidityFirstRequired,
    missingAprPreventsComparison,
    blockers,
    evidence,
    primaryEvidence,
    ignoredEvidence,
  };
}

// ── 2.6 Risk & Opportunity computation ───────────────────────────────────────

const SEVERITY_RANK:   Record<RiskSeverity, number>      = { critical: 0, warning: 1, info: 2 };
const IMPACT_RANK:     Record<OpportunityImpact, number> = { high: 0, medium: 1, low: 2 };
const CONFIDENCE_RANK: Record<ConfidenceLevel, number>   = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Aggregates already-computed assessment sections into ranked risk and
 * opportunity candidates.
 *
 * Pure function. No DB queries. No recalculation from raw context — every value
 * is read from the section objects produced earlier in computeAssessment().
 * The LLM turns these candidates into recommendations; this engine does not.
 *
 * Sorting:
 *   risks         — severity (critical → info) then confidence (HIGH → LOW)
 *   opportunities — impact   (high → low)      then confidence (HIGH → LOW)
 */
function computeRiskOpportunities(
  dataQuality:           DataQualitySection,
  cashFlow:              CashFlowSection,
  debt:                  DebtSection,
  liquidity:             LiquiditySection,
  debtStrategy:          DebtStrategySection,
  spendingOpportunities: SpendingOpportunitySection,
  goalAlignment:         GoalAlignmentSection,
  investmentReadiness:   InvestmentReadinessSection,
): RiskOpportunitySection {
  const risks:         AssessmentRisk[]        = [];
  const opportunities: AssessmentOpportunity[] = [];

  // ── Risks ─────────────────────────────────────────────────────────────────

  // LOW_LIQUIDITY — liquidity coverage at or below the warning band.
  if (liquidity.classification === 'CRITICAL' || liquidity.classification === 'WARNING') {
    const coverage = liquidity.coverageMonths !== null
      ? `${liquidity.coverageMonths.toFixed(1)} months of liquid coverage`
      : 'liquid coverage below target';
    risks.push({
      code:             'LOW_LIQUIDITY',
      severity:         liquidity.classification === 'CRITICAL' ? 'critical' : 'warning',
      confidence:       liquidity.confidence,
      evidence:         `${coverage} (${liquidity.classification})`,
      affectedSections: ['liquidity'],
    });
  }

  // INCOMPLETE_INCOME_DATA — income confidence is LOW.
  if (dataQuality.incomeConfidence === 'LOW') {
    risks.push({
      code:             'INCOMPLETE_INCOME_DATA',
      severity:         'warning',
      confidence:       'HIGH',
      evidence:         `Only ${dataQuality.incomeTransactionCount} income transaction(s) captured — income confidence LOW`,
      affectedSections: ['dataQuality', 'cashFlow'],
    });
  }

  // CASH_FLOW_UNRELIABLE — cash flow reliability degraded by income gaps.
  if (cashFlow.reliability === 'UNRELIABLE') {
    risks.push({
      code:             'CASH_FLOW_UNRELIABLE',
      severity:         'warning',
      confidence:       'HIGH',
      evidence:         'Cash flow reliability is UNRELIABLE — apparent deficits may be data artifacts, not real',
      affectedSections: ['cashFlow', 'dataQuality'],
    });
  }

  // HIGH_INTEREST_DEBT — debt classification flags elevated/critical APR.
  if (debt.classification === 'CRITICAL' || debt.classification === 'WARNING') {
    const apr = debtStrategy.weightedAvgApr !== null
      ? `weighted APR ${debtStrategy.weightedAvgApr.toFixed(2)}%`
      : 'elevated APR';
    const burden = debt.monthlyInterestBurden !== null
      ? `, ~$${debt.monthlyInterestBurden.toFixed(2)}/mo interest`
      : '';
    risks.push({
      code:             'HIGH_INTEREST_DEBT',
      severity:         debt.classification === 'CRITICAL' ? 'critical' : 'warning',
      confidence:       debt.confidence,
      evidence:         `${debt.classification} debt — ${apr}${burden}`,
      affectedSections: ['debt', 'debtStrategy'],
    });
  }

  // APR_MISSING_FOR_DEBT — outstanding debt with one or more missing APRs.
  if (debt.hasNullAPR && debt.totalLiabilities > 0) {
    const which = debt.aprGapAccountNames.length > 0
      ? `APR missing for: ${debt.aprGapAccountNames.join(', ')}`
      : 'APR missing for one or more debt accounts';
    const balOnly = debt.hasBalanceOnlyDebt
      ? ' (some are balance-only — APR structurally inaccessible in this Space)'
      : '';
    risks.push({
      code:             'APR_MISSING_FOR_DEBT',
      severity:         'warning',
      confidence:       'HIGH',
      evidence:         `${which}${balOnly}`,
      affectedSections: ['debt', 'debtStrategy'],
    });
  }

  // DEBT_PAYOFF_BLOCKED_BY_DATA — debt health cannot be classified from data.
  if (debt.classification === 'INSUFFICIENT_DATA' && debt.totalLiabilities > 0) {
    risks.push({
      code:             'DEBT_PAYOFF_BLOCKED_BY_DATA',
      severity:         'warning',
      confidence:       'HIGH',
      evidence:         `Debt health cannot be classified — APR completeness ${debt.aprCompleteness}; precise payoff comparison blocked`,
      affectedSections: ['debt', 'debtStrategy', 'capitalAllocation'],
    });
  }

  // GOALS_MISALIGNED — one or more active goals conflict with observed behavior.
  if (goalAlignment.hasGoalsDomain && goalAlignment.misalignedCount > 0) {
    risks.push({
      code:             'GOALS_MISALIGNED',
      severity:         'warning',
      confidence:       goalAlignment.confidence,
      evidence:         `${goalAlignment.misalignedCount} goal(s) misaligned with observed behavior (overall ${goalAlignment.overallStatus})`,
      affectedSections: ['goalAlignment'],
    });
  }

  // INVESTING_NOT_READY — pre-conditions for investing are not met.
  if (
    investmentReadiness.classification === 'DEBT_FIRST' ||
    investmentReadiness.classification === 'BUILD_LIQUIDITY_FIRST' ||
    investmentReadiness.classification === 'BLOCKED_BY_DATA'
  ) {
    risks.push({
      code:             'INVESTING_NOT_READY',
      severity:         investmentReadiness.classification === 'BLOCKED_BY_DATA' ? 'info' : 'warning',
      confidence:       investmentReadiness.confidence,
      evidence:         `Investment readiness: ${investmentReadiness.classification}`,
      affectedSections: ['investmentReadiness'],
    });
  }

  // HISTORY_INCOMPLETE — transaction history too sparse for confident analysis.
  if (dataQuality.transactionHistoryCompleteness === 'LOW') {
    risks.push({
      code:             'HISTORY_INCOMPLETE',
      severity:         'info',
      confidence:       'HIGH',
      evidence:         `Transaction history completeness LOW (${dataQuality.snapshotSpanDays}-day span in 90-day window)`,
      affectedSections: ['dataQuality'],
    });
  }

  // ── Opportunities ─────────────────────────────────────────────────────────

  // CUT_TOP_DISCRETIONARY_CATEGORY — largest reducible discretionary category.
  if (spendingOpportunities.hasTransactionData && spendingOpportunities.topReductionOpportunity) {
    const top = spendingOpportunities.topReductionOpportunity;
    const impact: OpportunityImpact =
      top.monthlyEquivalent >= OPP_DISCRETIONARY_HIGH_MONTHLY ? 'high' :
      top.monthlyEquivalent >= OPP_DISCRETIONARY_MED_MONTHLY  ? 'medium' :
      'low';
    opportunities.push({
      code:             'CUT_TOP_DISCRETIONARY_CATEGORY',
      impact,
      confidence:       spendingOpportunities.confidence,
      evidence:         `Top discretionary category ${top.category} at $${top.monthlyEquivalent.toFixed(2)}/mo`,
      affectedSections: ['spendingOpportunities'],
    });
  }

  // REVIEW_OTHER_CATEGORY — uncategorized spend worth review.
  if (spendingOpportunities.categoriesNeedingReview.length > 0) {
    opportunities.push({
      code:             'REVIEW_OTHER_CATEGORY',
      impact:           'low',
      confidence:       spendingOpportunities.confidence,
      evidence:         `Uncategorized spend to review: ${spendingOpportunities.categoriesNeedingReview.join(', ')}`,
      affectedSections: ['spendingOpportunities'],
    });
  }

  // PAY_HIGH_APR_DEBT — high-APR debt payoff yields a guaranteed return.
  if (debt.classification === 'CRITICAL' || debt.classification === 'WARNING') {
    const target = debtStrategy.avalancheCandidate
      ? `; highest-APR target ${debtStrategy.avalancheCandidate.accountName} (${debtStrategy.avalancheCandidate.apr!.toFixed(2)}%)`
      : '';
    const apr = debtStrategy.weightedAvgApr !== null
      ? `weighted APR ${debtStrategy.weightedAvgApr.toFixed(2)}%`
      : 'elevated APR';
    opportunities.push({
      code:             'PAY_HIGH_APR_DEBT',
      impact:           debt.classification === 'CRITICAL' ? 'high' : 'medium',
      confidence:       debt.confidence,
      evidence:         `Paying down ${apr} debt is a guaranteed return${target}`,
      affectedSections: ['debt', 'debtStrategy', 'capitalAllocation'],
    });
  }

  // BUILD_EMERGENCY_FUND — liquidity below target invites reserve building.
  if (liquidity.classification === 'CRITICAL' || liquidity.classification === 'WARNING') {
    const coverage = liquidity.coverageMonths !== null
      ? `currently ${liquidity.coverageMonths.toFixed(1)} months`
      : 'currently below target';
    opportunities.push({
      code:             'BUILD_EMERGENCY_FUND',
      impact:           liquidity.classification === 'CRITICAL' ? 'high' : 'medium',
      confidence:       liquidity.confidence,
      evidence:         `Liquid coverage ${coverage} — building toward ${LIQUIDITY_WARNING_MONTHS}+ months reduces risk`,
      affectedSections: ['liquidity', 'capitalAllocation'],
    });
  }

  // IMPROVE_DATA_QUALITY — closing income/APR gaps sharpens every downstream analysis.
  {
    const dataGaps: string[] = [];
    const dataSections = new Set<string>();
    if (dataQuality.incomeConfidence === 'LOW') {
      dataGaps.push('connect all income accounts');
      dataSections.add('dataQuality');
      dataSections.add('cashFlow');
    }
    if (debt.hasNullAPR && debt.totalLiabilities > 0) {
      dataGaps.push('enter missing debt APRs');
      dataSections.add('debt');
    }
    if (dataGaps.length > 0) {
      opportunities.push({
        code:             'IMPROVE_DATA_QUALITY',
        impact:           'medium',
        confidence:       'HIGH',
        evidence:         `Sharpen analysis: ${dataGaps.join('; ')}`,
        affectedSections: [...dataSections],
      });
    }
  }

  // ALIGN_SPENDING_WITH_GOALS — misaligned goals suggest a spending adjustment.
  if (goalAlignment.hasGoalsDomain && goalAlignment.misalignedCount > 0) {
    opportunities.push({
      code:             'ALIGN_SPENDING_WITH_GOALS',
      impact:           'medium',
      confidence:       goalAlignment.confidence,
      evidence:         `${goalAlignment.misalignedCount} goal(s) misaligned — adjusting spending can realign them`,
      affectedSections: ['goalAlignment', 'spendingOpportunities'],
    });
  }

  // READY_TO_INVEST — pre-conditions for investing are satisfied.
  if (investmentReadiness.classification === 'READY') {
    opportunities.push({
      code:             'READY_TO_INVEST',
      impact:           'high',
      confidence:       investmentReadiness.confidence,
      evidence:         'Liquidity is safe and debt is manageable — conditions support investing',
      affectedSections: ['investmentReadiness'],
    });
  }

  // EXPAND_TRANSACTION_HISTORY — more history improves confidence across sections.
  if (dataQuality.transactionHistoryCompleteness !== 'HIGH') {
    opportunities.push({
      code:             'EXPAND_TRANSACTION_HISTORY',
      impact:           dataQuality.transactionHistoryCompleteness === 'LOW' ? 'medium' : 'low',
      confidence:       'HIGH',
      evidence:         `Transaction history completeness ${dataQuality.transactionHistoryCompleteness} — more history raises confidence across the assessment`,
      affectedSections: ['dataQuality'],
    });
  }

  // ── Sorting ───────────────────────────────────────────────────────────────

  risks.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence],
  );

  opportunities.sort((a, b) =>
    IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] ||
    CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence],
  );

  // ── Section confidence ────────────────────────────────────────────────────
  // Tracks the completeness of the underlying data the aggregation relies on —
  // data quality gates the reliability of every risk and opportunity above.
  const confidence: ConfidenceLevel =
    (dataQuality.incomeConfidence === 'LOW' ||
     dataQuality.transactionHistoryCompleteness === 'LOW')     ? 'LOW'    :
    (dataQuality.incomeConfidence === 'MEDIUM' ||
     dataQuality.transactionHistoryCompleteness === 'MEDIUM')  ? 'MEDIUM' :
    'HIGH';

  return { risks, opportunities, confidence };
}

// ── Main computation ──────────────────────────────────────────────────────────

/**
 * Compute a structured financial assessment for a fully-assembled SpaceContext_AI.
 *
 * Pure function — no DB queries, no side effects, no LLM calls.
 * Call this after buildContext() and before prompt construction.
 */
export function computeAssessment(ctx: SpaceContext_AI): FinancialAssessment {
  const txn   = getTxnData(ctx);
  const snap  = getSnapData(ctx);
  const accts = getAcctsData(ctx);
  const goals = getGoalsData(ctx);

  // ── Raw inputs (with safe defaults for absent domains) ───────────────────

  const snapshotCount    = snap?.snapshotCount    ?? 0;
  const windowDays       = txn?.windowDays         ?? 90;
  const transactionCount = txn?.transactionCount   ?? 0;
  const incomeTotal      = txn?.incomeTotal        ?? 0;
  const expenseTotal     = txn?.expenseTotal       ?? 0;
  const debtPaymentTotal = txn?.debtPaymentTotal   ?? 0;
  const netCashFlow      = txn?.netCashFlow        ?? 0;
  const totalLiquid      = accts?.totalLiquid      ?? 0;
  const totalLiabilities = accts?.totalLiabilities ?? 0;

  const incomeEntry          = txn?.byCategory.find((c) => c.category === 'Income');
  const incomeTransactionCount = incomeEntry?.count ?? 0;

  const totalOutflows    = expenseTotal + debtPaymentTotal;
  const incomePlausRatio = totalOutflows > 0 ? incomeTotal / totalOutflows : 1;

  // ── Step 1: Data quality ─────────────────────────────────────────────────

  const transactionHistoryCompleteness: CompletenessLevel = (() => {
    if (transactionCount === 0 || snapshotCount < SNAPSHOT_LOW_THRESHOLD) return 'LOW';
    if (snapshotCount < SNAPSHOT_HIGH_THRESHOLD || transactionCount < TXN_COUNT_MINIMUM) return 'MEDIUM';
    return 'HIGH';
  })();

  const incomeConfidence: ConfidenceLevel = (() => {
    if (transactionHistoryCompleteness === 'LOW' || incomeTransactionCount === 0) return 'LOW';
    if (snapshotCount < SNAPSHOT_HIGH_THRESHOLD) {
      if (incomeTransactionCount <= 1 || incomePlausRatio < INCOME_PLAUS_RATIO_LOW) return 'LOW';
      return 'MEDIUM';
    }
    if (incomeTransactionCount <= 1 && incomePlausRatio < INCOME_PLAUS_RATIO_LOW) return 'LOW';
    if (incomeTransactionCount >= INCOME_TXN_HIGH_THRESHOLD && incomePlausRatio >= INCOME_PLAUS_RATIO_LOW) return 'HIGH';
    return 'MEDIUM';
  })();

  const dataQuality: DataQualitySection = {
    transactionHistoryCompleteness,
    snapshotSpanDays: snapshotCount,
    incomeConfidence,
    incomeTransactionCount,
  };

  // ── Step 2: Cash flow ────────────────────────────────────────────────────

  const impliedMonthlyIncome: number | null = txn && windowDays > 0
    ? Math.round((incomeTotal / windowDays * 30) * 100) / 100
    : null;

  const estimatedMonthlyExpenses: number | null = txn && windowDays > 0 && expenseTotal > 0
    ? Math.round((expenseTotal / windowDays * 30) * 100) / 100
    : null;

  const estimatedMonthlyDebtPayments: number | null = txn && windowDays > 0 && debtPaymentTotal > 0
    ? Math.round((debtPaymentTotal / windowDays * 30) * 100) / 100
    : null;

  const hasActiveDebtGoal = (goals?.goals ?? []).some(
    (g) => g.status === 'ACTIVE' && g.goalType === 'DEBT_REDUCTION',
  );

  const deficitCause: DeficitCauseClassification = (() => {
    if (netCashFlow >= 0)           return 'NOT_APPLICABLE';
    if (incomeConfidence === 'LOW') return 'LOW_INCOME_SAMPLE';
    const deficit      = Math.abs(netCashFlow);
    const debtFraction = deficit > 0 ? debtPaymentTotal / deficit : 0;
    if (debtFraction >= DEBT_FRACTION_DOMINANT && hasActiveDebtGoal) return 'INTENTIONAL_DEBT_PAYOFF';
    if (debtFraction >= DEBT_FRACTION_PARTIAL && hasActiveDebtGoal)  return 'MIXED';
    return 'POSSIBLE_OVERSPENDING';
  })();

  const cashFlowReliability: CashFlowReliability =
    incomeConfidence === 'LOW'    ? 'UNRELIABLE' :
    incomeConfidence === 'MEDIUM' ? 'PARTIAL'    :
    'RELIABLE';

  const cashFlow: CashFlowSection = {
    reliability:                  cashFlowReliability,
    confidence:                   incomeConfidence,
    deficitCause,
    transactionCompleteness:      transactionHistoryCompleteness,
    impliedMonthlyIncome,
    estimatedMonthlyExpenses,
    estimatedMonthlyDebtPayments,
    incomeTransactionCount,
    incompleteIncomeWarning:      incomeConfidence === 'LOW',
  };

  // ── Step 3: Debt ─────────────────────────────────────────────────────────

  let debtSection: DebtSection;

  if (!accts) {
    debtSection = {
      classification:        'INSUFFICIENT_DATA',
      confidence:            'LOW',
      totalLiabilities:      0,
      monthlyInterestBurden: null,
      aprCompleteness:       'NONE',
      hasNullAPR:            false,
      hasBalanceOnlyDebt:    false,
      aprGapAccountNames:    [],
    };
  } else if (totalLiabilities === 0) {
    debtSection = {
      classification:        'NO_DEBT',
      confidence:            'HIGH',
      totalLiabilities:      0,
      monthlyInterestBurden: null,
      aprCompleteness:       'FULL', // vacuously: no debt accounts to be incomplete
      hasNullAPR:            false,
      hasBalanceOnlyDebt:    false,
      aprGapAccountNames:    [],
    };
  } else {
    const debtAccounts = (accts.accounts ?? []).filter((a) => a.type === 'debt');

    let interestBurden    = 0;
    let totalDebtWithAPR  = 0;
    let hasNullAPR        = false;
    let fullVisDebtCount  = 0;
    let fullVisWithAPR    = 0;

    const hasBalanceOnlyDebt = debtAccounts.some((a) => a.visibilityLevel === 'BALANCE_ONLY');

    for (const acct of debtAccounts) {
      if (acct.visibilityLevel === 'BALANCE_ONLY') {
        // APR is structurally inaccessible — counts as missing for classification.
        hasNullAPR = true;
        continue;
      }
      // FULL-visibility debt account
      fullVisDebtCount++;
      if (acct.apr == null) {
        hasNullAPR = true;
      } else {
        fullVisWithAPR++;
        if (acct.apr > 0) {
          const balance   = Math.abs(acct.balance);
          interestBurden   += balance * acct.apr / 100 / 12;
          totalDebtWithAPR += balance;
        }
      }
    }

    // APR completeness across FULL-visibility debt accounts only.
    const aprCompleteness: AprCompleteness =
      fullVisDebtCount === 0         ? 'NONE'    :
      fullVisWithAPR === 0           ? 'NONE'    :
      fullVisWithAPR === fullVisDebtCount ? 'FULL' :
      'PARTIAL';

    // APR gap account names (FULL-visibility only — privacy enforced by assembler).
    const aprGapAccountNames: string[] = (accts.knowledgeGaps ?? [])
      .filter((g) => g.field === 'apr')
      .map((g) => g.accountName);

    // Debt health classification.
    let debtHealthClassification: DebtHealthClassification;
    if (hasNullAPR) {
      debtHealthClassification = 'INSUFFICIENT_DATA';
    } else {
      const weightedAvgAPR = totalDebtWithAPR > 0
        ? (interestBurden * 12 / totalDebtWithAPR) * 100
        : 0;
      const history = snap?.history ?? [];
      const isLiabilitiesDeclining =
        history.length >= 7 &&
        history[history.length - 1].liabilities < history[0].liabilities;

      if (weightedAvgAPR > APR_CRITICAL_THRESHOLD) {
        debtHealthClassification = 'CRITICAL';
      } else if (weightedAvgAPR > APR_WARNING_THRESHOLD) {
        debtHealthClassification = 'WARNING';
      } else if (isLiabilitiesDeclining) {
        debtHealthClassification = 'IMPROVING';
      } else {
        debtHealthClassification = 'HEALTHY';
      }
    }

    // Debt confidence: how reliable is the classification?
    // Balance data is always reliable; the uncertainty is APR completeness.
    const debtConfidence: ConfidenceLevel =
      debtHealthClassification !== 'INSUFFICIENT_DATA' ? 'HIGH' :
      aprCompleteness === 'PARTIAL'                    ? 'MEDIUM' :
      'LOW';

    debtSection = {
      classification:        debtHealthClassification,
      confidence:            debtConfidence,
      totalLiabilities,
      monthlyInterestBurden: interestBurden > 0
        ? Math.round(interestBurden * 100) / 100
        : null,
      aprCompleteness,
      hasNullAPR,
      hasBalanceOnlyDebt,
      aprGapAccountNames,
    };
  }

  // ── Step 4: Liquidity ────────────────────────────────────────────────────

  const liquidAccountCount: number = accts?.counts.liquid ?? 0;
  const hasAccountsDomain:  boolean = accts !== null;
  const noLiquidAccountsInSpace = hasAccountsDomain && liquidAccountCount === 0;

  const estimatedMonthlyExpense: number | null = txn && windowDays > 0 && expenseTotal > 0
    ? Math.round((expenseTotal / windowDays * 30) * 100) / 100
    : null;

  let liquidityCoverageMonths: number | null = null;
  let liquidityCoverageClassification: LiquidityCoverageClassification;

  if (liquidAccountCount === 0 || estimatedMonthlyExpense === null) {
    liquidityCoverageClassification = 'UNKNOWN';
  } else {
    liquidityCoverageMonths = Math.round((totalLiquid / estimatedMonthlyExpense) * 100) / 100;
    liquidityCoverageClassification =
      liquidityCoverageMonths < LIQUIDITY_CRITICAL_MONTHS  ? 'CRITICAL' :
      liquidityCoverageMonths < LIQUIDITY_WARNING_MONTHS   ? 'WARNING'  :
      liquidityCoverageMonths < LIQUIDITY_EXCELLENT_MONTHS ? 'SAFE'     :
      'EXCELLENT';
  }

  // Liquidity confidence: balance data is always reliable when accounts are present.
  const liquidityConfidence: ConfidenceLevel =
    !hasAccountsDomain      ? 'LOW'    :
    noLiquidAccountsInSpace ? 'MEDIUM' : // accounts present but liquid ones missing from Space
    'HIGH';

  const liquidity: LiquiditySection = {
    classification:          liquidityCoverageClassification,
    confidence:              liquidityConfidence,
    liquidCashTotal:         totalLiquid,
    liquidAccountCount,
    coverageMonths:          liquidityCoverageMonths,
    estimatedMonthlyExpense,
    noLiquidAccountsInSpace,
    hasAccountsDomain,
  };

  // ── Step 5: Current state priority ──────────────────────────────────────

  const currentStatePriority: CurrentStatePriority = (() => {
    if (
      transactionHistoryCompleteness === 'LOW' ||
      incomeConfidence === 'LOW'
    ) return 'DATA_QUALITY';

    if (liquidityCoverageClassification === 'CRITICAL') return 'LIQUIDITY';
    if (debtSection.classification === 'CRITICAL')      return 'DEBT';

    if (deficitCause === 'POSSIBLE_OVERSPENDING') return 'CASH_FLOW';
    if (debtSection.classification === 'WARNING') return 'DEBT';

    if (deficitCause === 'INTENTIONAL_DEBT_PAYOFF' || deficitCause === 'MIXED') return 'CASH_FLOW';

    return 'LIQUIDITY';
  })();

  // ── Step 6: Debt Strategy (2.2) ─────────────────────────────────────────

  const debtStrategy = computeDebtStrategy(accts, debtSection);

  // ── Step 7: Capital Allocation (2.1) ────────────────────────────────────
  // Must follow debtStrategy — uses its weightedAvgApr output.

  const capitalAllocation = computeCapitalAllocation(liquidity, debtSection, cashFlow, debtStrategy);

  // ── Step 8: Spending Opportunities (2.3) ────────────────────────────────

  const spendingOpportunities = computeSpendingOpportunities(txn, dataQuality);

  // ── Step 9: Goal Alignment (2.4) ────────────────────────────────────────

  const goalAlignment = computeGoalAlignment(goals, cashFlow, debtSection, txn, snap);

  // ── Step 10: Investment Readiness (2.5) ─────────────────────────────────

  const investmentReadiness = computeInvestmentReadiness(liquidity, debtSection, debtStrategy, ctx);

  // ── Step 11: Risk & Opportunity (2.6) ────────────────────────────────────
  // Aggregates the sections above — must run after all of them are computed.

  const riskOpportunities = computeRiskOpportunities(
    dataQuality,
    cashFlow,
    debtSection,
    liquidity,
    debtStrategy,
    spendingOpportunities,
    goalAlignment,
    investmentReadiness,
  );

  // ── Step 12: Heuristics and priorities ──────────────────────────────────

  const advisorHeuristics = deriveHeuristics(dataQuality, cashFlow, debtSection, liquidity);
  const priorities        = derivePriorities(dataQuality, cashFlow, debtSection, liquidity);

  return {
    dataQuality,
    cashFlow,
    debt:                  debtSection,
    liquidity,
    capitalAllocation,
    debtStrategy,
    spendingOpportunities,
    goalAlignment,
    investmentReadiness,
    riskOpportunities,
    currentStatePriority,
    advisorHeuristics,
    priorities,
  };
}

/**
 * Backward-compat alias for Slice 1 call sites.
 * Prefer computeAssessment() in new code.
 */
export const computeAnnotations = computeAssessment;
