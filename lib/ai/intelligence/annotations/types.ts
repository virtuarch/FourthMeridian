/**
 * lib/ai/intelligence/annotations/types.ts
 *
 * Type surface for the deterministic Financial Intelligence layer (was the
 * type block of annotations.ts). Pure declarations only — no runtime, no logic.
 *
 * AI-ARCH Part 5: extracted from the former lib/ai/intelligence/annotations.ts
 * god-module (byte-identical bodies). Public surface re-exported via ./index.
 */

export type CompletenessLevel  = 'LOW' | 'MEDIUM' | 'HIGH';

export type ConfidenceLevel    = 'LOW' | 'MEDIUM' | 'HIGH';

export type CashFlowReliability = 'UNRELIABLE' | 'PARTIAL' | 'RELIABLE';


/**
 * W2 — 'INTENTIONAL_DEBT_PAYOFF' and 'MIXED' were DELETED from this union.
 * Both were INTENT claims, gated on an ACTIVE DEBT_REDUCTION goal — and Goals
 * (the product's only intent-declaration mechanism) are retired. The doctrine:
 * declared debt-paydown intent is NEVER guessed from activity; with no
 * declaration mechanism, an intent-shaped cause is structurally unreachable,
 * not merely absent. What remains is measurable fact: DEBT_DRIVEN states that
 * debt payments explain the deficit (activity, not intent). When a declaration
 * mechanism returns, it belongs to debt planning/strategy (the recorded future
 * home) — re-adding an intent-backed cause then must route through THAT
 * authority, never through activity inference here.
 */
export type DeficitCauseClassification =
  | 'POSSIBLE_OVERSPENDING'    // canonical economic net < 0 — spending genuinely exceeded income
  | 'LOW_INCOME_SAMPLE'        // income data is incomplete — deficit is a data artifact
  /**
   * REVIEW-3 C-3 — the after-paydown position is negative but the CANONICAL
   * economic net is not: debt payments fully explain the cash deficit — a
   * measured fact about the money, with no claim about intent. Distinct from
   * POSSIBLE_OVERSPENDING so a consumer can never say "you spent more than you
   * took in" while the Cash Flow workspace shows a surplus for the same window.
   */
  | 'DEBT_DRIVEN'
  | 'NOT_APPLICABLE';          // no cash deficit (net after debt payments ≥ 0)


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
  | 'CASH_FLOW';    // spending problem or debt-driven deficit to surface
// W2 — 'GOALS' / 'GOALS_GOOD' deleted: the priority ladder never emitted them
// (dead union members) and the goals domain is retired.

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
  // W2 — 'DEBT_PAYOFF_IS_INTENTIONAL' deleted (intent claim; Goals retired).
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

// ── REVIEW-3 C-7 — declared input insufficiency ──────────────────────────────

/** Sections whose GRADE can be withheld for want of input. */
export type UngradedSectionName = 'debt' | 'liquidity' | 'cashFlow' | 'trajectory';

/**
 * WHY a section could not be graded. Machine-readable so a consumer (the Brief)
 * can distinguish "the evidence was withheld by the requesting scope" from "the
 * evidence does not exist" — the two demand different sentences.
 */
export type UngradedReasonCode =
  /** No accounts domain was assembled at all. */
  | 'ACCOUNTS_DOMAIN_ABSENT'
  /** The payload carries no per-account list — liabilities exist but cannot be
   *  graded from totals. W3 renamed this from ACCOUNT_LIST_WITHHELD_BY_SCOPE:
   *  withholding-by-scope no longer exists (the assembler emits the
   *  assessment-required rows at every scope hint), so an absent list is a
   *  genuine payload gap (fixture / hand-built context), never a payload-size
   *  choice. The core invariant: every refusal names a data gap. */
  | 'ACCOUNT_LIST_ABSENT'
  /** One or more debt accounts carry no APR (missing input, or balance-only
   *  visibility making it structurally inaccessible). */
  | 'APR_MISSING'
  /** No checking/savings accounts are linked to this Space. */
  | 'NO_LIQUID_ACCOUNTS_IN_SPACE'
  /** No expense baseline: no declared figure and no complete, untruncated
   *  calendar month in the analysis window. (Before W4 this was the normal
   *  state of the Brief — its 30-day rolling window almost never contained a
   *  complete calendar month. The assessment window is now 90 rolling days at
   *  every scope hint, so this refusal marks a genuinely thin corpus, not a
   *  scope artifact.) */
  | 'NO_EXPENSE_BASELINE_IN_WINDOW'
  /** Income confidence LOW — cash-flow verdicts would be data artifacts. */
  | 'LOW_INCOME_CONFIDENCE'
  /**
   * A2 — fewer than two COMPLETE calendar months, so no month-over-month
   * comparison exists. A direction cannot be inferred from one month, and a
   * partial month is never substituted to reach two.
   */
  | 'INSUFFICIENT_COMPLETE_MONTHS';

