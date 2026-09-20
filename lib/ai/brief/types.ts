/**
 * lib/ai/brief/types.ts
 *
 * THE DAILY BRIEF'S TWO SHAPES — the evidence code hands the model, and the
 * narration the model hands back.
 *
 * ⚠️ THE PACKAGE IS WHAT LEAVES THE SERVER. Every key below is a fact an existing
 * authority computed, rounded for reading, and nothing more: no account id, no
 * mask, no institution, no provider identifier, no transaction description, no
 * other user's memory, no prose from an earlier Brief. A key that is ABSENT was
 * not measured — it is never a zero, and the prompt says so.
 *
 * ⚠️ THE NARRATION HOLDS NO NUMBER CODE DID NOT. Its figures are checked against
 * this package before a Brief is accepted (licence.ts); its `evidence` paths are
 * resolved against it (contract.ts).
 */

/**
 * One measured movement, in the metric's own direction.
 *
 * `pct` is null when the opening value cannot be a base — nothing was there, or
 * it was smaller than the movement itself, so the ratio would describe the base
 * and not the change (lib/data/snapshot-window `pctOfOpening`). `from` is then
 * present: the opening the percentage was withheld over, so the change can be
 * stated as two amounts instead.
 */
export interface BriefDelta {
  abs: number;
  pct: number | null;
  from?: number;
}

/**
 * Movements between two observations. `from`/`to` are the window's dates; a
 * metric appears only when it was measured over exactly that window.
 */
export interface BriefChangeWindow {
  from: string;
  to:   string;
  netWorth?:      BriefDelta;
  liquid?:        BriefDelta;
  investments?:   BriefDelta;
  digitalAssets?: BriefDelta;
  debt?:          BriefDelta;
}

export interface BriefActivityRow {
  date:     string;
  /** Positive = money in, negative = money out. Reporting-currency agnostic (row currency). */
  amount:   number;
  /** The canonical FlowType, or UNCLASSIFIED. */
  flow:     string;
  merchant?: string;
  category: string;
  pending?: true;
  /** Both sides of this movement are the user's own accounts — one LEG of it. */
  betweenOwnAccounts?: true;
  /**
   * The CLASS of account this row posted on (lib/account-classifier `accountTier`):
   * LIQUID = checking/savings, LIABILITY = a card or loan, ASSET = investment,
   * crypto or other. A class, never an identity. It is the only evidence that a
   * movement belongs to a balance's change: a purchase that posted on a LIABILITY
   * account is part of what is owed; one on a LIQUID account is not. Absent when
   * the account's class is not known — then no connection is established.
   */
  account?: BriefAccountClass;
}

export type BriefAccountClass = 'LIQUID' | 'LIABILITY' | 'ASSET';

/**
 * A DETERMINISTIC CLASSIFICATION AS THE MODEL RECEIVES IT — never a bare label.
 *
 * The assessment's `ClassificationReason` (lib/ai/intelligence) plus the verdict
 * and its confidence: what was graded (`scope`), which rung fired (`reasonCode`),
 * the operands and thresholds the rule compared (`reasonMetrics`), and what they
 * were computed over. One shape for every classification the Brief ships.
 */
export interface BriefClassification {
  classification: string;
  scope:          string;
  reasonCode:     string;
  reasonMetrics:  Record<string, number | string | null>;
  confidence:     string;
  evidencePopulation: { kind: string; accounts: number; graded: number };
}

/** The claim families a Brief makes, each resting on its own population of sources. */
export const BRIEF_CLAIMS = [
  'netWorth', 'liquid', 'debt', 'investments', 'digitalAssets', 'pricedPositions', 'cashFlow',
] as const;
export type BriefClaim = (typeof BRIEF_CLAIMS)[number];

/**
 * CLAIM-SCOPED EVIDENCE — whether the sources behind ONE family of figures are
 * current. Completeness is a property of a claim, never of the Space.
 *
 * `completeness` is M1's contract (lib/ai/measures/measure.ts `Completeness`):
 * the same tiers, a reason sentence, and `byComponent` listing every source that
 * feeds THIS population — only when one of them is behind. A source that feeds a
 * different population does not appear, however stale it is.
 */
