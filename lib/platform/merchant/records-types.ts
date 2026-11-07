/**
 * lib/platform/merchant/records-types.ts  (PB-9 — Merchant Identity KPIs drill into their records)
 *
 * Client-safe vocabulary + DTOs for the four Merchant Identity drill-downs:
 *
 *   merchants  — the canonical merchant directory      (KPI "Merchants")
 *   unlinked   — live transactions with no merchant    (KPI "Without a merchant")
 *   merged     — audited merge decisions in the window (KPI "Merged")
 *   dismissed  — dismissed candidate pairs in the window (KPI "Dismissed")
 *
 * Types and constants only — no I/O. The ONE definition of each metric's
 * record set lives in records-query.ts (the where / SQL builders) and is read by
 * BOTH the overview KPI and the list total (records.ts), so a KPI and the table
 * it opens cannot disagree. These interfaces are the typed reader contract a
 * future consumer (Platform AI) reads through; nothing here is UI-specific.
 *
 * EXPOSURE (kept at, or narrower than, what Merchant Operations already shows):
 * merchant display names / canonical keys and counts (the review page already
 * shows these); NO amounts, NO tenant / user / account identity, NO raw
 * provider descriptor. A transaction row carries a SANITIZED descriptor only
 * when identity is expected for it (the operator needs it to act); legitimate
 * exclusions (wallet, transfer, no-counterparty) carry none.
 */

export type MerchantRecordsKind = "merchants" | "unlinked" | "merged" | "dismissed";
export const MERCHANT_RECORDS_KINDS: readonly MerchantRecordsKind[] = ["merchants", "unlinked", "merged", "dismissed"];

export type MerchantWindowDays = 30 | 90;

/** Rows per page — one constant for the reader, the route and the UI. */
export const MERCHANT_RECORDS_PAGE_SIZE = 25;
/** Search terms are clamped to this many characters. */
export const MERCHANT_RECORDS_QUERY_MAX = 40;

// ── Why a live transaction has no merchant ─────────────────────────────────────

/**
 * The PARTITION of live transactions by identity eligibility (records-core.ts
 * classifyIdentity = records-query.ts identityClassWhere; first match wins):
 *   WALLET           — an on-chain wallet movement; the wallet sync has no merchant path.
 *   TRANSFER         — a movement between accounts (transfer / debt payment).
 *   NO_COUNTERPARTY  — income, interest, investment or adjustment activity.
 *   ELIGIBLE         — everything else: merchant identity IS expected.
 * For an UNLINKED row, ELIGIBLE = actionable (a gap); the other three are
 * legitimate exclusions and are not defects.
 */
export type IdentityClass = "ELIGIBLE" | "WALLET" | "TRANSFER" | "NO_COUNTERPARTY";
export const IDENTITY_CLASSES: readonly IdentityClass[] = ["ELIGIBLE", "TRANSFER", "WALLET", "NO_COUNTERPARTY"];

export const IDENTITY_CLASS_META: Readonly<Record<IdentityClass, { label: string; reason: string; expected: boolean }>> = {
  ELIGIBLE: {
    label: "Identity expected",
    reason: "Merchant identity is expected for this row but was not resolved (it predates merchant identity, or resolution failed at write).",
    expected: true,
  },
  TRANSFER: {
    label: "Transfer",
    reason: "A movement between accounts (transfer or debt payment) — no merchant by nature.",
    expected: false,
  },
  WALLET: {
    label: "Wallet movement",
    reason: "An on-chain wallet movement — the wallet sync does not resolve merchant identity.",
    expected: false,
  },
  NO_COUNTERPARTY: {
    label: "No merchant counterparty",
    reason: "Income, interest, investment or adjustment activity — no merchant counterparty by nature.",
    expected: false,
  },
};

/** Where a transaction row came from — derived server-side; never a provider id. */
export type TransactionProvider = "BANK_FEED" | "IMPORT" | "WALLET" | "OTHER";
export const PROVIDER_LABEL: Readonly<Record<TransactionProvider, string>> = {
  BANK_FEED: "Bank feed",
  IMPORT: "File import",
  WALLET: "Wallet",
  OTHER: "Other",
};

// ── Sorts (whitelisted per kind; the first is the default) ───────────────────

export const MERCHANT_RECORDS_SORTS = {
  merchants: ["transactions_desc", "name_asc", "name_desc", "aliases_desc", "last_seen_desc", "created_desc"],
  unlinked: ["date_desc", "date_asc"],
  merged: ["decided_desc", "decided_asc"],
  dismissed: ["decided_desc", "decided_asc"],
} as const satisfies Record<MerchantRecordsKind, readonly string[]>;
export type MerchantRecordsSort<K extends MerchantRecordsKind = MerchantRecordsKind> = (typeof MERCHANT_RECORDS_SORTS)[K][number];

