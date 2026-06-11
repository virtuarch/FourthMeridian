"use client";
import { Card, CardTitle } from "@/components/ui/Card";
import { TrendingUp, TrendingDown } from "lucide-react";

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
}

export function NetWorthCard({ netWorth, totalAssets, totalDebt, liquid, change30d, changeLabel, lastUpdated, title = "Net Worth", hideInvestments = false }: Props) {
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
  const positive = change30d >= 0;
  const prevWorth = netWorth - change30d;
  const pct = prevWorth !== 0 ? (change30d / Math.abs(prevWorth)) * 100 : 0;

  return (
    <Card className="col-span-2">
      <CardTitle>{title}</CardTitle>
      <div className="flex items-end justify-between mt-1">
        <p className="text-4xl font-bold tracking-tight text-white">{fmt(netWorth)}</p>
        <div className="flex flex-col items-end mb-1 gap-0.5">
          <span className="text-xs text-gray-500 font-medium">{changeLabel}</span>
          <span className={`flex items-center gap-1 text-sm font-semibold ${positive ? "text-emerald-400" : "text-red-400"}`}>
            {positive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            <span className="text-xs font-medium opacity-80">({pct.toFixed(1)}%)</span>
            {fmt(change30d)}
          </span>
        </div>
      </div>
      <div className="flex justify-between mt-3 border-t border-gray-700 pt-3">
        {!hideInvestments && (
          <div>
            <p className="text-xs text-gray-400">Investments</p>
            <p className="text-sm font-semibold text-emerald-400">{fmt(totalAssets)}</p>
          </div>
        )}
        <div>
          <p className="text-xs text-gray-400">Liquid</p>
          <p className="text-sm font-semibold text-blue-400">{fmt(liquid)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Debt</p>
          <p className="text-sm font-semibold text-red-400">{fmt(Math.abs(totalDebt))}</p>
        </div>
      </div>
      {lastUpdated && (
        <p className="text-xs text-gray-600 mt-2">Updated {lastUpdated}</p>
      )}
    </Card>
  );
}
