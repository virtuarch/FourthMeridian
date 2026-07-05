/**
 * lib/ai/types.ts
 *
 * Core type contracts for the AI Context Builder (D4).
 *
 * Design principles:
 * - ContextDomain is an open string type, not an enum. This keeps the
 *   contract template-agnostic — finance, travel, business, property, and
 *   future Space types all register their own domain strings without touching
 *   this file.
 * - FinanceDomains provides the canonical constants for the built-in finance
 *   template. Non-finance templates define their own constants elsewhere.
 * - SpaceContext_AI uses an open Record<string, ContextDomainSection> for
 *   domains rather than named fields, for the same reason.
 * - Signals are deterministic and rule-based. No LLM calls here.
 *
 * Security invariant (enforced by lint rule — see eslint config):
 *   No file under lib/ai/ may import lib/plaid/encryption or call any
 *   decrypt function. Credential handling belongs exclusively to provider
 *   adapters and sync execution.
 */

import type { SpaceMemberRole } from '@prisma/client';

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

/**
 * An open string key identifying a context domain (e.g. "accounts",
 * "transactions_summary"). Not an enum — new templates add new strings
 * without modifying this file.
 */
export type ContextDomain = string;

/**
 * Built-in domain keys for the finance template.
 * Other templates (Travel, Business, Property, …) define their own
 * constants in their respective assembler directories.
 */
export const FinanceDomains = {
  ACCOUNTS:             'accounts',
  TRANSACTIONS_SUMMARY: 'transactions_summary',
  TRANSACTIONS_RAW:     'transactions_raw',
  HOLDINGS_SUMMARY:     'holdings_summary',
  HOLDINGS_RAW:         'holdings_raw',
  GOALS:                'goals',
  MEMBERS:              'members',
  SNAPSHOT_HISTORY:     'snapshot_history',
  PROVIDERS:            'providers',
  PLATFORM_HEALTH:      'platform_health',
} as const;

export type FinanceDomain = typeof FinanceDomains[keyof typeof FinanceDomains];

// ---------------------------------------------------------------------------
// Domain section
// ---------------------------------------------------------------------------

/**
 * The output of a single domain assembler. The `data` field is intentionally
 * `unknown` — consumers type-narrow against their own interfaces.
 */
export interface ContextDomainSection {
  domain:      string;
  assembledAt: string; // ISO-8601
  data:        unknown;
}

// ---------------------------------------------------------------------------
// Assembler options
// ---------------------------------------------------------------------------

/**
 * Options threaded through to each assembler invocation.
 * `scopeHint` lets callers signal intent without changing the domain list:
 *   - 'brief'  → assembler may return a condensed summary (for Daily Brief)
 *   - 'full'   → assembler returns the complete section (default)
 */
