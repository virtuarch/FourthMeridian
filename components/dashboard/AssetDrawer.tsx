"use client";

import { useEffect } from "react";
import { X, TrendingUp, TrendingDown } from "lucide-react";
import { TradingViewChart } from "@/components/charts/TradingViewChart";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { Holding } from "@/types";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

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
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 2 }).format(n);

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

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 backdrop-blur-sm" style={{ background: "var(--scrim)" }} onClick={onClose} />

      {/* Drawer */}
      <div
        className="relative w-full sm:max-w-2xl rounded-3xl shadow-2xl max-h-[88dvh] flex flex-col"
        style={{
          background: "var(--modal-surface)",
          backdropFilter: "blur(30px) saturate(160%)",
          WebkitBackdropFilter: "blur(30px) saturate(160%)",
          border: "1px solid var(--border-hairline-strong)",
        }}
      >
        {/* Handle bar (mobile) */}
        <div className="sm:hidden flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full" style={{ background: "var(--border-hairline-strong)" }} />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "var(--border-hairline)" }}>
          <div className="flex items-center gap-3">
            <CoinIcon symbol={asset.symbol} size={40} />
            <div>
              <p className="text-base font-bold" style={{ color: "var(--text-primary)" }}>{asset.name}</p>
              <div className="flex items-center gap-2">
                <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{fmt(asset.value)}</p>
                {asset.change24h !== undefined && (
                  <span
                    className="flex items-center gap-0.5 text-xs font-semibold"
                    style={{ color: positive ? "var(--accent-positive)" : "var(--accent-negative)" }}
                  >
                    {positive ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                    {positive ? "+" : ""}{asset.change24h}% 24h
                  </span>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors p-1">
            <X size={20} />
          </button>
        </div>

        {/* Stats row */}
        <div className="flex gap-4 px-5 py-3 border-b flex-wrap" style={{ borderColor: "var(--border-hairline)" }}>
          {asset.quantity !== undefined && (
            <div>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Quantity</p>
              <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{asset.quantity}</p>
            </div>
          )}
          {asset.price !== undefined && (
            <div>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Price</p>
              <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{fmt(asset.price)}</p>
            </div>
          )}
          {asset.source && (
            <div>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Source</p>
              <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{asset.source}</p>
            </div>
          )}
          {asset.walletAddress && (
            <div className="min-w-0">
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Address</p>
              <p className="text-xs font-mono truncate max-w-[160px]" style={{ color: "var(--text-secondary)" }}>{asset.walletAddress}</p>
            </div>
          )}
        </div>

        {/* Body — portfolio breakdown OR TradingView chart */}
        <div className="flex-1 overflow-y-auto">
          {isExchange ? (
            /* ── Exchange portfolio breakdown ── */
            <div className="px-5 py-4 space-y-1">
              <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: "var(--text-muted)" }}>
                Holdings
              </p>
              <div className="divide-y divide-[var(--border-hairline)] rounded-2xl border overflow-hidden" style={{ borderColor: "var(--border-hairline)" }}>
                {asset.holdings!.map((h) => {
                  const pos = h.change24h >= 0;
                  return (
                    <div key={h.id} className="flex items-center gap-3 px-4 py-3" style={{ background: "var(--glass-thin)" }}>
                      <CoinIcon symbol={h.symbol} size={36} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{h.symbol}</p>
                        <p className="text-xs truncate" style={{ color: "var(--text-muted)" }}>{h.name}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{fmt(h.value)}</p>
                        <div className="flex items-center justify-end gap-1 mt-0.5">
                          <span className="text-xs" style={{ color: "var(--text-muted)" }}>{h.quantity} @ {fmt(h.price)}</span>
                          <span
                            className="text-xs font-semibold"
                            style={{ color: pos ? "var(--accent-positive)" : "var(--accent-negative)" }}
                          >
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
                <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>Allocation</p>
                <div className="flex rounded-full overflow-hidden h-2 gap-px">
                  {asset.holdings!.map((h) => {
                    const pct = asset.value > 0 ? (h.value / asset.value) * 100 : 0;
                    // Per-symbol data-viz differentiation (chart colours, not card
                    // chrome) — preserved; only the neutral fallback is tokenised.
                    const colors: Record<string, string> = {
                      BTC: "bg-orange-400", ETH: "bg-blue-400", SOL: "bg-violet-400",
                      BNB: "bg-yellow-400", XRP: "bg-sky-400",
                    };
                    const known = colors[h.symbol];
                    return (
                      <div
                        key={h.id}
                        className={`${known ?? ""} transition-all`}
                        style={{ width: `${pct}%`, ...(known ? undefined : { background: "var(--text-faint)" }) }}
                        title={`${h.symbol} ${pct.toFixed(1)}%`}
                      />
                    );
                  })}
                </div>
                <div className="flex gap-3 mt-2 flex-wrap">
                  {asset.holdings!.map((h) => {
                    const pct = asset.value > 0 ? (h.value / asset.value) * 100 : 0;
                    return (
                      <span key={h.id} className="text-xs" style={{ color: "var(--text-secondary)" }}>
                        {h.symbol} <span className="font-medium" style={{ color: "var(--text-primary)" }}>{pct.toFixed(1)}%</span>
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
        <div className="px-5 py-3 border-t" style={{ borderColor: "var(--border-hairline)" }}>
          <p className="text-xs text-center" style={{ color: "var(--text-faint)" }}>
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
