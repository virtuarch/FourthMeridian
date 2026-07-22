"use client";

/**
 * components/dashboard/widgets/transactions/TransactionsFilterOverlay.tsx
 *
 * Transactions redesign — Slice 1. The single Filters surface that replaces the
 * permanent wall of dropdowns. It is PURE PRESENTATION: every filter's state and
 * setter is owned by SpaceTransactionsPanel and passed in, so the filter
 * semantics are provably identical to the pre-redesign selects — this component
 * only relocates them into one grouped, on-demand surface.
 *
 * Built on the Atlas OverlaySurface primitive (intent="dialog"): a centered
 * dialog on desktop, a content-sized bottom sheet on mobile, with focus-trap,
 * scroll-lock, ESC / backdrop close, and a sticky footer — all inherited. No new
 * drawer framework.
 *
 * Filters apply LIVE (as the old selects did): each change updates the parent
 * state immediately. The footer's primary button is a "Show N" dismissal, not a
 * staged apply, so nothing about when a filter takes effect changes.
 */

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { OverlaySurface } from "@/components/atlas/OverlaySurface";
import { GlassButton } from "@/components/atlas/GlassButton";
import type { Account, TransactionCategory } from "@/types";
import { FLOW_TYPE_LABEL } from "@/lib/transactions/flow-predicates";
import {
  BANKING_CATEGORIES,
  INPUT_BASE,
  PENDING_LABELS,
  SOURCE_LABELS,
  inputStyle,
  type PendingFilter,
  type SourceFilter,
} from "./transactions-filter-constants";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Count of matching rows — shown on the footer dismissal button. */
  resultCount: number;
  /** Active filter-group count — shown in the title and gates "Clear all". */
  activeCount: number;
  onClearAll: () => void;

  catFilter: TransactionCategory | null;
  setCatFilter: Dispatch<SetStateAction<TransactionCategory | null>>;
  flowFilter: string | null;
  setFlowFilter: Dispatch<SetStateAction<string | null>>;
  accountFilter: string | null;
  setAccountFilter: Dispatch<SetStateAction<string | null>>;
  sourceFilter: SourceFilter;
  setSourceFilter: Dispatch<SetStateAction<SourceFilter>>;
  pendingFilter: PendingFilter;
  setPendingFilter: Dispatch<SetStateAction<PendingFilter>>;

  /** Institution → accounts for this Space (built by the panel from the account
   *  list, NOT from the fetched rows — under server paging one page cannot
   *  enumerate the Space's accounts). */
  institutionGroups: Map<string, Account[]>;
}

/** One labeled filter group — uppercase label above its control. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: "var(--text-muted)" }}>
        {label}
      </p>
      {children}
    </div>
  );
}

const SELECT_CLASS = `w-full px-3 py-2.5 ${INPUT_BASE}`;

export function TransactionsFilterOverlay({
  open,
  onClose,
  resultCount,
  activeCount,
  onClearAll,
  catFilter,
  setCatFilter,
  flowFilter,
  setFlowFilter,
  accountFilter,
  setAccountFilter,
  sourceFilter,
  setSourceFilter,
  pendingFilter,
  setPendingFilter,
  institutionGroups,
}: Props) {
  return (
    <OverlaySurface
      open={open}
      onClose={onClose}
      title="Filters"
      subtitle={activeCount > 0 ? `${activeCount} active` : "None active"}
      intent="dialog"
      size="md"
      footer={
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClearAll}
            disabled={activeCount === 0}
            className="text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:text-[var(--text-primary)]"
            style={{ color: "var(--text-muted)" }}
          >
            Clear all
          </button>
          <GlassButton tone="meridian" size="md" onClick={onClose}>
            Show {resultCount.toLocaleString()} {resultCount === 1 ? "transaction" : "transactions"}
          </GlassButton>
        </div>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Accounts */}
        <Group label="Accounts">
          <select
            value={accountFilter ?? ""}
            onChange={(e) => setAccountFilter(e.target.value || null)}
            className={SELECT_CLASS}
            style={inputStyle}
            aria-label="Filter by account"
          >
            <option value="">All accounts</option>
            {[...institutionGroups.entries()].map(([inst, accts]) => (
              <optgroup key={inst} label={inst}>
                {accts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </Group>

        {/* Category */}
        <Group label="Category">
          <select
            value={catFilter ?? ""}
            onChange={(e) => setCatFilter((e.target.value as TransactionCategory) || null)}
            className={SELECT_CLASS}
            style={inputStyle}
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {BANKING_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Group>

        {/* Flow type */}
        <Group label="Flow type">
          <select
            value={flowFilter ?? ""}
            onChange={(e) => setFlowFilter(e.target.value || null)}
            className={SELECT_CLASS}
            style={inputStyle}
            aria-label="Filter by flow type"
          >
            <option value="">All flow types</option>
            {Object.entries(FLOW_TYPE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </Group>

        {/* Sources (provenance) */}
        <Group label="Sources">
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
            className={SELECT_CLASS}
            style={inputStyle}
            aria-label="Filter by source"
          >
            {(["all", "plaid", "import", "manual"] as SourceFilter[]).map((s) => (
              <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
            ))}
          </select>
        </Group>

        {/* Pending / cleared */}
        <Group label="Pending">
          <select
            value={pendingFilter}
            onChange={(e) => setPendingFilter(e.target.value as PendingFilter)}
            className={SELECT_CLASS}
            style={inputStyle}
            aria-label="Filter by pending status"
          >
            {(["all", "cleared", "pending"] as PendingFilter[]).map((p) => (
              <option key={p} value={p}>{PENDING_LABELS[p]}</option>
            ))}
          </select>
        </Group>

      </div>
    </OverlaySurface>
  );
}
