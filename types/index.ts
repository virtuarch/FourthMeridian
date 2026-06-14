export type AccountType = 'checking' | 'savings' | 'investment' | 'crypto' | 'debt' | 'other';

export type WalletChain = 'BTC' | 'ETH' | 'SOL' | 'BNB' | 'MATIC' | 'ADA' | 'XRP' | 'OTHER';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  institution: string;
  balance: number;
  currency: string;
  lastUpdated: string;
  // Debt fields
  creditLimit?:    number;  // populated from Plaid balances.limit or manual entry
  debtSubtype?:    string;  // credit_card | line_of_credit | heloc | auto_loan | mortgage | personal_loan | student_loan
  interestRate?:   number;  // Annual Percentage Rate (APR), e.g. 19.99
  minimumPayment?: number;  // Minimum monthly payment amount
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
  cashToPlay: number;
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

export interface Transaction {
  id: string;
  accountId: string;
  date: string;           // ISO date (YYYY-MM-DD)
  merchant: string;       // cleaned merchant name
  description?: string;  // raw/full description
  category: TransactionCategory;
  amount: number;         // positive = credit (money in), negative = debit (money out)
  pending: boolean;
}

export interface AiAdvice {
  id: string;
  summary: string;
  adviceText: string;
  riskLevel: 'low' | 'medium' | 'high';
  playReady: boolean;
  generatedAt: string;
}
