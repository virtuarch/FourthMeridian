// TI5-2 — the read-time relationship engine's output shape surfaces on the
// detail DTO. Type-only import (erased at runtime); RelationshipResolver is a
// zero-import pure module, so this adds no runtime dependency and no cycle.
import type { TransactionRelationships } from '@/lib/transactions/RelationshipResolver';
// TE-2B — the "needs classification" reason enum surfaces on the detail DTO.
// Type-only import (erased at runtime); the predicate module is pure/Prisma-free.
import type { NeedsClassificationReason } from '@/lib/transactions/needs-classification';
// CF-1 — the canonical TransferDisposition surfaces on the list DTO for the Cash
// Flow context projection. Type-only; the source module is pure/Prisma-free.
import type { TransferDisposition } from '@/lib/transactions/transfer-evidence';

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
  // MC1 QA Q4b — true when this off-stamp point's FX rate MISSED, so its values
  // are native/unconverted and sit at a different magnitude than the resolving
  // points. Additive and absent on homogeneous histories and successful
  // conversions (byte-identical DTOs), letting a presentation guard drop only
  // the genuinely mixed-unit points from a series.
  fxMiss?: true;
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
  merchant: string;       // RAW provider descriptor — never lost (forensic/import round-trip)
  /**
   * MI M6 read cutover — resolved Merchant Intelligence presentation (additive):
   *   merchantDisplayName = Merchant.displayName when resolved, else `merchant`.
   *   merchantLogoUrl     = Merchant.logoUrl when present, else null (icon fallback).
   * The raw `merchant` above is always preserved alongside these.
   */
  merchantDisplayName?: string;
  merchantLogoUrl?: string | null;
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
  /**
   * Cash Flow liquidity axis — the "other side" of a movement when it is a known
   * owned account AND visible to the reading Space (KD-15 gated at the data layer
   * via lib/transactions/counterparty-visibility.ts). Lets the client liquidity
   * engine resolve the counterparty's tier (asset/liquid/liability) to classify
   * transfers (asset→liquid = Asset Liquidation). Null when absent or not visible
   * — the id is never leaked across Spaces, and no name/detail is carried.
   */
  counterpartyAccountId?: string | null;

  // CF-1 — read-time canonical projection for the Cash Flow context section.
  // Additive/optional (existing callers untouched): derived server-side from
  // persisted transfer evidence + owned-counterparty resolution + the TE-2B
  // predicate. Presentation only — no calculation reads these. transferDisposition
  // is set only for TRANSFER rows; null otherwise.
  transferDisposition?: TransferDisposition | null;
  needsClassification?: boolean;

  // Transactions Tab Phase 1 — how this row entered Fourth Meridian, projected
  // onto the list DTO by getTransactions() via the SAME deriveSource() precedence
  // the detail read uses (import batch → Plaid → manual). Additive/optional:
  // reads that omit it (e.g. getDebtTransactions, the account-modal route) leave
  // it undefined. Presentation only — no calculation reads it.
  source?: TransactionProvenanceSource | null;
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

// TI2 durable-fact unions (local, Prisma-free — same convention as FlowType).
export type PaymentChannel = 'ONLINE' | 'IN_STORE' | 'OTHER' | 'UNKNOWN';
export type PaymentMethod = 'CARD' | 'ACH' | 'WIRE' | 'CHECK' | 'CASH' | 'INTERNAL_TRANSFER' | 'UNKNOWN';
export type SettlementState = 'PENDING' | 'POSTED';
export type CounterpartyType =
  | 'MERCHANT' | 'FINANCIAL_INSTITUTION' | 'INCOME_SOURCE'
  | 'PAYMENT_APP' | 'MARKETPLACE' | 'PAYMENT_TERMINAL' | 'UNKNOWN';

export interface TransactionDetail extends Transaction {
  // Raw Plaid personal_finance_category — the PROVIDER's opinion, persisted
  // since FlowType P3; distinct from Fourth Meridian semantics (flowType).
  pfcPrimary:         string | null;
  pfcDetailed:        string | null;
  pfcConfidenceLevel: string | null;
  /** ISO datetime the row was first seen by Fourth Meridian. */
  createdAt: string;

  // ── TI2 durable facts (TI5-1 — detail-only read exposure) ──────────────────
  // Already persisted on Transaction (TI2). Exposed here ONLY — the list-row
  // `Transaction` DTO and its serializer are deliberately unchanged. Null =
  // pre-TI2 / not captured / not derivable (never a manufactured claim).
  paymentChannel:        PaymentChannel | null;
  paymentMethod:         PaymentMethod | null;
  settlementState:       SettlementState | null;
  /** Plaid authorized_date as an ISO date ("YYYY-MM-DD"); distinct from posted `date`. */
  authorizedAt:          string | null;
  counterpartyType:      CounterpartyType | null;
  fxApplied:             boolean | null;
  pendingTransactionRef: string | null;
  tiFactsVersion:        number | null;

  account:      TransactionDetailAccount;
  provenance:   TransactionDetailProvenance;
  counterparty: TransactionDetailCounterparty | null;
  reporting:    TransactionDetailReporting | null;

  // ── TI5-2 — read-time relationship facts (RelationshipResolver) ────────────
  // Computed on read from a tiny candidate set; never persisted. Deterministic
  // only (pendingPosted, duplicate); refundCandidate/transferCandidate are null.
  relationships: TransactionRelationships;

  // ── TE-2B — needs-classification disclosure (derived server-side) ──────────
  // Semantic ambiguity only ("unknown purpose / unknown source"), NOT low
  // confidence. Computed by shouldSurfaceAsNeedsClassification() from canonical
  // fields; the raw inputs (transferRail, merchantId, classificationReason) are
  // NOT exposed — only this boolean + a provider-neutral reason. Drawer renders a
  // non-technical disclosure when true. Ordinary low-confidence purchases are false.
  needsClassification:       boolean;
  needsClassificationReason: NeedsClassificationReason | null;
}

export interface AiAdvice {
  id: string;
  summary: string;
  adviceText: string;
  riskLevel: 'low' | 'medium' | 'high';
  actionReady: boolean;
  generatedAt: string;
}
