export type AccountType = 'checking' | 'savings' | 'investment' | 'crypto' | 'debt' | 'other';

export type WalletChain = 'BTC' | 'ETH' | 'SOL' | 'BNB' | 'MATIC' | 'ADA' | 'XRP' | 'OTHER';

export interface Account {
  id: string;
  /** Resolved display name: displayName ?? officialName ?? plaidName ?? raw name. */
  name: string;
  type: AccountType;
  institution: string;
  balance: number;
  currency: string;
  lastUpdated: string;
  // Display-name metadata (Plaid values are never overwritten after import).
  plaidName?:    string;  // raw value Plaid returned for this account, frozen at import
  officialName?: string;  // Plaid's official_name, if provided, frozen at import
  displayName?:  string;  // user-editable override; undefined until the user renames the account
  // Debt fields — effective values prefer the DebtProfile when present and fall
  // back to the legacy flat columns otherwise.
  creditLimit?:    number;  // populated from Plaid balances.limit or manual entry
  debtSubtype?:    string;  // credit_card | line_of_credit | heloc | auto_loan | mortgage | personal_loan | student_loan
  interestRate?:   number;  // Annual Percentage Rate (APR), e.g. 19.99
  minimumPayment?: number;  // Minimum monthly payment amount — manual entry, or an estimate (see minimumPaymentIsEstimated)
  /** True when minimumPayment was computed from APR/balance, not entered by the user or provided by the issuer. */
  minimumPaymentIsEstimated?: boolean;
  /** Full debt profile, when one exists, for editing in the UI. */
  debtProfile?: {
    apr?:               number;
    minimumPayment?:    number;
    dueDay?:             number;
    statementCloseDay?: number;
    promoAprEndDate?:   string;  // ISO date (YYYY-MM-DD)
    notes?:             string;
  };
  // Crypto wallet fields
  walletAddress?: string;
  walletChain?: WalletChain;
  nativeBalance?: number;   // amount in native token (e.g. 0.085 BTC)
  /**
   * 'manual'  = user-entered asset (AccountType.other, no Plaid connection)
   * 'synced'  = Plaid sync successful
   * 'pending' = sync in progress
   * 'error'   = last sync failed
   */
  syncStatus?: 'synced' | 'pending' | 'error' | 'manual';
  /**
   * D2-7E reconnect flow. True only when the *current* user's own Plaid
   * connection to this account is NEEDS_REAUTH — never true for a Space
   * member viewing an account they don't own/connect. See getAccounts().
   */
  needsReauth?: boolean;
  /** PlaidItem.id to pass to openLink() for reconnect. Set iff needsReauth. */
  plaidItemId?: string;
}

export interface Holding {
  id: string;
  accountId: string;
  symbol: string;
  name: string;
  quantity: number;
  price: number;
  value: number;
  change24h: number;
  /** MC1 P4 Slice 5 — native currency of price/value (Phase 0 stamp; null = residue). */
  currency?: string | null;
  /** True for synthetic rows computed by the sync job (account.balance − positions sum). */
  isCash: boolean;
}

export interface Snapshot {
  date: string;
  netWorth: number;
  totalAssets: number;
  totalDebt: number;
  totalCash: number;      // checking only
  totalSavings: number;   // savings only
  totalInvestments: number;
  totalCrypto: number;
  cashOnHand: number;
  // D2.x Slice 4 — true for reconstructed/backfilled historical rows. Optional
  // so existing constructors default to undefined (treated as not-estimated).
  isEstimated?: boolean;
}

export type TransactionCategory =
  | 'Income'
  | 'Transfer'
  | 'Groceries'
  | 'Dining'
  | 'Shopping'
  | 'Travel'
  | 'Subscriptions'
  | 'Utilities'
  | 'Interest'
  | 'Payment'
  | 'Other'
  // Investment
  | 'Buy'
  | 'Sell'
  | 'Dividend'
  | 'Split'
  | 'Fee';

export interface InvestmentTransaction {
  id:          string;
  accountId:   string;
  date:        string;       // YYYY-MM-DD
  ticker:      string;       // stored in merchant field
  description: string;
  category:    'Buy' | 'Sell' | 'Dividend' | 'Split' | 'Fee';
  amount:      number;       // negative = cost (buy), positive = proceeds/income
}

/**
 * FlowType semantics (v2.5.5). Mirrors the Prisma enums, kept as local unions
 * so this client-facing type module stays Prisma-free — the same convention
 * `TransactionCategory` above already follows.
 */
export type FlowType =
  | 'SPENDING' | 'INCOME' | 'REFUND' | 'DEBT_PAYMENT' | 'TRANSFER'
  | 'INVESTMENT' | 'FEE' | 'INTEREST' | 'ADJUSTMENT' | 'UNKNOWN';

export type FlowDirection = 'INFLOW' | 'OUTFLOW' | 'INTERNAL' | 'UNKNOWN';

