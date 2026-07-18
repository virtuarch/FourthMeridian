"use client";

/**
 * components/space/widgets/debt/DebtAccountDetail.tsx
 *
 * The per-liability DETAIL body, shown inside the ledger's RightPanel (the Atlas panel
 * primitive — "tell me more about what I selected"). The debt analogue of HoldingDetail:
 * it leads with the customer's DEBT FACTS and stays honest about what isn't tracked.
 *
 * HONESTY: every figure is the ledger's own display-converted LiabilityRow (never
 * re-derived here) — the panel and the row can never disagree. Utilization renders only
 * for a revolving line (a real limit); an estimated minimum is labelled as such. Debt is
 * PRESENT-DAY (dual-authority), so these are current facts. Per-account balance/payment
 * HISTORY is not carried by the contract (only total-debt-over-time is) — so it is
 * OMITTED, never fabricated; the note says so plainly.
 */

import type { ReactNode } from "react";
import { formatCurrency, formatCurrencyExact } from "@/lib/format";
import type { LiabilityRow } from "./debt-ledger-util";
import { debtSubtypeLabel } from "./debt-ledger-util";

const UTIL_COLOR: Record<string, string> = {
  low:      "var(--accent-positive)",
  moderate: "#f59e0b",
  high:     "#f97316",
  over:     "var(--accent-negative)",
};

function utilLevel(pct: number): keyof typeof UTIL_COLOR {
  if (pct > 100) return "over";
  if (pct >= 70) return "high";
  if (pct >= 30) return "moderate";
  return "low";
}

function Row({ label, value, valueColor }: { label: string; value: ReactNode; valueColor?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-xs text-[var(--text-faint)]">{label}</span>
      <span className="text-sm tabular-nums text-right" style={{ color: valueColor ?? "var(--text-secondary)" }}>{value}</span>
    </div>
  );
}

export function DebtAccountDetail({ row, currency }: { row: LiabilityRow; currency: string }) {
  const a = row.account;
  const approx = row.estimated ? "≈ " : "";
  const util = row.utilizationPct;

  return (
    <div className="min-w-0">
      {/* Headline balance. */}
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Current balance</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums text-[var(--accent-negative)]">
        {approx}{formatCurrency(row.value, currency)}
      </p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        {debtSubtypeLabel(a)}{a.institution ? ` · ${a.institution}` : ""}
      </p>

      {/* Utilization — revolving lines only. */}
      {util != null && row.limit != null && (
        <div className="mt-5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--text-faint)]">Utilization</span>
            <span className="font-semibold" style={{ color: UTIL_COLOR[utilLevel(util)] }}>{util.toFixed(0)}%</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--surface-inset)]">
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, util))}%`, backgroundColor: UTIL_COLOR[utilLevel(util)] }} />
          </div>
          <p className="mt-1 text-[10px] text-[var(--text-faint)]">
            {formatCurrency(row.value, currency)} of {formatCurrency(row.limit, currency)}
            {util > 100 ? " · over limit" : ""}
          </p>
        </div>
      )}

      {/* Facts. */}
      <div className="mt-5 divide-y divide-[var(--border-hairline)] border-t border-[var(--border-hairline)]">
        <Row
          label="APR"
          value={a.interestRate != null ? `${a.interestRate.toFixed(2)}%` : "Not on file"}
          valueColor={a.interestRate == null ? "var(--text-faint)" : undefined}
        />
        {row.estInterest != null && (
          <Row label="Est. interest" value={<span className="text-[var(--accent-negative)]">{approx}{formatCurrencyExact(row.estInterest, currency)}/mo</span>} />
        )}
        <Row
          label="Minimum payment"
          value={
            row.minPayment != null
              ? <>{approx}{formatCurrency(row.minPayment, currency)}/mo{a.minimumPaymentIsEstimated ? <span className="text-[var(--text-faint)]"> · estimated</span> : null}</>
              : "Not on file"
          }
          valueColor={row.minPayment == null ? "var(--text-faint)" : undefined}
        />
        {row.limit != null && <Row label="Credit limit" value={`${approx}${formatCurrency(row.limit, currency)}`} />}
      </div>

      {/* Honest scope note — what this panel does NOT show, said plainly. */}
      <p className="mt-5 text-[11px] leading-snug text-[var(--text-faint)]">
        Debt figures are current. Per-account balance and payment history aren&rsquo;t tracked — the balance-history
        chart above the ledger shows total debt over time, not this account alone.
      </p>
    </div>
  );
}