/**
 * One section the assessment explicitly declined to grade, and why.
 *
 * REVIEW-3 C-7 (audit E3): `scopeHint` silently changed what computeAssessment
 * could decide — under 'brief', debt was forced INSUFFICIENT_DATA (cured by
 * W3: the assembler emits the debt rows at every hint) and liquidity was
 * UNKNOWN ~30 days in 31 on the 30-day brief window (cured by W4: the
 * assessment window is scope-invariant) — and nothing in the output said so.
 * A consumer either implied a grade it did not have or went silent without
 * knowing it was silent. This record makes every remaining refusal a FACT the
 * consumer can read — and since W3+W4 those refusals name genuine data gaps,
 * never scope choices: say what is missing, or stay silent knowingly — never
 * imply.
 */
export interface UngradedSection {
  section: UngradedSectionName;
  /** The refusing verdict the section carries (mirrors its classification). */
  verdict: 'INSUFFICIENT_DATA' | 'UNKNOWN' | 'UNRELIABLE';
  reason:  UngradedReasonCode;
  /** Human-readable explanation, suitable for prose. */
  detail:  string;
}

// ── Typed assessment sections ─────────────────────────────────────────────────


export interface DataQualitySection {
  transactionHistoryCompleteness: CompletenessLevel;
  snapshotSpanDays:               number;
  incomeConfidence:               ConfidenceLevel;
  incomeTransactionCount:         number;
  /**
   * TI2-W2 — fraction of in-window income that is sign-default inflow with no
   * resolved source (unknownInflowTotal / incomeTotal), or null when there is no
   * in-window income. A material share downgrades incomeConfidence below HIGH
   * even when the row-count proxy alone would pass — the honesty fact TE-2B adds
   * that a count of income transactions cannot see.
   */
  unidentifiedInflowShare:        number | null;
}


export interface CashFlowSection {
  reliability:                  CashFlowReliability;
  /** Mirrors income confidence — income is the volatile input in the cash flow equation. */
  confidence:                   ConfidenceLevel;
  deficitCause:                 DeficitCauseClassification;
  transactionCompleteness:      CompletenessLevel;
  /**
   * M1 — mean observed INCOME per reliable (complete, untruncated) calendar
   * month: the same month population as `estimatedMonthlyExpenses`. Never a
   * window total normalised by days. Null when no reliable month exists.
   */
  impliedMonthlyIncome:         number | null;
  /**
   * NET-BASELINE-1 — mean NET economic spending per reliable month: gross charges
   * less refunds dated that month, each month floored at 0. The figure every
   * "how much do I spend" derivation divides by.
   */
  estimatedMonthlyExpenses:     number | null;
  /**
   * Present ONLY when refunds moved the monthly figure materially (≥ $1/month):
   * the mean GROSS charges and what refunds took off, so the difference is
   * explained from evidence rather than subtracted in prose. `gross − refundEffect
   * = estimatedMonthlyExpenses`, exactly.
   */
  monthlyExpensesGross?:        number;
  monthlyRefundEffect?:         number;
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
   * v2.6-ASSESS-2 — which rung supplied `estimatedMonthlyExpense`: the user's
   * DECLARED figure or the MEASURED reliable-month average. Null when coverage
   * was refused. A surface quoting a coverage figure must say which it divided by.
   */
  estimatedMonthlyExpenseBasis: import('@/lib/liquidity/expense-baseline').ExpenseBaselineBasis | null;
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
  /**
   * P2-7D — REPORTING-currency balance (AccountSummaryItem.reportingBalance), the
   * same basis the candidate was ranked/weighted on, so a candidate surfaced next
   * to other reporting-currency figures reads in one consistent currency. NOT the
   * native account balance (that is account-detail on AccountSummaryItem.balance).
   */
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
  /** Lowest REPORTING-balance debt account — the snowball strategy target (ranked in
   *  the Space reporting currency, not native magnitudes). null if no accounts available. */
  snowballCandidate:          DebtCandidate | null;
  /** Weighted average APR across accounts where APR is known — weighted by REPORTING
   *  balance. null if none known. */
  weightedAvgApr:             number | null;
  knownMonthlyInterestBurden: number | null;
  missingAprAccountNames:     string[];
  hasBalanceOnlyDebt:         boolean;
  /**
   * P2-7D — true when any debt account driving this strategy had an ESTIMATED
   * reporting-currency balance (missing/walked-back FX or null-residue provenance),
   * so the cross-currency ranking/weighting/interest-burden figures are not exact.
   * Omitted when false. Data-only until Phase 4; consumers must not present the
   * cross-currency comparison as exact when this is set.
   */
  balancesEstimated?:         boolean;
}