export type FlowClassificationReason =
  | 'PLAID_PFC_DETAILED' | 'PLAID_PFC_PRIMARY' | 'CATEGORY_FLOW_VALUE'
  | 'CATEGORY_INVESTMENT_VALUE' | 'ACCOUNT_TYPE_CONTEXT'
  | 'SIGN_DEFAULT_SPENDING' | 'SIGN_DEFAULT_INFLOW' | 'AMBIGUOUS_UNKNOWN';

export interface Transaction {
  id: string;
  accountId: string;
  date: string;           // ISO date (YYYY-MM-DD)
  merchant: string;       // cleaned merchant name
  description?: string;  // raw/full description
  category: TransactionCategory;
  amount: number;         // positive = credit (money in), negative = debit (money out)
  pending: boolean;
  /**
   * MC1 Phase 3 Slice 4 — native currency of `amount` (Phase 0 provenance
   * stamp; null = pre-provenance residue). Additive: populated by the debt
   * read for the per-liability rollup's conversion; other reads may omit it.
   */
  currency?: string | null;

  // FlowType metadata (v2.5.5 P5 Slice 1 — additive read plumbing only).
  // Nothing consumes these yet; all category/sign logic is unchanged. Null for
  // any row not yet classified. Consumers arrive in later P5 slices.
  flowType?: FlowType | null;
  flowDirection?: FlowDirection | null;
  classificationConfidence?: number | null;
  classificationReason?: FlowClassificationReason | null;
  classifierVersion?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TransactionDetail (TI-1 — Transaction Intelligence Phase 1)
// The canonical single-transaction inspection DTO: a superset of the list-row
// `Transaction` above, stored-data-only (no new capture), Prisma-free (same
// convention as every type in this module). Served by
// GET /api/transactions/[id] via getTransactionDetail()
// (lib/data/transactions.ts) under the KD-15 visibility predicate.
// Internal/provider identifiers (plaidTransactionId, externalTransactionId,
// merchantEntityId, importBatchId, FK ids) are deliberately NOT exposed —
// provenance is resolved server-side into the display-safe blocks below.
// See docs/investigations/TRANSACTION_INTELLIGENCE_DETAIL_VIEW_INVESTIGATION_2026-07-06.md §1–§2.
// ─────────────────────────────────────────────────────────────────────────────

/** How this transaction entered Fourth Meridian. */
export type TransactionProvenanceSource = 'plaid' | 'import' | 'manual';

/** Resolved parent-account context (never raw FKs). */
export interface TransactionDetailAccount {
  id:          string;
  /** Resolved display name: displayName ?? officialName ?? plaidName ?? name. */
  name:        string;
  institution: string;
  /** Last-4 mask when known (canonical accounts only). */
  mask:        string | null;
  type:        AccountType;
  /** True when resolved from the legacy Account model (pre-migration rows). */
  legacy:      boolean;
}

/** Display-safe import/sync provenance. */
export interface TransactionDetailProvenance {
  source: TransactionProvenanceSource;
  /** Import batch source when source === 'import'. */
  importSource?:   'CSV' | 'EXCEL' | 'QUICKBOOKS';
  /** Original uploaded filename when source === 'import'. */
  importFilename?: string | null;
  /** ISO datetime the import completed, when source === 'import'. */
  importedAt?:     string | null;
}

/**
 * The "other side" of the movement when it is a known owned account
 * (Transaction.counterpartyAccountId, KD-18 seam). `visible: false` means a
 * counterparty exists but the current Space's link does not grant account
 * detail — render as "another account", never by name (fails closed).
 */
export interface TransactionDetailCounterparty {
  visible:    boolean;
  accountId?: string;
  name?:      string;
}

/**
 * MC1 read-time conversion of the native amount into the Space's reporting
 * currency, at the transaction's own date (historical FX, never today's
 * rate). Null when the conversion adds no information (clean identity —
 * native === reporting and nothing estimated). `rate`/`effectiveDateISO` are
 * null on estimated pass-throughs (rate miss / null-residue currency).
 */
export interface TransactionDetailReporting {
  amount:           number;
  currency:         string;
  estimated:        boolean;
  rate:             number | null;
  effectiveDateISO: string | null;
}

export interface TransactionDetail extends Transaction {
  // Raw Plaid personal_finance_category — the PROVIDER's opinion, persisted
  // since FlowType P3; distinct from Fourth Meridian semantics (flowType).
  pfcPrimary:         string | null;
  pfcDetailed:        string | null;
  pfcConfidenceLevel: string | null;
  /** ISO datetime the row was first seen by Fourth Meridian. */
  createdAt: string;

  account:      TransactionDetailAccount;
  provenance:   TransactionDetailProvenance;
  counterparty: TransactionDetailCounterparty | null;
  reporting:    TransactionDetailReporting | null;
}

export interface AiAdvice {
  id: string;
  summary: string;
  adviceText: string;
  riskLevel: 'low' | 'medium' | 'high';
  actionReady: boolean;
  generatedAt: string;
}
