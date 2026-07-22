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
// PRESENTATION ONLY (P2-2): this is the vocabulary for the Transactions-perspective
// category dropdown (TransactionsFilterOverlay) — a display/search filter the user
// opts into. It is NOT a semantic-population authority and must NEVER gate whether a
// row reaches canonical financial analysis (that is FlowType's job — see
// isBankingPopulation / BANKING_POPULATION in lib/data/transactions.ts). Using this
// list as a `category: { in: … }` query filter is a P2-2 regression; the source-scan
// in lib/data/transactions.population.test.ts guards against it.
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

// ── Group By ─────────────────────────────────────────────────────────────────
// TX-4 — the GroupBy vocabulary (`GROUP_BY_LABELS`, `type GroupBy`) was DELETED.
// Its only consumer was the explorer's client-side pivot, removed in TX-3.3: a
// pivot with per-bucket money totals is analytics over the whole set, which a
// bounded page cannot produce honestly and which the Cash Flow projection layer
// already owns. Recoverable at cd28478.

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