export interface BriefClaimEvidence {
  /** The package paths this entry governs (`*` = any measured window). */
  covers:     string[];
  /** What the figures were computed over. */
  population: string;
  /** How many sources feed that population in this Space. */
  sources:    number;
  /**
   * `reason` names each out-of-date source this claim rests on, with its state and
   * last update; `byComponent` (present only then) lists every source of the claim
   * with its tier. The same source's row in `freshness.staleSources` says which
   * claims it `affects` — one mapping, read from either side.
   */
  completeness: import('@/lib/ai/measures/measure').Completeness;
}

export interface BriefRecentActivity {
  from: string;
  to:   string;
  days: number;
  /** Every row in the window was read before ranking. */
  complete: boolean;
  transactionsInWindow: number;
  /** The largest movements by size, at most five. */
  top: BriefActivityRow[];
}

export type BriefBasis = 'CURRENT' | 'RETROSPECTIVE';

export interface BriefPackage {
  identity: {
    briefDay: string;
    /** The information ceiling. Nothing dated after it contributed. */
    asOf:     string;
    currency: string;
    basis:    BriefBasis;
  };

  /** Present only for a CURRENT package — freshness is a claim about today. */
  freshness?: {
    /** The band of the OLDEST balance observation in the Space. */
    band: string;
    /** PROVIDER_ATTESTED only when every observed account is; else INGESTION / UNOBSERVED. */
    basis: string;
    oldestBalanceObservedAt: string | null;
    oldestBalanceAgeDays:    number | null;
    staleAccounts:           number;
    unknownFreshnessAccounts: number;
    /** Sources behind the Space that need attention (lib/connections/space-data-health); absent when unreadable. */
    connectionsNeedingAttention?: number;
    needsReauth:             boolean;
    /**
     * The sources that need attention, by the name the viewer may see, with their
     * state and the last day Fourth Meridian successfully received data from each
     * (lib/connections/space-data-health.core.ts) — so a conclusion can be
     * qualified with "Chase hasn't updated since Sep 10" rather than "some
     * balances". Omitted when every source is current.
     */
    staleSources?: {
      label: string; state: string; lastUpdated: string | null;
      /**
       * The claims this source's staleness actually reaches (the keys of
       * `claimEvidence`). Empty = it qualifies nothing in this package. Absent only
       * when claim evidence could not be established.
       */
      affects?: BriefClaim[];
    }[];
  };

  /**
   * Per claim: the population it rests on and whether THAT population's sources
   * are current (claim-evidence.ts). CURRENT packages only. A claim with no entry
   * was not established — it is never "stale by default".
   */
  claimEvidence?: Partial<Record<BriefClaim, BriefClaimEvidence>>;

  currentState: {
    basis: 'CURRENT_ACCOUNTS' | 'HISTORICAL_SNAPSHOT';
    observedOn?: string;
    netWorth: number | null;
    liquid:   number | null;
    debt:     number | null;
    investments?: {
      traditional: number | null;
      digital:     number | null;
      combined:    number | null;
      /** A component could not be measured here, so the unknown one is null, not 0. */
      withheld?: true;
    };
    concentration?: {
      classification: string;
      topSymbol:      string | null;
      topWeightPct:   number;
      /** The value the weight is a share of. */
      populationValue: number;
      populationIsComplete: boolean;
      /**
       * Set by relevance.ts on the model's copy only: NEW / CHANGED since the
       * previous day's Brief, or UNCHANGED (present only because today's
       * investment movement makes it relevant). An unchanged, irrelevant
       * concentration is removed from the model's copy altogether.
       */
      novelty?: 'NEW' | 'CHANGED' | 'UNCHANGED';
    };
    /** Accounts in the Space this package cannot see. A count, never an identity. */
    hiddenAccounts?: number;
  };

  recentChanges: {
    /** Since the previous day's observation. */
    d1?: BriefChangeWindow;
    /** Past week (the product's 1W window). */
    w1?: BriefChangeWindow;
    /** Past month (the product's 1M window). */
    m1?: BriefChangeWindow;
  };