export const SORT_LABEL: Readonly<Record<string, string>> = {
  transactions_desc: "Most transactions",
  name_asc: "Name A–Z",
  name_desc: "Name Z–A",
  aliases_desc: "Most aliases",
  last_seen_desc: "Recently seen",
  created_desc: "Newest",
  date_desc: "Newest first",
  date_asc: "Oldest first",
  decided_desc: "Newest first",
  decided_asc: "Oldest first",
};

/** A parsed, validated records query. `filter` is the identity class (unlinked only). */
export interface MerchantRecordsQuery {
  kind: MerchantRecordsKind;
  window: MerchantWindowDays;
  q: string | null;
  sort: string;
  page: number;
  filter: IdentityClass | null;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface MerchantDirectoryRow {
  id: string;
  displayName: string;
  canonicalKey: string;
  aliasCount: number;
  /** Live (non-deleted) transactions resolved to this merchant, all tenants. */
  transactionCount: number;
  /** Latest live transaction date (YYYY-MM-DD), or null when none. */
  lastSeen: string | null;
  /** True when the merchant carries the provider's stable entity id. */
  providerBacked: boolean;
  enriched: boolean;
  /** Merge-review status by canonical key: survivor of a merge / kept apart / none. */
  reviewStatus: "MERGE_SURVIVOR" | "KEPT_APART" | "NONE";
  createdAt: string;
}

export interface UnlinkedTransactionRow {
  id: string;
  date: string;
  /** Sanitized descriptor — present only when identity is expected (ELIGIBLE). */
  descriptor: string | null;
  provider: TransactionProvider;
  accountType: string;
  flowType: string | null;
  category: string;
  identityClass: IdentityClass;
  expected: boolean;
}

export interface MergeDecisionRow {
  id: string;
  pairKey: string;
  verdict: "MERGED" | "DISMISSED";
  /** MERGED: the absorbed (deleted) merchant's key. DISMISSED: one side of the pair. */
  sourceKey: string;
  /** MERGED: the surviving merchant's key. DISMISSED: the other side. */
  destinationKey: string;
  /** The surviving / other merchant's current id, when it still exists (links to its detail). */
  destinationMerchantId: string | null;
  /** MERGED: transactions re-pointed by the merge (from its audit record), else null. */
  affectedTransactions: number | null;
  evidenceTier: string;
  evidenceSignal: string | null;
  decidedAt: string;
  operator: string | null;
  reason: { code: string; note: string | null } | null;
}

export interface MerchantRecordsPage<R> {
  kind: MerchantRecordsKind;
  query: MerchantRecordsQuery;
  /** Matching records for the query (search + filter), across all pages. */
  total: number;
  /** The KPI figure for this kind (no search / filter) — the number the operator clicked. */
  kpiTotal: number;
  page: number;
  pageSize: number;
  pageCount: number;
  rows: R[];
  /** unlinked only — the KPI split by identity class (sums to kpiTotal). */
  byClass?: { key: IdentityClass; label: string; count: number; expected: boolean }[];
  /** Window start (ISO) for the decision kinds. */
  since?: string;
  checkedAt: string;
}

export type MerchantRecordsResponse =
  | MerchantRecordsPage<MerchantDirectoryRow>
  | MerchantRecordsPage<UnlinkedTransactionRow>
  | MerchantRecordsPage<MergeDecisionRow>;

// ── Merchant detail ─────────────────────────────────────────────────────────

export interface MerchantDetailResponse {
  merchant: MerchantDirectoryRow & {
    defaultCategory: string | null;
    enrichmentSource: string | null;
    enrichedAt: string | null;
    updatedAt: string;
    userRuleCount: number;
  };
  aliases: { total: number; rows: { id: string; alias: string; source: string; createdAt: string }[] };
  classification: {
    byCategory: { key: string; count: number }[];
    byCategorySource: { key: string; count: number }[];
    byFlowType: { key: string; count: number }[];
  };
  transactions: { total: number; rows: Omit<UnlinkedTransactionRow, "descriptor" | "identityClass" | "expected">[] };
  history: { at: string; kind: "CREATED" | "ENRICHED" | "ALIAS_ADDED" | "MERGED_IN" | "KEPT_APART"; text: string; operator: string | null }[];
  checkedAt: string;
}

/** The precise identity-coverage figures the hero reads. */
export interface IdentityCoverage {
  live: number;
  linked: number;
  unlinked: number;
  /** Live rows where identity is expected (ELIGIBLE), linked or not. */
  eligible: number;
  eligibleLinked: number;
  unlinkedByClass: Record<IdentityClass, number>;
}
