import { Card, CardTitle } from "@/components/ui/Card";
import { TrendingUp, TrendingDown } from "lucide-react";

interface Props {
  stocks:        number;
  crypto:        number;
  cash?:         number; // uninvested cash inside investment/crypto accounts
  change?:       number;
  changeLabel?:  string;
  lastUpdated?:  string;
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(n);

const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

export function InvestmentsCard({ stocks, crypto, cash = 0, change, changeLabel, lastUpdated }: Props) {
  const total     = stocks + crypto + cash;
  const positive  = (change ?? 0) >= 0;
  const prevTotal = total - (change ?? 0);
  const pct       = prevTotal !== 0 ? ((change ?? 0) / Math.abs(prevTotal)) * 100 : 0;
  const hasChange = change !== undefined && changeLabel;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <CardTitle>Investments</CardTitle>
          <p className="text-4xl font-bold text-white mt-1 tracking-tight">{fmt(total)}</p>
          {lastUpdated && <p className="text-xs text-gray-600 mt-1">Updated {lastUpdated}</p>}
        </div>
        {hasChange && (
          <div className="flex flex-col items-end gap-0.5 shrink-0 mt-0.5">
            <span className="text-xs text-gray-500 font-medium">{changeLabel}</span>
            <span className={`flex items-center gap-1 text-sm font-semibold ${positive ? "text-emerald-400" : "text-red-400"}`}>
              {positive ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
              <span className="text-xs font-medium opacity-80">({pct.toFixed(1)}%)</span>
              {fmtFull(change ?? 0)}
            </span>
          </div>
        )}
      </div>

      <div className="flex gap-6 mt-4 pt-3 border-t border-gray-700/60">
        <div>
          <p className="text-xs text-gray-500">{cash > 0 ? "Stocks, Cash & Funds" : "Stocks & Funds"}</p>
          <p className="text-sm font-semibold text-violet-400 tabular-nums mt-0.5">{fmtFull(stocks)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Crypto</p>
          <p className="text-sm font-semibold text-yellow-400 tabular-nums mt-0.5">{fmtFull(crypto)}</p>
        </div>
        {cash > 0 && (
          <div>
            <p className="text-xs text-gray-500">Cash</p>
            <p className="text-sm font-semibold text-blue-400 tabular-nums mt-0.5">{fmtFull(cash)}</p>
          </div>
        )}
      </div>
    </Card>
  );
}