export interface AssemblerOptions {
  scopeHint?: 'full' | 'brief';
  /**
   * Optional explicit transaction window (D6 dynamic windows). When present,
   * the transactions assembler summarizes this UTC date range instead of its
   * default 30/90-day span. Both bounds are inclusive YYYY-MM-DD dates. Other
   * assemblers ignore this field. Absent → default behavior is preserved.
   */
  transactionWindow?: {
    startDate: string; // YYYY-MM-DD, inclusive floor
    endDate:   string; // YYYY-MM-DD, inclusive ceiling
    label?:    string; // human phrase for provenance ("year-to-date 2026")
  };
  /**
   * Optional transaction-drilldown request (D6 — category/merchant evidence
   * retrieval). Present ONLY for explicit follow-up questions like "what is this
   * Other category made up of?" or "show me the largest transactions". When set,
   * the transactions assembler additionally returns a bounded list of the actual
   * contributing transactions (TransactionDrilldown) for explainability. Absent
   * on every ordinary prompt — raw rows are never surfaced by default. Other
   * assemblers ignore this field.
   *
   * This is evidence retrieval, not a new calculation engine: it re-reads rows
   * already inside the Space's visibility boundary. Raw rows are drawn from
   * FULL-visibility accounts only (BALANCE_ONLY / SUMMARY_ONLY accounts never
   * contribute line items).
   */
  drilldown?: {
    /** Resolved TransactionCategory to filter to (e.g. "Other"). */
    category?: string;
    /** Free-text merchant query when the drilldown targets a specific merchant. */
    merchant?: string;
    /** Inclusive window floor (YYYY-MM-DD). Defaults to the summary window. */
    startDate?: string;
    /** Inclusive window ceiling (YYYY-MM-DD). Defaults to the summary window. */
    endDate?: string;
    /** Max rows to surface (defaults applied in the assembler). */
    limit?: number;
    /**
     * When true, non-spending categories (Income / Interest / Transfer /
     * Payment) are eligible — set only when the user explicitly asks about one
     * of those. Default false: spending (amount < 0) only.
     */
    includeNonSpending?: boolean;
    /** Short human label for provenance (e.g. "January 2026 · Other"). */
    label?: string;
  };
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * A deterministic, rule-based signal emitted by a signal detector after
 * context assembly. Signals are NOT generated by LLMs.
 *
 * Severity levels:
 *   - 'info'     → informational, no action required
 *   - 'warning'  → condition worth surfacing to the user
 *   - 'critical' → requires prompt attention
 */
export interface ContextSignal {
  id:         string;  // stable deterministic id — `${spaceId}:${type}` or `${spaceId}:${type}:${entityId}`
  type:       string;  // SignalType constant — machine-readable signal kind (D4 Slice 5)
  domain:     string;  // ContextDomain that produced this signal
  spaceId:    string;
  severity:   'info' | 'warning' | 'critical';
  title:      string;  // short human-readable summary (the LLM consumes this)
  body?:      string;  // optional additional detail
  value?:     number;  // observed value (e.g. balance, count)
  threshold?: number;  // rule threshold that triggered this signal
  metadata?:  Record<string, unknown>;
  detectedAt: string;  // ISO-8601
}

// ---------------------------------------------------------------------------
// Domain-specific data shapes
// ---------------------------------------------------------------------------

/**
 * Health summary for the accounts domain.
 * Account names are only populated for FULL-visibility accounts — BALANCE_ONLY
 * accounts contribute to error/stale counts but their names are never exposed.
 */
export interface AccountHealthSummary {
  errorCount:              number;
  staleCount:              number;
  needsReauthCount:        number;
  errorAccountNames:       string[]; // FULL visibility only
  staleAccountNames:       string[]; // FULL visibility only
  needsReauthAccountNames: string[]; // FULL visibility only
}

/**
 * A single account entry in the accounts domain section.
 * `name` is always the display-safe name — real name for FULL, generic label
 * for BALANCE_ONLY. `institution` is omitted on BALANCE_ONLY entries.
 *
 * Debt metadata fields (`apr`, `minimumPayment`, etc.) are populated ONLY for
 * FULL-visibility debt-type accounts. They are withheld for BALANCE_ONLY and
 * SUMMARY_ONLY accounts to prevent identifying financial assumptions from leaking
 * across Space membership boundaries.
 *
 * `rateSource` reflects where the effective APR came from:
 *   'user'     — DebtProfile.apr was set by the account owner
 *   'provider' — FinancialAccount.interestRate was populated by Plaid or another
 *                provider; not user-confirmed
 *   null       — no rate data available from any source
 */
export interface AccountSummaryItem {
  id:               string;
  name:             string;
  type:             string;
  institution?:     string;
  balance:          number;
  currency:         string;
  lastUpdated:           string;      // ISO-8601 — when FM last wrote this row from Plaid
  /** D4 Balance Freshness Provenance. ISO-8601 timestamp Plaid reports for when
   *  the balance was last fetched from the institution. Null when Plaid does not
   *  supply this field (currently all institutions except Capital One).
   *  Optional until the corresponding FinancialAccount schema field lands. */
  balanceLastUpdatedAt?: string | null;
  syncStatus?:      string | null;
  needsReauth:      boolean;
  visibilityLevel:  'FULL' | 'BALANCE_ONLY';

