"use client";

import { useEffect } from "react";
import { X, TrendingUp, TrendingDown } from "lucide-react";
import { TradingViewChart } from "@/components/charts/TradingViewChart";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { Holding } from "@/types";

interface AssetInfo {
  symbol:       string;
  name:         string;
  value:        number;
  quantity?:    number;
  price?:       number;
  change24h?:   number;
  source?:      string;
  walletAddress?: string;
  // Present when this asset is a multi-holding exchange account (Coinbase etc.)
  // When set, show portfolio breakdown instead of a TradingView chart.
  holdings?:    Holding[];
}

interface Props {
  asset:   AssetInfo | null;
  onClose: () => void;
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);

export function AssetDrawer({ asset, onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!asset) return null;

  const positive      = (asset.change24h ?? 0) >= 0;
  // Show portfolio breakdown when exchange account has known holdings
  const isExchange    = Array.isArray(asset.holdings) && asset.holdings.length > 0;
  // Show chart only for single-asset wallets (has walletAddress or not an exchange)
  const showChart     = !isExchange;

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center px-4 pt-4 pb-40 sm:p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer */}
      <div className="relative w-full sm:max-w-2xl bg-gray-900 border border-gray-700 rounded-3xl shadow-2xl max-h-[calc(100dvh-180px)] sm:max-h-[85vh] flex flex-col">
        {/* Handle bar (mobile) */}
        <div className="sm:hidden flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-gray-700" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <CoinIcon symbol={asset.symbol} size={40} />
            <div>
              <p className="text-base font-bold text-white">{asset.name}</p>
              <div className="flex items-center gap-2">
                <p className="text-sm text-gray-400">{fmt(asset.value)}</p>
                {asset.change24h !== undefined && (
                  <span className={`flex items-center gap-0.5 text-xs font-semibold ${positive ? "text-emerald-400" : "text-red-400"}`}>
                    {positive ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                    {positive ? "+" : ""}{asset.change24h}% 24h
                  </span>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors p-1">
            <X size={20} />
          </button>
        </div>

        {/* Stats row */}
        <div className="flex gap-4 px-5 py-3 border-b border-gray-800 flex-wrap">
          {asset.quantity !== undefined && (
            <div>
              <p className="text-xs text-gray-500">Quantity</p>
              <p className="text-sm font-semibold text-white">{asset.quantity}</p>
            </div>
          )}
          {asset.price !== undefined && (
            <div>
              <p className="text-xs text-gray-500">Price</p>
              <p className="text-sm font-semibold text-white">{fmt(asset.price)}</p>
            </div>
          )}
          {asset.source && (
            <div>
              <p className="text-xs text-gray-500">Source</p>
              <p className="text-sm font-semibold text-white">{asset.source}</p>
            </div>
          )}
          {asset.walletAddress && (
            <div className="min-w-0">
              <p className="text-xs text-gray-500">Address</p>
              <p className="text-xs font-mono text-gray-300 truncate max-w-[160px]">{asset.walletAddress}</p>
            </div>
          )}
        </div>

        {/* Body — portfolio breakdown OR TradingView chart */}
        <div className="flex-1 overflow-y-auto">
          {isExchange ? (
            /* ── Exchange portfolio breakdown ── */
            <div className="px-5 py-4 space-y-1">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">
                Holdings
              </p>
              <div className="divide-y divide-gray-800 rounded-2xl border border-gray-800 overflow-hidden">
                {asset.holdings!.map((h) => {
                  const pos = h.change24h >= 0;
                  return (
                    <div key={h.id} className="flex items-center gap-3 px-4 py-3 bg-gray-900/60">
                      <CoinIcon symbol={h.symbol} size={36} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-white">{h.symbol}</p>
                        <p className="text-xs text-gray-500 truncate">{h.name}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold text-white">{fmt(h.value)}</p>
                        <div className="flex items-center justify-end gap-1 mt-0.5">
                          <span className="text-xs text-gray-500">{h.quantity} @ {fmt(h.price)}</span>
                          <span className={`text-xs font-semibold ${pos ? "text-emerald-400" : "text-red-400"}`}>
                            {pos ? "+" : ""}{h.change24h}%
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Allocation bar */}
              <div className="pt-3">
                <p className="text-xs text-gray-500 mb-2">Allocation</p>
                <div className="flex rounded-full overflow-hidden h-2 gap-px">
                  {asset.holdings!.map((h) => {
                    const pct = asset.value > 0 ? (h.value / asset.value) * 100 : 0;
                    const colors: Record<string, string> = {
                      BTC: "bg-orange-400", ETH: "bg-blue-400", SOL: "bg-violet-400",
                      BNB: "bg-yellow-400", XRP: "bg-sky-400",
                    };
                    const color = colors[h.symbol] ?? "bg-gray-500";
                    return (
                      <div
                        key={h.id}
                        className={`${color} transition-all`}
                        style={{ width: `${pct}%` }}
                        title={`${h.symbol} ${pct.toFixed(1)}%`}
                      />
                    );
                  })}
                </div>
                <div className="flex gap-3 mt-2 flex-wrap">
                  {asset.holdings!.map((h) => {
                    const pct = asset.value > 0 ? (h.value / asset.value) * 100 : 0;
                    return (
                      <span key={h.id} className="text-xs text-gray-400">
                        {h.symbol} <span className="text-white font-medium">{pct.toFixed(1)}%</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            /* ── Single-asset chart ── */
            <div className="px-4 py-4">
              <TradingViewChart symbol={asset.symbol} height={360} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-800">
          <p className="text-xs text-gray-600 text-center">
            {isExchange
              ? "Holdings data from Plaid · For reference only · Not financial advice"
              : "Chart data from TradingView · For reference only · Not financial advice"
            }
          </p>
        </div>
      </div>
    </div>
  );
}