// ── 2.1 Capital Allocation — evidence enhancement ─────────────────────────────

/**
 * Named data domains that drive or are irrelevant to a capital allocation decision.
 * Used in primaryEvidence / ignoredEvidence so the LLM can explain its reasoning.
 */

export type AllocationEvidenceDomain = 'cashFlow' | 'debt' | 'liquidity' | 'investments';
// W2 — 'goals' deleted from the union (Goals retired; no engine ever cited it).

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

// ── 2.3B Spending Trends Engine types (D6.3B-1) ───────────────────────────────

/** Direction of a metric's month-over-month movement. */

export type TrendDirection = 'RISING' | 'FALLING' | 'FLAT' | 'INSUFFICIENT_DATA';

/** Which cash-flow metric a trend line describes. */

export type SpendingTrendMetric = 'income' | 'expense' | 'net';

/**
 * Deterministic month-over-month trend for a single cash-flow metric.
 *
 * Computed EXCLUSIVELY from complete calendar months in
 * TransactionsSummaryData.monthlyBreakdown — every month flagged `partial`
 * is excluded before any comparison. Fields are null when there is not enough
 * complete-month history to compute them (< 2 months for MoM, < 3 for rolling).
 *
 * `net` mirrors the top-level netCashFlow convention EXACTLY — since REVIEW-3
 * C-3 that is the CANONICAL economic net: income − clampEconomicSpend(gross
 * expense, refunds). Debt payments and transfers are movement, not cash flow,
 * and are excluded. Single formula source: metricValue().
 */

export interface MetricTrend {
  metric:                SpendingTrendMetric;
  /** YYYY-MM of the most recent complete month, or null when none. */
  latestCompleteMonth:   string | null;
  /** YYYY-MM of the prior complete month, or null when < 2 complete months. */
  previousCompleteMonth: string | null;
  /** latest − previous. null when < 2 complete months. */
  momDeltaAbs:           number | null;
  /**
   * Percentage change vs the previous complete month, using |previous| as the
   * denominator so the sign follows the delta. null when < 2 complete months
   * or the previous value is 0 (division undefined).
   */
  momDeltaPct:           number | null;
  /** Mean over the 3 most recent complete months. null when < 3 complete months. */
  rolling3moAvg:         number | null;
  /**
   * Movement classification. INSUFFICIENT_DATA when < 2 complete months exist —
   * the LLM must NOT infer or narrate a trend in that case.
   */
  direction:             TrendDirection;
}

/**
 * Deterministic spending-trends facts (D6.3B-1).
 *
 * Consumes TransactionsSummaryData.monthlyBreakdown ONLY — no new queries, no
 * LLM, no schema access. All comparative math uses complete months exclusively;
 * partial months are excluded and listed in `partialMonthsExcluded`.
 *
 * This slice intentionally covers month-over-month deltas, a 3-month rolling
 * average, and a direction classification only. No seasonality and no category
 * drift are computed here.
 */

export interface SpendingTrendsSection {
  confidence:             ConfidenceLevel;
  completeMonthsAnalyzed: number;
  /** YYYY-MM keys excluded from comparisons because the window clipped them. */
  partialMonthsExcluded:  string[];
  metricTrends:           MetricTrend[];
}

// ── 2.3C Trajectory Assessment (A2) ──────────────────────────────────────────

/**
 * Whether the user's measured financial trajectory is getting better or worse.
 *
 * WHY THIS EXISTS. computeSpendingTrends already produced per-metric DIRECTIONS
 * (income/expense/net RISING|FALLING|FLAT) and the serializer already showed them
 * to the model — but no deterministic conclusion was drawn from them. Direction
 * without significance is exactly the gap where a language model supplies its own
 * narrative: the same "expenses fell 3%" can be told as progress or as noise, and
 * nothing in the assessment said which. A2 makes the significance deterministic.
 *
 * THE ARBITER IS `net`, NOT A VOTE. Income and expense do not get equal ballots:
 * `net` (metricValue) is ALREADY their canonical resolution — income minus
 * clampEconomicSpend(expense, refunds), the REVIEW-3 C-3 economic net. So
 * "income rose but expenses rose faster" is not a tie to be broken here; it is a
 * question the canonical basis has already answered. Re-deciding it in this layer
 * would be a second, competing definition of the same fact.
 *
 * MATERIALITY IS INHERITED, NOT REDEFINED. A direction of FLAT already means the
 * move was below TREND_FLAT_PCT. This layer adds no second threshold: "material"
 * means "the existing engine did not call it FLAT".
 */