  // ── Debt metadata (FULL visibility, debt-type accounts only) ──────────────
  // Resolved from DebtProfile (preferred) → FinancialAccount flat fields (fallback).
  // All fields are undefined for non-debt account types and for BALANCE_ONLY accounts.
  apr?:                   number | null; // effective APR; null = known missing
  minimumPayment?:        number | null; // effective minimum payment; null = known missing
  rateSource?:            'user' | 'provider' | null;
  dueDay?:                number | null; // day of month (1–31)
  statementCloseDay?:     number | null; // day of month (1–31)
  promoAprEndDate?:       string | null; // ISO-8601 date string
  debtProfileUpdatedAt?:  string | null; // ISO-8601 — when DebtProfile was last touched
}

/**
 * A single knowledge gap — a field the AI needs for a calculation that has not
 * yet been provided by the user.
 *
 * Gaps are derived at assembly time from null/undefined debt metadata fields on
 * FULL-visibility debt accounts. They are never stored in the database; they are
 * recomputed on every `buildContext()` call.
 *
 * `field` is a stable machine key the chat prompt and UI can use to identify
 * what to collect. `label` is the human-readable name to surface in responses.
 * `debtSubtype` is included so the label can be contextualised (e.g. "Mortgage
 * Rate" instead of "APR" for a mortgage account).
 */
export interface KnowledgeGap {
  accountId:    string;
  accountName:  string;  // display-safe name (resolveDisplayName output)
  field:        'apr' | 'minimumPayment';
  label:        string;  // e.g. "APR", "Minimum Payment", "Mortgage Rate"
  debtSubtype?: string | null; // FinancialAccount.debtSubtype when present
}

/**
 * Data payload for the 'accounts' context domain.
 *
 * All monetary TOTALS are converted at read time into the Space's reporting
 * currency (Space.reportingCurrency; MC1 Phase 3 — the assembler builds a
 * real conversion context over the immutable FX archive). Per-account rows
 * keep their native currency. Unresolvable conversions (missing rate,
 * null-residue provenance) degrade to the native amount and taint
 * `totalsEstimated` — never excluded, never thrown. Presentation of the flag
 * is Phase 4; it is data-only here.
 *
 * When assembled with scopeHint='brief', the `accounts` array is omitted
 * to reduce payload size for the Daily Brief aggregator.
 *
 * `knowledgeGaps` lists debt metadata fields that are null for FULL-visibility
 * debt accounts. It is always present (possibly empty). The chat system prompt
 * uses this list to surface missing fields conversationally. The list is never
 * populated for BALANCE_ONLY accounts — those accounts' metadata is intentionally
 * withheld, so surfacing gaps for them would indirectly reveal their existence.
 */
export interface AccountsSectionData {
  totalCount:         number;
  totalAssets:        number;
  totalLiabilities:   number;
  netWorth:           number;
  totalLiquid:        number;
  totalInvestments:   number;
  totalDigitalAssets: number;
  totalRealAssets:    number;
  /**
   * MC1 Phase 3 Slice 4 (D-7) — true when any converted balance in the totals
   * above was estimated (rate walked back / missing, or null-residue
   * provenance). Data-only: no prompt or serializer consumes it until Phase 4.
   */
  totalsEstimated:    boolean;
  counts: {
    liquid:       number;
    investments:  number;
    digitalAssets: number;
    realAssets:   number;
    liabilities:  number;
  };
  health:         AccountHealthSummary;
  knowledgeGaps:  KnowledgeGap[];          // always present, possibly empty
  accounts?:      AccountSummaryItem[];    // omitted when scopeHint === 'brief'
  /**
   * Distinct FinancialAccount ids visible in this Space (one per SpaceAccountLink).
   * Populated regardless of scopeHint — used by the Daily Brief to deduplicate
   * accounts shared across multiple Spaces so "Accounts tracked" counts distinct
   * real accounts rather than link placements. IDs only; no balances or names.
   */
  accountIds?:    string[];
  /**
   * Privacy-safe identity roster of the accounts visible in this Space — one
   * entry per SpaceAccountLink. Populated regardless of scopeHint so the Daily
   * Brief can render the "Accounts Tracked" list after deduplicating by id.
   * NEVER contains balances. institution/mask are included only for FULL
   * visibility; BALANCE_ONLY/SUMMARY_ONLY entries carry a generic name and omit
   * institution/mask (mirroring the per-account `accounts` array behaviour).
   */
  trackedAccounts?: TrackedAccountLite[];
}

/**
 * Minimal, balance-free account identity used to build the Daily Brief's
 * "Accounts Tracked" roster. Deduplicated across Spaces by `id` downstream.
 */
export interface TrackedAccountLite {
  id:           string;              // FinancialAccount.id — the dedup key
  name:         string;              // privacy-resolved display name
  type:         string;              // AccountType
  subtype?:     string | null;       // debtSubtype when present
  institution?: string;             // FULL visibility only; omitted otherwise
  mask?:        string | null;       // last 4; FULL visibility only; omitted otherwise
  visibility:   'FULL' | 'BALANCE_ONLY' | 'SUMMARY_ONLY';
}

// ---------------------------------------------------------------------------
// Transactions summary domain types
// ---------------------------------------------------------------------------

/**
 * Spending total for a single transaction category.
 *
 * KD-17 (universal debits-only rule): `total` is the sum of |amount| over the
 * category's DEBIT rows only — the same population as expenseTotal and the
 * drilldown's matchedTotal, so the three surfaces always agree. Credit-side
 * rows (refunds, reimbursements, misclassified payment credits) are NEVER
 * netted into `total`; when present they are disclosed via `creditTotal`.
 * The rule is universal — it applies to non-spending categories too: Income's
 * inflow figure lives in incomeTotal, not here (its byCategory entry exists
 * for its `count`, read by lib/ai/intelligence/annotations.ts).
 */
export interface CategorySpend {
  category: string; // TransactionCategory value
  total:    number; // debit-only sum, absolute value (KD-17)
  /** Sum of positive-amount rows in this category, when > 0. Disclosure only —
   *  never added to `total`, never counted as spending. (KD-17) */
  creditTotal?: number;
  count:    number;
}

/**
 * Deterministic cash-flow rollup for a single calendar month (UTC).
 *
 * Buckets are computed directly from the transaction rows in the requested
 * window — never inferred from a total divided by a month count. This is the
 * authoritative source for any month-by-month question; the LLM must not
 * fabricate monthly figures from window totals or averages.
 *
 * Money semantics mirror the top-level TransactionsSummaryData exactly:
 *   incomeTotal      — positive amounts in Income + Interest categories
 *   expenseTotal     — absolute negative amounts, excluding Transfer & Payment
 *   debtPaymentTotal — absolute Payment-category outflows
 *   transferTotal    — absolute Transfer-category movement (both directions)
 * All money figures are settled-only (pending rows are excluded from totals but
 * counted in transactionCount, matching the top-level count convention).
 *
 * `partial` is true when the requested window does not fully cover this calendar
 * month (e.g. the current in-progress month, or a clipped first/last month) so
 * the figure can be labeled as incomplete rather than compared like a full month.
 */
export interface MonthlyBreakdownEntry {
  month:            string; // YYYY-MM (UTC)
  incomeTotal:      number;
  expenseTotal:     number;
  /** Gross flowType=REFUND sum for this month (P5 Slice 4 D-3 — mirrors the window-level field). */
  refundTotal:      number;
  debtPaymentTotal: number;
  transferTotal:    number;
  transactionCount: number; // settled + pending rows dated in this month
  /**
   * MC1 Phase 3 Slice 2 (D-7) — true when any converted row in this month was
   * estimated (rate walked back / missing, or null-residue currency). Always
   * emitted (false without a conversion context). Data-only until Phase 4 —
   * no prompt, serializer, or UI consumes it yet.
   */
  estimated:        boolean;
  /** True when the window clips this month (partial coverage). */
  partial?:         boolean;
  /**
   * True when this month sits at the fetch-cap coverage floor and older rows
   * within it were dropped by TRANSACTION_FETCH_LIMIT truncation (KD-7).
   * Distinct from `partial` (calendar clipping): a truncated month has
   * incomplete data and must be excluded from averages and month-over-month
   * trends and never presented as a complete month's figure.
   */
  truncated?:       boolean;
  /**
   * Deterministic per-category settled totals for THIS month, computed directly
   * from the queried rows (same rules as the top-level byCategory). Ordered by
   * absolute total descending; only categories with a non-zero settled total in
   * this month are present. A category absent from this list had no classified
   * settled transactions in this month within the queried window — consumers
   * must NOT render it as $0, invent it from an average, or fill a zero column.
   * Always present (possibly empty).
   */
  byCategory:       CategorySpend[];
  /** Top categories by absolute settled total in this month (≤3). Convenience
   *  slice of `byCategory` — kept for compact summaries. */
  topCategories?:   Array<{ category: string; total: number }>;
}

/**
 * A canonicalized SPENDING merchant rollup over the query window (D6.3A-1 —
 * Merchant Intelligence foundation; D6.3 stabilization). Rows are grouped by a
 * deterministic canonical key (see lib/transactions/merchant.ts); no ML or LLM
 * is involved.
 *
 * SPENDING-ONLY invariant (D6.3): this list represents money the user SPENT.
 * It is built exclusively from settled EXPENSE rows — amount < 0, with the
 * Income, Interest, Transfer, and Payment categories excluded. Payroll and
 * other inflows therefore never appear here (they belong in `incomeSources`),
 * and internal transfers and debt payments are likewise never reported as
 * merchants. `total` is the absolute sum of these settled expense amounts.
 * `category` is the merchant's dominant spending TransactionCategory (most
 * transactions; ties broken by larger absolute total). `firstSeen` /
 * `lastSeen` bound the merchant's activity inside the window.
 */
export interface MerchantSummary {
  /** Display-safe canonical merchant name. */
  canonicalName: string;
  /** Uppercased grouping key the name collapses to (stable across spellings). */
  canonicalKey:  string;
  /** Settled expense transaction count for this merchant in the window. */
  occurrences:   number;
  /** Absolute sum of settled expense amounts (spend magnitude). */
  total:         number;
  /** Dominant spending TransactionCategory for this merchant. */
  category:      string;
  /** Earliest settled expense date for this merchant (YYYY-MM-DD). */
  firstSeen:     string;
  /** Latest settled expense date for this merchant (YYYY-MM-DD). */
  lastSeen:      string;
}

/**
 * A canonicalized INCOME-SOURCE rollup over the query window (D6.3 stabilization
 * — companion to MerchantSummary). Grouped by the same deterministic canonical
 * key (lib/transactions/merchant.ts).
 *
 * INCOME-ONLY invariant: built exclusively from settled INFLOW rows — amount > 0
 * with flowType=INCOME (the same population that feeds the top-level
 * incomeTotal; includes dividends and interest earned since P5 Slice 4).
 * Transfers are excluded. `total` is the
 * (positive) sum of these settled inflow amounts. There is no `category` field:
 * every entry is, by construction, an income/interest source. This is where
 * payroll surfaces — it must never be described as a spending merchant.
 */
export interface IncomeSource {
  /** Display-safe canonical income-source name (e.g. an employer/payer). */
  canonicalName: string;
  /** Uppercased grouping key the name collapses to (stable across spellings). */
  canonicalKey:  string;
  /** Settled inflow transaction count for this source in the window. */
  occurrences:   number;
  /** Positive sum of settled inflow amounts for this source. */
  total:         number;
  /** Earliest settled inflow date for this source (YYYY-MM-DD). */
  firstSeen:     string;
  /** Latest settled inflow date for this source (YYYY-MM-DD). */
  lastSeen:      string;
}

/**
 * A merchant that appears two or more times in the query window —
 * a deterministic, rule-based indicator of a recurring charge.
 * No ML or LLM required.
 */
export interface RecurringCandidate {
  merchant:      string;
  occurrences:   number;
  typicalAmount: number; // mean amount across occurrences (negative = expense)
  category:      string;
}

/**
 * A single transaction surfaced by a drilldown (D6 — category/merchant evidence).
 * These are real line items, drawn ONLY from FULL-visibility accounts inside the
 * resolved Space/window. `amount` keeps the signed convention (negative = spend).
 * `accountName` is present only when the source account is FULL-visibility; it is
 * omitted otherwise so no account identity leaks across a visibility boundary.
 */
export interface DrilldownTransaction {
  date:         string;  // YYYY-MM-DD
  merchant:     string;  // canonical display name
  description?: string;  // raw provider description when available
  amount:       number;  // signed (negative = spend)
  category:     string;  // TransactionCategory value
  accountName?: string;  // FULL-visibility source account only
}

/**
 * Bounded evidence bundle answering a drilldown follow-up (D6 — "what is this
 * category made up of?", "show me the largest transactions"). Retrieval only —
 * no new aggregation semantics. Present on TransactionsSummaryData ONLY when the
 * request was an explicit drilldown; omitted on every ordinary prompt.
 *
 * `transactions` is sorted by absolute amount descending and capped. `totalCount`
 * / `matchedTotal` describe the FULL matching set in the window (pre-cap) so the
 * consumer can state coverage; `truncated` is true when rows were omitted by the
 * cap. `matchedTotal` and `shownTotal` are absolute sums.
 */
export interface TransactionDrilldown {
  /** Resolved category filter, if the drilldown was category-based. */
  category?:    string;
  /** Resolved merchant query, if the drilldown was merchant-based. */
  merchant?:    string;
  /** Inclusive window floor actually used (YYYY-MM-DD). */
  startDate:    string;
  /** Inclusive window ceiling actually used (YYYY-MM-DD). */
  endDate:      string;
  /** Human label for provenance (e.g. "January 2026 · Other"). */
  label?:       string;
  /** Matching transactions, sorted by |amount| desc, capped to the limit. */
  transactions: DrilldownTransaction[];
  /** Number of rows in `transactions` (post-cap). */
  shownCount:   number;
  /** Total matching rows in the window (pre-cap). */
  totalCount:   number;
  /** Absolute sum of the shown rows. */
  shownTotal:   number;
  /** Absolute sum of ALL matching rows in the window (the category/merchant total). */
  matchedTotal: number;
  /** True when totalCount > shownCount (rows omitted by the cap). */
  truncated:    boolean;
}

/**
 * Data payload for the 'transactions_summary' context domain.
 *
 * Summarizes banking transaction activity over a sliding window.
 * Raw transaction rows are never included — this domain is intentionally
 * aggregated-only to keep the context payload lean and avoid exposing
 * line-item detail to AI consumers by default.
 *
 * Amount sign convention (mirrors Plaid / existing codebase):
 *   positive → money in  (income, interest, incoming transfers)
 *   negative → money out (expenses, payments, outgoing transfers)
 *
 * `byCategory` lists all categories present in the window.
 * `recurringCandidates` is omitted when scopeHint='brief'.
 */
export interface TransactionsSummaryData {
  windowDays:       number;
  startDate:        string; // YYYY-MM-DD — window floor (requested)
  endDate:          string; // YYYY-MM-DD — most recent transaction date (or today)
  transactionCount: number; // settled + pending (of the rows actually aggregated)

