"use client";

/**
 * components/dashboard/widgets/transactions/TransactionFilterChips.tsx
 *
 * Transactions redesign — Slice 5. The active-filter chip row, lifted out of the
 * panel header into its own row beneath the Quick Flow pills. Each chip and its
 * dismiss button behave exactly as before (same state, same clears); this is a
 * relocation + a "+ Add filter" affordance that opens the Filters overlay.
 *
 * Rendered only when at least one filter group is active — so a clean list shows
 * no chrome here at all (reduce visual noise). Search, time range, and view are
 * toolbar concerns and never appear as chips (unchanged from before).
 */

import type { Dispatch, SetStateAction } from "react";
import { Plus, X } from "lucide-react";
import type { Account, TransactionCategory } from "@/types";
import { FLOW_TYPE_LABEL } from "@/lib/transactions/flow-predicates";
import {
  CAT_CHIP,
  PENDING_LABELS,
  SOURCE_LABELS,
  TRANSFER_DISPOSITION_LABEL,
  type PendingFilter,
  type SourceFilter,
} from "./transactions-filter-constants";

interface Props {
  selectedAccount: Account | null | undefined;
  setAccountFilter: Dispatch<SetStateAction<string | null>>;
  catFilter: TransactionCategory | null;
  setCatFilter: Dispatch<SetStateAction<TransactionCategory | null>>;
  flowFilter: string | null;
  setFlowFilter: Dispatch<SetStateAction<string | null>>;
  dispositionFilter: string | null;
  setDispositionFilter: Dispatch<SetStateAction<string | null>>;
  sourceFilter: SourceFilter;
  setSourceFilter: Dispatch<SetStateAction<SourceFilter>>;
  merchantFilter: string | null;
  setMerchantFilter: Dispatch<SetStateAction<string | null>>;
  needsReviewOnly: boolean;
  setNeedsReviewOnly: Dispatch<SetStateAction<boolean>>;
  pendingFilter: PendingFilter;
  setPendingFilter: Dispatch<SetStateAction<PendingFilter>>;
  activeCount: number;
  onClearAll: () => void;
  onAddFilter: () => void;
}

function Dismiss({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={`Remove ${label} filter`} className="hover:text-[var(--text-primary)] ml-0.5">
      <X size={10} />
    </button>
  );
}

export function TransactionFilterChips(props: Props) {
  const {
    selectedAccount, setAccountFilter,
    catFilter, setCatFilter,
    flowFilter, setFlowFilter,
    dispositionFilter, setDispositionFilter,
    sourceFilter, setSourceFilter,
    merchantFilter, setMerchantFilter,
    needsReviewOnly, setNeedsReviewOnly,
    pendingFilter, setPendingFilter,
    activeCount, onClearAll, onAddFilter,
  } = props;

  if (activeCount === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap px-1">
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>Active filters:</span>

      {selectedAccount && (
        <span className="text-xs border px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "var(--surface-inset)", color: "var(--accent-info)", borderColor: "var(--border-hairline)" }}>
          {selectedAccount.institution} · {selectedAccount.name}
          <Dismiss onClick={() => setAccountFilter(null)} label="account" />
        </span>
      )}
      {catFilter && (
        <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${CAT_CHIP}`}>
          {catFilter}
          <Dismiss onClick={() => setCatFilter(null)} label="category" />
        </span>
      )}
      {flowFilter && (
        <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${CAT_CHIP}`}>
          {FLOW_TYPE_LABEL[flowFilter] ?? flowFilter}
          <Dismiss onClick={() => setFlowFilter(null)} label="flow type" />
        </span>
      )}
      {dispositionFilter && (
        <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${CAT_CHIP}`}>
          {TRANSFER_DISPOSITION_LABEL[dispositionFilter] ?? dispositionFilter}
          <Dismiss onClick={() => setDispositionFilter(null)} label="movement" />
        </span>
      )}
      {sourceFilter !== "all" && (
        <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${CAT_CHIP}`}>
          {SOURCE_LABELS[sourceFilter]}
          <Dismiss onClick={() => setSourceFilter("all")} label="source" />
        </span>
      )}
      {merchantFilter && (
        <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${CAT_CHIP}`}>
          {merchantFilter}
          <Dismiss onClick={() => setMerchantFilter(null)} label="merchant" />
        </span>
      )}
      {needsReviewOnly && (
        <span className="text-xs border px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "var(--surface-inset)", color: "var(--accent-warning)", borderColor: "var(--border-hairline)" }}>
          Needs review
          <Dismiss onClick={() => setNeedsReviewOnly(false)} label="needs review" />
        </span>
      )}
      {pendingFilter !== "all" && (
        <span className="text-xs border px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "var(--surface-inset)", color: "var(--text-secondary)", borderColor: "var(--border-hairline)" }}>
          {PENDING_LABELS[pendingFilter]}
          <Dismiss onClick={() => setPendingFilter("all")} label="pending" />
        </span>
      )}

      <button
        onClick={onAddFilter}
        className="text-xs flex items-center gap-1 border border-dashed px-2 py-0.5 rounded-full transition-colors hover:text-[var(--text-primary)]"
        style={{ color: "var(--text-muted)", borderColor: "var(--border-hairline)" }}
      >
        <Plus size={11} /> Add filter
      </button>
      <button
        onClick={onClearAll}
        className="text-xs hover:text-[var(--text-secondary)] transition-colors"
        style={{ color: "var(--text-muted)" }}
      >
        Clear all
      </button>
    </div>
  );
}
