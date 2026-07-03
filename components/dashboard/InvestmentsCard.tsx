import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
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
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, notation: "compact", maximumFractionDigits: 1 }).format(n);

const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(n);

export function InvestmentsCard({ stocks, crypto, cash = 0, change, changeLabel, lastUpdated }: Props) {
  const total     = stocks + crypto + cash;
  const positive  = (change ?? 0) >= 0;
  const prevTotal = total - (change ?? 0);
  const pct       = prevTotal !== 0 ? ((change ?? 0) / Math.abs(prevTotal)) * 100 : 0;
  const hasChange = change !== undefined && changeLabel;

  return (
    <DataCard>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <DataCardTitle>Investments</DataCardTitle>
          <p className="text-4xl font-bold mt-1 tracking-tight" style={{ color: "var(--text-primary)" }}>{fmt(total)}</p>
          {lastUpdated && <p className="text-xs mt-1" style={{ color: "var(--text-faint)" }}>Updated {lastUpdated}</p>}
        </div>
        {hasChange && (
          <div className="flex flex-col items-end gap-0.5 shrink-0 mt-0.5">
            <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>{changeLabel}</span>
            <span
              className="flex items-center gap-1 text-sm font-semibold"
              style={{ color: positive ? "var(--accent-positive)" : "var(--accent-negative)" }}
            >
              {positive ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
              <span className="text-xs font-medium opacity-80">({pct.toFixed(1)}%)</span>
              {fmtFull(change ?? 0)}
            </span>
          </div>
        )}
      </div>

      <div className="flex gap-6 mt-4 pt-3 border-t" style={{ borderColor: "var(--border-hairline)" }}>
        <div>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>{cash > 0 ? "Stocks, Cash & Funds" : "Stocks & Funds"}</p>
          <p className="text-sm font-semibold tabular-nums mt-0.5" style={{ color: "var(--text-primary)" }}>{fmtFull(stocks)}</p>
        </div>
        <div>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Crypto</p>
          <p className="text-sm font-semibold tabular-nums mt-0.5" style={{ color: "var(--text-primary)" }}>{fmtFull(crypto)}</p>
        </div>
        {cash > 0 && (
          <div>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Cash</p>
            <p className="text-sm font-semibold tabular-nums mt-0.5" style={{ color: "var(--text-primary)" }}>{fmtFull(cash)}</p>
          </div>
        )}
      </div>
    </DataCard>
  );
}