  // ── Fetch-cap coverage (KD-7) ────────────────────────────────────────────
  /**
   * True when the number of matching rows exceeded `fetchLimit` and the OLDEST
   * rows were dropped (rows are fetched newest-first). When true, every total,
   * category/merchant rollup, and monthly figure covers only [coverageStartDate,
   * endDate] — figures before coverageStartDate are incomplete and must not be
   * presented as exact or compared month-over-month. Detected deterministically
   * via a LIMIT+1 sentinel fetch.
   */
  truncated:         boolean;
  /**
   * YYYY-MM-DD — the oldest date actually aggregated. Equals `startDate` when
   * `truncated` is false; when truncated it is the date of the oldest retained
   * row (the true coverage floor).
   */
  coverageStartDate: string;
  /** The row cap in force for this assembly (TRANSACTION_FETCH_LIMIT). */
  fetchLimit:        number;

  // ── Cash flow totals (FlowType P5 Slice 4 — flow semantics) ─────────────
  /** Sum of positive flowType=INCOME amounts (includes dividends, doctrine §5). */
  incomeTotal:       number;
  /**
   * Gross absolute sum over flowType ∈ {SPENDING, FEE, INTEREST} (D-2).
   * Refunds are NEVER netted here — see refundTotal (D-3) — preserving the
   * KD-17 debit-only reconciliation with byCategory.
   */
  expenseTotal:      number;
  /**
   * Gross absolute sum of flowType=REFUND rows (D-3): reversals of prior
   * spending, disclosed as a first-class figure. NOT income; consumers net
   * explicitly. Includes any positive spend-category rows the classifier
   * folded to REFUND (e.g. misclassified card-payment credits — N10 caveat).
   */
  refundTotal:       number;
  /** Absolute sum of source-side (amount < 0) flowType=DEBT_PAYMENT legs. */
  debtPaymentTotal:  number;
  /** Absolute sum of flowType=TRANSFER (internal moves, both directions). */
  transferTotal:     number;
  /** incomeTotal + refundTotal − expenseTotal − debtPaymentTotal (D-4; excludes transfers). */
  netCashFlow:       number;
  /**
   * MC1 Phase 3 Slice 4 (D-7) — true when any converted row in the window
   * totals above was estimated (rate walked back / missing, or null-residue
   * provenance). Data-only until Phase 4.
   */
  estimated:         boolean;

