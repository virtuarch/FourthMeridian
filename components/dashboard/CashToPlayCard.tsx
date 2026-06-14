import { Card, CardTitle } from "@/components/ui/Card";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { Zap, TrendingUp, TrendingDown } from "lucide-react";

interface Props {
  checking:     number;
  savings:      number;
  playReady:    boolean;
  debt?:        number; // total outstanding debt balance
  investable?:  number; // uninvested cash inside brokerage / crypto accounts
  hero?:        boolean;
  change?:      number;
  changeLabel?: string;
  lastUpdated?: string;
}

function getStatus(checking: number, bankCash: number, debt: number): { label: string; cls: string } {
  const highDebt = debt > 0 && debt >= bankCash * 0.5;
  if (highDebt && checking < 1000)
    return { label: "DANGER ZONE",    cls: "bg-red-500/20 text-red-400"         };
  if (highDebt)
    return { label: "CLEAR DEBT",     cls: "bg-red-500/20 text-red-400"         };
  if (checking >= 1500)
    return { label: "DEPLOY CAPITAL", cls: "bg-emerald-500/20 text-emerald-400" };
  if (checking >= 1000)
    return { label: "HOLD",           cls: "bg-yellow-500/20 text-yellow-400"   };
  return   { label: "CASH LOW",       cls: "bg-red-500/20 text-red-400"         };
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, notation: "compact", maximumFractionDigits: 1 }).format(n);

const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(n);

function Row({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
        <span className="text-xs text-gray-400">{label}</span>
      </div>
      <span className="text-xs font-semibold tabular-nums" style={{ color }}>{fmtFull(value)}</span>
    </div>
  );
}

export function CashToPlayCard({
  checking, savings, debt = 0, investable = 0, hero, change, changeLabel, lastUpdated,
}: Props) {
  const bankCash      = checking + savings;
  const totalCash     = bankCash + investable;
  const status        = getStatus(checking, bankCash, debt);
  const positive      = (change ?? 0) >= 0;
  const prevBank      = bankCash - (change ?? 0);
  const pct           = prevBank !== 0 ? ((change ?? 0) / Math.abs(prevBank)) * 100 : 0;
  const hasChange     = change !== undefined && changeLabel;
  const hasInvestable = investable > 0;

  // ── Compact (All / Banking tabs) ─────────────────────────────────────────
  if (!hero) {
    return (
      <Card>
        <CardTitle>Cash on Hand</CardTitle>

        <p className="text-2xl font-bold text-white mt-1">{fmt(hasInvestable ? totalCash : bankCash)}</p>

        <div className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold mt-2 ${status.cls}`}>
          <Zap size={9} fill="currentColor" />
          {status.label}
        </div>

        <div className="flex flex-col gap-1.5 mt-3">
          <Row color="#3b82f6" label="Checking"  value={checking} />
          <Row color="#10b981" label="Savings"   value={savings}  />
          {hasInvestable && (
            <>
              <div className="border-t border-gray-800/60 my-0.5" />
              <Row color="#8b5cf6" label="Brokerage Cash" value={investable} />
            </>
          )}
        </div>

        {lastUpdated && <p className="text-xs text-gray-600 mt-3">Updated {lastUpdated}</p>}
      </Card>
    );
  }

  // ── Hero (Cash tab, full-width) ───────────────────────────────────────────
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <CardTitle>Cash on Hand</CardTitle>
          <p className="text-4xl font-bold text-white mt-1 tracking-tight">
            {fmt(hasInvestable ? totalCash : bankCash)}
          </p>
          {lastUpdated && <p className="text-xs text-gray-600 mt-1">Updated {lastUpdated}</p>}
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0 mt-0.5">
          {hasChange && (
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-xs text-gray-500 font-medium">{changeLabel}</span>
              <span className={`flex items-center gap-1 text-sm font-semibold ${positive ? "text-emerald-400" : "text-red-400"}`}>
                {positive ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                <span className="text-xs font-medium opacity-80">({pct.toFixed(1)}%)</span>
                {fmtFull(change ?? 0)}
              </span>
            </div>
          )}
          <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${status.cls}`}>
            <Zap size={11} fill="currentColor" />
            {status.label}
          </div>
        </div>
      </div>

      {/* Breakdown */}
      <div className="flex flex-col gap-2 mt-4 pt-3 border-t border-gray-700/60">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />
            <span className="text-xs text-gray-400">Checking</span>
          </div>
          <span className="text-sm font-semibold text-blue-400 tabular-nums">{fmtFull(checking)}</span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
            <span className="text-xs text-gray-400">Savings</span>
          </div>
          <span className="text-sm font-semibold text-emerald-400 tabular-nums">{fmtFull(savings)}</span>
        </div>
        {hasInvestable && (
          <>
            <div className="border-t border-gray-800/50 my-0.5" />
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-violet-400 shrink-0" />
                <span className="text-xs text-gray-400">Brokerage Cash</span>
              </div>
              <span className="text-sm font-semibold text-violet-400 tabular-nums">{fmtFull(investable)}</span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
