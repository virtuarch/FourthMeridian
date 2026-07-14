"use client";

/**
 * components/dashboard/widgets/transactions/QuickFlowPills.tsx
 *
 * Transactions redesign — Slice 3. FlowType is a core Fourth Meridian concept,
 * so the most-used flows are surfaced as pill shortcuts directly beneath the
 * toolbar instead of being buried in the Filters overlay. Each pill drives the
 * SAME `flowFilter` state the overlay's "Flow type" select drives — one source
 * of truth, no new backend behavior. "All" clears the flow filter (null).
 *
 * The pill set is a curated SUBSET of the full FlowType ontology; the remaining
 * kinds (Interest, Investment, Adjustment, Unknown) stay reachable via the
 * overlay's Flow type select — nothing is removed. When `flowFilter` holds a
 * kind with no pill, no pill reads active (and "All" is not lit either), which
 * honestly reflects that the active flow lives in the overlay.
 *
 * Horizontally scrollable on narrow viewports (`no-scrollbar`) so the row never
 * wraps or forces the Filters sheet open for a common interaction.
 */

import type { ReactNode } from "react";
import {
  ArrowUpRight,
  ArrowDownRight,
  ArrowLeftRight,
  CreditCard,
  RotateCcw,
  Minus,
  LayoutGrid,
} from "lucide-react";

// value === null → "All". Otherwise the raw FlowType enum value, matching the
// persisted `flowType` the predicate compares against.
const PILLS: { id: string | null; label: string; icon: ReactNode }[] = [
  { id: null,           label: "All",       icon: <LayoutGrid size={13} /> },
  { id: "INCOME",       label: "Income",    icon: <ArrowUpRight size={13} /> },
  { id: "SPENDING",     label: "Spending",  icon: <ArrowDownRight size={13} /> },
  { id: "TRANSFER",     label: "Transfers", icon: <ArrowLeftRight size={13} /> },
  { id: "DEBT_PAYMENT", label: "Debt",      icon: <CreditCard size={13} /> },
  { id: "REFUND",       label: "Refunds",   icon: <RotateCcw size={13} /> },
  { id: "FEE",          label: "Fees",      icon: <Minus size={13} /> },
];

interface Props {
  value: string | null;
  onChange: (next: string | null) => void;
}

export function QuickFlowPills({ value, onChange }: Props) {
  return (
    <div
      role="group"
      aria-label="Quick flow filter"
      className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-0.5"
    >
      {PILLS.map((pill) => {
        const isActive = value === pill.id;
        return (
          <button
            key={pill.label}
            type="button"
            onClick={() => onChange(pill.id)}
            aria-pressed={isActive}
            className="flex items-center gap-1.5 shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]"
            style={isActive
              ? { background: "rgba(59,130,246,.12)", borderColor: "rgba(125,168,255,.35)", color: "var(--meridian-400)" }
              : { background: "var(--glass-ultrathin)", borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}
          >
            <span aria-hidden className="inline-flex shrink-0">{pill.icon}</span>
            {pill.label}
          </button>
        );
      })}
    </div>
  );
}