  // ── Pending ─────────────────────────────────────────────────────────────
  pendingCreditCount: number;
  pendingCreditTotal: number;
  pendingDebitCount:  number;
  /** Absolute value of pending outflows. */
  pendingDebitTotal:  number;

  // ── By category ─────────────────────────────────────────────────────────
  byCategory: CategorySpend[];

  // ── Monthly rollups (deterministic; D6) ─────────────────────────────────
  /**
   * Per-calendar-month cash-flow buckets for the requested window, oldest → newest.
   * Only months inside the window appear. This is the authoritative answer to any
   * month-by-month question — consumers must never derive monthly figures by
   * dividing a window total by a month count.
   */
  monthlyBreakdown: MonthlyBreakdownEntry[];

  // ── Highlights ──────────────────────────────────────────────────────────
  largestIncome:  { merchant: string; amount: number; date: string } | null;
  largestExpense: { merchant: string; amount: number; date: string } | null;

  // ── Recurring candidates (omitted on scopeHint='brief') ─────────────────
  recurringCandidates?: RecurringCandidate[];

  // ── Merchant rollup (D6.3A-1; omitted on scopeHint='brief') ──────────────
  /**
   * Canonicalized per-merchant SPENDING rollup over the window, sorted by
   * absolute total descending and capped to the top N merchants to bound prompt
   * size. Grouped by deterministic canonical key (lib/transactions/merchant.ts).
   * Settled expense rows only — income, interest, transfers, and debt payments
   * are excluded (see MerchantSummary). Omitted when scopeHint='brief'.
   */
  merchants?: MerchantSummary[];