export type TrajectoryClassification =
  /** Canonical economic net rose materially month over month. */
  | 'IMPROVING'
  /** Canonical economic net fell materially month over month. */
  | 'WORSENING'
  /** Net flat, and no offsetting material component moves behind it. */
  | 'STABLE'
  /**
   * Net is flat, but income AND expense both moved materially — the steadiness is
   * the product of two offsetting moves, not of a steady state. Reporting that as
   * STABLE would be a false comfort: a household whose income fell 20% while
   * spending fell 20% has a flat net and a materially changed position.
   */
  | 'MIXED'
  /** Fewer than two complete months — no comparison exists. */
  | 'INSUFFICIENT_DATA';

/** A component move that complicates the headline verdict. */
export interface TrajectorySignal {
  metric:    SpendingTrendMetric;
  direction: TrendDirection;
  /** Plain statement of why this move runs against (or complicates) the verdict. */
  note:      string;
}

/**
 * Deterministic trajectory conclusion (A2).
 *
 * Consumes SpendingTrendsSection ONLY — no raw transactions, no new query, no
 * second measurement basis. The authority chain stays:
 *   canonical transaction basis → complete-month trend metrics → this verdict.
 */
export interface TrajectorySection {
  classification: TrajectoryClassification;
  /**
   * Mirrors SpendingTrendsSection.confidence, which ALREADY encodes how much
   * history stands behind the verdict (< 2 complete months LOW, 2 MEDIUM, >= 3
   * HIGH). A one-period comparison is therefore never presented as more than it
   * is, and no second confidence vocabulary is introduced.
   */
  confidence:     ConfidenceLevel;
  /**
   * What the verdict was computed from. 'MONTH_OVER_MONTH' is a SINGLE-period
   * comparison — the honest name for one delta between two complete months.
   * Null when the verdict was withheld.
   */
  basis:          'MONTH_OVER_MONTH' | null;
  completeMonthsAnalyzed: number;
  /** The composite that decided the verdict. */
  netDirection:      TrendDirection;
  incomeDirection:   TrendDirection;
  expenseDirection:  TrendDirection;
  /** Material component moves running against, or complicating, the verdict. */
  divergentSignals:  TrajectorySignal[];
}

// ── 2.4 Goal Alignment Engine types — DELETED (W2) ───────────────────────────
// GoalAlignmentStatus / GoalAlignmentItem / GoalAlignmentSection (and the
// 'MIXED' overall status that lived only on that section) were removed with
// the Goals retirement — there are no goals left to align against.

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
  // W2 — 'GOALS_MISALIGNED' deleted (its emitting rule read the retired
  // goal-alignment section).
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
  // W2 — 'ALIGN_SPENDING_WITH_GOALS' deleted with the goal-alignment section.
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
 *   spendingTrends       — 2.3B Spending Trends Engine (deterministic MoM/rolling)
 *   trajectory           — 2.3C Trajectory Assessment (A2: significance of those trends)
 *   investmentReadiness  — 2.5 Investment Readiness Engine
 *   riskOpportunities    — 2.6 Risk & Opportunity Engine (aggregates 2.1–2.5 + base)
 *
 * W2 — goalAlignment (2.4) was removed with the Goals retirement; engine
 * numbering is preserved for doc continuity.
 */

export interface FinancialAssessment {
  dataQuality:           DataQualitySection;
  cashFlow:              CashFlowSection;
  debt:                  DebtSection;
  liquidity:             LiquiditySection;
  capitalAllocation:     CapitalAllocationSection;      // 2.1
  debtStrategy:          DebtStrategySection;           // 2.2
  spendingOpportunities: SpendingOpportunitySection;    // 2.3
  spendingTrends:        SpendingTrendsSection;         // 2.3B
  trajectory:            TrajectorySection;             // 2.3C (A2)
  investmentReadiness:   InvestmentReadinessSection;    // 2.5
  riskOpportunities:     RiskOpportunitySection;        // 2.6
  /** Top-ranked priority — used by the prompt for the leading instruction. */
  currentStatePriority:  CurrentStatePriority;
  /** Typed advisor flags derived deterministically from the sections above. */
  advisorHeuristics:     AdvisorHeuristic[];
  /** Ranked list of active priorities — deterministic hints, not recommendations. */
  priorities:            AssessmentPriority[];
  /**
   * REVIEW-3 C-7 — sections whose grade was WITHHELD, each with a declared
   * reason. Empty when every section was graded. Consumers must read this
   * before implying any grade: a missing verdict is a refusal, not a pass.
   */
  ungraded:              UngradedSection[];
}

// ── Thresholds ────────────────────────────────────────────────────────────────