  recentActivity?: BriefRecentActivity;

  behavior?: {
    window: { from: string; to: string; days: number };
    /** M1 — mean income per complete calendar month, the same population as expenses. */
    monthlyIncome:       number | null;
    /** M1 — the canonical expense baseline (the figure `liquidity.coverageMonths` divided by). */
    monthlyExpenses:     number | null;
    /** Which rung supplied `monthlyExpenses`: DECLARED by the user or MEASURED. Absent when refused. */
    monthlyExpensesBasis?: 'STATED' | 'DECLARED' | 'MEASURED';
    monthlyDebtPayments: number | null;
    cashFlowReliability: string;
    incomeConfidence:    string;
    deficitCause:        string;
    /**
     * Present only when a deficit was graded: the verdict WITH its scope, rung and
     * operands (economic net, debt payments, the new charges they settled, net
     * paydown). Scope CASH_NET_AFTER_DEBT_PAYDOWN — never "debt payments".
     */
    deficit?:            BriefClassification;
    /** CURRENT only — graded against today's balances. Each carries WHY it fired. */
    liquidity?: BriefClassification & { coverageMonths: number | null };
    /**
     * The RATE on the balance owed today (scope RATE_ON_OWED_BALANCE) — not the
     * size of the debt, not how it is used or repaid, not a verdict on the user's
     * debt situation. Was `debt: { classification }`, a bare label that was
     * narrated as "the most severe tier, driven by how you've been using it".
     */
    debtRate?: BriefClassification & { aprCompleteness: string };
    /**
     * What that rate would cost, next to the user's own position — ungraded facts
     * with their operands. `monthlyInterestIfCarried` is NOT interest being paid.
     * Present only beside a flagged rate (WARNING / CRITICAL): it answers "the rate
     * is high — does it matter here?", and is not a standing fact to narrate daily.
     */
    debtBurden?: {
      ratedOwed: number;
      monthlyInterestIfCarried: number | null;
      interestOfMonthlyIncomePct: number | null;
      interestOfMonthlyExpensesPct: number | null;
      owedOfLiquidPct: number | null;
      /** The bases those percentages divided by. */
      comparedWith: { monthlyIncome: number | null; monthlyExpenses: number | null; liquid: number | null };
    };
  };

  plans?: {
    goals: {
      metric: string | null;
      targetAmount: number;
      byDate: string;
      current?: number;
      remaining?: number;
      progressPct?: number;
    }[];
    planned: { label: string; amount: number }[];
    /** The nearest future cash projection on record — a topic, never its value. */
    nextCheckpoint?: { metric: 'liquid'; horizon: string };
  };

  dataQuality: {
    historyDays: number | null;
    transactionHistory: string | null;
    knowledgeGaps: { account: string; missing: string }[];
    ungraded: { section: string; reason: string }[];
    unidentifiedIncomeSharePct?: number;
    unvaluedPositions: number;
    totalsEstimated: boolean;
    totalsUnconverted: boolean;
  };
}

// ── Narration ────────────────────────────────────────────────────────────────

export const OBSERVATION_KINDS = [
  'CASH', 'SPENDING', 'INCOME', 'DEBT', 'INVESTMENTS', 'PLAN', 'DATA_QUALITY',
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export const IMPORTANCE = ['NOTABLE', 'CONTEXT'] as const;
export type Importance = (typeof IMPORTANCE)[number];

export interface BriefObservation {
  kind:       ObservationKind;
  title:      string;
  body:       string;
  importance: Importance;
  /** Package paths this observation rests on, e.g. "recentChanges.w1.liquid". */
  evidence:   string[];
}

/** What the model returns. */
export interface BriefNarration {
  headline:     string;
  quiet:        boolean;
  observations: BriefObservation[];
}

/** An accepted Brief — the narration, validated, with its provenance. */
export interface DailyBrief extends BriefNarration {
  briefDay:     string;
  generatedAt:  string;
  evidenceAsOf: string;
}