  // ── Income-source rollup (D6.3 stabilization; omitted on scopeHint='brief') ─
  /**
   * Canonicalized per-source INCOME rollup over the window, sorted by total
   * descending and capped to the top N sources to bound prompt size. Grouped by
   * the same deterministic canonical key as `merchants`. Settled positive
   * Income/Interest rows only (see IncomeSource). Payroll surfaces here — never
   * in `merchants`. Omitted when scopeHint='brief'.
   */
  incomeSources?: IncomeSource[];

  // ── Drilldown evidence (D6; present only on explicit drilldown follow-ups) ─
  /**
   * Bounded list of the actual transactions behind a category/merchant/period,
   * returned ONLY when the request was an explicit drilldown ("what is this made
   * up of?", "show the largest transactions"). Omitted on every ordinary prompt
   * so raw rows are never surfaced by default. FULL-visibility accounts only.
   */
  drilldown?: TransactionDrilldown;
}

// ---------------------------------------------------------------------------
// Holdings summary domain types (D6.3C-1)
// ---------------------------------------------------------------------------

/**
 * A single aggregated investment position for the holdings domain.
 *
 * Positions are aggregated by `symbol` across every FULL-visibility account —
 * two brokerages both holding VTI produce one entry whose `value` is the sum.
 * `weight` is the fraction of `analyzedInvestedValue` (FULL-visibility, non-cash)
 * this symbol represents, in [0, 1].
 *
 * Positions are ONLY ever populated from FULL-visibility accounts. Holdings in
 * BALANCE_ONLY / SUMMARY_ONLY accounts contribute to the aggregate value totals
 * but never appear here — their symbols must not leak across Space membership
 * boundaries (mirrors the accounts assembler's BALANCE_ONLY guarantee).
 */
export interface HoldingPosition {
  symbol: string;
  name:   string;
  value:  number; // summed market value across FULL accounts
  weight: number; // 0..1, fraction of analyzedInvestedValue
}

/**
 * Concentration classification for the analyzable (FULL-visibility, non-cash)
 * portion of the portfolio.
 *   INSUFFICIENT_DATA — no analyzable positions (all holdings hidden or cash)
 *   DIVERSIFIED       — no meaningful single-name or top-heavy concentration
 *   MODERATE          — some concentration, not yet a risk
 *   CONCENTRATED      — a single name or top cluster dominates
 *   HIGHLY_CONCENTRATED — extreme single-name or top-cluster dominance
 */
export type ConcentrationClassification =
  | 'INSUFFICIENT_DATA'
  | 'DIVERSIFIED'
  | 'MODERATE'
  | 'CONCENTRATED'
  | 'HIGHLY_CONCENTRATED';

/**
 * Deterministic concentration metrics over the analyzable (FULL-visibility,
 * non-cash) positions, all computed relative to `analyzedInvestedValue`.
 *
 * All metric fields are null when there are no analyzable positions
 * (classification === 'INSUFFICIENT_DATA').
 *
 *   topWeight         — largest single-symbol weight, 0..1
 *   top5Weight        — sum of the five largest weights, 0..1 (or fewer if <5)
 *   herfindahl        — Σ(weight²), 0..1; higher = more concentrated
 *   effectiveHoldings — 1 / herfindahl; intuitive "effective number of positions"
 */
export interface HoldingsConcentration {
  classification:    ConcentrationClassification;
  topSymbol:         string | null;
  topWeight:         number | null;
  top5Weight:        number | null;
  herfindahl:        number | null;
  effectiveHoldings: number | null;
}

/**
 * Data payload for the 'holdings_summary' context domain (D6.3C-1).
 *
 * Deterministic, value-based investment intelligence computed from existing
 * Holding rows — no cost basis, no returns, no asset-class/sector data (see
 * `dataLimits`). Monetary values are denominated per the accounts domain's
 * MC1 Phase 3 contract (totals in the Space's reporting currency; per-row
 * values native). NOTE: this holdings assembler itself still sums raw values
 * (not yet threaded through the conversion seam — recorded as a Phase 3
 * closeout finding alongside F-3); all-USD data is unaffected.
 *
 * ── Visibility model (mirrors lib/ai/assemblers/accounts.ts) ─────────────────
 * Aggregate value totals (totalPortfolioValue, investedValue, cashValue,
 * cashPct) include EVERY visible account regardless of visibility level — these
 * are sums and reveal nothing identifying, exactly like the accounts domain
 * totals. Position-level detail (topPositions, positionCount, concentration) is
 * computed ONLY over FULL-visibility accounts. When any visible account is
 * BALANCE_ONLY / SUMMARY_ONLY and holds positions, `positionsPartiallyHidden`
 * is true and a note is added to `dataLimits`.
 *
 * `topPositions` is omitted when scopeHint === 'brief'.
 */
export interface HoldingsSummaryData {
  /** All visible holdings incl. synthetic cash rows. */
  totalPortfolioValue: number;
  /** Non-cash holdings across all visible accounts. */
  investedValue:       number;
  /** Synthetic uninvested-cash rows (isCash) across all visible accounts. */
  cashValue:           number;
  /** cashValue / totalPortfolioValue, 0..1 (0 when total is 0). */
  cashPct:             number;
  /** Count of distinct symbols in the analyzable (FULL, non-cash) set. */
  positionCount:       number;
  /** Value the concentration analysis is computed over (FULL, non-cash). */
  analyzedInvestedValue: number;
  /** True when some visible accounts are shared below FULL visibility and
   *  their positions are therefore excluded from position/concentration analysis. */
  positionsPartiallyHidden: boolean;
  /** Largest analyzable positions by value, descending (≤ HOLDINGS_TOP_N).
   *  Omitted when scopeHint === 'brief'. */
  topPositions?:       HoldingPosition[];
  concentration:       HoldingsConcentration;
  /** Deterministic statements of what this domain cannot answer, so the LLM
   *  never implies cost basis, gains, returns, or asset-class data exists. */
  dataLimits:          string[];
}

// ---------------------------------------------------------------------------
// Snapshot domain types
// ---------------------------------------------------------------------------

/**
 * A single SpaceSnapshot data point, normalized for AI consumption.
 * Field names are semantically clear rather than terse DB column aliases.
 */
export interface SnapshotDataPoint {
  date:         string; // YYYY-MM-DD
  netWorth:     number;
  totalAssets:  number;
  liabilities:  number; // `debt` column — positive absolute value
  liquid:       number; // cash + savings
  investments:  number; // `stocks` column
  digitalAssets: number; // `crypto` column
  cashOnHand:   number;
  netLiquid:    number;
}

/**
 * Data payload for the 'snapshot_history' context domain.
 *
 * `history` is bounded (≤ SNAPSHOT_HISTORY_LIMIT rows, newest-last).
 * When assembled with scopeHint='brief', `history` is omitted and only
 * `latest` + trend deltas are returned.
 */
export interface SnapshotSectionData {
  snapshotCount:   number;
  oldestDate:      string | null; // YYYY-MM-DD
  newestDate:      string | null; // YYYY-MM-DD
  /** Absolute net-worth change from oldest to newest in the window. */
  netWorthTrend:   number | null; // null if fewer than 2 snapshots
  /** Percentage change, null if oldest net worth was 0. */
  netWorthTrendPct: number | null;
  latest:          SnapshotDataPoint | null;
  history:         SnapshotDataPoint[]; // omitted on scopeHint='brief'
}

// ---------------------------------------------------------------------------
// Goals domain types
// ---------------------------------------------------------------------------

/**
 * A single goal summary for AI context.
 * Only fields relevant to AI-generated advice are included.
 * Sensitive or purely-UI fields (description, spendingCategory, etc.) are
 * omitted to keep the context payload lean.
 */
export interface GoalSummaryItem {
  id:       string;
  name:     string;
  category: string; // GoalCategory
  goalType: string; // GoalType
  status:   string; // GoalStatus

