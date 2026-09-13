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

/** One measured movement, in the metric's own direction. `pct` null when the opening was 0. */
export interface BriefDelta {
  abs: number;
  pct: number | null;
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
    accountsWithSyncErrors:  number;
    needsReauth:             boolean;
  };

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
    monthlyIncome:       number | null;
    monthlyExpenses:     number | null;
    monthlyDebtPayments: number | null;
    cashFlowReliability: string;
    incomeConfidence:    string;
    deficitCause:        string;
    /** CURRENT only — graded against today's balances. */
    liquidity?: { classification: string; coverageMonths: number | null };
    debt?:      { classification: string; aprCompleteness: string };
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
