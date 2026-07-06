"use client";
import { DataCard } from "@/components/atlas/DataCard";
import { TrendingUp, TrendingDown } from "lucide-react";
import { useDisplayCurrency } from "@/lib/currency-context";
import { EstimatedChip } from "@/components/ui/EstimatedChip";

interface Props {
  netWorth:          number;
  totalAssets:       number;
  totalDebt:         number;
  liquid:            number;
  change30d:         number;
  changeLabel:       string;
  lastUpdated?:      string;
  title?:            string;
  hideInvestments?:  boolean;
  /** MC1 P4 Slice 3 (D-5) — quiet "≈ / est." marker when the totals carry estimated conversions. */
  estimated?:        boolean;
}

export function NetWorthCard({ netWorth, totalAssets, totalDebt, liquid, change30d, changeLabel, lastUpdated, title = "Net Worth", hideInvestments = false, estimated = false }: Props) {
  // MC1 Phase 4 Slice 1 (D-1) — all values on this card are aggregates.
  const displayCurrency = useDisplayCurrency();
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: displayCurrency, maximumFractionDigits: 0 }).format(n);
  const positive = change30d >= 0;
  const prevWorth = netWorth - change30d;
  const pct = prevWorth !== 0 ? (change30d / Math.abs(prevWorth)) * 100 : 0;

  return (
    <DataCard title={title} className="col-span-2">
      <div className="flex items-end justify-between mt-1">
        <p className="text-4xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>{estimated ? "\u2248 " : ""}{fmt(netWorth)}{estimated && <EstimatedChip />}</p>
        <div className="flex flex-col items-end mb-1 gap-0.5">
          <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>{changeLabel}</span>
          <span
            className="flex items-center gap-1 text-sm font-semibold"
            style={{ color: positive ? "var(--accent-positive)" : "var(--accent-negative)" }}
          >
            {positive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            <span className="text-xs font-medium opacity-80">({pct.toFixed(1)}%)</span>
            {fmt(change30d)}
          </span>
        </div>
      </div>
      <div className="flex justify-between mt-3 border-t pt-3" style={{ borderColor: "var(--border-hairline)" }}>
        {!hideInvestments && (
          <div>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Investments</p>
            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{fmt(totalAssets)}</p>
          </div>
        )}
        <div>
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Liquid</p>
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{fmt(liquid)}</p>
        </div>
        <div>
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Debt</p>
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{fmt(Math.abs(totalDebt))}</p>
        </div>
      </div>
      {lastUpdated && (
        <p className="text-xs mt-2" style={{ color: "var(--text-faint)" }}>Updated {lastUpdated}</p>
      )}
    </DataCard>
  );
}