  // FINANCIAL / SPENDING_LIMIT — amounts and progress
  targetAmount?:  number | null;
  currentAmount?: number;
  /** 0-100 integer, null when not computable (HABIT, DEBT_REDUCTION). */
  progressPct?:   number | null;
  targetDate?:    string | null; // YYYY-MM-DD

  // DEBT_REDUCTION — debt-specific reduction targets
  targetReductionAmount?: number | null;
  targetReductionPct?:    number | null;
  snapshotBalance?:       number | null;

  // HABIT — streak tracking
  habitFrequency?: string | null;
  currentStreak?:  number;
  longestStreak?:  number;
  lastCheckIn?:    string | null; // ISO-8601

  completedAt?: string | null; // ISO-8601
}

/**
 * Data payload for the 'goals' context domain.
 */
export interface GoalsSectionData {
  totalCount: number;
  counts: {
    active:    number;
    paused:    number;
    completed: number;
  };
  goals: GoalSummaryItem[];
}

// ---------------------------------------------------------------------------
// Assembled context
// ---------------------------------------------------------------------------

/**
 * The complete AI context object returned by buildContext().
 *
 * `domains` is an open map keyed by ContextDomain string — consumers
 * access sections by key (e.g. ctx.domains['accounts']) rather than
 * by named interface fields. This supports templates that declare
 * entirely different domain sets.
 *
 * `signals` is the flat list of all signals detected across all assembled
 * domains, sorted by severity then detectedAt.
 *
 * `auditLogId` is the ID of the AuditLog row created on assembly.
 * Consumers may reference it for traceability.
 */
export interface SpaceContext_AI {
  requestedAt:     string; // ISO-8601
  spaceId:         string;
  userId:          string;
  role:            SpaceMemberRole;
  agentId:         string;
  resolvedDomains: string[]; // ordered list of domains that were attempted
  space: {
    id:       string;
    name:     string;
    type:     string;
    category: string;
  };
  domains:     Record<string, ContextDomainSection>;
  signals:     ContextSignal[];
  auditLogId:  string;
}
