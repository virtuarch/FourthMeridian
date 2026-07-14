"use client";

/**
 * components/dashboard/widgets/transactions/TransactionSummaryCards.tsx
 *
 * Transactions redesign — Slice 4. The inline summary strip becomes a row of
 * proper KPI cards (icon · title · value · subtitle) on the Atlas DataCard shell.
 *
 * The MATH is unchanged: every figure is passed in already-computed from the
 * panel's single shared `sumByFlowType` map, and the `fmt` formatter is the same
 * display-currency aggregate formatter. Presentation only.
 *
 * Zero-count honesty (§9.7) is preserved: a money card renders ONLY when its
 * figure > 0 — never a fabricated "$0.00". The Transactions count card always
 * renders (it reflects the actual filtered row count, which the empty state
 * handles separately upstream). Sign + color conventions match the old strip
 * exactly (Spend negative/red, Income & Refunds positive/green, movements
 * neutral ink).
 */

import type { ReactNode } from "react";
import {
  Receipt,
  ArrowDownCircle,
  ArrowUpCircle,
  ArrowLeftRight,
  CreditCard,
  LineChart,
  RotateCcw,
} from "lucide-react";
import { DataCard } from "@/components/atlas/DataCard";

interface Props {
  count: number;
  spend: number;
  income: number;
  transfers: number;
  debtPayments: number;
  investments: number;
  refunds: number;
  /** Display-currency aggregate formatter (same one the panel uses). */
  fmt: (n: number) => string;
  /** Active time-range label, shown as each card's subtitle. */
  rangeLabel: string;
}

function Kpi({
  icon,
  tint,
  title,
  value,
  valueColor,
  subtitle,
}: {
  icon: ReactNode;
  tint: string;
  title: string;
  value: string;
  valueColor?: string;
  subtitle: string;
}) {
  return (
    <DataCard padding="var(--space-4)" className="min-w-0">
      <div className="flex items-start gap-3 min-w-0">
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
          style={{ background: tint, color: valueColor ?? "var(--text-secondary)" }}
          aria-hidden
        >
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-widest truncate" style={{ color: "var(--text-muted)" }}>
            {title}
          </p>
          <p className="text-lg font-bold tabular-nums leading-tight truncate" style={{ color: valueColor ?? "var(--text-primary)" }}>
            {value}
          </p>
          <p className="text-[11px] truncate" style={{ color: "var(--text-faint)" }}>{subtitle}</p>
        </div>
      </div>
    </DataCard>
  );
}

export function TransactionSummaryCards({
  count,
  spend,
  income,
  transfers,
  debtPayments,
  investments,
  refunds,
  fmt,
  rangeLabel,
}: Props) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      {/* Transactions — always shown. */}
      <Kpi
        icon={<Receipt size={16} />}
        tint="rgba(59,130,246,.12)"
        title="Transactions"
        value={count.toLocaleString()}
        valueColor="var(--accent-info)"
        subtitle={rangeLabel}
      />

      {/* Money cards — rendered only when present (zero-count honesty). */}
      {spend > 0 && (
        <Kpi
          icon={<ArrowDownCircle size={16} />}
          tint="rgba(237,82,71,.12)"
          title="Spend"
          value={`-${fmt(spend)}`}
          valueColor="var(--accent-negative)"
          subtitle={rangeLabel}
        />
      )}
      {income > 0 && (
        <Kpi
          icon={<ArrowUpCircle size={16} />}
          tint="rgba(52,199,89,.12)"
          title="Income"
          value={`+${fmt(income)}`}
          valueColor="var(--accent-positive)"
          subtitle={rangeLabel}
        />
      )}
      {transfers > 0 && (
        <Kpi
          icon={<ArrowLeftRight size={16} />}
          tint="var(--surface-inset)"
          title="Transfers"
          value={fmt(transfers)}
          subtitle={rangeLabel}
        />
      )}
      {debtPayments > 0 && (
        <Kpi
          icon={<CreditCard size={16} />}
          tint="rgba(245,158,11,.12)"
          title="Debt payments"
          value={fmt(debtPayments)}
          subtitle={rangeLabel}
        />
      )}
      {investments > 0 && (
        <Kpi
          icon={<LineChart size={16} />}
          tint="rgba(139,92,246,.12)"
          title="Investments"
          value={fmt(investments)}
          subtitle={rangeLabel}
        />
      )}
      {refunds > 0 && (
        <Kpi
          icon={<RotateCcw size={16} />}
          tint="rgba(52,199,89,.12)"
          title="Refunds"
          value={`+${fmt(refunds)}`}
          valueColor="var(--accent-positive)"
          subtitle={rangeLabel}
        />
      )}
    </div>
  );
}
