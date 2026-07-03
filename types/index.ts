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

  // FlowType metadata (v2.5.5 P5 Slice 1 — additive read plumbing only).
  // Nothing consumes these yet; all category/sign logic is unchanged. Null for
  // any row not yet classified. Consumers arrive in later P5 slices.
  flowType?: FlowType | null;
  flowDirection?: FlowDirection | null;
  classificationConfidence?: number | null;
  classificationReason?: FlowClassificationReason | null;
  classifierVersion?: number | null;
}

export interface AiAdvice {
  id: string;
  summary: string;
  adviceText: string;
  riskLevel: 'low' | 'medium' | 'high';
  actionReady: boolean;
  generatedAt: string;
}
