/**
 * components/dashboard/widgets/transactions/transactions-filter-constants.ts
 *
 * Shared filter vocabulary for the Transactions perspective. These consts were
 * previously inlined in SpaceTransactionsPanel; they are lifted here VERBATIM so
 * the panel and the new TransactionsFilterOverlay render the exact same option
 * lists and labels from one source (redesign Slice 1). No semantics change — the
 * values, order, and labels are byte-for-byte what the panel shipped.
 */

import type { CSSProperties } from "react";
import type { TransactionCategory } from "@/types";

// ── Category badge ────────────────────────────────────────────────────────────
// Neutralised to a single ink chip (matches the other transaction surfaces); the
// label carries the meaning.
export const CAT_CHIP = "bg-[var(--surface-inset)] text-[var(--text-secondary)]";

// ── Category options ──────────────────────────────────────────────────────────
export const BANKING_CATEGORIES: TransactionCategory[] = [
  "Income", "Transfer", "Groceries", "Dining", "Shopping",
  "Travel", "Subscriptions", "Utilities", "Interest", "Payment", "Other",
];

// ── Pending / cleared filter ──────────────────────────────────────────────────
export type PendingFilter = "all" | "cleared" | "pending";

export const PENDING_LABELS: Record<PendingFilter, string> = {
  all:     "All",
  cleared: "Cleared",
  pending: "Pending",
};

// ── Source filter (provenance) — backed by the list-level `source` field ──────
export type SourceFilter = "all" | "plaid" | "import" | "manual";

export const SOURCE_LABELS: Record<SourceFilter, string> = {
  all:    "All sources",
  plaid:  "Plaid",
  import: "Import",
  manual: "Manual",
};

// ── Group By / perspective — "none" is the flat List view ─────────────────────
export type GroupBy = "none" | "flow" | "merchant" | "account" | "category";

export const GROUP_BY_LABELS: Record<GroupBy, string> = {
  none:     "No grouping",
  flow:     "Flow type",
  merchant: "Merchant",
  account:  "Account",
  category: "Category",
};

// ── Transfer disposition (CF-1) — humanized canonical TransferDisposition ──────
export const TRANSFER_DISPOSITION_LABEL: Record<string, string> = {
  INTERNAL_TRANSFER:      "Internal transfer",
  EXTERNAL_BANK_TRANSFER: "External bank transfer",
  ASSET_VENUE_TRANSFER:   "Asset venue transfer",
  CASH_MOVEMENT:          "Cash movement",
  PAYMENT_APP_MOVEMENT:   "Payment app movement",
  UNKNOWN_MOVEMENT:       "Unknown movement",
};

// ── Shared input styling (Atlas tokens) ───────────────────────────────────────
export const INPUT_BASE = "border rounded-xl text-sm placeholder:text-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-info)] transition-colors";
export const inputStyle: CSSProperties = { background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-primary)" };
